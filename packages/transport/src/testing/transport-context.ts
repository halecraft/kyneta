// transport-context — shared `TransportContext` factory for tests.
//
// Centralized so that any new field on `TransportContext` is a one-line
// change here instead of edits across every transport package's
// `__tests__/` directory.

import { type Mock, vi } from "vitest"
import type { TransportContext } from "../transport.js"

/**
 * `TransportContext` whose callbacks are `vi.fn()` mocks — preserves the
 * `Mock` interface (`.mock.calls`, etc.) on the return type so tests can
 * inspect call history without `as any` casts.
 */
export type TestTransportContext = Omit<
  TransportContext,
  | "onChannelReceive"
  | "onChannelAdded"
  | "onChannelRemoved"
  | "onChannelEstablish"
> & {
  onChannelReceive: Mock<TransportContext["onChannelReceive"]>
  onChannelAdded: Mock<TransportContext["onChannelAdded"]>
  onChannelRemoved: Mock<TransportContext["onChannelRemoved"]>
  onChannelEstablish: Mock<TransportContext["onChannelEstablish"]>
}

/**
 * Build a `TransportContext` for tests with `vi.fn()` callbacks and a
 * closure-scoped channelId counter that mirrors the synchronizer's
 * per-instance counter.
 *
 * `overrides` lets a test pin specific callbacks or identity without
 * losing the default `mintChannelId`. The return type preserves the
 * `Mock` interface on each callback so tests can read `.mock.calls`.
 *
 * @example
 * ```ts
 * const ctx = createTestTransportContext({
 *   identity: { peerId: "peer-a", principal: "peer-a", type: "user" },
 *   onChannelEstablish: channel => established.push(channel.channelId),
 * })
 * ```
 */
export function createTestTransportContext(
  overrides: Partial<TransportContext> = {},
): TestTransportContext {
  let nextChannelId = 1
  const base: TestTransportContext = {
    identity: { peerId: "test-peer", principal: "Test Peer", type: "user" },
    onChannelReceive: vi.fn() as TestTransportContext["onChannelReceive"],
    onChannelAdded: vi.fn() as TestTransportContext["onChannelAdded"],
    onChannelRemoved: vi.fn() as TestTransportContext["onChannelRemoved"],
    onChannelEstablish: vi.fn() as TestTransportContext["onChannelEstablish"],
    mintChannelId: () => nextChannelId++,
  }
  // Overrides may pass plain functions for the channel callbacks; cast back
  // to the test surface so the `.mock` accessors stay typed on the defaults
  // that callers didn't override.
  return { ...base, ...overrides } as TestTransportContext
}
