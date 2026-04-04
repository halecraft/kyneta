// connect — platform-abstracted unix socket client connection.
//
// Uses runtime detection to select between Node.js `net.createConnection`
// and Bun's `Bun.connect`. Both paths are server-side only.

import type { UnixSocket } from "./types.js"

/**
 * Connect to a unix socket server.
 *
 * Uses runtime detection to select between Node.js `net.createConnection`
 * and Bun's `Bun.connect`. Both paths are server-side only.
 *
 * @param path - Path to the unix socket file
 * @returns A connected `UnixSocket`
 */
export async function connect(path: string): Promise<UnixSocket> {
  if (typeof (globalThis as any).Bun !== "undefined") {
    return connectBun(path)
  }
  return connectNode(path)
}

/**
 * Node.js connection implementation using `net.createConnection`.
 */
async function connectNode(path: string): Promise<UnixSocket> {
  const { wrapNodeUnixSocket } = await import("./types.js")
  const { createConnection } = await import("node:net")

  return new Promise((resolve, reject) => {
    const rawSocket = createConnection(path)

    const onConnect = () => {
      rawSocket.removeListener("error", onError)
      resolve(wrapNodeUnixSocket(rawSocket))
    }

    const onError = (error: Error) => {
      rawSocket.removeListener("connect", onConnect)
      reject(error)
    }

    rawSocket.once("connect", onConnect)
    rawSocket.once("error", onError)
  })
}

/**
 * Bun connection implementation using `Bun.connect`.
 */
async function connectBun(path: string): Promise<UnixSocket> {
  const { wrapBunUnixSocket } = await import("./types.js")

  return new Promise((resolve, reject) => {
    let resolved = false

    ;(globalThis as any).Bun.connect({
      unix: path,
      socket: {
        open(rawSocket: any) {
          if (resolved) return
          resolved = true
          const { unixSocket, handlers } = wrapBunUnixSocket(rawSocket)
          // Store handlers on the Bun socket's data property for event dispatch
          rawSocket.data = handlers
          resolve(unixSocket)
        },
        data(rawSocket: any, data: Uint8Array) {
          rawSocket.data?.onData?.(data)
        },
        close(rawSocket: any) {
          if (!resolved) {
            resolved = true
            reject(new Error(`Failed to connect to unix socket: ${path}`))
            return
          }
          rawSocket.data?.onClose?.()
        },
        error(rawSocket: any, error: Error) {
          if (!resolved) {
            resolved = true
            reject(error)
            return
          }
          rawSocket.data?.onError?.(error)
        },
        drain(rawSocket: any) {
          rawSocket.data?.onDrain?.()
        },
      },
    })
  })
}