import { mount } from "@kyneta/core"
import type { Changeset, TreeEvent, PendingChange } from "@kyneta/schema"

import { RecipeBookSchema } from "./schema.js"
import { SEED } from "./seed.js"
import { createDoc, applyChanges, subscribe, version } from "./facade.js"
import { parseClientMessage, toPendingChanges } from "./protocol.js"
import { createApp } from "./app.js"

const doc = createDoc(RecipeBookSchema, { ...SEED })

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

ws.addEventListener("message", (event) => {
  const msg = parseClientMessage(event.data)
  if (msg?.type === "delta" && msg.ops.length > 0) {
    // origin: "sync" tells inputTextRegion to preserve cursor position
    applyChanges(doc, toPendingChanges(msg.ops), { origin: "sync" })
  }
})

// Forward local mutations to the server. Filter out sync-origin changes
// to prevent echo loops (server sent it to us, we don't send it back).
subscribe(doc, (changeset: Changeset<TreeEvent>) => {
  if (changeset.origin === "sync") return
  if (ws.readyState !== WebSocket.OPEN) return

  const ops: PendingChange[] = changeset.changes.map((event) => ({
    path: event.path,
    change: event.change,
  }))
  ws.send(JSON.stringify({ type: "delta", ops, version: version(doc) }))
})

ws.addEventListener("close", () => {
  console.log("[ws] disconnected from server")
})