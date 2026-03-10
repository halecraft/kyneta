// === Authority Chain Replay ===
// Implements §5.1 of the spec: computing effective capabilities for a peer
// at a given causal moment by replaying all authority constraints.
//
// Key semantics:
// - The reality creator holds implicit Admin capability.
// - Capabilities propagate via grant authority constraints.
// - Concurrent grant and revoke of the same capability → revoke wins.
// - Capability attenuation: you can only grant capabilities you hold.
// - Authority(C) capability is required to grant/revoke capability C.
//
// See unified-engine.md §5.

import type {
  PeerID,
  CnId,
  Constraint,
  AuthorityConstraint,
  Capability,
  RetractScope,
  VersionVector,
} from './types.js';
import { cnIdKey } from './cnid.js';
import { vvHasSeenCnId } from './version-vector.js';

// ---------------------------------------------------------------------------
// Capability equality
// ---------------------------------------------------------------------------

/**
 * Check if two capabilities are structurally equal.
 */
export function capabilityEquals(a: Capability, b: Capability): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case 'admin':
      return true;

    case 'write':
      return (
        b.kind === 'write' &&
        pathPatternEquals(a.pathPattern, (b as typeof a).pathPattern)
      );

    case 'createNode':
      return (
        b.kind === 'createNode' &&
        pathPatternEquals(a.pathPattern, (b as typeof a).pathPattern)
      );

    case 'retract':
      return (
        b.kind === 'retract' &&
        retractScopeEquals(a.scope, (b as typeof a).scope)
      );

    case 'createRule':
      return (
        b.kind === 'createRule' &&
        a.minLayer === (b as typeof a).minLayer
      );

    case 'authority':
      return (
        b.kind === 'authority' &&
        capabilityEquals(a.capability, (b as typeof a).capability)
      );
  }
}

/**
 * Produce a deterministic string key for a capability, for use as Map/Set key.
 */
export function capabilityKey(cap: Capability): string {
  switch (cap.kind) {
    case 'admin':
      return 'admin';
    case 'write':
      return `write:${cap.pathPattern.join('/')}`;
    case 'createNode':
      return `createNode:${cap.pathPattern.join('/')}`;
    case 'retract':
      return `retract:${retractScopeKey(cap.scope)}`;
    case 'createRule':
      return `createRule:${cap.minLayer}`;
    case 'authority':
      return `authority:${capabilityKey(cap.capability)}`;
  }
}

function retractScopeKey(scope: RetractScope): string {
  switch (scope.kind) {
    case 'own':
      return 'own';
    case 'any':
      return 'any';
    case 'byPath':
      return `byPath:${scope.pattern.join('/')}`;
  }
}

function pathPatternEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function retractScopeEquals(a: RetractScope, b: RetractScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'byPath' && b.kind === 'byPath') {
    return pathPatternEquals(a.pattern, b.pattern);
  }
  return true; // 'own' === 'own', 'any' === 'any'
}

// ---------------------------------------------------------------------------
// Capability containment (for attenuation checks)
// ---------------------------------------------------------------------------

/**
 * Check if capability `held` covers capability `required`.
 *
 * Admin covers everything. Otherwise, the held capability must be
 * at least as broad as the required one. This prevents capability
 * escalation: you cannot grant more than you have.
 *
 * Note: This is a simplified containment check. A full implementation
 * would need glob matching for path patterns. For now, we use exact
 * match or Admin.
 */
export function capabilityCovers(held: Capability, required: Capability): boolean {
  // Admin covers everything
  if (held.kind === 'admin') return true;

  // Same kind — check specifics
  if (held.kind !== required.kind) return false;

  switch (held.kind) {
    case 'write':
      // Exact path match or wildcard pattern (simplified: exact only)
      return pathPatternEquals(
        held.pathPattern,
        (required as typeof held).pathPattern,
      );

    case 'createNode':
      return pathPatternEquals(
        held.pathPattern,
        (required as typeof held).pathPattern,
      );

    case 'retract': {
      const reqScope = (required as typeof held).scope;
      // 'any' covers everything
      if (held.scope.kind === 'any') return true;
      // 'own' only covers 'own'
      if (held.scope.kind === 'own') return reqScope.kind === 'own';
      // 'byPath' covers same or narrower path
      if (held.scope.kind === 'byPath' && reqScope.kind === 'byPath') {
        return pathPatternEquals(held.scope.pattern, reqScope.pattern);
      }
      return false;
    }

    case 'createRule':
      // Lower minLayer is broader (can create rules at more layers)
      return held.minLayer <= (required as typeof held).minLayer;

    case 'authority':
      // Authority(C) covers Authority(C') iff C covers C'
      return capabilityCovers(
        held.capability,
        (required as typeof held).capability,
      );
  }
}

