// listen — platform-abstracted unix socket server listener.
//
// Uses runtime detection to select between Node.js `net.createServer`
// and Bun's `Bun.listen`. Both paths are server-side only — tree-
// shakeability is irrelevant.

import type { UnixSocket } from "./types.js"

// ---------------------------------------------------------------------------
// Listener interface
// ---------------------------------------------------------------------------

/**
 * Platform-abstracted listener handle.
 *
 * Returned by the `listen()` function. Call `stop()` to close the
 * listening socket.
 */
export interface UnixSocketListener {
  stop(): void
}

/**
 * Callback invoked when a new client connects.
 */
export type OnConnectionCallback = (socket: UnixSocket) => void

// ---------------------------------------------------------------------------
// listen
// ---------------------------------------------------------------------------

/**
 * Create a unix socket server listener.
 *
 * Uses runtime detection to select between Node.js `net.createServer`
 * and Bun's `Bun.listen`. Both paths are server-side only.
 *
 * @param path - Path to the unix socket file
 * @param onConnection - Callback invoked for each new connection
 * @returns A listener handle with a `stop()` method
 */
export async function listen(
  path: string,
  onConnection: OnConnectionCallback,
): Promise<UnixSocketListener> {
  if (typeof (globalThis as any).Bun !== "undefined") {
    return listenBun(path, onConnection)
  }
  return listenNode(path, onConnection)
}

// ---------------------------------------------------------------------------
// Node.js implementation
// ---------------------------------------------------------------------------

/**
 * Node.js listener implementation using `net.createServer`.
 */
async function listenNode(
  path: string,
  onConnection: OnConnectionCallback,
): Promise<UnixSocketListener> {
  const { wrapNodeUnixSocket } = await import("./types.js")
  const { createServer } = await import("node:net")

  return new Promise((resolve, reject) => {
    const server = createServer(rawSocket => {
      onConnection(wrapNodeUnixSocket(rawSocket))
    })

    server.on("error", reject)

    server.listen(path, () => {
      // Remove the error handler used during startup
      server.removeListener("error", reject)

      resolve({
        stop() {
          server.close()
        },
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Bun implementation
// ---------------------------------------------------------------------------

/**
 * Bun listener implementation using `Bun.listen`.
 */
async function listenBun(
  path: string,
  onConnection: OnConnectionCallback,
): Promise<UnixSocketListener> {
  const { wrapBunUnixSocket } = await import("./types.js")

  const server = (globalThis as any).Bun.listen({
    unix: path,
    socket: {
      open(rawSocket: any) {
        const { unixSocket, handlers } = wrapBunUnixSocket(rawSocket)
        // Store handlers on the Bun socket's data property for event dispatch
        rawSocket.data = handlers
        onConnection(unixSocket)
      },
      data(rawSocket: any, data: Uint8Array) {
        rawSocket.data?.onData?.(data)
      },
      close(rawSocket: any) {
        rawSocket.data?.onClose?.()
      },
      error(rawSocket: any, error: Error) {
        rawSocket.data?.onError?.(error)
      },
      drain(rawSocket: any) {
        rawSocket.data?.onDrain?.()
      },
    },
  })

  return {
    stop() {
      server.stop()
    },
  }
}
