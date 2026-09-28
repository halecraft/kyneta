// seats — the identities a store issues, and the pool they come from.
//
// A Runtime's `peerId` is a seat: an address its operations are issued
// under. A seat is sound only while one writer holds it and that writer's
// state holds every operation ever issued under it. A store can issue a seat
// that outlives the process, because it holds the state that proves it
// (store-first: nothing leaves before the store has it). Which kind of seat a
// store issues depends on how it makes the seat exclusive; see `Seat`.

import { randomPeerId } from "@kyneta/random"
import { peerNumber } from "@kyneta/schema"
import type { PeerId } from "@kyneta/transport"

/**
 * A fresh id: a Runtime's without a store, or one per open of a store that
 * cannot hold a lock. It has no history, so it needs no lock or fence.
 */
export type SessionSeat = { readonly kind: "session"; readonly peerId: PeerId }

/**
 * A seat reused on every open, exclusive through a lock held by the writing
 * connection itself (a file lock). No write can outlive the lock, so it has
 * no fence.
 */
export type OwnedSeat = { readonly kind: "owned"; readonly peerId: PeerId }

/**
 * A seat taken from the storage's pool, exclusive through a lock the platform
 * releases when its holder dies. The lock and the writes are separate things,
 * so a dead holder's write may still be in flight when the seat is taken
 * again: every write checks `fence` against the storage's.
 */
export type PooledSeat = {
  readonly kind: "pooled"
  readonly peerId: PeerId
  /** This claim's fence; the storage rejects writes carrying an older one. */
  readonly fence: number
}

export type Seat = SessionSeat | OwnedSeat | PooledSeat

/** A seat for a Runtime without a store. */
export function sessionSeat(): SessionSeat {
  return { kind: "session", peerId: randomPeerId() }
}

/** Fresh peer ids, without end. */
export function* freshPeerIds(): Generator<PeerId, never> {
  for (;;) yield randomPeerId()
}

/**
 * Every seat a storage has issued, oldest first, and the fence of each pooled
 * seat's latest claim. Stored in the storage's store-wide metadata under
 * `STORE_META_SEATS_KEY`.
 */
export type SeatPool = {
  readonly seats: readonly PeerId[]
  readonly fences: Readonly<Record<PeerId, number>>
}

const EMPTY_POOL: SeatPool = { seats: [], fences: {} }

/**
 * The stored pool, decoded totally: anything malformed is empty. A string is
 * `JSON.parse`d first, as some backends store JSON text.
 *
 * An empty pool is the safe reading. Every open then mints a fresh seat, and
 * a holder of a seat the pool no longer lists fails its fence check.
 */
export function parseSeatPool(raw: unknown): SeatPool {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return EMPTY_POOL
    }
  }
  if (typeof value !== "object" || value === null) return EMPTY_POOL
  const { seats, fences } = value as { seats?: unknown; fences?: unknown }
  if (!Array.isArray(seats) || !seats.every(s => typeof s === "string")) {
    return EMPTY_POOL
  }
  if (new Set(seats).size !== seats.length) return EMPTY_POOL
  if (typeof fences !== "object" || fences === null || Array.isArray(fences)) {
    return EMPTY_POOL
  }
  const decoded: Record<PeerId, number> = {}
  for (const [peerId, fence] of Object.entries(fences)) {
    if (!seats.includes(peerId)) return EMPTY_POOL
    if (!Number.isSafeInteger(fence) || (fence as number) < 1) {
      return EMPTY_POOL
    }
    decoded[peerId] = fence as number
  }
  return { seats: seats as PeerId[], fences: decoded }
}

/**
 * The oldest seat not held, else `fresh` appended, with its fence
 * incremented.
 *
 * Refuses a `fresh` whose 53-bit peer number equals an existing seat's: Yjs
 * addresses a peer by that number, so two seats of one storage sharing it
 * would share an address. The caller mints another.
 */
export function allocateSeat(input: {
  readonly pool: SeatPool
  readonly held: ReadonlySet<PeerId>
  readonly fresh: PeerId
}):
  | { readonly seat: PooledSeat; readonly pool: SeatPool }
  | { readonly collision: true } {
  const { pool, held, fresh } = input
  const free = pool.seats.find(seat => !held.has(seat))
  if (free === undefined && collides(pool, fresh)) return { collision: true }
  const peerId = free ?? fresh
  const fence = (pool.fences[peerId] ?? 0) + 1
  return {
    seat: { kind: "pooled", peerId, fence },
    pool: {
      seats: free === undefined ? [...pool.seats, fresh] : pool.seats,
      fences: { ...pool.fences, [peerId]: fence },
    },
  }
}

function collides(pool: SeatPool, fresh: PeerId): boolean {
  const number = peerNumber(fresh, 53)
  return pool.seats.some(seat => peerNumber(seat, 53) === number)
}

/**
 * The check a pooled backend runs inside each write transaction, on the pool
 * it read there. Throws `SeatLostError` when the stored fence for `seat` is
 * not `seat.fence`: the seat has been claimed again since.
 */
export function assertSeatHeld(pool: SeatPool, seat: PooledSeat): void {
  if (pool.fences[seat.peerId] !== seat.fence) throw new SeatLostError(seat)
}

/**
 * Thrown by a store write whose seat has since been claimed again. The Runtime
 * no longer holds its identity: every later write fails the same way, and
 * recovery is to open a new store (in a browser, reload).
 */
export class SeatLostError extends Error {
  readonly peerId: PeerId

  constructor(seat: Seat) {
    super(
      `Store: seat ${seat.peerId} has been claimed by another writer; ` +
        `this store can no longer write`,
    )
    this.name = "SeatLostError"
    this.peerId = seat.peerId
  }
}
