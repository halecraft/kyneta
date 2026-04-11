// ═══════════════════════════════════════════════════════════════════════════
//
//   Encrafte — AI
//
//   Server-side OpenRouter integration via Vercel AI SDK.
//   This module is server-only — never imported by client code.
//
//   Provides a configured OpenRouter provider and a model factory.
//   AI streaming endpoints in api.ts will use getModel() to obtain
//   a model instance for streamText() calls.
//
// ═══════════════════════════════════════════════════════════════════════════

import { createOpenRouter } from "@openrouter/ai-sdk-provider"

const DEFAULT_MODEL = "anthropic/claude-sonnet-4"

const openrouter = createOpenRouter({
  apiKey: Bun.env.OPENROUTER_API_KEY ?? "",
})

/** Get a model instance for use with the Vercel AI SDK's streamText/generateText. */
export function getModel(name: string = DEFAULT_MODEL) {
  return openrouter(name)
}
