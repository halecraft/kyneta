import { beforeEach, describe, expect, it } from "vitest"

import {
  createMockCounterRef,
  createMockTextRef,
  getActiveSubscriptionCount,
  installDOMGlobals,
  resetTestState,
  Scope,
  subscribe,
  subscribeMultiple,
  subscribeWithValue,
  transformSource,
  withTypes,
} from "./helpers.js"

installDOMGlobals()

describe("compiler integration - reactive expressions", () => {
  beforeEach(() => {
    resetTestState()
  })

  describe("Task 5.2: Reactive text content", () => {
    it("should generate subscribeWithValue for reactive text", () => {
      const source = withTypes(`
        declare const count: CounterRef

        div(() => {
          p(count.get())
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Should detect reactive content
      expect(result.ir[0].isReactive).toBe(true)

      // Should generate subscription call
      expect(result.code).toContain("subscribeWithValue")
      expect(result.code).toContain("count")
    })

    it("should generate subscribeWithValue for template literal with reactive content", () => {
      const source = withTypes(`
        declare const count: CounterRef

        div(() => {
          p(\`Count: \${count.get()}\`)
        })
      `)

      const result = transformSource(source, { target: "dom" })

      expect(result.ir[0].isReactive).toBe(true)
      expect(result.code).toContain("subscribeWithValue")
      expect(result.code).toContain("Count:")
    })

    it("should execute reactive text and update on change", () => {
      // Create a mock counter ref
      const { ref: count } = createMockCounterRef(0)

      // Set initial value
      count.increment(5)

      // Create the element factory manually (simulating compiled code)
      const scope = new Scope()
      const div = document.createElement("div")
      const p = document.createElement("p")
      const text = document.createTextNode("")
      p.appendChild(text)
      div.appendChild(p)

      // Subscribe (simulating compiled code)
      subscribeWithValue(
        count,
        () => count.get(),
        v => {
          text.textContent = String(v)
        },
        scope,
      )

      // Initial value should be set
      expect(text.textContent).toBe("5")

      // Update the counter
      count.increment(3)

      // Text should update
      expect(text.textContent).toBe("8")

      // Cleanup
      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)
    })
  })

  describe("Task 5.3: Reactive attributes", () => {
    it("should generate subscribe for reactive class attribute", () => {
      const source = withTypes(`
        declare const className: TextRef

        div({ class: className.toString() }, () => {
          p("Hello")
        })
      `)

      const result = transformSource(source, { target: "dom" })

      expect(result.ir[0].isReactive).toBe(true)
      expect(result.code).toContain("subscribe")
      expect(result.code).toContain("className")
    })

    it("should execute reactive attribute and update on change", () => {
      // Create a mock counter ref for boolean-like behavior
      const { ref: activeCount } = createMockCounterRef(0)

      // Create element manually
      const scope = new Scope()
      const div = document.createElement("div")

      // Initial value (0 = inactive, >0 = active)
      div.className = activeCount.get() > 0 ? "active" : "inactive"

      // Subscribe (simulating compiled code)
      subscribe(
        activeCount,
        () => {
          div.className = activeCount.get() > 0 ? "active" : "inactive"
        },
        scope,
      )

      expect(div.className).toBe("inactive")

      // Update to active
      activeCount.increment(1)

      expect(div.className).toBe("active")

      scope.dispose()
    })
  })

  describe("Task 5.4: Reactive integration with mock refs", () => {
    it("should handle counter increment reactively", () => {
      const { ref: clicks } = createMockCounterRef(0)

      const scope = new Scope()
      const button = document.createElement("button")
      const textNode = document.createTextNode("")
      button.appendChild(textNode)

      subscribeWithValue(
        clicks,
        () => `Clicks: ${clicks.get()}`,
        v => {
          textNode.textContent = v
        },
        scope,
      )

      expect(textNode.textContent).toBe("Clicks: 0")

      // Simulate clicks
      clicks.increment(1)
      expect(textNode.textContent).toBe("Clicks: 1")

      clicks.increment(1)
      expect(textNode.textContent).toBe("Clicks: 2")

      scope.dispose()
    })

    it("should handle text updates reactively", () => {
      const { ref: title } = createMockTextRef("Hello")

      const scope = new Scope()
      const h1 = document.createElement("h1")
      const textNode = document.createTextNode("")
      h1.appendChild(textNode)

      subscribeWithValue(
        title,
        () => title.toString(),
        v => {
          textNode.textContent = v
        },
        scope,
      )

      expect(textNode.textContent).toBe("Hello")

      // Update text
      title.insert(5, " World")

      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })

    it("should clean up subscriptions on scope dispose", () => {
      const { ref: value } = createMockCounterRef(0)

      const scope = new Scope()
      const textNode = document.createTextNode("")

      subscribeWithValue(
        value,
        () => value.get(),
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
      value.increment(100)
      expect(textNode.textContent).toBe(oldContent)
    })

    it("should handle multiple reactive expressions", () => {
      const { ref: firstName } = createMockTextRef("John")
      const { ref: lastName } = createMockTextRef("Doe")

      const scope = new Scope()

      const firstNameNode = document.createTextNode("")
      const lastNameNode = document.createTextNode("")
      const fullNameNode = document.createTextNode("")

      subscribeWithValue(
        firstName,
        () => firstName.toString(),
        v => {
          firstNameNode.textContent = v
        },
        scope,
      )

      subscribeWithValue(
        lastName,
        () => lastName.toString(),
        v => {
          lastNameNode.textContent = v
        },
        scope,
      )

      // This simulates a computed expression depending on both
      const updateFullName = () => {
        fullNameNode.textContent = `${firstName.toString()} ${lastName.toString()}`
      }
      subscribe(firstName, updateFullName, scope)
      subscribe(lastName, updateFullName, scope)
      updateFullName() // Initial value

      expect(getActiveSubscriptionCount()).toBe(4)
      expect(firstNameNode.textContent).toBe("John")
      expect(lastNameNode.textContent).toBe("Doe")
      expect(fullNameNode.textContent).toBe("John Doe")

      // Update first name
      firstName.delete(0, 4)
      firstName.insert(0, "Jane")

      expect(firstNameNode.textContent).toBe("Jane")
      expect(fullNameNode.textContent).toBe("Jane Doe")

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should use subscribeMultiple for expressions with multiple dependencies", () => {
      const { ref: firstName } = createMockTextRef("John")
      const { ref: lastName } = createMockTextRef("Doe")

      const scope = new Scope()
      const fullNameNode = document.createTextNode("")

      // Set initial value
      fullNameNode.textContent = `${firstName.toString()} ${lastName.toString()}`

      // Subscribe to both dependencies with a single subscribeMultiple call
      subscribeMultiple(
        [firstName, lastName],
        () => {
          fullNameNode.textContent = `${firstName.toString()} ${lastName.toString()}`
        },
        scope,
      )

      // Should create 2 subscriptions (one per ref)
      expect(getActiveSubscriptionCount()).toBe(2)
      expect(fullNameNode.textContent).toBe("John Doe")

      // Update first name only - should trigger update
      firstName.delete(0, 4)
      firstName.insert(0, "Jane")
      expect(fullNameNode.textContent).toBe("Jane Doe")

      // Update last name only - should also trigger update
      lastName.delete(0, 3)
      lastName.insert(0, "Smith")
      expect(fullNameNode.textContent).toBe("Jane Smith")

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)
    })
  })
})