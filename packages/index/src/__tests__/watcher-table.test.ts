import { describe, expect, it } from "vitest"
import { createWatcherTable } from "../watcher-table.js"

describe("createWatcherTable", () => {
  it("re-adding an existing key tears down the prior watcher first", () => {
    // fromList's re-keying path calls add(newKey) after remove(currentKey),
    // but a duplicate add() for a key that was never explicitly removed must
    // still dispose the prior subscription — otherwise watchers leak whenever
    // a caller refreshes a tracked value.
    const installs: string[] = []
    const teardowns: string[] = []
    let installCount = 0

    const table = createWatcherTable<number>((key, value) => {
      const id = `${key}:${value}:#${++installCount}`
      installs.push(id)
      return () => teardowns.push(id)
    })

    table.add("k", 1)
    table.add("k", 2) // re-install with different value

    expect(installs).toEqual(["k:1:#1", "k:2:#2"])
    expect(teardowns).toEqual(["k:1:#1"]) // the first watcher was torn down

    table.clear()
    expect(teardowns).toEqual(["k:1:#1", "k:2:#2"])
  })

  it("remove returns false for unknown keys without touching teardowns", () => {
    let teardownCount = 0
    const table = createWatcherTable<number>(() => () => teardownCount++)
    expect(table.remove("nope")).toBe(false)
    expect(teardownCount).toBe(0)
  })
})
