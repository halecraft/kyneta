// writable-context — the context every ref of a document shares: the batch
// lifecycle, the prepare pipeline, delivery, and the document's coordinate
// and subscriber tries.
//
// One fixed construction. `prepare` calls each step itself, in one order:
// locate, complete, advance, the substrate, settle, mark what was populated.
// The delivery dispatcher plans and fires each sealed batch's notifications.

import type { DispatcherHandle } from "@kyneta/machine"
import { createDispatcher } from "@kyneta/machine"
import type { ChangeBase } from "./change.js"
import type { Op } from "./changefeed.js"
import { completeAt } from "./complete.js"
import { CoordinateTrie } from "./coordinate-trie.js"
import { deliverNotifications, planDelivery } from "./delivery.js"
import {
  abortFrame,
  closeFrame,
  emptyFrames,
  type FrameStack,
  inFrame,
  openFrame,
  record,
} from "./interpreters/frame-stack.js"
import { SubscriberTrie } from "./interpreters/subscriber-trie.js"
import type {
  SealedBatch,
  TraceEntry,
  WritableContext,
} from "./interpreters/writable.js"
import type { Path } from "./path.js"
import type { PositionCapable } from "./position.js"
import { advance, settle } from "./ref/address.js"
import type { RichTextSchema, Schema, TextSchema } from "./schema.js"
import type {
  BatchOptions,
  BatchOutcome,
  CommitOptions,
  PrepareOptions,
  SubstratePrepare,
} from "./substrate.js"
import { TREE_NODE_ALLOCATE } from "./substrate.js"
import { planSubtreeEffect } from "./subtree-effect.js"

const ABORTED: BatchOutcome = { ops: [], inverses: [], aborted: true }
const AUTHOR: PrepareOptions = { ingress: "author" }
const COMPENSATE: PrepareOptions = { ingress: "compensate" }
const ANNOUNCE: PrepareOptions = { ingress: "announce" }

// ---------------------------------------------------------------------------
// buildWritableContext — shared builder for substrate factories
// ---------------------------------------------------------------------------

export interface SubstrateCapabilities {
  nativeResolver?: (schema: Schema, path: Path) => unknown
  positionResolver?: (
    schema: TextSchema | RichTextSchema,
    path: Path,
  ) => PositionCapable
  treeNodeAllocate?: (
    path: Path,
    parent?: string | null,
    index?: number,
  ) => string
}

type DeliveryMsg = { readonly type: "deliver"; readonly batch: SealedBatch }

/**
 * Builds a WritableContext around a substrate's mutation primitives, for a
 * document whose root schema is `schema`.
 *
 * The substrate sees only authored ops and their compensations:
 * - `substrate.prepare(path, change, recordInverse)` — apply the change to
 *   σ and λ; for a forward op, hand over its inverse, which the context
 *   records on the active frame once `prepare` returns.
 * - `substrate.afterBatch(outcome)` — end of an authored batch, inside the
 *   bracket, with the ops that survived and their inverses
 *   (plain logs the batch; CRDT substrates drain their coalescing buffers).
 * - `substrate.runBatch?(body, options)` — optional native bracket, invoked
 *   around the outermost frame.
 */
