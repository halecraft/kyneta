import { mount } from "@kyneta/core"
import type { Changeset, Op, SubstratePayload } from "@kyneta/schema/basic"
import { createApp } from "./app.js"
import {
  applyChanges,
  createDoc,
  createDocFromSnapshot,
  subscribe,
  version,
} from "@kyneta/schema/basic"
import { parseClientMessage, toOps } from "./protocol.js"
import { RecipeBookSchema } from "./schema.js"
import { SEED } from "./seed.js"

// --- Document initialization ---
// If the server embedded a substrate snapshot in the SSR HTML, reconstruct
// the doc from it. Otherwise fall back to creating from SEED (e.g. direct
// JS load without SSR, or development without a server).

const snapshotText = document.getElementById("kyneta-state")?.textContent
const doc = snapshotText
  ? createDocFromSnapshot(RecipeBookSchema, {
      encoding: "json",
      data: snapshotText,
    } satisfies SubstratePayload)
  : createDoc(RecipeBookSchema, { ...SEED })

const root = document.getElementById("root")!
const app = createApp(doc)
mount(app, root)

// --- WebSocket sync ---

const ws = new WebSocket(`ws://${location.host}/ws`)

ws.addEventListener("open", () => {
  // Use the server's frontier from the SSR meta tag so we only receive
  // ops the server has applied since rendering this page.
  const serverVersion = Number(
    document.querySelector<HTMLMetaElement>('meta[name="kyneta-version"]')
      ?.content ?? "0",
  )
  ws.send(JSON.stringify({ type: "sync", version: serverVersion }))
})

ws.addEventListener("message", event => {
  const msg = parseClientMessage(event.data)
  if (msg?.type === "delta" && msg.ops.length > 0) {
    // origin: "sync" tells inputTextRegion to preserve cursor position
    applyChanges(doc, toOps(msg.ops), { origin: "sync" })
  }
})

// Forward local mutations to the server. Filter out sync-origin changes
// to prevent echo loops (server sent it to us, we don't send it back).
subscribe(doc, (changeset: Changeset<Op>) => {
  if (changeset.origin === "sync") return
  if (ws.readyState !== WebSocket.OPEN) return

  const ops: Op[] = changeset.changes.map(event => ({
    path: event.path,
    change: event.change,
  }))
  ws.send(JSON.stringify({ type: "delta", ops, version: version(doc) }))
})

ws.addEventListener("close", () => {
  console.log("[ws] disconnected from server")
})
