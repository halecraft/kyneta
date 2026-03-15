// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Client Entry Point
//
//   Hydrates the server-rendered HTML and mounts the interactive app.
//   Phase 2 will add document acquisition and WebSocket sync bootstrap.
//
// ═══════════════════════════════════════════════════════════════════════════

import { mount } from "@kyneta/core"
import { createApp } from "./app.js"

// Phase 1: minimal client — no document, no sync.
// Phase 2 replaces this with real document acquisition via createDoc + SEED,
// WebSocket connection, and frontier-based sync bootstrap.
const root = document.getElementById("root")!
const app = createApp(null)
mount(app, root)