// tui — terminal UI rendering and input.
//
// Pure render function + imperative input handler. No framework dependency.
// Composable box-drawing primitives with dynamic width calculation.

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

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

/** Visible character width of a string, ignoring ANSI escape sequences. */
function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length
}

/** Pad `s` on the right with spaces to reach `width` visible characters. */
function padVisible(s: string, width: number): string {
  const deficit = width - visibleWidth(s)
  return deficit > 0 ? s + " ".repeat(deficit) : s
}

// ---------------------------------------------------------------------------
// Box primitives
// ---------------------------------------------------------------------------

function boxTop(title: string, innerWidth: number): string {
  // ╭─── title ───╮
  // We want at least 3 ─ on each side of the title.
  const titleText = ` ${title} `
  const remaining = innerWidth - titleText.length
  const left = Math.max(3, Math.floor(remaining / 2))
  const right = Math.max(3, remaining - left)
  return `${CYAN}╭${"─".repeat(left)}${titleText}${"─".repeat(right)}╮${RESET}`
}

function boxBottom(innerWidth: number): string {
  return `${CYAN}╰${"─".repeat(innerWidth)}╯${RESET}`
}

/** Wrap visible content inside box walls, padded to `innerWidth`. */
function boxLine(content: string, innerWidth: number): string {
  return `${CYAN}│${RESET}${padVisible(content, innerWidth)}${CYAN}│${RESET}`
}

function boxEmpty(innerWidth: number): string {
  return boxLine(" ".repeat(innerWidth), innerWidth)
}

// ---------------------------------------------------------------------------
// Field formatting
// ---------------------------------------------------------------------------

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

/** Format a single field row's content (no box chrome). */
function formatField(
  field: Field,
  value: unknown,
  selected: boolean,
  labelWidth: number,
): string {
  const label = padVisible(field.label, labelWidth)
  const display = formatValue(field, value)
  const content = `  ${label}  ${display}`
  if (selected) return `${INVERSE}${content}${RESET}`
  return content
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface PeerInfo {
  peerIds: string[]
  role: "listener" | "connector" | "negotiating" | "disposed"
}

const TITLE = "unix-socket-sync"
const PAD = 2 // horizontal padding inside box walls
const MIN_INNER = 20

export function render(
  fields: Field[],
  values: Record<string, unknown>,
  selectedIndex: number,
  peerInfo: PeerInfo,
): string {
  const labelWidth = Math.max(...fields.map((f) => f.label.length))

  // Pre-format all field rows to measure their widths.
  const fieldRows = fields.map((field, i) =>
    formatField(field, values[field.key], i === selectedIndex, labelWidth),
  )

  // Inner width = max visible content width + padding on each side.
  const maxContentWidth = Math.max(...fieldRows.map(visibleWidth))
  const innerWidth = Math.max(
    MIN_INNER,
    maxContentWidth + PAD * 2,
    TITLE.length + 8, // room for ─── on each side of the title
  )

  // Role tag (displayed outside the box, after the top border).
  const roleTag = peerInfo.role === "listener" ? `${DIM}(listening)${RESET}`
    : peerInfo.role === "connector" ? `${DIM}(connected)${RESET}`
    : `${DIM}(negotiating...)${RESET}`

  // Peer info (displayed below the box).
  const peerCount = peerInfo.peerIds.length
  const peerLabel = peerCount === 1 ? "1 peer" : `${peerCount} peers`
  const peerNames = peerInfo.peerIds.length > 0
    ? peerInfo.peerIds.join(", ")
    : "none"

  // Compose.
  const lines = [
    `${BOLD}${boxTop(TITLE, innerWidth)}  ${roleTag}`,
    boxEmpty(innerWidth),
    ...fieldRows.map((row) =>
      boxLine(padVisible(` ${row} `, innerWidth), innerWidth),
    ),
    boxEmpty(innerWidth),
    boxBottom(innerWidth),
    `${DIM}${peerLabel}: ${peerNames}${RESET}`,
    "",
    `${DIM}↑↓/jk navigate  ←→/hl change  q quit${RESET}`,
  ]

  return "\x1b[2J\x1b[H" + lines.join("\n")
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