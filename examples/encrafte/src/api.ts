// ═══════════════════════════════════════════════════════════════════════════
//
//   Encrafte — API Routes
//
//   Server-side request handler for /api/* endpoints.
//   AI streaming endpoints will be added here in future plans.
//
// ═══════════════════════════════════════════════════════════════════════════

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })

export async function handleApiRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/api/, "")

  if (req.method === "GET" && path === "/health") {
    return json({
      ok: true,
      ai:
        typeof Bun.env.OPENROUTER_API_KEY === "string" &&
        Bun.env.OPENROUTER_API_KEY.length > 0,
    })
  }

  return json({ error: "not found" }, 404)
}
