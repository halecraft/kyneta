// tui — terminal UI rendering and input.
//
// Pure render function + imperative input handler. No framework dependency.
// Raw ANSI escape codes for a 6-row config editor with header and footer.

import type { Field, StringField } from "./fields.js"

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const INVERSE = "\x1b[7m"
const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const WHITE = "\x1b[37m"

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface PeerInfo {
  peerIds: string[]
  role: "listener" | "connector" | "negotiating" | "disposed"
}

export function render(
  fields: Field[],
  values: Record<string, unknown>,
  selectedIndex: number,
  peerInfo: PeerInfo,
): string {
  const lines: string[] = []

  // Header
  const roleTag = peerInfo.role === "listener" ? `${DIM}(listening)${RESET}`
    : peerInfo.role === "connector" ? `${DIM}(connected)${RESET}`
    : `${DIM}(negotiating...)${RESET}`
  lines.push(`${BOLD}${CYAN}  ╭─── unix-socket-sync ───╮${RESET}  ${roleTag}`)
  lines.push(`${CYAN}  │${RESET}                         ${CYAN}│${RESET}`)

  // Fields
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const value = values[field.key]
    const selected = i === selectedIndex
    const prefix = selected ? `${INVERSE}` : ""
    const suffix = selected ? `${RESET}` : ""

    const label = field.label.padEnd(14)
    const display = formatValue(field, value)

    lines.push(`${CYAN}  │${RESET} ${prefix}  ${label} ${display.padEnd(8)}${suffix}  ${CYAN}│${RESET}`)
  }

  // Footer
  lines.push(`${CYAN}  │${RESET}                         ${CYAN}│${RESET}`)
  const peerCount = peerInfo.peerIds.length
  const peerLabel = peerCount === 1 ? "1 peer" : `${peerCount} peers`
  const peerNames = peerInfo.peerIds.length > 0
    ? peerInfo.peerIds.join(", ")
    : "none"
  lines.push(`${CYAN}  ╰─────────────────────────╯${RESET}`)
  lines.push(`${DIM}  ${peerLabel}: ${peerNames}${RESET}`)
  lines.push("")
  lines.push(`${DIM}  ↑↓/jk navigate  ←→/hl change  q quit${RESET}`)

  return "\x1b[2J\x1b[H" + lines.join("\n")
}

function formatValue(field: Field, value: unknown): string {
  switch (field.type) {
    case "boolean":
      return value ? `${GREEN}● on${RESET}` : `${DIM}○ off${RESET}`
    case "string":
      return `${YELLOW}${String(value || (field as StringField).options[0])}${RESET}`
    case "number":
      return `${WHITE}${String(value ?? 0)}${RESET}`
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type Action = "up" | "down" | "left" | "right" | "quit"

export function startInput(onAction: (action: Action) => void): () => void {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")

  const handler = (key: string) => {
    // Ctrl-C
    if (key === "\x03") { onAction("quit"); return }
    // Escape
    if (key === "\x1b") { onAction("quit"); return }
    // q
    if (key === "q") { onAction("quit"); return }
    // Arrow keys (escape sequences)
    if (key === "\x1b[A" || key === "k") { onAction("up"); return }
    if (key === "\x1b[B" || key === "j") { onAction("down"); return }
    if (key === "\x1b[D" || key === "h") { onAction("left"); return }
    if (key === "\x1b[C" || key === "l") { onAction("right"); return }
    // Enter / Space
    if (key === "\r" || key === " ") { onAction("right"); return }
  }

  process.stdin.on("data", handler)

  return () => {
    process.stdin.off("data", handler)
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}