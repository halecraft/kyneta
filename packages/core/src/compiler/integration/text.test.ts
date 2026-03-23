import { beforeEach, describe, expect, it } from "vitest"

import {
  createMockTextRef,
  getActiveSubscriptionCount,
  inputTextRegion,
  installDOMGlobals,
  read,
  resetTestState,
  Scope,
  textRegion,
  transformSource,
  transformSourceInPlace,
  valueRegion,
  withTypes,
} from "./helpers.js"

installDOMGlobals()

describe("compiler integration - text patching", () => {
  beforeEach(() => {
    resetTestState()
  })

  describe("Direct TextRef read uses insertData for character insertion", () => {
    it("should use insertData for text insertion via textRegion", () => {
      const { ref: title } = createMockTextRef("Hello")

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
      textRegion(textNode, title, scope)

      expect(textNode.textContent).toBe("Hello")

      // Reset tracking
      insertDataCalls = []

      // Insert " World" at the end
      title.insert(5, " World")

      // Should have used insertData, not textContent replacement
      expect(insertDataCalls.length).toBe(1)
      expect(insertDataCalls[0]).toEqual({ offset: 5, data: " World" })
      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })

    it("should use insertData for insertion at start", () => {
      const { ref: title } = createMockTextRef("World")

      const scope = new Scope()
      const textNode = document.createTextNode("")

      let insertDataCalls: Array<{ offset: number; data: string }> = []
      const originalInsertData = textNode.insertData.bind(textNode)
      textNode.insertData = (offset: number, data: string) => {
        insertDataCalls.push({ offset, data })
        originalInsertData(offset, data)
      }

      textRegion(textNode, title, scope)
      insertDataCalls = []

      // Insert "Hello " at the start
      title.insert(0, "Hello ")

      expect(insertDataCalls.length).toBe(1)
      expect(insertDataCalls[0]).toEqual({ offset: 0, data: "Hello " })
      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })
  })

  describe("Direct TextRef read uses deleteData for character deletion", () => {
    it("should use deleteData for text deletion via textRegion", () => {
      const { ref: title } = createMockTextRef("Hello World")

      const scope = new Scope()
      const textNode = document.createTextNode("")

      // Track deleteData calls
      let deleteDataCalls: Array<{ offset: number; count: number }> = []
      const originalDeleteData = textNode.deleteData.bind(textNode)
      textNode.deleteData = (offset: number, count: number) => {
        deleteDataCalls.push({ offset, count })
        originalDeleteData(offset, count)
      }

      textRegion(textNode, title, scope)
      expect(textNode.textContent).toBe("Hello World")

      deleteDataCalls = []

      // Delete " World" (6 characters starting at index 5)
      title.delete(5, 6)

      expect(deleteDataCalls.length).toBe(1)
      expect(deleteDataCalls[0]).toEqual({ offset: 5, count: 6 })
      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })

    it("should use deleteData for deletion at start", () => {
      const { ref: title } = createMockTextRef("Hello World")

      const scope = new Scope()
      const textNode = document.createTextNode("")

      let deleteDataCalls: Array<{ offset: number; count: number }> = []
      const originalDeleteData = textNode.deleteData.bind(textNode)
      textNode.deleteData = (offset: number, count: number) => {
        deleteDataCalls.push({ offset, count })
        originalDeleteData(offset, count)
      }

      textRegion(textNode, title, scope)
      deleteDataCalls = []

      // Delete "Hello " (6 characters starting at index 0)
      title.delete(0, 6)

      expect(deleteDataCalls.length).toBe(1)
      expect(deleteDataCalls[0]).toEqual({ offset: 0, count: 6 })
      expect(textNode.textContent).toBe("World")

      scope.dispose()
    })
  })

  describe("Non-direct read uses full replacement", () => {
    it("should use textContent replacement for transformed text", () => {
      const { ref: title } = createMockTextRef("hello")

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
      // Use valueRegion (what codegen emits for non-direct reads)
      valueRegion(
        [title],
        () => (read(title) as string).toUpperCase(),
        v => {
          textNode.textContent = String(v)
        },
        scope,
      )

      expect(textNode.textContent).toBe("HELLO")
      textContentSets = 0 // Reset after initial

      // Update text
      title.insert(5, " world")

      // Should use textContent replacement, NOT insertData/deleteData
      expect(textContentSets).toBeGreaterThan(0)
      expect(insertDataCalls).toBe(0)
      expect(deleteDataCalls).toBe(0)
      expect(textNode.textContent).toBe("HELLO WORLD")

      scope.dispose()
    })

    it("should use textContent replacement for template literals", () => {
      const { ref: name } = createMockTextRef("Alice")

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
      valueRegion(
        [name],
        () => `Hello, ${read(name)}!`,
        v => {
          textNode.textContent = String(v)
        },
        scope,
      )

      expect(textNode.textContent).toBe("Hello, Alice!")
      textContentSets = 0

      name.delete(0, 5)
      name.insert(0, "Bob")

      expect(textContentSets).toBeGreaterThan(0)
      expect(insertDataCalls).toBe(0)
      expect(textNode.textContent).toBe("Hello, Bob!")

      scope.dispose()
    })
  })

  describe("Multi-dep text expression uses replace semantics", () => {
    it("should use textContent replacement for multi-dependency expressions", () => {
      const { ref: firstName } = createMockTextRef("John")
      const { ref: lastName } = createMockTextRef("Doe")

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

      // Multi-dependency expression — uses valueRegion
      // valueRegion handles initial render, so reset counter after it runs
      valueRegion(
        [firstName, lastName],
        () => `${read(firstName)} ${read(lastName)}`,
        v => {
          textNode.textContent = v
        },
        scope,
      )
      textContentSets = 0

      // Update first name
      firstName.delete(0, 4)
      firstName.insert(0, "Jane")

      // Should use textContent replacement
      expect(textContentSets).toBeGreaterThan(0)
      expect(insertDataCalls).toBe(0)
      expect(textNode.textContent).toBe("Jane Doe")

      // Update last name
      textContentSets = 0
      lastName.delete(0, 3)
      lastName.insert(0, "Smith")

      expect(textContentSets).toBeGreaterThan(0)
      expect(textNode.textContent).toBe("Jane Smith")

      scope.dispose()
    })
  })

  describe("textRegion surgical updates", () => {
    it("should handle multiple sequential edits with surgical updates", () => {
      const { ref: content } = createMockTextRef("abc")

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

      textRegion(textNode, content, scope)
      expect(textNode.textContent).toBe("abc")

      // First edit: insert "X" at position 1 → "aXbc"
      insertDataCalls = []
      content.insert(1, "X")

      expect(insertDataCalls).toEqual([{ offset: 1, data: "X" }])
      expect(textNode.textContent).toBe("aXbc")

      // Second edit: delete "X" → "abc"
      deleteDataCalls = []
      content.delete(1, 1)

      expect(deleteDataCalls).toEqual([{ offset: 1, count: 1 }])
      expect(textNode.textContent).toBe("abc")

      // Third edit: insert "123" at end → "abc123"
      insertDataCalls = []
      content.insert(3, "123")

      expect(insertDataCalls).toEqual([{ offset: 3, data: "123" }])
      expect(textNode.textContent).toBe("abc123")

      scope.dispose()
    })

    it("should clean up subscription on scope dispose", () => {
      const { ref: title } = createMockTextRef("Hello")

      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, title, scope)
      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)

      // Changes after dispose should not affect the text node
      const oldContent = textNode.textContent
      title.insert(5, " World")

      expect(textNode.textContent).toBe(oldContent)
    })
  })

  // ===========================================================================
  // inputTextRegion — delta-aware input value patching
  // ===========================================================================

  describe("inputTextRegion for value attributes", () => {
    it("should generate inputTextRegion call for input with explicit TextRef value", () => {
      const source = withTypes(`
        declare const title: TextRef

        div(() => {
          input({ value: title.toString() })
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Verify the IR has the right shape
      const builder = result.ir[0]
      const inputEl = builder.children.find(
        (c: any) => c.kind === "element" && c.tag === "input",
      ) as any
      expect(inputEl).toBeDefined()
      const valueAttr = inputEl.attributes.find((a: any) => a.name === "value")
      expect(valueAttr).toBeDefined()
      expect(valueAttr.value.bindingTime).toBe("reactive")
      expect(valueAttr.value.dependencies).toHaveLength(1)
      expect(valueAttr.value.dependencies[0].deltaKind).toBe("text")

      // Generated code should use valueRegion for reactive value attribute
      expect(result.code).toContain("valueRegion")
    })

    it("should generate inputTextRegion for schema-inferred TextRef on value attribute", () => {
      // This test verifies the narrow-delta-types fix works end-to-end:
      // CHANGEFEED schema inference → TextRef → deltaKind "text" → valueRegion
      const source = withTypes(`
        declare const doc: { title: TextRef }

        div(() => {
          input({ value: doc.title.toString() })
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Schema-inferred TextRef should resolve deltaKind "text"
      // Compiler now emits valueRegion for all reactive attributes
      expect(result.code).toContain("valueRegion")
    })

    it("should NOT generate inputTextRegion for non-direct TextRef read on value", () => {
      const source = withTypes(`
        declare const title: TextRef

        div(() => {
          input({ value: title.toString().toUpperCase() })
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Should NOT use inputTextRegion (not a direct read)
      expect(result.code).not.toContain("inputTextRegion")
      // Should use valueRegion for the reactive attribute
      expect(result.code).toContain("valueRegion")
    })

    it("should apply surgical updates to input.value via inputTextRegion", () => {
      const { ref: title } = createMockTextRef("Hello")

      const scope = new Scope()
      const input = document.createElement("input") as HTMLInputElement

      // Mock setRangeText with a functional implementation
      const setRangeTextCalls: Array<{
        text: string
        start: number
        end: number
        mode: string
      }> = []
      input.setRangeText = ((
        text: string,
        start: number,
        end: number,
        mode?: string,
      ) => {
        setRangeTextCalls.push({
          text,
          start,
          end,
          mode: mode ?? "preserve",
        })
        const current = input.value
        input.value = current.slice(0, start) + text + current.slice(end)
      }) as HTMLInputElement["setRangeText"]

      // Use inputTextRegion directly (the function that generated code calls)
      inputTextRegion(input, title, scope)
      expect(input.value).toBe("Hello")

      // Insert " World" at end — should use setRangeText, not full replacement
      title.insert(5, " World")

      expect(input.value).toBe("Hello World")
      expect(setRangeTextCalls.length).toBe(1)
      expect(setRangeTextCalls[0]).toEqual({
        text: " World",
        start: 5,
        end: 5,
        mode: "end",
      })

      // Delete " World" — should also use setRangeText
      setRangeTextCalls.length = 0
      title.delete(5, 6)

      expect(input.value).toBe("Hello")
      expect(setRangeTextCalls.length).toBe(1)
      expect(setRangeTextCalls[0]).toEqual({
        text: "",
        start: 5,
        end: 11,
        mode: "end",
      })

      scope.dispose()
    })

    it("should clean up inputTextRegion subscription on scope dispose", () => {
      const { ref: title } = createMockTextRef("Hello")

      const scope = new Scope()
      const input = document.createElement("input") as HTMLInputElement

      inputTextRegion(input, title, scope)
      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)

      // Changes after dispose should not affect the input
      title.insert(5, " World")

      expect(input.value).toBe("Hello")
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
      expect(resultDom.code).toContain('createElement("p")')

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
      const fn = new Function("document", "scope", `${code}\nreturn app(scope)`)
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
      // The kyneta-todo crash: client: block unwraps to statements,
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
      const _code = result.sourceFile.getFullText()

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
    it("should detect state()().toString() as reactive and subscribe", () => {
      // The bug: expressionIsReactive did not recurse through chained call
      // expressions, so x().toString() was classified as render-time
      // (evaluated once) instead of reactive (subscribed).
      //
      // We use withTypes() + an inline state() declaration so the compiler
      // can fully resolve the CHANGEFEED-bearing return type without needing
      // the real @kyneta/core module resolution (which may not fully chain
      // through LocalRef → CHANGEFEED in the in-memory ts-morph project).
      const source = withTypes(`
        interface LocalRef<T> {
          (): T
          readonly [CHANGEFEED]: Changefeed<T, ReplaceChange<T>>
          set(value: T): void
        }
        declare function state<T>(initial: T): LocalRef<T>

        const app = div(() => {
          const x = state(0)
          p(x().toString())
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // The content node must be classified as reactive — it should have
      // a subscribe() call in the generated code, not just textContent = ...
      expect(result.ir[0].isReactive).toBe(true)
      expect(result.ir[0].allDependencies.length).toBeGreaterThan(0)

      // The generated code should contain a subscription, not a one-shot set
      expect(result.code).toContain("valueRegion")
    })

    it("should classify chained x().toString() as reactive in IR", () => {
      const source = withTypes(`
        interface LocalRef<T> {
          (): T
          readonly [CHANGEFEED]: Changefeed<T, ReplaceChange<T>>
          set(value: T): void
        }
        declare function state<T>(initial: T): LocalRef<T>

        const app = div(() => {
          const x = state(42)
          span(x().toString())
        })
      `)

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
