// use-doc-status / use-initialize / use-doc-ready.
//
// The transportless case is the one worth having here: before `ready` gained
// its offline carve-out, a local-only app gating render on `useDocReady`
// showed a spinner that never went away. That regression is now a test.

import { Exchange } from "@kyneta/exchange"
import { json, Schema } from "@kyneta/schema"
import { act, cleanup, render, screen } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { useDocReady } from "../use-doc-ready.js"
import { useDocStatus } from "../use-doc-status.js"
import { useInitialize } from "../use-initialize.js"

const TestDoc = json.bind(
  Schema.struct({ title: Schema.string(), count: Schema.number() }),
)

afterEach(cleanup)

describe("useDocStatus", () => {
  it("reports empty for a transportless, storeless document", () => {
    const exchange = new Exchange({ id: "test" })
    const doc = exchange.get("doc-1", TestDoc)

    function Probe() {
      return <span data-testid="s">{useDocStatus(doc)}</span>
    }
    render(<Probe />)

    expect(screen.getByTestId("s").textContent).toBe("empty")
    exchange.reset()
  })

  it("moves to populated when data arrives", async () => {
    const exchange = new Exchange({ id: "test", authority: "self" })
    const doc = exchange.get("doc-1", TestDoc)

    function Probe() {
      return <span data-testid="s">{useDocStatus(doc)}</span>
    }
    render(<Probe />)
    expect(screen.getByTestId("s").textContent).toBe("empty")

    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
      doc.title.set("hello")
    })

    expect(screen.getByTestId("s").textContent).toBe("populated")
    exchange.reset()
  })
})

describe("useInitialize", () => {
  it("seeds once even under StrictMode's double mount", async () => {
    // StrictMode deliberately invokes effects twice in development. The
    // per-document promise cache in `initialize` is what makes that harmless;
    // without it, the defaults would be written twice.
    const exchange = new Exchange({ id: "test", authority: "self" })
    const doc = exchange.get("doc-1", TestDoc)

    let writes = 0
    function Probe() {
      const status = useInitialize(doc, (d: never) => {
        writes++
        ;(d as { title: { set(v: string): void } }).title.set("Untitled")
      })
      return <span data-testid="s">{status}</span>
    }

    await act(async () => {
      render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      )
      await new Promise(r => setTimeout(r, 10))
    })

    expect(writes).toBe(1)
    expect(doc.title()).toBe("Untitled")
    exchange.reset()
  })
})

describe("useDocReady", () => {
  it("is true on a transportless exchange", () => {
    // The permanent-spinner regression: `ready` used to stay false forever
    // with no transports, because nothing could ever reconcile.
    const exchange = new Exchange({ id: "test" })
    const doc = exchange.get("doc-1", TestDoc)

    function Probe() {
      return <span data-testid="r">{String(useDocReady(doc))}</span>
    }
    render(<Probe />)

    expect(screen.getByTestId("r").textContent).toBe("true")
    exchange.reset()
  })
})
