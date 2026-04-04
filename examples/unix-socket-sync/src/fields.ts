// fields — typed field metadata for config values.
//
// Drives both TUI rendering and input handling. Each field has a key
// (matching the schema), a label, a type, and type-specific config.
// Pure step functions compute the next value given a direction.

// ---------------------------------------------------------------------------
// Field descriptor types
// ---------------------------------------------------------------------------

export type BooleanField = {
  key: string
  label: string
  type: "boolean"
}

export type StringField = {
  key: string
  label: string
  type: "string"
  options: string[]
}

export type NumberField = {
  key: string
  label: string
  type: "number"
  step: number
  min: number
  max: number
}

export type Field = BooleanField | StringField | NumberField

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

export const fields: Field[] = [
  { key: "darkMode", label: "Dark Mode", type: "boolean" },
  { key: "logLevel", label: "Log Level", type: "string", options: ["debug", "info", "warn", "error"] },
  { key: "region", label: "Region", type: "string", options: ["us-east", "eu-west", "ap-south"] },
  { key: "maintenance", label: "Maintenance", type: "boolean" },
  { key: "maxRequests", label: "Max Requests", type: "number", step: 100, min: 0, max: 10000 },
  { key: "rateLimit", label: "Rate Limit", type: "number", step: 10, min: 0, max: 1000 },
]

// ---------------------------------------------------------------------------
// Pure step functions
// ---------------------------------------------------------------------------

export type Direction = "left" | "right"

export function stepBoolean(_current: boolean, _direction: Direction): boolean {
  return !_current
}

export function stepString(current: string, options: string[], direction: Direction): string {
  const idx = options.indexOf(current)
  if (idx === -1) return options[0]
  if (direction === "right") {
    return options[(idx + 1) % options.length]
  }
  return options[(idx - 1 + options.length) % options.length]
}

export function stepNumber(current: number, step: number, min: number, max: number, direction: Direction): number {
  if (direction === "right") {
    return Math.min(current + step, max)
  }
  return Math.max(current - step, min)
}