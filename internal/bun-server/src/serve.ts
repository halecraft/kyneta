/// <reference types="bun-types" />

// ─────────────────────────────────────────────────────────────────────────
//  serveDist — brotli-aware static file serving from a dist directory
//
//  Serves pre-compressed .br files when the client accepts brotli encoding,
//  falling back to the original file. Returns 404 for missing files.
// ─────────────────────────────────────────────────────────────────────────

const BR_ACCEPT = /\bbr\b/

export async function serveDist(
  req: Request,
  distDir: string,
): Promise<Response> {
  const url = new URL(req.url)
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname
  const acceptsBr = BR_ACCEPT.test(
    req.headers.get("accept-encoding") ?? "",
  )

  if (acceptsBr) {
    const brFile = Bun.file(`${distDir}${pathname}.br`)
    if (await brFile.exists()) {
      const original = Bun.file(`${distDir}${pathname}`)
      return new Response(brFile, {
        headers: {
          "Content-Encoding": "br",
          "Content-Type": original.type,
        },
      })
    }
  }

  const file = Bun.file(`${distDir}${pathname}`)
  return (await file.exists())
    ? new Response(file)
    : new Response("Not found", { status: 404 })
}