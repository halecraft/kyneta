import { z } from "zod/v4"
import type { PendingChange } from "@kyneta/schema"

// --- Wire schemas ---

const PathSegment = z.union([
  z.object({ type: z.literal("key"), key: z.string() }),
  z.object({ type: z.literal("index"), index: z.number() }),
])

const Change = z.object({ type: z.string() }).passthrough()

const PendingChangeSchema = z.object({
  path: z.array(PathSegment),
  change: Change,
})

// --- Protocol messages ---

export const SyncMessage = z.object({
  type: z.literal("sync"),
  version: z.number(),
})

export const DeltaMessage = z.object({
  type: z.literal("delta"),
  ops: z.array(PendingChangeSchema),
  version: z.number(),
})

export const ServerMessage = z.discriminatedUnion("type", [SyncMessage, DeltaMessage])
export const ClientMessage = z.discriminatedUnion("type", [DeltaMessage])

export type ServerMessage = z.infer<typeof ServerMessage>
export type ClientMessage = z.infer<typeof ClientMessage>

// --- Parse helpers ---

export function parseServerMessage(data: unknown): ServerMessage | null {
  const result = ServerMessage.safeParse(typeof data === "string" ? JSON.parse(data) : data)
  return result.success ? result.data as ServerMessage : null
}

export function parseClientMessage(data: unknown): ClientMessage | null {
  const result = ClientMessage.safeParse(typeof data === "string" ? JSON.parse(data) : data)
  return result.success ? result.data as ClientMessage : null
}

/**
 * Narrows a parsed DeltaMessage's ops to PendingChange[].
 * The Zod schema validates structure; this cast bridges to the nominal type.
 */
export function toPendingChanges(ops: z.infer<typeof PendingChangeSchema>[]): PendingChange[] {
  return ops as unknown as PendingChange[]
}