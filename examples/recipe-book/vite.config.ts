import kyneta from "@kyneta/core/vite"
import { defineConfig } from "vite"

// The @kyneta/core/vite path re-exports from the unplugin Vite adapter.
// Canonical import for new consumers: @kyneta/core/unplugin/vite
export default defineConfig({
  plugins: [kyneta()],
})