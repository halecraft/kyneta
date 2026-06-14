// use-document.test.tsx — Tier 2 React integration tests.
//
// Proves useDocument retrieves a ref from the Exchange via context,
// and that repeated calls with the same docId + BoundSchema return
// the same ref identity.

import { Exchange } from "@kyneta/exchange"
import type { PlainState } from "@kyneta/schema"
import { json, Schema, unwrap } from "@kyneta/schema"
import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { ExchangeProvider } from "../exchange-context.js"
import { useDocument } from "../use-document.js"

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const TestSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})

const TestDoc = json.bind(TestSchema)

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function createWrapper() {
  const exchange = new Exchange({ id: "test" })
  return ({ children }: { children: ReactNode }) => (
    <ExchangeProvider exchange={exchange}>{children}</ExchangeProvider>
  )
}

// ---------------------------------------------------------------------------
// useDocument
// ---------------------------------------------------------------------------

describe("useDocument", () => {
  it("returns a callable ref", () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useDocument("test-doc", TestDoc), {
      wrapper,
    })
    expect(typeof result.current).toBe("function")
  })

  it("ref returns initial plain value", () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useDocument("test-doc-2", TestDoc), {
      wrapper,
    })
    const value = result.current()
    expect(value).toEqual({ title: "", count: 0 })
  })

  it("returns the same ref identity on re-render", () => {
    const wrapper = createWrapper()
    const { result, rerender } = renderHook(
      () => useDocument("stable-doc", TestDoc),
      { wrapper },
    )

    const first = result.current
    rerender()
    const second = result.current

    expect(first).toBe(second)
  })

  it("unwrap(doc) is precisely typed as the root native (PlainState)", () => {
    const wrapper = createWrapper()
    const { result } = renderHook(() => useDocument("native-doc", TestDoc), {
      wrapper,
    })

    // The native map threads through useDocument → DocRef, so unwrap(doc)
    // is exactly PlainState (json.bind's root native) — not `unknown`, and
    // with no narrowing required. This assignment is the type assertion.
    const native: PlainState = unwrap(result.current)
    expect(native).toBeDefined()
  })
})
