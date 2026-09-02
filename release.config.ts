import { defineConfig } from "@halecraft/release"

export default defineConfig({
  groups: {
    core: { packages: ["packages/*", "packages/exchange/wire", "!packages/react"] },
    backends: { packages: ["packages/schema/backends/*"] },
    transport: { packages: ["packages/exchange/transports/*"] },
    stores: { packages: ["packages/exchange/stores/*"] },
    bindings: { packages: ["packages/react"] },
    experimental: { packages: ["experimental/*"] },
  },
  remotes: ["origin", "github"],
  access: "public",
})
