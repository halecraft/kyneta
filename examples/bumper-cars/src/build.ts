import { buildClient } from "@kyneta/bun-server"

export const build = () => buildClient()

if (import.meta.main) {
  console.log("✅ Bumper Cars client build:")
  await build()
}