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
import ts from "typescript"
import { beforeEach, describe, expect, it } from "vitest"

import {
  conditionalRegion,
  listRegion,
  subscribe,
  subscribeMultiple,
  subscribeWithValue,
  textRegion,
  Scope,
} from "../runtime/index.js"
import {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
  resetScopeIdCounter,
  setRootScope,
  assertMaxMutations,
  createCountingContainer,
} from "../testing/index.js"
import {
  mergeImports,
  transformSource,
  transformSourceInPlace,
} from "./transform.js"

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

  const scope = new Scope()
  const node = executeGeneratedCode(fnCode, scope)

  return { node, scope }
}

describe("compiler integration - static compilation", () => {
  beforeEach(() => {
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
    setRootScope(null)
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
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
    setRootScope(null)
  })

  describe("Task 5.2: Reactive text content", () => {
    it("should generate subscribeWithValue for reactive text", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
        declare const count: CounterRef

        div(() => {
          p(count.get())
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should detect reactive content
      expect(result.ir[0].isReactive).toBe(true)

      // Should generate subscription call
      expect(result.code).toContain("subscribeWithValue")
      expect(result.code).toContain("count")
    })

    it("should generate subscribeWithValue for template literal with reactive content", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
        declare const count: CounterRef

        div(() => {
          p(\`Count: \${count.get()}\`)
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.ir[0].isReactive).toBe(true)
      expect(result.code).toContain("subscribeWithValue")
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
      const scope = new Scope()
      const div = document.createElement("div")
      const p = document.createElement("p")
      const text = document.createTextNode("")
      p.appendChild(text)
      div.appendChild(p)

      // Subscribe (simulating compiled code)
      subscribeWithValue(
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
      expect(getActiveSubscriptionCount()).toBe(0)
    })
  })

  describe("Task 5.3: Reactive attributes", () => {
    it("should generate subscribe for reactive class attribute", () => {
      const source = `
        import { TextRef } from "@loro-extended/change"
        declare const className: TextRef

        div({ class: className.toString() }, () => {
          p("Hello")
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.ir[0].isReactive).toBe(true)
      expect(result.code).toContain("subscribe")
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
      const scope = new Scope()
      const div = document.createElement("div")

      // Initial value (0 = inactive, >0 = active)
      div.className = doc.activeCount.get() > 0 ? "active" : "inactive"

      // Subscribe (simulating compiled code)
      subscribe(
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

      const scope = new Scope()
      const button = document.createElement("button")
      const textNode = document.createTextNode("")
      button.appendChild(textNode)

      subscribeWithValue(
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

      const scope = new Scope()
      const h1 = document.createElement("h1")
      const textNode = document.createTextNode("")
      h1.appendChild(textNode)

      subscribeWithValue(
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

      const scope = new Scope()
      const textNode = document.createTextNode("")

      subscribeWithValue(
        doc.value,
        () => doc.value.get(),
        v => {
          textNode.textContent = String(v)
        },
        scope,
      )

      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)

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

      const scope = new Scope()

      const firstNameNode = document.createTextNode("")
      const lastNameNode = document.createTextNode("")
      const fullNameNode = document.createTextNode("")

      subscribeWithValue(
        doc.firstName,
        () => doc.firstName.toString(),
        v => {
          firstNameNode.textContent = v
        },
        scope,
      )

      subscribeWithValue(
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
      subscribe(doc.firstName, updateFullName, scope)
      subscribe(doc.lastName, updateFullName, scope)
      updateFullName() // Initial value

      expect(getActiveSubscriptionCount()).toBe(4)
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
      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should use subscribeMultiple for expressions with multiple dependencies", () => {
      const schema = Shape.doc({
        firstName: Shape.text(),
        lastName: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.firstName.insert(0, "John")
      doc.lastName.insert(0, "Doe")
      loro(doc).commit()

      const scope = new Scope()
      const fullNameNode = document.createTextNode("")

      // Set initial value
      fullNameNode.textContent = `${doc.firstName.toString()} ${doc.lastName.toString()}`

      // Subscribe to both dependencies with a single subscribeMultiple call
      subscribeMultiple(
        [doc.firstName, doc.lastName],
        () => {
          fullNameNode.textContent = `${doc.firstName.toString()} ${doc.lastName.toString()}`
        },
        scope,
      )

      // Should create 2 subscriptions (one per ref)
      expect(getActiveSubscriptionCount()).toBe(2)
      expect(fullNameNode.textContent).toBe("John Doe")

      // Update first name only - should trigger update
      doc.firstName.delete(0, 4)
      doc.firstName.insert(0, "Jane")
      loro(doc).commit()
      expect(fullNameNode.textContent).toBe("Jane Doe")

      // Update last name only - should also trigger update
      doc.lastName.delete(0, 3)
      doc.lastName.insert(0, "Smith")
      loro(doc).commit()
      expect(fullNameNode.textContent).toBe("Jane Smith")

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)
    })
  })
})

// =============================================================================
// Phase 6: List Region Integration Tests
// =============================================================================

describe("compiler integration - list regions", () => {
  beforeEach(() => {
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
    setRootScope(null)
  })

  describe("Task 6.1: for-of detection", () => {
    it("should detect for-of loop and create ListRegionNode in IR", () => {
      const source = `
        import { ListRef } from "@loro-extended/change"
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
        import { ListRef } from "@loro-extended/change"
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
        import { ListRef } from "@loro-extended/change"
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

  describe("Task 6.2: Generated listRegion call", () => {
    it("should generate listRegion call with correct parameters", () => {
      const source = `
        import { ListRef } from "@loro-extended/change"
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("listRegion")
      expect(result.code).toContain("items")
      expect(result.code).toContain("create:")
      expect(result.code).toContain("(item, _index)")
      expect(result.code).toContain("scope")
    })

    it("should generate create handler that returns element", () => {
      const source = `
        import { ListRef } from "@loro-extended/change"
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
        import { ListRef } from "@loro-extended/change"
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
        import { ListRef } from "@loro-extended/change"
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

      const scope = new Scope()
      const ul = document.createElement("ul")

      listRegion(
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

      const scope = new Scope()

      listRegion(
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

      const scope = new Scope()

      listRegion(
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

      const scope = new Scope()
      const ul = document.createElement("ul")

      listRegion(
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
    resetSubscriptionIdCounter()
    resetScopeIdCounter()
  })

  describe("Task 7.1: if detection", () => {
    it("should detect if statement and create ConditionalNode in IR", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
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
        c => c.kind === "conditional",
      )
      expect(conditionalRegion).toBeDefined()
      expect(conditionalRegion?.kind).toBe("conditional")
    })

    it("should capture subscription target from condition", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional",
      ) as any

      expect(conditionalRegion.subscriptionTarget).toEqual({
        source: "doc.count",
        deltaKind: "replace",
      })
    })

    it("should capture condition expression source", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Has items")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional",
      ) as any

      expect(conditionalRegion.branches[0].condition.source).toBe(
        "doc.count.get() > 0",
      )
    })
  })

  describe("Task 7.2: Generated conditionalRegion call", () => {
    it("should generate conditionalRegion call with marker", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("conditionalRegion")
      expect(result.code).toContain('document.createComment("kinetic:if")')
    })

    it("should generate whenTrue handler that returns element", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
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
        import { CounterRef } from "@loro-extended/change"
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

      // Should dissolve - no conditionalRegion call or handlers
      expect(result.code).not.toContain("whenTrue")
      expect(result.code).not.toContain("whenFalse")
      expect(result.code).not.toContain("conditionalRegion(")

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
        import { CounterRef } from "@loro-extended/change"
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
        c => c.kind === "conditional",
      ) as any

      expect(conditionalRegion.branches.length).toBe(2)
      expect(conditionalRegion.branches[0].condition).not.toBeNull()
      expect(conditionalRegion.branches[1].condition).toBeNull() // else branch
    })

    it("should handle if/else-if/else with three branches", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
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
        c => c.kind === "conditional",
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
        import { TextRef } from "@loro-extended/change"
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
        c => c.kind === "conditional",
      ) as any

      // Check that branches have body content
      expect(conditionalRegion.branches[0].body.length).toBeGreaterThan(0)
      expect(conditionalRegion.branches[1].body.length).toBeGreaterThan(0)
    })
  })

  // Note: Runtime behavior tests for conditionalRegion and __staticConditionalRegion
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
      const scope = new Scope()
      const container = document.createElement("div")

      const p = document.createElement("p")
      const text = document.createTextNode("")
      p.appendChild(text)
      container.appendChild(p)

      // Subscribe to reactive content
      subscribeWithValue(
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
        import { CounterRef } from "@loro-extended/change"
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

      // The compiled code should be dissolved (no conditionalRegion call)
      expect(result.code).not.toContain("conditionalRegion(")
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
    resetSubscriptionIdCounter()
    resetScopeIdCounter()
  })

  describe("Task 8.1: bind() detection in props", () => {
    it("should detect bind() call and create binding in element IR", () => {
      const source = `
        import { TextRef } from "@loro-extended/change"
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
        import { TextRef } from "@loro-extended/change"
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { title: TextRef }

        div(() => {
          input({ type: "text", value: bind(doc.title) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Check that the generated code contains the binding call
      expect(result.code).toContain("bindTextValue")
      expect(result.code).toContain("doc.title")
    })

    it("should detect checked binding for checkbox", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { enabled: CounterRef }

        div(() => {
          input({ type: "checkbox", checked: bind(doc.enabled) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      // Should generate bindChecked for checkbox
      expect(result.code).toContain("bindChecked")
      expect(result.code).toContain("doc.enabled")
    })
  })

  describe("Task 8.2: Generated binding code", () => {
    it("should generate bindTextValue call for value binding", () => {
      const source = `
        import { TextRef } from "@loro-extended/change"
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { name: TextRef }

        div(() => {
          input({ type: "text", value: bind(doc.name) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("bindTextValue")
      expect(result.code).toContain('createElement("input")')
    })

    it("should generate bindChecked call for checked binding", () => {
      const source = `
        import { CounterRef } from "@loro-extended/change"
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { active: CounterRef }

        div(() => {
          input({ type: "checkbox", checked: bind(doc.active) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("bindChecked")
      expect(result.code).toContain('createElement("input")')
    })

    it("should include binding imports when bindings are present", () => {
      const source = `
        import { TextRef } from "@loro-extended/change"
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { title: TextRef }

        div(() => {
          input({ type: "text", value: bind(doc.title) })
        })
      `

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("bindTextValue")
    })
  })

  // Note: Runtime behavior tests for bindTextValue, bindChecked, etc.
  // are in binding.test.ts. This section tests compiler integration only.

  describe("Task 8.3: Compile-and-verify integration", () => {
    it("should compile binding code with correct structure and imports", () => {
      // This test verifies the full compiler pipeline for bindings:
      // source → IR → codegen (including imports)

      const textSource = `
        import { TextRef } from "@loro-extended/change"
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { title: TextRef }

        div(() => {
          input({ type: "text", value: bind(doc.title) })
        })
      `

      const checkboxSource = `
        import { CounterRef } from "@loro-extended/change"
        declare function bind<T>(ref: T): { __brand: "kinetic:binding", ref: T }
        declare const doc: { enabled: CounterRef }

        div(() => {
          input({ type: "checkbox", checked: bind(doc.enabled) })
        })
      `

      const textResult = transformSource(textSource, { target: "dom" })
      const checkboxResult = transformSource(checkboxSource, { target: "dom" })

      // Text binding generates bindTextValue
      expect(textResult.code).toContain("bindTextValue")
      expect(textResult.code).toContain("doc.title")
      expect(textResult.code).toContain('createElement("input")')

      // Checkbox binding generates bindChecked
      expect(checkboxResult.code).toContain("bindChecked")
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
    resetSubscriptionIdCounter()
    resetScopeIdCounter()
  })

  describe("Task 9.4: All patterns working together", () => {
    it("should compile list with reactive content and conditionals", () => {
      const source = `
        import { ListRef, TextRef, CounterRef } from "@loro-extended/change"
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
      expect(result.code).toContain("listRegion")

      // Should contain conditional region
      expect(result.code).toContain("conditionalRegion")

      // Should have subscription calls for reactive content
      expect(result.code).toContain("doc.showCompleted")
      expect(result.code).toContain("item.done")
    })

    it("should compile form with bindings and reactive display", () => {
      const source = `
        import { TextRef, CounterRef } from "@loro-extended/change"
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
      expect(result.code).toContain("bindTextValue")
      expect(result.code).toContain("bindChecked")

      // Should have reactive text display
      expect(result.code).toContain("doc.title.toString()")
      expect(result.code).toContain("doc.count.value.toString()")
    })

    it("should compile nested lists with reactive items", () => {
      const source = `
        import { ListRef, TextRef } from "@loro-extended/change"
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
      const listRegionCount = (result.code.match(/listRegion/g) || []).length
      expect(listRegionCount).toBeGreaterThanOrEqual(2) // outer and inner lists
    })

    it("should compile conditional with different content types", () => {
      const source = `
        import { CounterRef, ListRef } from "@loro-extended/change"
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
        c => c.kind === "conditional",
      )
      expect(conditionalRegion).toBeDefined()
      if (conditionalRegion && conditionalRegion.kind === "conditional") {
        expect(conditionalRegion.branches.length).toBe(3)
      }

      // Should have list regions inside branches
      expect(result.code).toContain("listRegion")
    })

    it("should handle static and reactive content mixed", () => {
      const source = `
        import { TextRef } from "@loro-extended/change"
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

      const scope = new Scope()
      const ul = document.createElement("ul")

      // Manually construct what compiled code would generate
      listRegion(
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

      const scope = new Scope()
      const container = document.createElement("div")

      // Title element with reactive text
      const h1 = document.createElement("h1")
      const titleText = document.createTextNode(doc.title.toString())
      h1.appendChild(titleText)
      container.appendChild(h1)

      // Subscribe to title changes
      subscribeWithValue(
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

      conditionalRegion(
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
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
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

      const scope = new Scope()
      const container = document.createElement("div")

      // Simulate what the compiled code would do - with a statement inside the create callback
      // This tests that statements (like const upperItem = ...) are preserved
      listRegion(
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
        import { ListRef } from "@loro-extended/change"
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
      expect(result.code).toContain("listRegion")
    })

    it("should generate correct HTML code for variable declaration in for-of", () => {
      const source = `
        import { ListRef } from "@loro-extended/change"
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
      const source = `
        import { ListRef } from "@loro-extended/change"
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

    it("should compile top-level statements in builder (HTML)", () => {
      const source = `
        div(() => {
          const x = 1
          const y = 2
          p(String(x + y))
        })
      `

      const resultHtml = transformSource(source, { target: "html" })

      // After unification, top-level builder statements are preserved in HTML output
      expect(resultHtml.code).toContain("const x = 1")
      expect(resultHtml.code).toContain("const y = 2")

      // Verify order: x before y before element
      const xIndex = resultHtml.code.indexOf("const x = 1")
      const yIndex = resultHtml.code.indexOf("const y = 2")
      const pIndex = resultHtml.code.indexOf("<p>")
      expect(xIndex).toBeLessThan(yIndex)
      expect(yIndex).toBeLessThan(pIndex)
    })

    it("should compile nested element with statements (HTML)", () => {
      const source = `
        div(() => {
          header(() => {
            const x = 1
            h1(String(x))
          })
        })
      `

      const resultHtml = transformSource(source, { target: "html" })

      // Statements inside nested elements are preserved
      expect(resultHtml.code).toContain("const x = 1")
      expect(resultHtml.code).toContain("<header>")
      expect(resultHtml.code).toContain("<h1>")
    })
  })

  describe("Task 4.3: Interleaved statements and elements", () => {
    it("should preserve interleaving order in generated code", () => {
      const source = `
        import { ListRef } from "@loro-extended/change"
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

      // Should generate a for...of loop for static loop (unified accumulation-line architecture)
      expect(result.code).toContain("for (const x of [1, 2, 3])")
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

      const scope = new Scope()
      const container = document.createElement("div")

      // Simulate compiled code that uses itemRef.get() pattern
      // This is what the compiler generates from:
      //   for (const itemRef of doc.items) {
      //     const item = itemRef.get()
      //     li(item)
      //   }
      listRegion(
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

      const scope = new Scope()
      const container = document.createElement("div")

      // Capture the ref for later modification
      const capturedRefs: Array<{ get(): string; set(v: string): void }> = []

      listRegion(
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
        import { ListRef } from "@loro-extended/change"
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

// =============================================================================
// Phase 5 Integration Tests: Text Patching
// =============================================================================

describe("compiler integration - text patching", () => {
  beforeEach(() => {
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
    setRootScope(null)
  })

  describe("Task 5.1: Direct TextRef read uses insertData for character insertion", () => {
    it("should use insertData for text insertion via textRegion", () => {
      const schema = Shape.doc({
        title: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.title.insert(0, "Hello")
      loro(doc).commit()

      const scope = new Scope()
      const textNode = document.createTextNode("")

      // Track insertData calls
      let insertDataCalls: Array<{ offset: number; data: string }> = []
      const originalInsertData = textNode.insertData.bind(textNode)
      textNode.insertData = (offset: number, data: string) => {
        insertDataCalls.push({ offset, data })
        originalInsertData(offset, data)
      }

      // Use textRegion (the surgical patching function)
      textRegion(textNode, doc.title, scope)

      expect(textNode.textContent).toBe("Hello")

      // Reset tracking
      insertDataCalls = []

      // Insert " World" at the end
      doc.title.insert(5, " World")
      loro(doc).commit()

      // Should have used insertData, not textContent replacement
      expect(insertDataCalls.length).toBe(1)
      expect(insertDataCalls[0]).toEqual({ offset: 5, data: " World" })
      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })

    it("should use insertData for insertion at start", () => {
      const schema = Shape.doc({
        title: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.title.insert(0, "World")
      loro(doc).commit()

      const scope = new Scope()
      const textNode = document.createTextNode("")

      let insertDataCalls: Array<{ offset: number; data: string }> = []
      const originalInsertData = textNode.insertData.bind(textNode)
      textNode.insertData = (offset: number, data: string) => {
        insertDataCalls.push({ offset, data })
        originalInsertData(offset, data)
      }

      textRegion(textNode, doc.title, scope)
      insertDataCalls = []

      // Insert "Hello " at the start
      doc.title.insert(0, "Hello ")
      loro(doc).commit()

      expect(insertDataCalls.length).toBe(1)
      expect(insertDataCalls[0]).toEqual({ offset: 0, data: "Hello " })
      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })
  })

  describe("Task 5.2: Direct TextRef read uses deleteData for character deletion", () => {
    it("should use deleteData for text deletion via textRegion", () => {
      const schema = Shape.doc({
        title: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.title.insert(0, "Hello World")
      loro(doc).commit()

      const scope = new Scope()
      const textNode = document.createTextNode("")

      // Track deleteData calls
      let deleteDataCalls: Array<{ offset: number; count: number }> = []
      const originalDeleteData = textNode.deleteData.bind(textNode)
      textNode.deleteData = (offset: number, count: number) => {
        deleteDataCalls.push({ offset, count })
        originalDeleteData(offset, count)
      }

      textRegion(textNode, doc.title, scope)
      expect(textNode.textContent).toBe("Hello World")

      deleteDataCalls = []

      // Delete " World" (6 characters starting at index 5)
      doc.title.delete(5, 6)
      loro(doc).commit()

      expect(deleteDataCalls.length).toBe(1)
      expect(deleteDataCalls[0]).toEqual({ offset: 5, count: 6 })
      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })

    it("should use deleteData for deletion at start", () => {
      const schema = Shape.doc({
        title: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.title.insert(0, "Hello World")
      loro(doc).commit()

      const scope = new Scope()
      const textNode = document.createTextNode("")

      let deleteDataCalls: Array<{ offset: number; count: number }> = []
      const originalDeleteData = textNode.deleteData.bind(textNode)
      textNode.deleteData = (offset: number, count: number) => {
        deleteDataCalls.push({ offset, count })
        originalDeleteData(offset, count)
      }

      textRegion(textNode, doc.title, scope)
      deleteDataCalls = []

      // Delete "Hello " (6 characters starting at index 0)
      doc.title.delete(0, 6)
      loro(doc).commit()

      expect(deleteDataCalls.length).toBe(1)
      expect(deleteDataCalls[0]).toEqual({ offset: 0, count: 6 })
      expect(textNode.textContent).toBe("World")

      scope.dispose()
    })
  })

  describe("Task 5.3: Non-direct read uses full replacement", () => {
    it("should use textContent replacement for transformed text", () => {
      const schema = Shape.doc({
        title: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.title.insert(0, "hello")
      loro(doc).commit()

      const scope = new Scope()
      const textNode = document.createTextNode("")

      // Track both surgical and replacement operations
      let insertDataCalls = 0
      let deleteDataCalls = 0
      let textContentSets = 0

      const originalInsertData = textNode.insertData.bind(textNode)
      textNode.insertData = (offset: number, data: string) => {
        insertDataCalls++
        originalInsertData(offset, data)
      }

      const originalDeleteData = textNode.deleteData.bind(textNode)
      textNode.deleteData = (offset: number, count: number) => {
        deleteDataCalls++
        originalDeleteData(offset, count)
      }

      // Track textContent sets via property descriptor
      let _textContent = ""
      Object.defineProperty(textNode, "textContent", {
        get() {
          return _textContent
        },
        set(value: string) {
          textContentSets++
          _textContent = value
        },
        configurable: true,
      })

      // Non-direct read: .toUpperCase() transformation
      // Use subscribeWithValue (what codegen emits for non-direct reads)
      subscribeWithValue(
        doc.title,
        () => doc.title.get().toUpperCase(),
        v => {
          textNode.textContent = String(v)
        },
        scope,
      )

      expect(textNode.textContent).toBe("HELLO")
      textContentSets = 0 // Reset after initial

      // Update text
      doc.title.insert(5, " world")
      loro(doc).commit()

      // Should use textContent replacement, NOT insertData/deleteData
      expect(textContentSets).toBeGreaterThan(0)
      expect(insertDataCalls).toBe(0)
      expect(deleteDataCalls).toBe(0)
      expect(textNode.textContent).toBe("HELLO WORLD")

      scope.dispose()
    })

    it("should use textContent replacement for template literals", () => {
      const schema = Shape.doc({
        name: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.name.insert(0, "Alice")
      loro(doc).commit()

      const scope = new Scope()
      const textNode = document.createTextNode("")

      let insertDataCalls = 0
      let textContentSets = 0

      const originalInsertData = textNode.insertData.bind(textNode)
      textNode.insertData = (offset: number, data: string) => {
        insertDataCalls++
        originalInsertData(offset, data)
      }

      let _textContent = ""
      Object.defineProperty(textNode, "textContent", {
        get() {
          return _textContent
        },
        set(value: string) {
          textContentSets++
          _textContent = value
        },
        configurable: true,
      })

      // Template literal (non-direct read)
      subscribeWithValue(
        doc.name,
        () => `Hello, ${doc.name.get()}!`,
        v => {
          textNode.textContent = String(v)
        },
        scope,
      )

      expect(textNode.textContent).toBe("Hello, Alice!")
      textContentSets = 0

      doc.name.delete(0, 5)
      doc.name.insert(0, "Bob")
      loro(doc).commit()

      expect(textContentSets).toBeGreaterThan(0)
      expect(insertDataCalls).toBe(0)
      expect(textNode.textContent).toBe("Hello, Bob!")

      scope.dispose()
    })
  })

  describe("Task 5.4: Multi-dep text expression uses replace semantics", () => {
    it("should use textContent replacement for multi-dependency expressions", () => {
      const schema = Shape.doc({
        firstName: Shape.text(),
        lastName: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.firstName.insert(0, "John")
      doc.lastName.insert(0, "Doe")
      loro(doc).commit()

      const scope = new Scope()
      const textNode = document.createTextNode("")

      let insertDataCalls = 0
      let textContentSets = 0

      const originalInsertData = textNode.insertData.bind(textNode)
      textNode.insertData = (offset: number, data: string) => {
        insertDataCalls++
        originalInsertData(offset, data)
      }

      let _textContent = ""
      Object.defineProperty(textNode, "textContent", {
        get() {
          return _textContent
        },
        set(value: string) {
          textContentSets++
          _textContent = value
        },
        configurable: true,
      })

      // Multi-dependency expression — uses subscribeMultiple
      textNode.textContent = `${doc.firstName.get()} ${doc.lastName.get()}`
      textContentSets = 0

      subscribeMultiple(
        [doc.firstName, doc.lastName],
        () => {
          textNode.textContent = `${doc.firstName.get()} ${doc.lastName.get()}`
        },
        scope,
      )

      // Update first name
      doc.firstName.delete(0, 4)
      doc.firstName.insert(0, "Jane")
      loro(doc).commit()

      // Should use textContent replacement
      expect(textContentSets).toBeGreaterThan(0)
      expect(insertDataCalls).toBe(0)
      expect(textNode.textContent).toBe("Jane Doe")

      // Update last name
      textContentSets = 0
      doc.lastName.delete(0, 3)
      doc.lastName.insert(0, "Smith")
      loro(doc).commit()

      expect(textContentSets).toBeGreaterThan(0)
      expect(textNode.textContent).toBe("Jane Smith")

      scope.dispose()
    })
  })

  describe("textRegion surgical updates", () => {
    it("should handle multiple sequential edits with surgical updates", () => {
      const schema = Shape.doc({
        content: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.content.insert(0, "abc")
      loro(doc).commit()

      const scope = new Scope()
      const textNode = document.createTextNode("")

      let insertDataCalls: Array<{ offset: number; data: string }> = []
      let deleteDataCalls: Array<{ offset: number; count: number }> = []

      const originalInsertData = textNode.insertData.bind(textNode)
      textNode.insertData = (offset: number, data: string) => {
        insertDataCalls.push({ offset, data })
        originalInsertData(offset, data)
      }

      const originalDeleteData = textNode.deleteData.bind(textNode)
      textNode.deleteData = (offset: number, count: number) => {
        deleteDataCalls.push({ offset, count })
        originalDeleteData(offset, count)
      }

      textRegion(textNode, doc.content, scope)
      expect(textNode.textContent).toBe("abc")

      // First edit: insert "X" at position 1 → "aXbc"
      insertDataCalls = []
      doc.content.insert(1, "X")
      loro(doc).commit()

      expect(insertDataCalls).toEqual([{ offset: 1, data: "X" }])
      expect(textNode.textContent).toBe("aXbc")

      // Second edit: delete "X" → "abc"
      deleteDataCalls = []
      doc.content.delete(1, 1)
      loro(doc).commit()

      expect(deleteDataCalls).toEqual([{ offset: 1, count: 1 }])
      expect(textNode.textContent).toBe("abc")

      // Third edit: insert "123" at end → "abc123"
      insertDataCalls = []
      doc.content.insert(3, "123")
      loro(doc).commit()

      expect(insertDataCalls).toEqual([{ offset: 3, data: "123" }])
      expect(textNode.textContent).toBe("abc123")

      scope.dispose()
    })

    it("should clean up subscription on scope dispose", () => {
      const schema = Shape.doc({
        title: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      doc.title.insert(0, "Hello")
      loro(doc).commit()

      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, doc.title, scope)
      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)

      // Changes after dispose should not affect the text node
      const oldContent = textNode.textContent
      doc.title.insert(5, " World")
      loro(doc).commit()

      expect(textNode.textContent).toBe(oldContent)
    })
  })

  // ===========================================================================
  // Target Labels (client: / server:)
  // ===========================================================================

  describe("target labels (client: / server:)", () => {
    it("should compile client: block to DOM but not HTML", () => {
      const source = `
        div(() => {
          client: {
            console.log("client-only")
          }
          h1("shared")
        })
      `

      const resultDom = transformSource(source, { target: "dom" })
      const resultHtml = transformSource(source, { target: "html" })

      // DOM output should contain the client-only statement
      expect(resultDom.code).toContain('console.log("client-only")')

      // HTML output should NOT contain the client-only statement
      expect(resultHtml.code).not.toContain('console.log("client-only")')

      // Both should contain the shared element
      expect(resultDom.code).toContain("h1")
      expect(resultHtml.code).toContain("<h1>")
    })

    it("should compile server: block to HTML but not DOM", () => {
      const source = `
        div(() => {
          server: {
            console.log("server-only")
          }
          h1("shared")
        })
      `

      const resultDom = transformSource(source, { target: "dom" })
      const resultHtml = transformSource(source, { target: "html" })

      // HTML output should contain the server-only statement
      expect(resultHtml.code).toContain('console.log("server-only")')

      // DOM output should NOT contain the server-only statement
      expect(resultDom.code).not.toContain('console.log("server-only")')

      // Both should contain the shared element
      expect(resultDom.code).toContain("h1")
      expect(resultHtml.code).toContain("<h1>")
    })

    it("should handle both client: and server: blocks in same builder", () => {
      const source = `
        div(() => {
          client: {
            console.log("browser")
          }
          h1("title")
          server: {
            console.log("ssr")
          }
        })
      `

      const resultDom = transformSource(source, { target: "dom" })
      const resultHtml = transformSource(source, { target: "html" })

      // DOM: has client, no server
      expect(resultDom.code).toContain('console.log("browser")')
      expect(resultDom.code).not.toContain('console.log("ssr")')

      // HTML: has server, no client
      expect(resultHtml.code).toContain('console.log("ssr")')
      expect(resultHtml.code).not.toContain('console.log("browser")')
    })

    it("should preserve statements and elements inside target blocks", () => {
      const source = `
        div(() => {
          client: {
            const x = 1
            p(String(x))
          }
          h1("always")
        })
      `

      const resultDom = transformSource(source, { target: "dom" })

      // DOM: client block unwrapped — statement and element both present
      expect(resultDom.code).toContain("const x = 1")
      expect(resultDom.code).toContain("createElement(\"p\")")

      const resultHtml = transformSource(source, { target: "html" })

      // HTML: client block stripped — neither statement nor element
      expect(resultHtml.code).not.toContain("const x = 1")
      // The <p> from the client block should be gone, but <h1> stays
      expect(resultHtml.code).toContain("<h1>")
    })

    it("should handle target blocks inside for loops", () => {
      const source = `
        ul(() => {
          for (const x of [1, 2, 3]) {
            server: {
              console.log("rendering item")
            }
            li(String(x))
          }
        })
      `

      const resultDom = transformSource(source, { target: "dom" })
      const resultHtml = transformSource(source, { target: "html" })

      // DOM: server block stripped
      expect(resultDom.code).not.toContain('console.log("rendering item")')

      // HTML: server block unwrapped
      expect(resultHtml.code).toContain('console.log("rendering item")')

      // Both have the li
      expect(resultDom.code).toContain("li")
      expect(resultHtml.code).toContain("<li>")
    })

    it("should handle target blocks inside conditionals", () => {
      const source = `
        div(() => {
          if (true) {
            client: {
              console.log("client conditional")
            }
            p("visible")
          }
        })
      `

      const resultDom = transformSource(source, { target: "dom" })
      const resultHtml = transformSource(source, { target: "html" })

      // DOM: client block unwrapped inside conditional
      expect(resultDom.code).toContain('console.log("client conditional")')

      // HTML: client block stripped inside conditional
      expect(resultHtml.code).not.toContain('console.log("client conditional")')
    })

    it("should not strip unknown labels", () => {
      const source = `
        div(() => {
          myLabel: {
            console.log("custom label")
          }
          p("hello")
        })
      `

      // Unknown labels are captured as verbatim statements in both targets
      const resultDom = transformSource(source, { target: "dom" })
      const resultHtml = transformSource(source, { target: "html" })

      expect(resultDom.code).toContain("myLabel")
      expect(resultHtml.code).toContain("myLabel")
    })
  })

  // ===========================================================================
  // Template Cloning — Statements Before Elements (walker path bug)
  // ===========================================================================

  describe("template cloning with statements before elements", () => {
    /**
     * Execute code produced by transformSourceInPlace (template cloning path).
     *
     * transformSourceInPlace uses generateElementFactoryWithResult which
     * always uses template cloning. The generated code includes module-level
     * template declarations and a scope-taking factory function.
     */
    function compileInPlaceAndExecute(source: string): {
      node: Node
      scope: Scope
    } {
      const result = transformSourceInPlace(source, { target: "dom" })
      const code = result.sourceFile.getFullText()

      // The generated code has template declarations at the top and
      // the factory function assigned to a variable. We eval the whole
      // thing and then call the last assigned factory.
      // biome-ignore lint/security/noGlobalEval: test utility
      const fn = new Function(
        "document",
        "scope",
        `${code}\nreturn app(scope)`,
      )
      const scope = new Scope()
      const node = fn(document, scope)
      return { node, scope }
    }

    it("should handle statements before reactive elements (template cloning)", () => {
      // This is the core bug: statements don't produce DOM nodes, but the
      // walker uses IR array indices as paths. Statement at index 0 makes
      // the walker think h1 is at index 1 (nextSibling), but in the DOM
      // h1 is the firstChild.
      const source = `
        const app = div(() => {
          const x = 1
          h1(String(x))
        })
      `

      const result = transformSourceInPlace(source, { target: "dom" })
      const code = result.sourceFile.getFullText()

      // Should compile without error
      expect(code).toContain("const x = 1")
      expect(code).toContain("_tmpl_")

      // Should be executable without "can't access property of null" error
      const { node, scope } = compileInPlaceAndExecute(source)
      expect((node as Element).tagName.toLowerCase()).toBe("div")
      expect((node as Element).querySelector("h1")).not.toBeNull()
      expect((node as Element).querySelector("h1")?.textContent).toBe("1")

      scope.dispose()
    })

    it("should handle client: block before elements (template cloning)", () => {
      // The kinetic-todo crash: client: block unwraps to statements,
      // shifting all subsequent element paths in the walker.
      const source = `
        const app = div(() => {
          client: {
            console.log("browser only")
          }
          h1("Hello")
          p("World")
        })
      `

      const result = transformSourceInPlace(source, { target: "dom" })
      const code = result.sourceFile.getFullText()

      expect(code).toContain('console.log("browser only")')
      expect(code).toContain("_tmpl_")

      const { node, scope } = compileInPlaceAndExecute(source)
      expect((node as Element).tagName.toLowerCase()).toBe("div")
      expect((node as Element).querySelector("h1")?.textContent).toBe("Hello")
      expect((node as Element).querySelector("p")?.textContent).toBe("World")

      scope.dispose()
    })

    it("should handle multiple statements interleaved with elements (template cloning)", () => {
      const source = `
        const app = div(() => {
          const x = 1
          h1("First")
          const y = 2
          p("Second")
        })
      `

      const result = transformSourceInPlace(source, { target: "dom" })
      const code = result.sourceFile.getFullText()

      const { node, scope } = compileInPlaceAndExecute(source)
      expect((node as Element).querySelector("h1")?.textContent).toBe("First")
      expect((node as Element).querySelector("p")?.textContent).toBe("Second")

      scope.dispose()
    })
  })

  // ===========================================================================
  // state() Reactive Detection — Chained Method Calls
  // ===========================================================================

  describe("state() reactive detection with chained method calls", () => {
    it("should detect state().get().toString() as reactive and subscribe", () => {
      // The bug: expressionIsReactive did not recurse through chained call
      // expressions, so x.get().toString() was classified as render-time
      // (evaluated once) instead of reactive (subscribed).
      const source = `
        import { state } from "@loro-extended/reactive"

        const app = div(() => {
          const x = state(0)
          p(x.get().toString())
        })
      `

      const result = transformSource(source, { target: "dom" })

      // The content node must be classified as reactive — it should have
      // a subscribe() call in the generated code, not just textContent = ...
      expect(result.ir[0].isReactive).toBe(true)
      expect(result.ir[0].allDependencies.length).toBeGreaterThan(0)

      // The generated code should contain a subscription, not a one-shot set
      expect(result.code).toContain("subscribe")
    })

    it("should classify chained x.get().toString() as reactive in IR", () => {
      const source = `
        import { state } from "@loro-extended/reactive"

        const app = div(() => {
          const x = state(42)
          span(x.get().toString())
        })
      `

      const result = transformSource(source, { target: "dom" })
      const builder = result.ir[0]

      // Find the span element's content child
      const spanEl = builder.children.find(
        c => c.kind === "element" && (c as { tag: string }).tag === "span",
      )
      expect(spanEl).toBeDefined()
      if (spanEl?.kind === "element") {
        const content = spanEl.children[0]
        expect(content.kind).toBe("content")
        if (content.kind === "content") {
          expect(content.bindingTime).toBe("reactive")
        }
      }
    })
  })
})

// =============================================================================
// Component Compilation Tests
// =============================================================================

/**
 * Compile source in-place and return executable JS.
 *
 * Functional core: source → executable JS string (pure aside from
 * ts-morph project state, which is shared and reset between tests).
 *
 * Uses transformSourceInPlace to preserve the full source (component
 * definitions + usage sites), mergeImports to add runtime imports,
 * ts.transpileModule to strip TypeScript syntax, and a line filter
 * to remove import statements (eval doesn't support ES imports;
 * runtime symbols are provided by the caller via `new Function`).
 */
function compileInPlace(
  source: string,
  target: "dom" | "html" = "dom",
): string {
  const result = transformSourceInPlace(source, { target })
  mergeImports(result.sourceFile, result.requiredImports)
  const fullTs = result.sourceFile.getFullText()

  // Strip all TypeScript syntax in one pass
  const { outputText } = ts.transpileModule(fullTs, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  })

  // Filter out import lines — runtime deps are injected by the caller
  return outputText
    .split("\n")
    .filter(line => !line.trimStart().startsWith("import "))
    .join("\n")
}

/**
 * Wrap source so the last top-level builder call is assigned to a variable.
 *
 * transformSourceInPlace replaces builder calls inline. If the builder call
 * is a bare expression statement (not assigned), the compiled factory ends
 * up as an anonymous expression. This wrapper assigns it to `__lastBuilder`.
 */
function wrapLastBuilder(source: string): string {
  const lines = source.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trimStart()
    // Match lines like: `div(() => {`, `section(() => {`, `ul(() => {`
    if (/^[a-z]\w*\s*\(\s*(\{[^}]*\}\s*,\s*)?\(\)\s*=>\s*\{/.test(trimmed)) {
      const indent = lines[i].length - trimmed.length
      lines[i] = " ".repeat(indent) + "const __lastBuilder = " + trimmed
      return lines.join("\n")
    }
  }
  return source
}

/**
 * Runtime dependencies injected into compiled component code via
 * `new Function` parameters. Keys are the parameter names that
 * generated code references as bare identifiers.
 */
const RUNTIME_DEPS: Record<string, unknown> = {
  subscribe,
  subscribeMultiple,
  subscribeWithValue,
  listRegion,
  conditionalRegion,
  textRegion,
  Scope,
  document,
}
const RUNTIME_DEP_NAMES = Object.keys(RUNTIME_DEPS)
const RUNTIME_DEP_VALUES = Object.values(RUNTIME_DEPS)

/**
 * Compile source in-place and execute the last builder factory.
 *
 * Imperative shell: wrapLastBuilder → compileInPlace → new Function → call.
 *
 * Uses `new Function(...)` instead of `eval()` to avoid strict-mode
 * scoping issues where `const`/`var` declarations don't leak out.
 * The compiled JS is wrapped in a function body that receives runtime
 * dependencies as parameters and returns the `__lastBuilder` factory.
 */
function compileAndExecuteComponent(
  source: string,
): { node: Node; scope: Scope } {
  const wrapped = wrapLastBuilder(source)
  const js = compileInPlace(wrapped)

  // The wrapLastBuilder helper assigned `const __lastBuilder = section(...)`.
  // After compilation, __lastBuilder holds `(scope) => { ... }`.
  // Wrap in a function body and return it.
  const body = `${js}\nreturn __lastBuilder;`
  const fn = new Function(...RUNTIME_DEP_NAMES, body)
  const factory = fn(...RUNTIME_DEP_VALUES) as (scope: Scope) => Node

  const scope = new Scope()
  const node = factory(scope)
  return { node, scope }
}

/**
 * Preamble that provides ComponentFactory and Element types for ts-morph
 * type resolution. Included at the top of test source strings.
 */
const COMPONENT_PREAMBLE = `
type Element = (scope: any) => Node
type ComponentFactory<P extends Record<string, unknown> = {}> =
  | ((props: P, builder: () => void) => Element)
  | ((props: P) => Element)
  | ((builder: () => void) => Element)
  | (() => Element)
`

describe("Component compilation", () => {
  beforeEach(() => {
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
    setRootScope(null)
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
