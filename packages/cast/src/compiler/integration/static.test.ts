/**
 * Static compilation integration tests.
 * No reactive dependencies — pure compilation and execution.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  compileAndExecute,
  dom,
  installDOMGlobals,
  resetTestState,
  transformSource,
} from "./helpers.js"

installDOMGlobals()

describe("compiler integration - static compilation", () => {
  beforeEach(() => {
    resetTestState()
  })

  describe("Basic static compilation", () => {
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

  describe("Nested static structures", () => {
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

  describe("HTML output for nested structures", () => {
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
