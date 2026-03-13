import { beforeEach, describe, expect, it } from "vitest"

import {
  createMockCounterRef,
  createMockTextRef,
  getActiveSubscriptionCount,
  installDOMGlobals,
  read,
  resetTestState,
  Scope,
  subscribe,
  subscribeWithValue,
} from "./helpers.js"

installDOMGlobals()

describe("compiler integration - reactive expressions", () => {
  beforeEach(() => {
    resetTestState()
  })

  it("should execute reactive attribute and update on change", () => {
    // Create a mock counter ref for boolean-like behavior
    const { ref: activeCount } = createMockCounterRef(0)

    // Create element manually
    const scope = new Scope()
    const div = document.createElement("div")

    // Initial value (0 = inactive, >0 = active)
    div.className = read(activeCount) > 0 ? "active" : "inactive"

    // Subscribe (simulating compiled code)
    subscribe(
      activeCount,
      () => {
        div.className = read(activeCount) > 0 ? "active" : "inactive"
      },
      scope,
    )

    expect(div.className).toBe("inactive")

    // Update to active
    activeCount.increment(1)

    expect(div.className).toBe("active")

    scope.dispose()
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
      () => read(firstName),
      v => {
        firstNameNode.textContent = v
      },
      scope,
    )

    subscribeWithValue(
      lastName,
      () => read(lastName),
      v => {
        lastNameNode.textContent = v
      },
      scope,
    )

    // This simulates a computed expression depending on both
    const updateFullName = () => {
      fullNameNode.textContent = `${read(firstName)} ${read(lastName)}`
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
})