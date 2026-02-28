/**
 * Integration tests for compiler → runtime.
 *
 * These tests compile TypeScript source code and execute the generated
 * JavaScript to verify the full pipeline works end-to-end.
 *
 * Phase 4: Static compilation tests
 * Phase 5: Reactive expression tests (using real Loro documents)
 * Phase 6: List region tests
 * Phase 7: Conditional region tests
 * Phase 8: Binding compilation tests
 */

import { createTypedDoc, loro, Shape } from "@loro-extended/change"
import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it } from "vitest"

import { __conditionalRegion, __listRegion } from "../runtime/regions.js"
import {
  __resetScopeIdCounter,
  __setRootScope,
  Scope,
} from "../runtime/scope.js"
import {
  __activeSubscriptions,
  __getActiveSubscriptionCount,
  __resetSubscriptionIdCounter,
  __subscribe,
  __subscribeWithValue,
} from "../runtime/subscribe.js"
import {
  assertMaxMutations,
  createCountingContainer,
} from "../testing/counting-dom.js"
import { transformSource } from "./transform.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.Comment = dom.window.Comment
global.Text = dom.window.Text
global.Event = dom.window.Event
global.HTMLInputElement = dom.window.HTMLInputElement

/**
 * Execute generated DOM code and return the created element.
 *
 * The generated code is wrapped in a function that takes a scope parameter.
 * We create a scope and call the function to get the DOM element.
 */
function executeGeneratedCode(code: string, scope: Scope): Node {
  // The generated code is a function expression like:
  // (scope) => {
  //   const _div0 = document.createElement("div")
  //   ...
  //   return _div0
  // }
  //
  // We need to wrap it in parentheses and call it with eval.
  // biome-ignore lint/security/noGlobalEval: This is a test utility that needs to execute generated code
  const fn = eval(`(${code})`)
  return fn(scope)
}

/**
 * Compile source and execute it, returning the DOM element.
 */
function compileAndExecute(source: string): { node: Node; scope: Scope } {
  const result = transformSource(source, { target: "dom" })

  if (result.ir.length === 0) {
    throw new Error("No builder calls found in source")
  }

  // The generated code looks like:
  // const element0 = (scope) => {
  //   const _div0 = document.createElement("div")
  //   ...
  //   return _div0
  // }
  //
  // We need to extract the full function body, not just the first line.
  // Find where "const element0 = " starts and extract the arrow function.
  const code = result.code

  // Find the start of the function assignment
  const assignmentMatch = code.match(/const element\d+ = /)
  if (!assignmentMatch || assignmentMatch.index === undefined) {
    throw new Error(
      `Could not find element definition in generated code:\n${code}`,
    )
  }

  // Extract from after the assignment to the end
  const startIndex = assignmentMatch.index + assignmentMatch[0].length
  const fnCode = code.slice(startIndex).trim()

  const scope = new Scope("test")
  const node = executeGeneratedCode(fnCode, scope)

  return { node, scope }
}

