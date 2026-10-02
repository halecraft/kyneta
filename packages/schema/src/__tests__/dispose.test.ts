import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import { plainSubstrateFactory } from "../substrates/plain.js"
import { disposeConformance } from "../testing/dispose-conformance.js"

disposeConformance({ factory: plainSubstrateFactory }, { label: "plain" })
disposeConformance(
  { factory: ephemeralSubstrateFactory },
  { label: "ephemeral" },
)
