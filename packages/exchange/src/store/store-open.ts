// store-open — what opening a store decides.
//
// Opening a store reads its store-wide metadata once: the format marker,
// which says whether this code can read the storage at all, and the seat
// pool, which the store takes its seat from. Both are decided here, purely,
// and the backend writes what the plan says in one step.

import type { PeerId } from "@kyneta/transport"
import {
  allocateSeat,
  type OwnedSeat,
  type PooledSeat,
  parseSeatPool,
  type Seat,
  type SeatPool,
  type SessionSeat,
} from "./seats.js"
import {
  decideStoreFormat,
  parseStoreFormat,
  type StoreFormatVersion,
  StoreFormatVersionError,
} from "./store-format.js"

/**
 * How a backend makes its seat exclusive, and what it knows of the seats held
 * (see `Seat`).
 *
 * - `session`: a fresh seat per open, never stored.
 * - `owned`: the pool's single seat, reused on every open.
 * - `pooled`: the oldest pool seat not in `held`, which the backend
 *   snapshotted while holding its allocation lock.
 */
export type Seating = SessionSeating | OwnedSeating | PooledSeating
export type SessionSeating = { readonly kind: "session" }
export type OwnedSeating = { readonly kind: "owned" }
export type PooledSeating = {
  readonly kind: "pooled"
  readonly held: ReadonlySet<PeerId>
}

/**
 * The outcome of opening: refused, or a seat of the kind the seating asked
 * for. `P` is what the plan writes to the pool: always a pool for a pooled
 * open, since every claim increments a fence.
 */
export type StoreOpenPlan<
  S extends Seat = Seat,
  P extends SeatPool | undefined = SeatPool | undefined,
> =
  | { readonly action: "refuse"; readonly error: StoreFormatVersionError }
  | {
      readonly action: "open"
      readonly seat: S
      /** The format marker to write, for a brand-new store. */
      readonly writeFormat?: StoreFormatVersion
      /** The pool to write, when the open changed it. */
      readonly writePool: P
    }

/** What `planStoreOpen` reads. */
export type StoreOpenInput<T extends Seating> = {
  readonly backend: string
  readonly current: StoreFormatVersion
  /** The stored format marker, raw; `undefined` when absent. */
  readonly storedFormat: unknown
  readonly storeHasData: boolean
  /** The stored pool, raw; `undefined` when absent. */
  readonly storedPool: unknown
  readonly seating: T
  /**
   * New peer ids. A pooled open takes the first whose 53-bit peer number no
   * pool seat shares; the others take the first.
   */
  readonly fresh: Iterable<PeerId>
}

/** What opening a store decides, from what its store-metadata holds. */
export function planStoreOpen(
  input: StoreOpenInput<SessionSeating>,
): StoreOpenPlan<SessionSeat, undefined>
export function planStoreOpen(
  input: StoreOpenInput<OwnedSeating>,
): StoreOpenPlan<OwnedSeat>
export function planStoreOpen(
  input: StoreOpenInput<PooledSeating>,
): StoreOpenPlan<PooledSeat, SeatPool>
export function planStoreOpen(input: StoreOpenInput<Seating>): StoreOpenPlan
export function planStoreOpen(input: StoreOpenInput<Seating>): StoreOpenPlan {
  const { backend, current, seating } = input

  const parsed =
    input.storedFormat === undefined
      ? null
      : parseStoreFormat(input.storedFormat)
  if (parsed === "malformed") {
    return refuse(backend, "malformed-version", null, current)
  }
  const format = decideStoreFormat({
    current,
    stored: parsed,
    storeHasData: input.storeHasData,
  })
  if (format.action === "refuse") {
    return refuse(backend, format.reason, parsed, current)
  }
  const writeFormat =
    format.action === "stamp" ? { writeFormat: format.value } : {}
  const open = (seat: Seat, writePool?: SeatPool): StoreOpenPlan => ({
    action: "open",
    seat,
    writePool,
    ...writeFormat,
  })

  const pool = parseSeatPool(input.storedPool)
  switch (seating.kind) {
    case "session":
      return open({ kind: "session", peerId: first(input.fresh) })
    case "owned": {
      const owned = pool.seats[0]
      if (owned !== undefined) return open({ kind: "owned", peerId: owned })
      const peerId = first(input.fresh)
      return open({ kind: "owned", peerId }, { seats: [peerId], fences: {} })
    }
    case "pooled":
      for (const fresh of input.fresh) {
        const allocated = allocateSeat({ pool, held: seating.held, fresh })
        if (!("collision" in allocated)) {
          return open(allocated.seat, allocated.pool)
        }
      }
      throw new Error("planStoreOpen: ran out of fresh peer ids")
  }
}

function first(fresh: Iterable<PeerId>): PeerId {
  for (const peerId of fresh) return peerId
  throw new Error("planStoreOpen: no fresh peer id")
}

function refuse(
  backend: string,
  reason: StoreFormatVersionError["reason"],
  stored: StoreFormatVersion | null,
  current: StoreFormatVersion,
): StoreOpenPlan {
  return {
    action: "refuse",
    error: new StoreFormatVersionError({ reason, backend, stored, current }),
  }
}