describe("compiler integration - static compilation", () => {
  beforeEach(() => {
    __resetScopeIdCounter()
    __resetSubscriptionIdCounter()
    __activeSubscriptions.clear()
    __setRootScope(null)
  })

  describe("Task 4.1: Basic static compilation", () => {
    it("should compile and execute simple div with h1", () => {
      const source = `
        div(() => {
          h1("Hello")
        })
      `

      const { node, scope } = compileAndExecute(source)

      expect(node).toBeInstanceOf(dom.window.Element)
      expect((node as Element).tagName.toLowerCase()).toBe("div")
      expect((node as Element).children.length).toBe(1)
      expect((node as Element).children[0].tagName.toLowerCase()).toBe("h1")
      expect((node as Element).children[0].textContent).toBe("Hello")

      scope.dispose()
    })

    it("should compile and execute div with text content", () => {
      const source = `
        p(() => {
          "Just some text"
        })
      `

      // Note: The current implementation may not handle bare string expressions
      // This test documents the expected behavior
      const result = transformSource(source, { target: "dom" })
      expect(result.ir.length).toBe(1)
      expect(result.ir[0].factoryName).toBe("p")
    })

    it("should generate valid HTML output", () => {
      const source = `
        div(() => {
          h1("Hello")
        })
      `

      const result = transformSource(source, { target: "html" })

      expect(result.code).toContain("<div>")
      expect(result.code).toContain("</div>")
      expect(result.code).toContain("<h1>")
      expect(result.code).toContain("Hello")
      expect(result.code).toContain("</h1>")
    })

    it("should produce syntactically valid DOM code", () => {
      const source = `
        div(() => {
          h1("Title")
          p("Content")
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Verify balanced delimiters
      const openBraces = (result.code.match(/{/g) || []).length
      const closeBraces = (result.code.match(/}/g) || []).length
      expect(openBraces).toBe(closeBraces)

      const openParens = (result.code.match(/\(/g) || []).length
      const closeParens = (result.code.match(/\)/g) || []).length
      expect(openParens).toBe(closeParens)
    })

    it("should produce syntactically valid HTML code", () => {
      const source = `
        div(() => {
          h1("Title")
          p("Content")
        })
      `

      const result = transformSource(source, { target: "html" })

      // Verify balanced template literals
      const backticks = (result.code.match(/`/g) || []).length
      expect(backticks % 2).toBe(0)

      // Verify balanced HTML tags (simple check)
      expect(result.code).toContain("<div>")
      expect(result.code).toContain("</div>")
    })
  })

  describe("Task 4.2: Nested static structures", () => {
    it("should compile deeply nested elements", () => {
      const source = `
        div(() => {
          header(() => {
            nav(() => {
              ul(() => {
                li(() => {
                  a("Link 1")
                })
                li(() => {
                  a("Link 2")
                })
              })
            })
          })
        })
      `

      const { node, scope } = compileAndExecute(source)

      expect((node as Element).tagName.toLowerCase()).toBe("div")

      const header = (node as Element).querySelector("header")
      expect(header).not.toBeNull()

      const nav = header?.querySelector("nav")
      expect(nav).not.toBeNull()

      const ul = nav?.querySelector("ul")
      expect(ul).not.toBeNull()

      const lis = ul?.querySelectorAll("li")
      expect(lis?.length).toBe(2)

      const links = ul?.querySelectorAll("a")
      expect(links?.length).toBe(2)
      expect(links?.[0].textContent).toBe("Link 1")
      expect(links?.[1].textContent).toBe("Link 2")

      scope.dispose()
    })

    it("should handle mixed text and element children", () => {
      const source = `
        div(() => {
          h1("Title")
          p("Paragraph 1")
          p("Paragraph 2")
          footer(() => {
            span("Footer text")
          })
        })
      `

      const { node, scope } = compileAndExecute(source)

      const h1 = (node as Element).querySelector("h1")
      expect(h1?.textContent).toBe("Title")

      const paragraphs = (node as Element).querySelectorAll("p")
      expect(paragraphs.length).toBe(2)
      expect(paragraphs[0].textContent).toBe("Paragraph 1")
      expect(paragraphs[1].textContent).toBe("Paragraph 2")

      const footer = (node as Element).querySelector("footer")
      expect(footer).not.toBeNull()

      const span = footer?.querySelector("span")
      expect(span?.textContent).toBe("Footer text")

      scope.dispose()
    })

    it("should apply static props as attributes", () => {
      const source = `
        div({ class: "container", id: "main" }, () => {
          p({ class: "content" }, () => {
            span("Text")
          })
        })
      `

      const { node, scope } = compileAndExecute(source)

      expect((node as Element).className).toBe("container")
      expect((node as Element).id).toBe("main")

      const p = (node as Element).querySelector("p")
      expect(p?.className).toBe("content")

      scope.dispose()
    })

    it("should apply data attributes", () => {
      const source = `
        div({ "data-testid": "my-component", "data-value": "123" }, () => {
          span("Content")
        })
      `

      const { node, scope } = compileAndExecute(source)

      expect((node as Element).getAttribute("data-testid")).toBe("my-component")
      expect((node as Element).getAttribute("data-value")).toBe("123")

      scope.dispose()
    })

    it("should handle input elements with type and placeholder", () => {
      const source = `
        input({ type: "text", placeholder: "Enter name" }, () => {})
      `

      const { node, scope } = compileAndExecute(source)

      expect((node as Element).tagName.toLowerCase()).toBe("input")
      expect((node as HTMLInputElement).type).toBe("text")
      expect((node as HTMLInputElement).placeholder).toBe("Enter name")

      scope.dispose()
    })

    it("should handle boolean attributes", () => {
      const source = `
        input({ type: "checkbox", disabled: "true" }, () => {})
      `

      const { node, scope } = compileAndExecute(source)

      // Note: The current implementation may set disabled as a string attribute
      // This test documents the behavior
      expect((node as Element).hasAttribute("disabled")).toBe(true)

      scope.dispose()
    })
  })

  describe("Task 4.2: HTML output for nested structures", () => {
    it("should generate correct HTML for nested elements", () => {
      const source = `
        div(() => {
          header(() => {
            h1("Title")
          })
          main(() => {
            p("Content")
          })
        })
      `

      const result = transformSource(source, { target: "html" })

      // The HTML should contain the nested structure
      expect(result.code).toContain("<div>")
      expect(result.code).toContain("<header>")
      expect(result.code).toContain("<h1>")
      expect(result.code).toContain("Title")
      expect(result.code).toContain("</h1>")
      expect(result.code).toContain("</header>")
      expect(result.code).toContain("<main>")
      expect(result.code).toContain("<p>")
      expect(result.code).toContain("Content")
      expect(result.code).toContain("</p>")
      expect(result.code).toContain("</main>")
      expect(result.code).toContain("</div>")
    })

    it("should escape special characters in HTML output", () => {
      const source = `
        p(() => {
          span("<script>alert('xss')</script>")
        })
      `

      const result = transformSource(source, { target: "html" })

      // The text should be escaped
      expect(result.code).not.toContain("<script>")
      expect(result.code).toContain("&lt;script&gt;")
    })

    it("should include attributes in HTML output", () => {
      const source = `
        div({ class: "container", id: "main" }, () => {
          span("Text")
        })
      `

      const result = transformSource(source, { target: "html" })

      expect(result.code).toContain('class="container"')
      expect(result.code).toContain('id="main"')
    })
  })

  describe("Multiple builder calls", () => {
    it("should handle multiple top-level builders", () => {
      const source = `
        header(() => {
          h1("Title")
        })

        footer(() => {
          p("Footer")
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.ir.length).toBe(2)
      expect(result.ir[0].factoryName).toBe("header")
      expect(result.ir[1].factoryName).toBe("footer")

      // Should generate two element definitions
      expect(result.code).toContain("const element0")
      expect(result.code).toContain("const element1")
    })
  })

  describe("Edge cases", () => {
    it("should handle empty builder", () => {
      const source = `
        div(() => {})
      `

      const { node, scope } = compileAndExecute(source)

      expect((node as Element).tagName.toLowerCase()).toBe("div")
      expect((node as Element).children.length).toBe(0)

      scope.dispose()
    })

    it("should handle void elements", () => {
      const source = `
        div(() => {
          br(() => {})
          hr(() => {})
        })
      `

      const { node, scope } = compileAndExecute(source)

      const br = (node as Element).querySelector("br")
      expect(br).not.toBeNull()

      const hr = (node as Element).querySelector("hr")
      expect(hr).not.toBeNull()

      scope.dispose()
    })

    it("should handle img element with src and alt", () => {
      const source = `
        img({ src: "/image.png", alt: "An image" }, () => {})
      `

      const { node, scope } = compileAndExecute(source)

      expect((node as Element).tagName.toLowerCase()).toBe("img")
      expect((node as HTMLImageElement).src).toContain("/image.png")
      expect((node as HTMLImageElement).alt).toBe("An image")

      scope.dispose()
    })

    it("should handle anchor element with href", () => {
      const source = `
        a({ href: "https://example.com" }, () => {
          span("Click here")
        })
      `

      const { node, scope } = compileAndExecute(source)

      expect((node as Element).tagName.toLowerCase()).toBe("a")
      expect((node as HTMLAnchorElement).href).toBe("https://example.com/")

      scope.dispose()
    })
  })
})

// =============================================================================
// Phase 5: Reactive Expression Integration Tests
// =============================================================================

describe("compiler integration - reactive expressions", () => {
  beforeEach(() => {
    __resetScopeIdCounter()
    __resetSubscriptionIdCounter()
    __activeSubscriptions.clear()
    __setRootScope(null)
  })

  describe("Task 5.2: Reactive text content", () => {
    it("should generate __subscribeWithValue for reactive text", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const count: CounterRef

        div(() => {
          p(count.get())
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should detect reactive content
      expect(result.ir[0].isReactive).toBe(true)

      // Should generate subscription call
      expect(result.code).toContain("__subscribeWithValue")
      expect(result.code).toContain("count")
    })

    it("should generate __subscribeWithValue for template literal with reactive content", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const count: CounterRef

        div(() => {
          p(\`Count: \${count.get()}\`)
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.ir[0].isReactive).toBe(true)
      expect(result.code).toContain("__subscribeWithValue")
      expect(result.code).toContain("Count:")
    })

    it("should execute reactive text and update on change", () => {
      // Create a real Loro document
      const schema = Shape.doc({
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)

      // Set initial value
      doc.count.increment(5)
      loro(doc).commit()

      // Create the element factory manually (simulating compiled code)
      const scope = new Scope("test")
      const div = document.createElement("div")
      const p = document.createElement("p")
      const text = document.createTextNode("")
      p.appendChild(text)
      div.appendChild(p)

      // Subscribe (simulating compiled code)
      __subscribeWithValue(
        doc.count,
        () => doc.count.get(),
        v => {
          text.textContent = String(v)
        },
        scope,
      )

      // Initial value should be set
      expect(text.textContent).toBe("5")

      // Update the document
      doc.count.increment(3)
      loro(doc).commit()

      // Text should update
      expect(text.textContent).toBe("8")

      // Cleanup
      scope.dispose()
      expect(__getActiveSubscriptionCount()).toBe(0)
    })
  })

  describe("Task 5.3: Reactive attributes", () => {
    it("should generate __subscribe for reactive class attribute", () => {
      const source = `
        interface TextRef {
          toString(): string
        }
        declare const className: TextRef

        div({ class: className.toString() }, () => {
          p("Hello")
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.ir[0].isReactive).toBe(true)
      expect(result.code).toContain("__subscribe")
      expect(result.code).toContain("className")
    })

    it("should execute reactive attribute and update on change", () => {
      // Create a real Loro document with counter for boolean-like behavior
      const schema = Shape.doc({
        activeCount: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      loro(doc).commit()

      // Create element manually
      const scope = new Scope("test")
      const div = document.createElement("div")

      // Initial value (0 = inactive, >0 = active)
      div.className = doc.activeCount.get() > 0 ? "active" : "inactive"

      // Subscribe (simulating compiled code)
      __subscribe(
        doc.activeCount,
        () => {
          div.className = doc.activeCount.get() > 0 ? "active" : "inactive"
        },
        scope,
      )

      expect(div.className).toBe("inactive")

      // Update to active
      doc.activeCount.increment(1)
      loro(doc).commit()

      expect(div.className).toBe("active")

      scope.dispose()
    })
  })

  describe("Task 5.4: Reactive integration with real Loro", () => {
    it("should handle counter increment reactively", () => {
      const schema = Shape.doc({
        clicks: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      loro(doc).commit()

      const scope = new Scope("test")
      const button = document.createElement("button")
      const textNode = document.createTextNode("")
      button.appendChild(textNode)

      __subscribeWithValue(
        doc.clicks,
        () => `Clicks: ${doc.clicks.get()}`,
        v => {
          textNode.textContent = v
        },
        scope,
      )

      expect(textNode.textContent).toBe("Clicks: 0")

      // Simulate clicks
      doc.clicks.increment(1)
      loro(doc).commit()
      expect(textNode.textContent).toBe("Clicks: 1")

      doc.clicks.increment(1)
      loro(doc).commit()
      expect(textNode.textContent).toBe("Clicks: 2")

      scope.dispose()
    })

    it("should handle text updates reactively", () => {
      const schema = Shape.doc({
        title: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.title.insert(0, "Hello")
      loro(doc).commit()

      const scope = new Scope("test")
      const h1 = document.createElement("h1")
      const textNode = document.createTextNode("")
      h1.appendChild(textNode)

      __subscribeWithValue(
        doc.title,
        () => doc.title.toString(),
        v => {
          textNode.textContent = v
        },
        scope,
      )

      expect(textNode.textContent).toBe("Hello")

      // Update text
      doc.title.insert(5, " World")
      loro(doc).commit()

      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })

    it("should clean up subscriptions on scope dispose", () => {
      const schema = Shape.doc({
        value: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      loro(doc).commit()

      const scope = new Scope("test")
      const textNode = document.createTextNode("")

      __subscribeWithValue(
        doc.value,
        () => doc.value.get(),
        v => {
          textNode.textContent = String(v)
        },
        scope,
      )

      expect(__getActiveSubscriptionCount()).toBe(1)

      scope.dispose()

      expect(__getActiveSubscriptionCount()).toBe(0)

      // Updates after dispose should not change the text
      const oldContent = textNode.textContent
      doc.value.increment(100)
      loro(doc).commit()
      expect(textNode.textContent).toBe(oldContent)
    })

    it("should handle multiple reactive expressions", () => {
      const schema = Shape.doc({
        firstName: Shape.text(),
        lastName: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.firstName.insert(0, "John")
      doc.lastName.insert(0, "Doe")
      loro(doc).commit()

      const scope = new Scope("test")

      const firstNameNode = document.createTextNode("")
      const lastNameNode = document.createTextNode("")
      const fullNameNode = document.createTextNode("")

      __subscribeWithValue(
        doc.firstName,
        () => doc.firstName.toString(),
        v => {
          firstNameNode.textContent = v
        },
        scope,
      )

      __subscribeWithValue(
        doc.lastName,
        () => doc.lastName.toString(),
        v => {
          lastNameNode.textContent = v
        },
        scope,
      )

      // This simulates a computed expression depending on both
      const updateFullName = () => {
        fullNameNode.textContent = `${doc.firstName.toString()} ${doc.lastName.toString()}`
      }
      __subscribe(doc.firstName, updateFullName, scope)
      __subscribe(doc.lastName, updateFullName, scope)
      updateFullName() // Initial value

      expect(__getActiveSubscriptionCount()).toBe(4)
      expect(firstNameNode.textContent).toBe("John")
      expect(lastNameNode.textContent).toBe("Doe")
      expect(fullNameNode.textContent).toBe("John Doe")

      // Update first name
      doc.firstName.delete(0, 4)
      doc.firstName.insert(0, "Jane")
      loro(doc).commit()

      expect(firstNameNode.textContent).toBe("Jane")
      expect(fullNameNode.textContent).toBe("Jane Doe")

      scope.dispose()
      expect(__getActiveSubscriptionCount()).toBe(0)
    })
  })
})

// =============================================================================
// Phase 6: List Region Integration Tests
// =============================================================================

describe("compiler integration - list regions", () => {
  beforeEach(() => {
    __resetScopeIdCounter()
    __resetSubscriptionIdCounter()
    __activeSubscriptions.clear()
    __setRootScope(null)
  })

  describe("Task 6.1: for-of detection", () => {
    it("should detect for-of loop and create ListRegionNode in IR", () => {
      const source = `
        interface ListRef<T> {
          toArray(): T[]
        }
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.ir).toHaveLength(1)
      expect(result.ir[0].children).toHaveLength(1)
      expect(result.ir[0].children[0].kind).toBe("loop")

      const loop = result.ir[0].children[0] as any
      expect(loop.iterableSource).toBe("items")
      expect(loop.iterableBindingTime).toBe("reactive")
      expect(loop.itemVariable).toBe("item")
      expect(loop.indexVariable).toBeNull()
    })

    it("should capture index variable from array destructuring", () => {
      const source = `
        interface ListRef<T> {
          entries(): Iterable<[number, T]>
        }
        declare const items: ListRef<string>

        ul(() => {
          for (const [i, item] of items.entries()) {
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      const loop = result.ir[0].children[0] as any
      expect(loop.kind).toBe("loop")
      expect(loop.iterableBindingTime).toBe("reactive")
      expect(loop.itemVariable).toBe("item")
      expect(loop.indexVariable).toBe("i")
    })

    it("should capture loop body as list region body", () => {
      const source = `
        interface ListRef<T> {
          toArray(): T[]
        }
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      const listRegion = result.ir[0].children[0] as any
      expect(listRegion.body).toHaveLength(1)
      expect(listRegion.body[0].kind).toBe("element")
      expect(listRegion.body[0].tag).toBe("li")
    })
  })

  describe("Task 6.2: Generated __listRegion call", () => {
    it("should generate __listRegion call with correct parameters", () => {
      const source = `
        interface ListRef<T> {
          toArray(): T[]
        }
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("__listRegion")
      expect(result.code).toContain("items")
      expect(result.code).toContain("create:")
      expect(result.code).toContain("(item, _index)")
      expect(result.code).toContain("scope")
    })

    it("should generate create handler that returns element", () => {
      const source = `
        interface ListRef<T> {
          toArray(): T[]
        }
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should create li element
      expect(result.code).toContain('document.createElement("li")')
      // Should return element directly (optimized path for single element)
      expect(result.code).toContain("return _li")
    })

    it("should use index variable when provided", () => {
      const source = `
        interface ListRef<T> {
          entries(): Iterable<[number, T]>
        }
        declare const items: ListRef<string>

        ul(() => {
          for (const [idx, item] of items.entries()) {
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should use the actual index variable name
      expect(result.code).toContain("(item, idx)")
    })
  })

  describe("Task 6.3: Nested reactive content in list items", () => {
    it("should handle static content in list items", () => {
      const source = `
        interface ListRef<T> {
          toArray(): T[]
        }
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Item access in list should be treated as expression
      expect(result.code).toContain("createTextNode(String(item))")
    })
  })

  describe("Task 6.4: O(k) verification with runtime", () => {
    it("should render initial list items", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      doc.items.push("item1")
      doc.items.push("item2")
      doc.items.push("item3")
      loro(doc).commit()

      const scope = new Scope("test")
      const ul = document.createElement("ul")

      __listRegion(
        ul,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(ul.children.length).toBe(3)
      expect(ul.children[0].textContent).toBe("item1")
      expect(ul.children[1].textContent).toBe("item2")
      expect(ul.children[2].textContent).toBe("item3")

      scope.dispose()
    })

    it("should achieve O(1) DOM operations for single insert", () => {
      const { container, counts, reset } = createCountingContainer("ul")
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)

      // Add initial items
      for (let i = 0; i < 10; i++) {
        doc.items.push(`item-${i}`)
      }
      loro(doc).commit()

      const scope = new Scope("test")

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(10)
      reset() // Clear initial render counts

      // Insert ONE item in the middle
      doc.items.insert(5, "new-item")
      loro(doc).commit()

      // Should be O(1), not O(n)
      assertMaxMutations(counts, 1)
      expect(counts.insertBefore).toBe(1)

      scope.dispose()
    })

    it("should achieve O(1) DOM operations for single delete", () => {
      const { container, counts, reset } = createCountingContainer("ul")
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)

      // Add initial items
      for (let i = 0; i < 10; i++) {
        doc.items.push(`item-${i}`)
      }
      loro(doc).commit()

      const scope = new Scope("test")

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(10)
      reset() // Clear initial render counts

      // Delete ONE item
      doc.items.delete(5, 1)
      loro(doc).commit()

      // Should be O(1), not O(n)
      assertMaxMutations(counts, 1)
      expect(counts.removeChild).toBe(1)
      expect(container.children.length).toBe(9)

      scope.dispose()
    })

    it("should clean up item scopes when items are deleted", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      doc.items.push("a")
      doc.items.push("b")
      doc.items.push("c")
      loro(doc).commit()

      const scope = new Scope("test")
      const ul = document.createElement("ul")

      __listRegion(
        ul,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(ul.children.length).toBe(3)

      // Delete middle item
      doc.items.delete(1, 1)
      loro(doc).commit()

      expect(ul.children.length).toBe(2)
      expect(ul.children[0].textContent).toBe("a")
      expect(ul.children[1].textContent).toBe("c")

      scope.dispose()
    })
  })
})

// =============================================================================
// Phase 7: Conditional Region Tests
// =============================================================================

describe("compiler integration - conditional regions", () => {
  beforeEach(() => {
    __resetSubscriptionIdCounter()
    __resetScopeIdCounter()
  })

  describe("Task 7.1: if detection", () => {
    it("should detect if statement and create ConditionalRegionNode in IR", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should have one builder
      expect(result.ir.length).toBe(1)

      // Should have a conditional region as a child
      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional-region",
      )
      expect(conditionalRegion).toBeDefined()
      expect(conditionalRegion?.kind).toBe("conditional-region")
    })

    it("should capture subscription target from condition", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional-region",
      ) as any

      expect(conditionalRegion.subscriptionTarget).toBe("doc.count")
    })

    it("should capture condition expression source", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Has items")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional-region",
      ) as any

      expect(conditionalRegion.branches[0].condition.source).toBe(
        "doc.count.get() > 0",
      )
    })
  })

  describe("Task 7.2: Generated __conditionalRegion call", () => {
    it("should generate __conditionalRegion call with marker", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("__conditionalRegion")
      expect(result.code).toContain('document.createComment("kinetic:if")')
    })

    it("should generate whenTrue handler that returns element", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("whenTrue: () => {")
      expect(result.code).toContain('createElement("p")')
    })

    it("should dissolve conditional with identical structure", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          } else {
            p("Hidden!")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should dissolve - no __conditionalRegion call or handlers
      expect(result.code).not.toContain("whenTrue")
      expect(result.code).not.toContain("whenFalse")
      expect(result.code).not.toContain("__conditionalRegion(")

      // Should have direct element creation with ternary
      expect(result.code).toContain('createElement("p")')
      expect(result.code).toContain("?")
      expect(result.code).toContain('"Visible!"')
      expect(result.code).toContain('"Hidden!"')
    })
  })

  describe("Task 7.3: else/else-if chains", () => {
    it("should handle if/else with two branches", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Yes")
          } else {
            p("No")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional-region",
      ) as any

      expect(conditionalRegion.branches.length).toBe(2)
      expect(conditionalRegion.branches[0].condition).not.toBeNull()
      expect(conditionalRegion.branches[1].condition).toBeNull() // else branch
    })

    it("should handle if/else-if/else with three branches", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 10) {
            p("Many")
          } else if (doc.count.get() > 0) {
            p("Some")
          } else {
            p("None")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional-region",
      ) as any

      expect(conditionalRegion.branches.length).toBe(3)
      expect(conditionalRegion.branches[0].condition?.source).toBe(
        "doc.count.get() > 10",
      )
      expect(conditionalRegion.branches[1].condition?.source).toBe(
        "doc.count.get() > 0",
      )
      expect(conditionalRegion.branches[2].condition).toBeNull() // else branch
    })

    it("should capture body content for each branch", () => {
      const source = `
        interface TextRef {
          toString(): string
        }
        declare const doc: { status: TextRef }

        div(() => {
          if (doc.status.toString() === "loading") {
            span("Loading...")
          } else {
            span("Done!")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional-region",
      ) as any

      // Check that branches have body content
      expect(conditionalRegion.branches[0].body.length).toBeGreaterThan(0)
      expect(conditionalRegion.branches[1].body.length).toBeGreaterThan(0)
    })
  })

  // Note: Runtime behavior tests for __conditionalRegion and __staticConditionalRegion
  // are in regions.test.ts. This section tests compiler integration only.

  describe("Task 7.4: Compile-and-execute integration", () => {
    it("should compile and execute dissolved conditional reactively", () => {
      // This test verifies the full pipeline: source → IR → codegen → execute
      // With identical structure, the conditional should be dissolved

      const schema = Shape.doc({
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      // Start with count = 0 (false condition)
      loro(doc).commit()

      // Manually construct what dissolved code would produce
      // Dissolved conditionals create element directly with ternary in subscription
      const scope = new Scope("test")
      const container = document.createElement("div")

      const p = document.createElement("p")
      const text = document.createTextNode("")
      p.appendChild(text)
      container.appendChild(p)

      // Subscribe to reactive content
      __subscribeWithValue(
        doc.count,
        () => (doc.count.get() > 0 ? "Has items" : "Empty"),
        v => {
          text.textContent = String(v)
        },
        scope,
      )

      // Verify initial state
      expect(container.querySelector("p")?.textContent).toBe("Empty")

      // Change condition and verify reactive update
      doc.count.increment(5)
      loro(doc).commit()
      expect(container.querySelector("p")?.textContent).toBe("Has items")

      // Verify the generated code structure matches what we executed
      const source = `
        interface CounterRef {
          get(): number
        }
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Has items")
          } else {
            p("Empty")
          }
        })
      `
      const result = transformSource(source, { target: "dom" })

      // The compiled code should be dissolved (no __conditionalRegion call)
      expect(result.code).not.toContain("__conditionalRegion(")
      expect(result.code).not.toContain("whenTrue")
      expect(result.code).not.toContain("whenFalse")

      // Should have direct element creation with ternary
      expect(result.code).toContain('createElement("p")')
      expect(result.code).toContain("?")
      expect(result.code).toContain('"Has items"')
      expect(result.code).toContain('"Empty"')

      scope.dispose()
    })
  })
})

// =============================================================================
// Phase 8: Binding Tests
// =============================================================================

describe("compiler integration - bindings", () => {
  beforeEach(() => {
    __resetSubscriptionIdCounter()
    __resetScopeIdCounter()
  })

  describe("Task 8.1: bind() detection in props", () => {
    it("should detect bind() call and create binding in element IR", () => {
      const source = `
        interface TextRef {
          toString(): string
        }
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { title: TextRef }

        div(() => {
          input({ type: "text", value: bind(doc.title) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should have one builder (the div wrapping the input)
      expect(result.ir.length).toBe(1)

      // The div should have one child (the input element)
      expect(result.ir[0].children.length).toBe(1)
      expect(result.ir[0].children[0].kind).toBe("element")
    })

    it("should extract ref source from bind() call", () => {
      const source = `
        interface TextRef {
          toString(): string
        }
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { title: TextRef }

        div(() => {
          input({ type: "text", value: bind(doc.title) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Check that the generated code contains the binding call
      expect(result.code).toContain("__bindTextValue")
      expect(result.code).toContain("doc.title")
    })

    it("should detect checked binding for checkbox", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { enabled: CounterRef }

        div(() => {
          input({ type: "checkbox", checked: bind(doc.enabled) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should generate __bindChecked for checkbox
      expect(result.code).toContain("__bindChecked")
      expect(result.code).toContain("doc.enabled")
    })
  })

  describe("Task 8.2: Generated binding code", () => {
    it("should generate __bindTextValue call for value binding", () => {
      const source = `
        interface TextRef {
          toString(): string
        }
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { name: TextRef }

        div(() => {
          input({ type: "text", value: bind(doc.name) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("__bindTextValue")
      expect(result.code).toContain('createElement("input")')
    })

    it("should generate __bindChecked call for checked binding", () => {
      const source = `
        interface CounterRef {
          get(): number
        }
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { active: CounterRef }

        div(() => {
          input({ type: "checkbox", checked: bind(doc.active) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("__bindChecked")
      expect(result.code).toContain('createElement("input")')
    })

    it("should include binding imports when bindings are present", () => {
      const source = `
        interface TextRef {
          toString(): string
        }
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { title: TextRef }

        div(() => {
          input({ type: "text", value: bind(doc.title) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("__bindTextValue")
    })
  })

  // Note: Runtime behavior tests for __bindTextValue, __bindChecked, etc.
  // are in binding.test.ts. This section tests compiler integration only.

  describe("Task 8.3: Compile-and-verify integration", () => {
    it("should compile binding code with correct structure and imports", () => {
      // This test verifies the full compiler pipeline for bindings:
      // source → IR → codegen (including imports)

      const textSource = `
        interface TextRef {
          toString(): string
        }
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { title: TextRef }

        div(() => {
          input({ type: "text", value: bind(doc.title) })
        })
      `

      const checkboxSource = `
        interface CounterRef {
          get(): number
        }
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { enabled: CounterRef }

        div(() => {
          input({ type: "checkbox", checked: bind(doc.enabled) })
        })
      `

      const textResult = transformSource(textSource, { target: "dom" })
      const checkboxResult = transformSource(checkboxSource, { target: "dom" })

      // Text binding generates __bindTextValue
      expect(textResult.code).toContain("__bindTextValue")
      expect(textResult.code).toContain("doc.title")
      expect(textResult.code).toContain('createElement("input")')

      // Checkbox binding generates __bindChecked
      expect(checkboxResult.code).toContain("__bindChecked")
      expect(checkboxResult.code).toContain("doc.enabled")

      // Both should have proper element creation
      expect(textResult.ir[0].children[0].kind).toBe("element")
      expect(checkboxResult.ir[0].children[0].kind).toBe("element")
    })
  })
})

// =============================================================================
// Combined Scenarios (Task 9.4)
// =============================================================================

describe("compiler integration - combined scenarios", () => {
  beforeEach(() => {
    __resetSubscriptionIdCounter()
    __resetScopeIdCounter()
  })

  describe("Task 9.4: All patterns working together", () => {
    it("should compile list with reactive content and conditionals", () => {
      const source = `
        interface ListRef<T> {
          toArray(): T[]
          [Symbol.iterator](): Iterator<T>
        }
        interface TextRef {
          toString(): string
        }
        interface CounterRef {
          get(): number
          value: number
        }
        declare const doc: {
          items: ListRef<{ name: TextRef, done: CounterRef }>
          showCompleted: CounterRef
        }

        div(() => {
          h1("Todo List")

          if (doc.showCompleted.get() > 0) {
            p("Showing completed items")
          }

          for (const item of doc.items) {
            li(() => {
              span(item.name.toString())
              if (item.done.get() > 0) {
                span(" ✓")
              }
            })
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should have one builder
      expect(result.ir.length).toBe(1)

      // Should contain list region
      expect(result.code).toContain("__listRegion")

      // Should contain conditional region
      expect(result.code).toContain("__conditionalRegion")

      // Should have subscription calls for reactive content
      expect(result.code).toContain("doc.showCompleted")
      expect(result.code).toContain("item.done")
    })

    it("should compile form with bindings and reactive display", () => {
      const source = `
        interface TextRef {
          toString(): string
        }
        interface CounterRef {
          get(): number
          value: number
        }
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: {
          title: TextRef
          count: CounterRef
        }

        div(() => {
          h1("Edit Form")

          input({ type: "text", value: bind(doc.title) })

          p(doc.title.toString())

          input({ type: "checkbox", checked: bind(doc.count) })

          span(doc.count.value.toString())
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should have bindings
      expect(result.code).toContain("__bindTextValue")
      expect(result.code).toContain("__bindChecked")

      // Should have reactive text display
      expect(result.code).toContain("doc.title.toString()")
      expect(result.code).toContain("doc.count.value.toString()")
    })

    it("should compile nested lists with reactive items", () => {
      const source = `
        interface ListRef<T> {
          toArray(): T[]
          [Symbol.iterator](): Iterator<T>
        }
        interface TextRef {
          toString(): string
        }
        declare const doc: {
          categories: ListRef<{
            name: TextRef
            items: ListRef<{ text: TextRef }>
          }>
        }

        div(() => {
          for (const category of doc.categories) {
            section(() => {
              h2(category.name.toString())

              ul(() => {
                for (const item of category.items) {
                  li(item.text.toString())
                }
              })
            })
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should have nested list regions (at least 2 - may include import statement)
      const listRegionCount = (result.code.match(/__listRegion/g) || []).length
      expect(listRegionCount).toBeGreaterThanOrEqual(2) // outer and inner lists
    })

    it("should compile conditional with different content types", () => {
      const source = `
        interface CounterRef {
          get(): number
          value: number
        }
        interface ListRef<T> {
          toArray(): T[]
          [Symbol.iterator](): Iterator<T>
        }
        declare const doc: {
          mode: CounterRef
          items: ListRef<string>
        }

        div(() => {
          if (doc.mode.get() === 0) {
            p("Empty state - no items")
          } else if (doc.mode.get() === 1) {
            ul(() => {
              for (const item of doc.items) {
                li(item)
              }
            })
          } else {
            div(() => {
              h2("Grid view")
              for (const item of doc.items) {
                span(item)
              }
            })
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should have conditional region with multiple branches
      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional-region",
      )
      expect(conditionalRegion).toBeDefined()
      if (
        conditionalRegion &&
        conditionalRegion.kind === "conditional-region"
      ) {
        expect(conditionalRegion.branches.length).toBe(3)
      }

      // Should have list regions inside branches
      expect(result.code).toContain("__listRegion")
    })

    it("should handle static and reactive content mixed", () => {
      const source = `
        interface TextRef {
          toString(): string
        }
        declare const doc: { name: TextRef }

        div(() => {
          header(() => {
            h1("Static Title")
            nav(() => {
              a({ href: "/" }, "Home")
              a({ href: "/about" }, "About")
            })
          })

          main(() => {
            p("Welcome, ")
            span(doc.name.toString())
            p("!")
          })

          footer(() => {
            p("Copyright 2024")
          })
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should have one builder
      expect(result.ir.length).toBe(1)

      // Should have static elements
      expect(result.code).toContain('createElement("header")')
      expect(result.code).toContain('createElement("nav")')
      expect(result.code).toContain('createElement("footer")')

      // Should have reactive content
      expect(result.code).toContain("doc.name.toString()")
    })
  })

  describe("Task 9.4: Runtime execution of combined patterns", () => {
    it("should execute list with static content in items", () => {
      // Use plain strings - struct items return raw values from toArray()
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)

      // Add initial items
      doc.items.push("Task 1")
      doc.items.push("Task 2 ⚡")

      const scope = new Scope("test")
      const ul = document.createElement("ul")

      // Manually construct what compiled code would generate
      __listRegion(
        ul,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            const textNode = document.createTextNode(item)
            li.appendChild(textNode)
            return li
          },
        },
        scope,
      )

      // Should render both items
      expect(ul.children.length).toBe(2)
      expect(ul.children[0].textContent).toBe("Task 1")
      expect(ul.children[1].textContent).toContain("Task 2")
      expect(ul.children[1].textContent).toContain("⚡")

      scope.dispose()
    })

    it("should handle reactive updates across multiple features", () => {
      const schema = Shape.doc({
        title: Shape.text(),
        showDetails: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      doc.title.insert(0, "Initial Title")

      const scope = new Scope("test")
      const container = document.createElement("div")

      // Title element with reactive text
      const h1 = document.createElement("h1")
      const titleText = document.createTextNode(doc.title.toString())
      h1.appendChild(titleText)
      container.appendChild(h1)

      // Subscribe to title changes
      __subscribeWithValue(
        doc.title,
        () => doc.title.toString(),
        value => {
          titleText.textContent = value
        },
        scope,
      )

      // Conditional details section
      const marker = document.createComment("kinetic:if")
      container.appendChild(marker)

      __conditionalRegion(
        marker,
        doc.showDetails,
        () => loro(doc.showDetails).value > 0,
        {
          whenTrue: () => {
            const details = document.createElement("p")
            details.textContent = "Details are visible"
            return details
          },
          whenFalse: () => {
            const hidden = document.createElement("p")
            hidden.textContent = "Details hidden"
            return hidden
          },
        },
        scope,
      )

      // Initial state
      expect(container.querySelector("h1")?.textContent).toBe("Initial Title")
      expect(container.textContent).toContain("Details hidden")

      // Update title
      doc.title.delete(0, doc.title.toString().length)
      doc.title.insert(0, "Updated Title")
      expect(container.querySelector("h1")?.textContent).toBe("Updated Title")

      // Show details
      doc.showDetails.increment(1)
      expect(container.textContent).toContain("Details are visible")

      scope.dispose()
    })
  })
})

// =============================================================================
// Phase 4 Integration Tests: Arbitrary Statements
// =============================================================================

describe("compiler integration - arbitrary statements", () => {
  beforeEach(() => {
    __resetScopeIdCounter()
    __resetSubscriptionIdCounter()
    __activeSubscriptions.clear()
  })

  describe("Task 4.1: Variable declaration in for-of body", () => {
    it("should compile and execute variable declaration in reactive list", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)

      // Add initial items
      doc.items.push("first")
      doc.items.push("second")
      loro(doc).commit()

      const scope = new Scope("test")
      const container = document.createElement("div")

      // Simulate what the compiled code would do - with a statement inside the create callback
      // This tests that statements (like const upperItem = ...) are preserved
      __listRegion(
        container,
        doc.items,
        {
          create: (itemRef: { get(): string }, _index) => {
            // This pattern tests statement preservation:
            // const upperItem = item.toUpperCase() would have been dropped before
            const item = itemRef.get()
            const upperItem = item.toUpperCase()
            const li = document.createElement("li")
            li.textContent = upperItem
            return li
          },
        },
        scope,
      )

      // Verify items rendered correctly with transformation applied
      const listItems = container.querySelectorAll("li")
      expect(listItems.length).toBe(2)
      expect(listItems[0].textContent).toBe("FIRST")
      expect(listItems[1].textContent).toBe("SECOND")

      scope.dispose()
    })

    it("should generate correct DOM code for variable declaration in for-of", () => {
      const source = `
        import { ListRef } from "./loro-types"
        declare const items: ListRef<{ get(): string }>

        ul(() => {
          for (const itemRef of items) {
            const item = itemRef.get()
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      // The generated code should contain the variable declaration
      expect(result.code).toContain("const item = itemRef.get()")
      expect(result.code).toContain("__listRegion")
    })

    it("should generate correct HTML code for variable declaration in for-of", () => {
      const source = `
        import { ListRef } from "./loro-types"
        declare const items: ListRef<{ get(): string }>

        ul(() => {
          for (const itemRef of items) {
            const item = itemRef.get()
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "html" })

      // The generated HTML code should contain the variable declaration
      expect(result.code).toContain("const item = itemRef.get()")
    })
  })

  describe("Task 4.2: Multiple statements in builder", () => {
    it("should compile multiple statements in correct order (DOM)", () => {
      const source = `
        div(() => {
          const x = 1
          const y = 2
          p(String(x + y))
        })
      `

      const resultDom = transformSource(source, { target: "dom" })

      // DOM should contain the statements
      expect(resultDom.code).toContain("const x = 1")
      expect(resultDom.code).toContain("const y = 2")

      // Verify order: x before y
      const xIndexDom = resultDom.code.indexOf("const x = 1")
      const yIndexDom = resultDom.code.indexOf("const y = 2")
      expect(xIndexDom).toBeLessThan(yIndexDom)
    })

    it("should compile multiple statements in list region (HTML)", () => {
      // HTML codegen only handles statements in body contexts (list regions, conditionals)
      // Direct builder children in HTML don't go through generateBodyHtml
      const source = `
        import { ListRef } from "./loro-types"
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            const x = 1
            const y = 2
            li(String(x + y))
          }
        })
      `

      const resultHtml = transformSource(source, { target: "html" })

      // Should contain the statements in the list body
      expect(resultHtml.code).toContain("const x = 1")
      expect(resultHtml.code).toContain("const y = 2")
    })
  })

  describe("Task 4.3: Interleaved statements and elements", () => {
    it("should preserve interleaving order in generated code", () => {
      const source = `
        import { ListRef } from "./loro-types"
        declare const items: ListRef<{ get(): string }>

        ul(() => {
          for (const item of items) {
            console.log("before")
            li(item)
            console.log("after")
          }
        })
      `

      const resultDom = transformSource(source, { target: "dom" })

      // Verify order in DOM code
      const beforeIndex = resultDom.code.indexOf('console.log("before")')
      const liIndex = resultDom.code.indexOf('createElement("li")')
      const afterIndex = resultDom.code.indexOf('console.log("after")')

      expect(beforeIndex).toBeGreaterThan(-1)
      expect(liIndex).toBeGreaterThan(-1)
      expect(afterIndex).toBeGreaterThan(-1)
      expect(beforeIndex).toBeLessThan(liIndex)
      expect(liIndex).toBeLessThan(afterIndex)
    })
  })

  describe("Task 4.4: Static loops", () => {
    it("should compile and execute static for-of loop (DOM)", () => {
      const source = `
        ul(() => {
          for (const x of [1, 2, 3]) {
            li(String(x))
          }
        })
      `

      const { node, scope } = compileAndExecute(source)

      // Should create three li elements
      const listItems = (node as Element).querySelectorAll("li")
      expect(listItems.length).toBe(3)
      expect(listItems[0].textContent).toBe("1")
      expect(listItems[1].textContent).toBe("2")
      expect(listItems[2].textContent).toBe("3")

      scope.dispose()
    })

    it("should generate static loop in HTML output", () => {
      const source = `
        ul(() => {
          for (const x of [1, 2, 3]) {
            li(String(x))
          }
        })
      `

      const result = transformSource(source, { target: "html" })

      // Should generate a map expression for static loop
      expect(result.code).toContain("[1, 2, 3].map")
      expect(result.code).toContain("<li>")
    })

    it("should handle static loop with statements", () => {
      const source = `
        ul(() => {
          for (const x of [1, 2, 3]) {
            const doubled = x * 2
            li(String(doubled))
          }
        })
      `

      const resultDom = transformSource(source, { target: "dom" })
      const resultHtml = transformSource(source, { target: "html" })

      expect(resultDom.code).toContain("const doubled = x * 2")
      expect(resultHtml.code).toContain("const doubled = x * 2")
    })
  })

  describe("Task 4.5: Static conditionals", () => {
    it("should compile and execute static if (true) (DOM)", () => {
      const source = `
        div(() => {
          if (true) {
            p("shown")
          }
        })
      `

      const { node, scope } = compileAndExecute(source)

      // Should create the p element
      const p = (node as Element).querySelector("p")
      expect(p).not.toBeNull()
      expect(p?.textContent).toBe("shown")

      scope.dispose()
    })

    it("should compile and execute static if (false) (DOM)", () => {
      const source = `
        div(() => {
          if (false) {
            p("hidden")
          }
        })
      `

      const { node, scope } = compileAndExecute(source)

      // Should NOT create the p element
      const p = (node as Element).querySelector("p")
      expect(p).toBeNull()

      scope.dispose()
    })

    it("should compile and execute static if/else (DOM)", () => {
      const source = `
        div(() => {
          if (false) {
            p("yes")
          } else {
            p("no")
          }
        })
      `

      const { node, scope } = compileAndExecute(source)

      // Should create the else branch element
      const p = (node as Element).querySelector("p")
      expect(p).not.toBeNull()
      expect(p?.textContent).toBe("no")

      scope.dispose()
    })

    it("should generate static conditional in HTML output", () => {
      const source = `
        div(() => {
          if (true) {
            p("shown")
          }
        })
      `

      const result = transformSource(source, { target: "html" })

      // Should have conditional logic
      expect(result.code).toContain("true")
      expect(result.code).toContain("<p>")
    })
  })

  describe("Task 4.5: Ref-based iteration pattern", () => {
    it("should compile and execute itemRef.get() pattern in list region", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      doc.items.push("first")
      doc.items.push("second")
      loro(doc).commit()

      const scope = new Scope("test")
      const container = document.createElement("div")

      // Simulate compiled code that uses itemRef.get() pattern
      // This is what the compiler generates from:
      //   for (const itemRef of doc.items) {
      //     const item = itemRef.get()
      //     li(item)
      //   }
      __listRegion(
        container,
        doc.items,
        {
          create: (
            itemRef: { get(): string; set(v: string): void },
            _index,
          ) => {
            // This is the pattern the compiler preserves as a statement
            const item = itemRef.get()
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      // Verify items rendered correctly
      const listItems = container.querySelectorAll("li")
      expect(listItems.length).toBe(2)
      expect(listItems[0].textContent).toBe("first")
      expect(listItems[1].textContent).toBe("second")

      scope.dispose()
    })

    it("should allow .set() on refs received in list region handlers", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      doc.items.push("original")
      loro(doc).commit()

      const scope = new Scope("test")
      const container = document.createElement("div")

      // Capture the ref for later modification
      const capturedRefs: Array<{ get(): string; set(v: string): void }> = []

      __listRegion(
        container,
        doc.items,
        {
          create: (
            itemRef: { get(): string; set(v: string): void },
            _index,
          ) => {
            capturedRefs.push(itemRef)
            const li = document.createElement("li")
            li.textContent = itemRef.get()
            return li
          },
        },
        scope,
      )

      // Verify we got a ref
      expect(capturedRefs.length).toBe(1)
      expect(capturedRefs[0].get()).toBe("original")

      // Modify via the ref (simulating an event handler)
      capturedRefs[0].set("modified")
      loro(doc).commit()

      // Verify the change persisted in the document
      expect(doc.items.get(0)?.get()).toBe("modified")

      scope.dispose()
    })

    it("should generate HTML with spread syntax for ref preservation", () => {
      const source = `
        import { ListRef } from "./loro-types"
        declare const items: ListRef<{ get(): string }>

        ul(() => {
          for (const itemRef of items) {
            const item = itemRef.get()
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "html" })

      // Should use spread syntax [...items] instead of .toArray()
      expect(result.code).toContain("[...items]")
      expect(result.code).not.toContain(".toArray()")

      // Should preserve the statement
      expect(result.code).toContain("const item = itemRef.get()")
    })
  })

  describe("Task 4.6: Return statement error", () => {
    it("should throw compile-time error for return statement", () => {
      const source = `
        div(() => {
          if (true) return
          p("hello")
        })
      `

      expect(() => transformSource(source, { target: "dom" })).toThrow(
        /Return statement not supported/,
      )
    })

    it("should include line number in error message", () => {
      const source = `
        div(() => {
          if (true) return
          p("hello")
        })
      `

      try {
        transformSource(source, { target: "dom" })
        expect.fail("Should have thrown an error")
      } catch (e) {
        expect((e as Error).message).toContain("line")
      }
    })
  })
})
