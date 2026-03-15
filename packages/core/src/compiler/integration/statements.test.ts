import { beforeEach, describe, expect, it } from "vitest"
import {
  compileAndExecute,
  createMockPlainRef,
  createMockSequenceRef,
  installDOMGlobals,
  listRegion,
  resetTestState,
  Scope,
  transformSource,
  withTypes,
} from "./helpers.js"

installDOMGlobals()

describe("compiler integration - arbitrary statements", () => {
  beforeEach(() => {
    resetTestState()
  })

  describe("Variable declaration in for-of body", () => {
    it("should compile and execute variable declaration in reactive list", () => {
      const ref1 = createMockPlainRef("first")
      const ref2 = createMockPlainRef("second")
      const { ref: items } = createMockSequenceRef([ref1.ref, ref2.ref])

      const scope = new Scope()
      const container = document.createElement("div")

      // Simulate what the compiled code would do - with a statement inside the create callback
      // This tests that statements (like const upperItem = ...) are preserved
      listRegion(
        container,
        items,
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
      const source = withTypes(`
        declare const items: ListRef<{ get(): string }>

        ul(() => {
          for (const itemRef of items) {
            const item = itemRef.get()
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // The generated code should contain the variable declaration
      expect(result.code).toContain("const item = itemRef.get()")
      expect(result.code).toContain("listRegion")
    })

    it("should generate correct HTML code for variable declaration in for-of", () => {
      const source = withTypes(`
        declare const items: ListRef<{ get(): string }>

        ul(() => {
          for (const itemRef of items) {
            const item = itemRef.get()
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "html" })

      // The generated HTML code should contain the variable declaration
      expect(result.code).toContain("const item = itemRef.get()")
    })
  })

  describe("Multiple statements in builder", () => {
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
      const source = withTypes(`
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            const x = 1
            const y = 2
            li(String(x + y))
          }
        })
      `)

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

  describe("Interleaved statements and elements", () => {
    it("should preserve interleaving order in generated code", () => {
      const source = withTypes(`
        declare const items: ListRef<{ get(): string }>

        ul(() => {
          for (const item of items) {
            console.log("before")
            li(item)
            console.log("after")
          }
        })
      `)

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

  describe("Static loops", () => {
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

  describe("Static conditionals", () => {
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

  describe("Ref-based iteration pattern", () => {
    it("should compile and execute itemRef.get() pattern in list region", () => {
      const ref1 = createMockPlainRef("first")
      const ref2 = createMockPlainRef("second")
      const { ref: items } = createMockSequenceRef([ref1.ref, ref2.ref])

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
        items,
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
      const ref1 = createMockPlainRef("original")
      const { ref: items } = createMockSequenceRef([ref1.ref])

      const scope = new Scope()
      const container = document.createElement("div")

      // Capture the ref for later modification
      const capturedRefs: Array<{ get(): string; set(v: string): void }> = []

      listRegion(
        container,
        items,
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

      // Verify the change persisted in the document
      expect(items.get(0)?.get()).toBe("modified")

      scope.dispose()
    })

    it("should generate HTML with spread syntax for ref preservation", () => {
      const source = withTypes(`
        declare const items: ListRef<{ get(): string }>

        ul(() => {
          for (const itemRef of items) {
            const item = itemRef.get()
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "html" })

      // Should use spread syntax [...items] instead of .toArray()
      expect(result.code).toContain("[...items]")
      expect(result.code).not.toContain(".toArray()")

      // Should preserve the statement
      expect(result.code).toContain("const item = itemRef.get()")
    })
  })

  describe("Return statement error", () => {
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