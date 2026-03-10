/**
 * SSR Render Module Tests
 *
 * Tests for server-side rendering utilities.
 */

import { describe, expect, it } from "vitest"

import {
  closeMarker,
  createRenderFunction,
  escapeHtml,
  executeRender,
  generateMarkerId,
  isVoidElement,
  openMarker,
  renderAttribute,
  renderAttributes,
  renderCloseTag,
  renderConditional,
  renderElement,
  renderList,
  renderOpenTag,
  renderToDocument,
  renderToString,
  type SSRContext,
} from "./render.js"

// =============================================================================
// HTML Escaping Tests
// =============================================================================

describe("escapeHtml", () => {
  it("should escape ampersands", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry")
  })

  it("should escape less-than signs", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;")
  })

  it("should escape greater-than signs", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b")
  })

  it("should escape double quotes", () => {
    expect(escapeHtml('He said "hello"')).toBe("He said &quot;hello&quot;")
  })

  it("should escape single quotes", () => {
    expect(escapeHtml("It's fine")).toBe("It&#x27;s fine")
  })

  it("should escape multiple special characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    )
  })

  it("should handle empty strings", () => {
    expect(escapeHtml("")).toBe("")
  })

  it("should handle strings without special characters", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World")
  })

  it("should convert non-strings to strings", () => {
    expect(escapeHtml(123 as unknown as string)).toBe("123")
  })
})

// =============================================================================
// Hydration Marker Tests
// =============================================================================

describe("hydration markers", () => {
  describe("generateMarkerId", () => {
    it("should generate unique marker IDs", () => {
      const ctx: SSRContext = { doc: {} }

      const id1 = generateMarkerId(ctx, "list")
      const id2 = generateMarkerId(ctx, "list")
      const id3 = generateMarkerId(ctx, "if")

      expect(id1).toBe("kinetic:list:1")
      expect(id2).toBe("kinetic:list:2")
      expect(id3).toBe("kinetic:if:3")
    })

    it("should start counter at 1 for new context", () => {
      const ctx: SSRContext = { doc: {} }
      const id = generateMarkerId(ctx, "test")
      expect(id).toBe("kinetic:test:1")
    })
  })

  describe("openMarker", () => {
    it("should create opening marker comment", () => {
      expect(openMarker("kinetic:list:1")).toBe("<!--kinetic:list:1-->")
    })
  })

  describe("closeMarker", () => {
    it("should create closing marker comment", () => {
      expect(closeMarker("list")).toBe("<!--/kinetic:list-->")
      expect(closeMarker("if")).toBe("<!--/kinetic:if-->")
    })
  })
})

// =============================================================================
// Void Element Tests
// =============================================================================

describe("isVoidElement", () => {
  it("should recognize void elements", () => {
    expect(isVoidElement("br")).toBe(true)
    expect(isVoidElement("hr")).toBe(true)
    expect(isVoidElement("img")).toBe(true)
    expect(isVoidElement("input")).toBe(true)
    expect(isVoidElement("meta")).toBe(true)
    expect(isVoidElement("link")).toBe(true)
  })

  it("should reject non-void elements", () => {
    expect(isVoidElement("div")).toBe(false)
    expect(isVoidElement("span")).toBe(false)
    expect(isVoidElement("p")).toBe(false)
    expect(isVoidElement("a")).toBe(false)
  })

  it("should be case-insensitive", () => {
    expect(isVoidElement("BR")).toBe(true)
    expect(isVoidElement("Img")).toBe(true)
  })
})

// =============================================================================
// Attribute Rendering Tests
// =============================================================================

describe("renderAttribute", () => {
  it("should render string attributes", () => {
    expect(renderAttribute("class", "container")).toBe(' class="container"')
  })

  it("should escape attribute values", () => {
    expect(renderAttribute("title", 'Say "hello"')).toBe(
      ' title="Say &quot;hello&quot;"',
    )
  })

  it("should render boolean true as attribute name only", () => {
    expect(renderAttribute("disabled", true)).toBe(" disabled")
  })

  it("should omit boolean false attributes", () => {
    expect(renderAttribute("disabled", false)).toBe("")
  })

  it("should omit null attributes", () => {
    expect(renderAttribute("value", null)).toBe("")
  })

  it("should omit undefined attributes", () => {
    expect(renderAttribute("value", undefined)).toBe("")
  })

  it("should convert numbers to strings", () => {
    expect(renderAttribute("tabindex", 0)).toBe(' tabindex="0"')
  })
})

