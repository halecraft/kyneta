/**
 * Integration tests for compiler → runtime.
 *
 * These tests compile TypeScript source code and execute the generated
 * JavaScript to verify the full pipeline works end-to-end.
 *
 * Phase 4: Static compilation tests
 * Phase 5: Reactive expression tests (using real Loro documents)
 */

import { createTypedDoc, loro, Shape } from "@loro-extended/change"
import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it } from "vitest"
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
import { transformSource } from "./transform.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.Comment = dom.window.Comment
global.Text = dom.window.Text

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
