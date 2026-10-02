import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The backends are packages of their own, and run their own tests.
    include: ["src/**/*.test.ts"],
  },
})