describe("renderAttributes", () => {
  it("should render multiple attributes", () => {
    const result = renderAttributes({
      class: "btn",
      id: "submit",
      type: "button",
    })
    expect(result).toContain(' class="btn"')
    expect(result).toContain(' id="submit"')
    expect(result).toContain(' type="button"')
  })

  it("should handle empty object", () => {
    expect(renderAttributes({})).toBe("")
  })

  it("should filter out false/null/undefined", () => {
    const result = renderAttributes({
      class: "btn",
      disabled: false,
      value: null,
      placeholder: undefined,
    })
    expect(result).toBe(' class="btn"')
  })
})

// =============================================================================
// Tag Rendering Tests
// =============================================================================

describe("renderOpenTag", () => {
  it("should render tag without attributes", () => {
    expect(renderOpenTag("div")).toBe("<div>")
  })

  it("should render tag with attributes", () => {
    expect(renderOpenTag("div", { class: "container" })).toBe(
      '<div class="container">',
    )
  })

  it("should render void elements", () => {
    expect(renderOpenTag("input", { type: "text" })).toBe('<input type="text">')
  })
})

describe("renderCloseTag", () => {
  it("should render closing tag for normal elements", () => {
    expect(renderCloseTag("div")).toBe("</div>")
  })

  it("should return empty string for void elements", () => {
    expect(renderCloseTag("br")).toBe("")
    expect(renderCloseTag("img")).toBe("")
  })
})

describe("renderElement", () => {
  it("should render complete element", () => {
    expect(renderElement("div", { class: "box" }, "Hello")).toBe(
      '<div class="box">Hello</div>',
    )
  })

  it("should render element without attributes", () => {
    expect(renderElement("p", undefined, "Text")).toBe("<p>Text</p>")
  })

  it("should render element without children", () => {
    expect(renderElement("div", { id: "empty" })).toBe('<div id="empty"></div>')
  })

  it("should render void elements without closing tag", () => {
    expect(renderElement("input", { type: "text" })).toBe('<input type="text">')
  })

  it("should render nested elements", () => {
    const inner = renderElement("span", undefined, "World")
    const outer = renderElement("div", undefined, `Hello ${inner}`)
    expect(outer).toBe("<div>Hello <span>World</span></div>")
  })
})

// =============================================================================
// List Rendering Tests
// =============================================================================

describe("renderList", () => {
  it("should render empty list with markers", () => {
    const ctx: SSRContext = { doc: {} }
    const result = renderList(ctx, [], () => "", true)

    expect(result).toContain("<!--kinetic:list:")
    expect(result).toContain("<!--/kinetic:list-->")
  })

  it("should render items with markers", () => {
    const ctx: SSRContext = { doc: {} }
    const items = ["a", "b", "c"]
    const result = renderList(
      ctx,
      items,
      (item, index) => `<li data-index="${index}">${item}</li>`,
      true,
    )

    expect(result).toContain("<!--kinetic:list:")
    expect(result).toContain('<li data-index="0">a</li>')
    expect(result).toContain('<li data-index="1">b</li>')
    expect(result).toContain('<li data-index="2">c</li>')
    expect(result).toContain("<!--/kinetic:list-->")
  })

  it("should render without markers when hydratable is false", () => {
    const ctx: SSRContext = { doc: {} }
    const result = renderList(ctx, ["x"], item => `<li>${item}</li>`, false)

    expect(result).not.toContain("<!--")
    expect(result).toBe("<li>x</li>")
  })

  it("should pass context to render function", () => {
    const doc = { value: 42 }
    const ctx: SSRContext = { doc }
    const result = renderList(
      ctx,
      [1],
      (_item, _index, c) => `<li>${(c.doc as { value: number }).value}</li>`,
      false,
    )

    expect(result).toBe("<li>42</li>")
  })
})

// =============================================================================
// Conditional Rendering Tests
// =============================================================================

describe("renderConditional", () => {
  it("should render true branch when condition is true", () => {
    const ctx: SSRContext = { doc: {} }
    const result = renderConditional(
      ctx,
      true,
      () => "<p>Yes</p>",
      () => "<p>No</p>",
      true,
    )

    expect(result).toContain("<!--kinetic:if:")
    expect(result).toContain("<p>Yes</p>")
    expect(result).not.toContain("<p>No</p>")
    expect(result).toContain("<!--/kinetic:if-->")
  })

  it("should render false branch when condition is false", () => {
    const ctx: SSRContext = { doc: {} }
    const result = renderConditional(
      ctx,
      false,
      () => "<p>Yes</p>",
      () => "<p>No</p>",
      true,
    )

    expect(result).toContain("<p>No</p>")
    expect(result).not.toContain("<p>Yes</p>")
  })

  it("should render nothing for false with no else branch", () => {
    const ctx: SSRContext = { doc: {} }
    const result = renderConditional(
      ctx,
      false,
      () => "<p>Yes</p>",
      undefined,
      true,
    )

    expect(result).toContain("<!--kinetic:if:")
    expect(result).toContain("<!--/kinetic:if-->")
    expect(result).not.toContain("<p>Yes</p>")
  })

  it("should render without markers when hydratable is false", () => {
    const ctx: SSRContext = { doc: {} }
    const result = renderConditional(
      ctx,
      true,
      () => "<p>Content</p>",
      undefined,
      false,
    )

    expect(result).not.toContain("<!--")
    expect(result).toBe("<p>Content</p>")
  })
})