// ---------------------------------------------------------------------------
// Authority State
// ---------------------------------------------------------------------------

/**
 * A grant/revoke event for a specific (peer, capability) pair.
 * Used internally during authority chain replay.
 */
interface AuthorityEvent {
  /** The authority constraint that produced this event. */
  readonly constraintId: CnId;
  /** The lamport timestamp for causal ordering. */
  readonly lamport: number;
  /** The peer of the asserting agent. */
  readonly asserterPeer: PeerID;
  /** Grant or revoke. */
  readonly action: 'grant' | 'revoke';
}

/**
 * The result of computing authority for a reality.
 */
export interface AuthorityState {
  /** The peer who created the reality (holds implicit Admin). */
  readonly creator: PeerID;

  /**
   * Effective capabilities for each peer.
   * Map<PeerID, Set<capabilityKey>>
   */
  readonly effectiveCapabilities: ReadonlyMap<PeerID, ReadonlySet<string>>;

  /**
   * Full capability objects by key for lookup.
   */
  readonly capabilityIndex: ReadonlyMap<string, Capability>;
}

// ---------------------------------------------------------------------------
// Compute capabilities
// ---------------------------------------------------------------------------

/**
 * Compute the effective capabilities for all peers at a given causal moment.
 *
 * Replays all authority constraints that are causally before the given
 * version vector V. For each (peer, capability) pair, determines whether
 * the net effect is a grant or revoke.
 *
 * Semantics:
 * - Reality creator always has Admin.
 * - For each (targetPeer, capability) pair, collect all authority events.
 * - Sort by (lamport, peer) for deterministic ordering.
 * - Among concurrent events (same lamport, different peer), revoke wins.
 * - The last-writer determines effective state; ties broken by revoke-wins.
 *
 * @param constraints - All constraints (we filter to authority type internally).
 * @param creator - PeerID of the reality creator.
 * @param version - Version vector defining the causal moment. If undefined,
 *                  all constraints are considered (current state).
 * @returns AuthorityState with effective capabilities.
 */
export function computeAuthority(
  constraints: Iterable<Constraint>,
  creator: PeerID,
  version?: VersionVector,
): AuthorityState {
  // Collect authority events grouped by (targetPeer, capabilityKey)
  // Key: `${targetPeer}||${capabilityKey}`
  const eventsByPeerCap = new Map<string, AuthorityEvent[]>();
  const capIndex = new Map<string, Capability>();

  for (const c of constraints) {
    // Filter to authority constraints only
    if (c.type !== 'authority') continue;

    // If version-parameterized, only consider constraints visible at V
    if (version !== undefined && !vvHasSeenCnId(version, c.id)) continue;

    const payload = c.payload;
    const capKey = capabilityKey(payload.capability);
    const compositeKey = `${payload.targetPeer}||${capKey}`;

    // Index the capability object
    if (!capIndex.has(capKey)) {
      capIndex.set(capKey, payload.capability);
    }

    let events = eventsByPeerCap.get(compositeKey);
    if (events === undefined) {
      events = [];
      eventsByPeerCap.set(compositeKey, events);
    }

    events.push({
      constraintId: c.id,
      lamport: c.lamport,
      asserterPeer: c.id.peer,
      action: payload.action,
    });
  }

  // Resolve each (peer, capability) pair
  const effective = new Map<PeerID, Set<string>>();

  // Creator always has Admin
  const creatorCaps = new Set<string>();
  creatorCaps.add(capabilityKey({ kind: 'admin' }));
  effective.set(creator, creatorCaps);
  capIndex.set('admin', { kind: 'admin' });

  for (const [compositeKey, events] of eventsByPeerCap) {
    const sepIdx = compositeKey.indexOf('||');
    const targetPeer = compositeKey.slice(0, sepIdx);
    const capKey = compositeKey.slice(sepIdx + 2);

    const resolved = resolveAuthorityEvents(events);

    if (resolved === 'grant') {
      let caps = effective.get(targetPeer);
      if (caps === undefined) {
        caps = new Set();
        effective.set(targetPeer, caps);
      }
      caps.add(capKey);
    } else {
      // revoke — remove if present
      const caps = effective.get(targetPeer);
      if (caps !== undefined) {
        caps.delete(capKey);
      }
    }
  }

  return {
    creator,
    effectiveCapabilities: effective,
    capabilityIndex: capIndex,
  };
}

