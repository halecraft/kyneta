import { describe, expect, it } from "vitest"
import { planCompression } from "../compress.js"

describe("planCompression", () => {
  it("compresses when paths are provided and SKIP_BROTLI is unset", () => {
    expect(planCompression(["a.js"], {})).toEqual({
      action: "compress",
      files: ["a.js"],
    })
  })

  it("preserves all paths in the plan", () => {
    const paths = ["a.js", "b.css", "c.wasm"]
    expect(planCompression(paths, {})).toEqual({
      action: "compress",
      files: paths,
    })
  })

  it("skips when SKIP_BROTLI is set", () => {
    expect(planCompression(["a.js"], { SKIP_BROTLI: "1" })).toEqual({
      action: "skip",
      reason: "SKIP_BROTLI is set",
    })
  })

  it("skips when SKIP_BROTLI is any truthy string", () => {
    expect(planCompression(["a.js"], { SKIP_BROTLI: "true" })).toEqual({
      action: "skip",
      reason: "SKIP_BROTLI is set",
    })
  })

  it("skips when paths array is empty", () => {
    expect(planCompression([], {})).toEqual({
      action: "skip",
      reason: "no files",
    })
  })

  it("prefers SKIP_BROTLI over empty paths", () => {
    expect(planCompression([], { SKIP_BROTLI: "1" })).toEqual({
      action: "skip",
      reason: "SKIP_BROTLI is set",
    })
  })
})