// =============================================================================
// Render Function Tests
// =============================================================================

describe("createRenderFunction", () => {
  it("should create a render function from a template", () => {
    const render = createRenderFunction(ctx => {
      const doc = ctx.doc as { name: string }
      return `<h1>Hello, ${escapeHtml(doc.name)}!</h1>`
    })

    const ctx: SSRContext = { doc: { name: "World" } }
    expect(render(ctx)).toBe("<h1>Hello, World!</h1>")
  })
})

describe("executeRender", () => {
  it("should execute a render function with context", () => {
    const render = (ctx: SSRContext) => {
      const doc = ctx.doc as { count: number }
      return `<span>${doc.count}</span>`
    }

    const result = executeRender(render, { count: 42 })
    expect(result).toBe("<span>42</span>")
  })
})

describe("renderToString", () => {
  it("should render to HTML string", () => {
    const render = () => "<div>Content</div>"
    const result = renderToString(render, {})
    expect(result).toBe("<div>Content</div>")
  })
})

describe("renderToDocument", () => {
  it("should wrap content in HTML document structure", () => {
    const render = () => "<div>App</div>"
    const result = renderToDocument(render, {}, { title: "Test App" })

    expect(result).toContain("<!DOCTYPE html>")
    expect(result).toContain("<html>")
    expect(result).toContain("<title>Test App</title>")
    expect(result).toContain('<div id="root"><div>App</div></div>')
    expect(result).toContain("</html>")
  })

  it("should include head content", () => {
    const render = () => "<div>App</div>"
    const result = renderToDocument(
      render,
      {},
      {
        head: '<link rel="stylesheet" href="style.css">',
      },
    )

    expect(result).toContain('<link rel="stylesheet" href="style.css">')
  })

  it("should include scripts", () => {
    const render = () => "<div>App</div>"
    const result = renderToDocument(
      render,
      {},
      {
        scripts: '<script src="app.js"></script>',
      },
    )

    expect(result).toContain('<script src="app.js"></script>')
  })

  it("should escape title for XSS prevention", () => {
    const render = () => "<div>App</div>"
    const result = renderToDocument(
      render,
      {},
      {
        title: '<script>alert("xss")</script>',
      },
    )

    expect(result).toContain(
      "<title>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</title>",
    )
  })
})

// =============================================================================
// Pretty Printing Tests
// =============================================================================

describe("pretty printing", () => {
  it("should format minified HTML when pretty option is true", () => {
    const render = () => "<div><p>Hello</p><p>World</p></div>"
    const result = renderToString(render, {}, { pretty: true })

    // Should have newlines and indentation
    expect(result).toContain("\n")
    expect(result).toMatch(/<div>\s*\n\s+<p>/)
  })

  it("should not format HTML when pretty option is false", () => {
    const render = () => "<div><p>Hello</p></div>"
    const result = renderToString(render, {}, { pretty: false })

    expect(result).toBe("<div><p>Hello</p></div>")
  })

  it("should not format HTML by default", () => {
    const render = () => "<div><p>Hello</p></div>"
    const result = renderToString(render, {})

    expect(result).toBe("<div><p>Hello</p></div>")
  })

  it("should preserve hydration markers when pretty printing", () => {
    const render = () =>
      "<div><!--kinetic:list:1--><li>Item</li><!--/kinetic:list--></div>"
    const result = renderToString(render, {}, { pretty: true })

    expect(result).toContain("<!--kinetic:list:1-->")
    expect(result).toContain("<!--/kinetic:list-->")
  })

  it("should handle nested elements with pretty printing", () => {
    const render = () =>
      '<div class="app"><header><h1>Title</h1></header><main><p>Content</p></main></div>'
    const result = renderToString(render, {}, { pretty: true })

    // Should be multi-line
    const lines = result.split("\n")
    expect(lines.length).toBeGreaterThan(1)

    // Should have proper structure
    expect(result).toContain("<div")
    expect(result).toContain("<header>")
    expect(result).toContain("<h1>Title</h1>")
    expect(result).toContain("</div>")
  })
})
