import react from "@vitejs/plugin-react"
import wasm from "vite-plugin-wasm"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), wasm()],
  build: {
    target: "esnext",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
})
