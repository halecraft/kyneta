// ═══════════════════════════════════════════════════════════════════════════
//
//   Encrafte — App
//
//   Minimal chat interface proving Exchange sync works.
//   Renders a message list from a Loro-backed ThreadDoc and a text
//   input form that appends messages. Open two tabs to see sync.
//
// ═══════════════════════════════════════════════════════════════════════════

import { persistentPeerId } from "@kyneta/exchange"
import { useDocument, useValue } from "@kyneta/react"
import { ThreadDoc } from "./schema.js"

const peerId = persistentPeerId("encrafte-peer-id")

export function App() {
  const doc = useDocument("thread:main", ThreadDoc)
  const { messages } = useValue(doc)

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
        <span className="peer-id" title={peerId}>
          {peerId.slice(0, 8)}
        </span>
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
        <button type="submit">Send</button>
      </form>
    </div>
  )
}
