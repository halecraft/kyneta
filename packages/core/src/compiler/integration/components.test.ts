/**
 * Component compilation integration tests.
 * Tests component factories, event handler threading, SSR, and scope disposal.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  compileAndExecuteComponent,
  compileInPlace,
  COMPONENT_PREAMBLE,
  dom,
  installDOMGlobals,
  resetTestState,
  Scope,
} from "./helpers.js"

installDOMGlobals()

describe("Component compilation", () => {
  beforeEach(() => {
    resetTestState()
  })

  it("should compile and execute a basic component", () => {
    const source = `
      ${COMPONENT_PREAMBLE}

      const Greeting: ComponentFactory<{ text: string }> = (props) => {
        return div(() => {
          h1(props.text)
        })
      }

      section(() => {
        Greeting({ text: "Hello from component" })
      })
    `

    const { node, scope } = compileAndExecuteComponent(source)

    expect(node).toBeInstanceOf(dom.window.Element)
    const el = node as HTMLElement
    expect(el.tagName.toLowerCase()).toBe("section")
    expect(el.children.length).toBe(1)
    expect(el.children[0].tagName.toLowerCase()).toBe("div")
    const innerH1 = el.children[0].children[0]
    expect(innerH1.tagName.toLowerCase()).toBe("h1")
    expect(innerH1.textContent).toBe("Hello from component")

    scope.dispose()
  })

  it("should thread event handler props through to component DOM", () => {
    const source = `
      ${COMPONENT_PREAMBLE}

      const ClickButton: ComponentFactory<{ label: string; onClick: (e: MouseEvent) => void }> = (props) => {
        return button({ onClick: props.onClick }, () => {
          h1(props.label)
        })
      }

      div(() => {
        ClickButton({ label: "Press me", onClick: handleClick })
      })
    `

    // Provide handleClick in eval scope
    let clicked = false
    ;(globalThis as any).handleClick = () => { clicked = true }

    const { node, scope } = compileAndExecuteComponent(source)

    const btn = (node as HTMLElement).querySelector("button")
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toBe("Press me")

    btn!.click()
    expect(clicked).toBe(true)

    delete (globalThis as any).handleClick
    scope.dispose()
  })

  it("should thread onKeyDown handler prop to input inside component", () => {
    const source = `
      ${COMPONENT_PREAMBLE}

      const SearchBox: ComponentFactory<{ onKeyDown: (e: KeyboardEvent) => void }> = (props) => {
        return div(() => {
          input({ type: "text", onKeyDown: props.onKeyDown })
        })
      }

      section(() => {
        SearchBox({ onKeyDown: handleKeyDown })
      })
    `

    let keyPressed = ""
    ;(globalThis as any).handleKeyDown = (e: any) => { keyPressed = e.key }

    const { node, scope } = compileAndExecuteComponent(source)

    const inputEl = (node as HTMLElement).querySelector("input")
    expect(inputEl).not.toBeNull()

    // Simulate keydown event
    const event = new dom.window.KeyboardEvent("keydown", { key: "Enter" })
    inputEl!.dispatchEvent(event)
    expect(keyPressed).toBe("Enter")

    delete (globalThis as any).handleKeyDown
    scope.dispose()
  })

  it("should render multiple components inside a static for loop", () => {
    const source = `
      ${COMPONENT_PREAMBLE}

      const Item: ComponentFactory<{ text: string }> = (props) => {
        return li(() => {
          span(props.text)
        })
      }

      ul(() => {
        Item({ text: "Alice" })
        Item({ text: "Bob" })
        Item({ text: "Carol" })
      })
    `

    const { node, scope } = compileAndExecuteComponent(source)

    const el = node as HTMLElement
    expect(el.tagName.toLowerCase()).toBe("ul")
    expect(el.children.length).toBe(3)
    expect(el.children[0].textContent).toBe("Alice")
    expect(el.children[1].textContent).toBe("Bob")
    expect(el.children[2].textContent).toBe("Carol")

    scope.dispose()
  })

  it("should dispose component child scopes when parent is disposed", () => {
    const source = `
      ${COMPONENT_PREAMBLE}

      const Child: ComponentFactory = () => {
        return div(() => {
          span("child")
        })
      }

      section(() => {
        Child()
      })
    `

    const { node, scope } = compileAndExecuteComponent(source)

    // The component creates a child scope via scope.createChild()
    expect(scope.childCount).toBe(1)

    scope.dispose()

    // After disposing parent, the child scope should also be disposed
    expect(scope.disposed).toBe(true)
  })

  it("should compile expression-body arrow components", () => {
    const source = `
      ${COMPONENT_PREAMBLE}

      const Tag: ComponentFactory<{ label: string }> = (props) =>
        div(() => {
          span(props.label)
        })

      section(() => {
        Tag({ label: "expression body" })
      })
    `

    const { node, scope } = compileAndExecuteComponent(source)

    const el = node as HTMLElement
    expect(el.tagName.toLowerCase()).toBe("section")
    const innerDiv = el.children[0]
    expect(innerDiv.tagName.toLowerCase()).toBe("div")
    expect(innerDiv.children[0].tagName.toLowerCase()).toBe("span")
    expect(innerDiv.children[0].textContent).toBe("expression body")

    scope.dispose()
  })

  it("should compile component to HTML without emitting component tags (SSR)", () => {
    const source = `
      ${COMPONENT_PREAMBLE}

      const Badge: ComponentFactory<{ label: string }> = (props) => {
        return div(() => {
          span(props.label)
        })
      }

      section(() => {
        Badge({ label: "info" })
      })
    `

    const js = compileInPlace(source, "html")

    // The compiled SSR code should call Badge(props)(), not emit <Badge>
    expect(js).toContain("Badge(")
    expect(js).toContain("()")
    expect(js).not.toContain("<Badge")
    expect(js).not.toContain("</Badge>")
    // The component's own body should produce <div> and <span>
    expect(js).toContain("<div>")
    expect(js).toContain("<span>")
  })

  it("should produce correct HTML when SSR render function is executed", () => {
    const source = `
      ${COMPONENT_PREAMBLE}

      const Pill: ComponentFactory<{ text: string }> = (props) => {
        return div(() => {
          span(props.text)
        })
      }

      const __lastRender = section(() => {
        Pill({ text: "active" })
      })
    `

    const js = compileInPlace(source, "html")

    // Use new Function to execute the compiled code and return __lastRender.
    // The HTML codegen needs __escapeHtml which it defines in the compiled
    // output, so no runtime deps needed beyond what's in the JS itself.
    const body = `${js}\nreturn __lastRender;`
    const fn = new Function(body)
    const renderFn = fn() as () => string
    const html = renderFn()

    // Should contain the component's rendered HTML, not component tags
    expect(html).toContain("<section>")
    expect(html).toContain("<div>")
    expect(html).toContain("<span>")
    expect(html).toContain("active")
    expect(html).toContain("</span>")
    expect(html).toContain("</div>")
    expect(html).toContain("</section>")
    expect(html).not.toContain("<Pill")
    expect(html).not.toContain("</Pill>")
  })
})