/**
 * Resolve a list of authority events to a single grant/revoke outcome.
 *
 * Events are sorted by (lamport DESC, peer DESC) — the highest
 * (lamport, peer) event wins. Among events with the same highest
 * lamport, if ANY is a revoke, revoke wins (conservative).
 */
function resolveAuthorityEvents(
  events: readonly AuthorityEvent[],
): 'grant' | 'revoke' {
  if (events.length === 0) return 'revoke'; // no events → not granted

  // Find the maximum lamport
  let maxLamport = -1;
  for (const e of events) {
    if (e.lamport > maxLamport) {
      maxLamport = e.lamport;
    }
  }

  // Collect all events at the maximum lamport
  const topEvents = events.filter((e) => e.lamport === maxLamport);

  // If any top event is a revoke, revoke wins (concurrent revoke-wins)
  for (const e of topEvents) {
    if (e.action === 'revoke') {
      return 'revoke';
    }
  }

  // All top events are grants
  return 'grant';
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Check if a peer has a specific capability at the given authority state.
 */
export function hasCapability(
  state: AuthorityState,
  peer: PeerID,
  required: Capability,
): boolean {
  // Creator always has Admin which covers everything
  if (peer === state.creator) return true;

  const caps = state.effectiveCapabilities.get(peer);
  if (caps === undefined) return false;

  // Check if any held capability covers the required one
  for (const capKey of caps) {
    const held = state.capabilityIndex.get(capKey);
    if (held !== undefined && capabilityCovers(held, required)) {
      return true;
    }
  }

  return false;
}

/**
 * Get all effective capabilities for a peer.
 */
export function getCapabilities(
  state: AuthorityState,
  peer: PeerID,
): Capability[] {
  if (peer === state.creator) {
    return [{ kind: 'admin' }];
  }

  const capKeys = state.effectiveCapabilities.get(peer);
  if (capKeys === undefined) return [];

  const result: Capability[] = [];
  for (const key of capKeys) {
    const cap = state.capabilityIndex.get(key);
    if (cap !== undefined) {
      result.push(cap);
    }
  }
  return result;
}

/**
 * Get the required capability for a given constraint type.
 *
 * This maps each constraint type to what capability the asserting peer
 * must hold (per §5.2).
 *
 * Note: For structure and value constraints, the path-based capability
 * check requires knowledge of the skeleton (to determine the path of
 * the target node). Since we're computing validity before the skeleton
 * exists, we use a simplified check:
 * - Admin covers everything.
 * - Write/CreateNode with any path pattern is accepted (path validation
 *   is deferred to a future plan with real path-based capabilities).
 *
 * For now, the important constraint is that the peer has *some*
 * appropriate capability kind.
 */
export function requiredCapability(constraint: Constraint): Capability | null {
  switch (constraint.type) {
    case 'structure':
      // CreateNode capability (simplified: any path)
      return { kind: 'createNode', pathPattern: ['*'] };

    case 'value':
      // Write capability (simplified: any path)
      return { kind: 'write', pathPattern: ['*'] };

    case 'retract':
      // Retract capability — scope 'any' is the broadest
      return { kind: 'retract', scope: { kind: 'any' } };

    case 'rule':
      // CreateRule with the rule's layer
      return { kind: 'createRule', minLayer: constraint.payload.layer };

    case 'authority':
      // Authority(C) where C is the capability being granted/revoked
      return { kind: 'authority', capability: constraint.payload.capability };

    case 'bookmark':
      // Bookmarks require no special capability (any peer can bookmark)
      return null;
  }
}