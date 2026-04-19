/// <reference types="bun-types" />

import { buildClient } from "@kyneta/bun-server"
import kyneta from "@kyneta/cast/unplugin/bun"

export const build = () => buildClient({ plugins: [kyneta()] })

if (import.meta.main) {
  console.log("✅ Client build succeeded:")
  await build()
}