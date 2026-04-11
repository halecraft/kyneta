import { change, createLoroDoc } from "@kyneta/loro-schema"
import { describe, expect, it } from "vitest"
import { ThreadSchema } from "./schema.js"

describe("ThreadSchema", () => {
  it("creates a doc with an empty message list", () => {
    const doc = createLoroDoc(ThreadSchema)
    expect(doc.messages.length).toBe(0)
  })

  it("appends a message via change()", () => {
    const doc = createLoroDoc(ThreadSchema)
    change(doc, d => {
      d.messages.push({
        author: "alice",
        content: "hello",
        timestamp: 1000,
      })
    })
    expect(doc.messages.length).toBe(1)
    expect(doc.messages.at(0)?.content()).toBe("hello")
    expect(doc.messages.at(0)?.author()).toBe("alice")
    expect(doc.messages.at(0)?.timestamp()).toBe(1000)
  })
})