export function buildWritableContext(
  substrate: SubstratePrepare,
  schema: Schema,
  capabilities: SubstrateCapabilities = {},
): WritableContext {
  // What the authored batch did, frame by frame (`frame-stack.ts`): what
  // `batch()` returns, what `afterBatch` receives, and what an abort
  // compensates.
  let frames: FrameStack = emptyFrames

  // The context's coordinates and subscribers.
  const subscribers = new SubscriberTrie()
  const trie = new CoordinateTrie(at => subscribers.holdsAt(at))

  // What to deliver: one trace per open batch, every op it prepared. An
  // announcement made while an authored batch is open pushes its own trace,
  // so neither batch captures the other's ops.
  const traces: TraceEntry[][] = []

  // Delivers sealed batches in seal order, planning each batch's changesets
  // when its turn comes, so a subscriber that joined meanwhile hears it.
  // Created on first use so that it picks up the lease `createRef` attaches
  // to the context.
  let deliveries: DispatcherHandle<DeliveryMsg> | undefined
  const delivery = (): DispatcherHandle<DeliveryMsg> => {
    deliveries ??= createDispatcher<DeliveryMsg>(
      ({ batch }) =>
        deliverNotifications(
          planDelivery(batch.entries, subscribers),
          batch.options,
        ),
      { lease: ctx.lease, label: "changefeed" },
    )
    return deliveries
  }
  const release = (batch: SealedBatch): void => {
    delivery().dispatch({ type: "deliver", batch })
  }

  // Locate, complete an authored change, advance a list's addresses, the
  // substrate call for the ingress and the op joining the open batch's trace
  // (and, authored, its frame), settle what the change rewrote, then mark
  // what it populated. Everything after completion sees the completed
  // change. A compensation is read from σ and an announcement comes from a
  // substrate that applied it, so both are complete already.
  //
  // `locate` decides only the live path, `at`: the op is frozen here, once,
  // from it. Its own coordinate is stable under its own change, and a later
  // op in the batch may advance the address it sits on.
  const prepare = (
    rawPath: Path,
    incoming: ChangeBase,
    options: PrepareOptions,
  ): void => {
    const trace = traces.at(-1)
    if (trace === undefined) {
      throw new Error("ctx.prepare called outside runBatch or announce")
    }
    const path = trie.locate(rawPath)
    const change =
      options.ingress === "author"
        ? completeAt(schema, substrate.reader, path, incoming)
        : incoming
    advance(trie, path, change)
    const op: Op = { path: path.toRaw(), change }
    switch (options.ingress) {
      case "author": {
        const inverses: ChangeBase[] = []
        substrate.prepare(path, change, inverse => inverses.push(inverse))
        const [inverse] = inverses
        if (inverse === undefined || inverses.length > 1) {
          throw new Error(
            `substrate.prepare must record exactly one inverse for a write, and recorded ${inverses.length}.`,
          )
        }
        frames = record(frames, { at: path, op, inverse })
        break
      }
      case "compensate":
        substrate.prepare(path, change, null)
        break
      case "announce":
        break
    }
    trace.push({ op, at: path })
    settle(trie, schema, substrate.reader, path, change)
    subscribers.markPopulated(path, planSubtreeEffect(change))
  }

  // The native bracket around the outermost frame. Substrates without one
  // (plain, ephemeral) run the frame directly.
  const bracket: (work: () => void, options: CommitOptions) => void =
    substrate.runBatch?.bind(substrate) ?? (work => work())

  // Close a batch's trace: pop it, so a stray prepare after the seal throws
  // instead of joining a batch that is already sealed.
  const closeTrace = (trace: TraceEntry[]): void => {
    if (traces.at(-1) === trace) traces.pop()
  }

  const sealAndRelease = (trace: TraceEntry[], options: BatchOptions): void => {
    closeTrace(trace)
    release({ options, entries: trace })
  }

  const runBatch: WritableContext["runBatch"] = (work, opts) => {
    const outermost = !inFrame(frames)
    if (outermost) traces.push([])
    const trace = traces.at(-1) ?? []
    let captured: Op[] = []

    const wrappedWork = (): void => {
      frames = openFrame(frames)
      try {
        work()
      } catch (e) {
        // Replay this frame's inverses LIFO through `prepare`, not
        // `substrate.prepare`, so the compensations join the trace (the
        // aborted Changeset shows the full op log) and run every stage. The
        // substrate gets no recorder, so it records no inverse of an inverse.
        const aborted = abortFrame(frames)
        frames = aborted.frames
        try {
          for (const { at, inverse } of aborted.compensations) {
            prepare(at, inverse, COMPENSATE)
          }
          if (aborted.outermost) {
            substrate.afterBatch(ABORTED)
            sealAndRelease(trace, { ...opts, ingress: "author", aborted: true })
          }
        } catch (compErr: any) {
          const err =
            compErr instanceof Error ? compErr : new Error(String(compErr))
          err.cause = e
          throw err
        }
        throw e
      }
      const closed = closeFrame(frames)
      frames = closed.frames
      captured = closed.ops
      if (closed.outcome !== undefined) {
        substrate.afterBatch(closed.outcome)
        sealAndRelease(trace, { ...opts, ingress: "author" })
      }
    }

    if (!outermost) {
      wrappedWork()
      return captured
    }
    // Hold deliveries for the native bracket: this batch is sealed inside
    // it, and anything announced while the native commit runs is sealed
    // after it, so both are delivered in seal order once the commit closes.
    try {
      delivery().hold(() => bracket(wrappedWork, opts))
    } finally {
      closeTrace(trace)
    }
    return captured
  }

  const announce: WritableContext["announce"] = (ops, options) => {
    if (ops.length === 0) return
    const trace: TraceEntry[] = []
    traces.push(trace)
    try {
      for (const { path, change } of ops) {
        prepare(path, change, ANNOUNCE)
      }
    } catch (error) {
      closeTrace(trace)
      throw error
    }
    sealAndRelease(trace, { ingress: "announce", ...options })
  }

  // Depth-aware dispatch combinator:
  // - outside any runBatch frame: open an implicit single-op runBatch —
  //   auto-commit semantics. Subscribers see a degenerate Changeset of one
  //   change.
  // - inside a frame (e.g. a batch(doc, fn) body): just call prepare. The
  //   outer frame owns the seal, so multi-helper blocks collapse into one
  //   Changeset.
  const dispatch = (path: Path, change: ChangeBase): void => {
    if (!inFrame(frames)) {
      runBatch(() => {
        prepare(path, change, AUTHOR)
      }, {})
    } else {
      prepare(path, change, AUTHOR)
    }
  }

  const ctx: WritableContext = {
    reader: substrate.reader,
    schema,
    trie,
    subscribers,
    prepare,
    runBatch,
    announce,
    dispatch,
  }

  if (capabilities.nativeResolver) {
    Object.defineProperty(ctx, "nativeResolver", {
      value: capabilities.nativeResolver,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }

  if (capabilities.positionResolver) {
    Object.defineProperty(ctx, "positionResolver", {
      value: capabilities.positionResolver,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }

  if (capabilities.treeNodeAllocate) {
    Object.defineProperty(ctx, TREE_NODE_ALLOCATE, {
      value: capabilities.treeNodeAllocate,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }

  return ctx
}
