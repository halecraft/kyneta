// ═══════════════════════════════════════════════════════════════════════════
//
//   Encrafte — App
//
//   Minimal chat interface proving Exchange sync works.
//   Renders a message list from a Loro-backed ThreadDoc and a text
//   input form that appends messages. Open two tabs to see sync.
//
//   Uses Ark UI components (Dialog, Tooltip) for accessible interactions
//   and design tokens from tokens.css for theming.
//
// ═══════════════════════════════════════════════════════════════════════════

import { persistentPeerId } from "@kyneta/exchange"
import { useDocument, useValue } from "@kyneta/react"
import { Info, Send, X } from "lucide-react"
import { useState } from "react"
import { Dialog } from "./components/ui/dialog.js"
import { Tooltip } from "./components/ui/tooltip.js"
import { ThreadDoc } from "./schema.js"

const peerId = persistentPeerId("encrafte-peer-id")

export function App() {
  const doc = useDocument("thread:main", ThreadDoc)
  const { messages } = useValue(doc)
  const [aboutOpen, setAboutOpen] = useState(false)

  const sendMessage = (content: string) => {
    doc.messages.push({
      author: peerId,
      content,
      timestamp: Date.now(),
    })
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Encrafte</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Tooltip.Root openDelay={300} closeDelay={0}>
            <Tooltip.Trigger asChild>
              <span className="peer-id" title={peerId}>
                {peerId.slice(0, 8)}
              </span>
            </Tooltip.Trigger>
            <Tooltip.Positioner>
              <Tooltip.Content>
                Peer ID: {peerId}
                <Tooltip.Arrow>
                  <Tooltip.ArrowTip />
                </Tooltip.Arrow>
              </Tooltip.Content>
            </Tooltip.Positioner>
          </Tooltip.Root>

          <button
            type="button"
            className="btn-plain"
            onClick={() => setAboutOpen(true)}
            style={{ height: "auto", padding: "4px" }}
          >
            <Info size={16} />
          </button>
        </div>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <p className="empty-state">
            No messages yet. Say something — open another tab to see sync.
          </p>
        )}
        {messages.map(msg => {
          const isOwn = msg.author === peerId
          return (
            <div
              key={`${msg.author}-${msg.timestamp}`}
              className={`message ${isOwn ? "message--own" : ""}`}
            >
              <span className="message-author">
                {isOwn ? "you" : msg.author.slice(0, 8)}
              </span>
              <span className="message-content">{msg.content}</span>
            </div>
          )
        })}
      </div>

      <form
        className="input-bar"
        onSubmit={e => {
          e.preventDefault()
          const form = e.currentTarget
          const input = form.elements.namedItem("content") as HTMLInputElement
          const text = input.value.trim()
          if (!text) return
          sendMessage(text)
          form.reset()
        }}
      >
        <input
          name="content"
          type="text"
          placeholder="Type a message..."
          autoComplete="off"
        />
        <button type="submit" className="btn-solid">
          <Send size={16} />
        </button>
      </form>

      {/* ── About dialog ──────────────────────────────────────────────── */}

      <Dialog.Root open={aboutOpen} onOpenChange={e => setAboutOpen(e.open)}>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Title>About Encrafte</Dialog.Title>
            <Dialog.Description>
              A multiplayer collaborative tool for building software — forkable
              conversations, an inventory of context, and a canvas of live
              artefacts.
            </Dialog.Description>
            <div style={{ marginTop: "16px" }}>
              <p
                style={{
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-fg-muted)",
                  lineHeight: 1.6,
                }}
              >
                Built with kyneta Exchange for real-time CRDT sync, Ark UI for
                accessible components, and OpenRouter for AI integration.
              </p>
            </div>
            <Dialog.CloseTrigger>
              <X size={16} />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </div>
  )
}
