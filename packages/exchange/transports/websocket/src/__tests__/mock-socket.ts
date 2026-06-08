// mock-socket — a minimal server-side `Socket` for transport tests.
//
// `close()` flips `readyState` to "closed" and (by default) invokes the
// registered `onClose` handler — this is the exact signal `drainConnections`
// awaits. Pass `{ fireCloseOnClose: false }` to model a socket that never
// acknowledges the close (used to exercise the drain deadline path).

import type { Socket, SocketReadyState } from "../types.js"

export interface MockSocketOptions {
  /** Whether `close()` synchronously fires the `onClose` handler. Default true. */
  fireCloseOnClose?: boolean
}

export interface MockSocket extends Socket {
  /** Everything passed to `send()`, in order. */
  readonly sent: ReadonlyArray<Uint8Array<ArrayBuffer> | string>
  /** Deliver an inbound frame to the registered message handler. */
  receive(data: Uint8Array<ArrayBuffer> | string): void
}

export function createMockSocket(options: MockSocketOptions = {}): MockSocket {
  const fireCloseOnClose = options.fireCloseOnClose ?? true
  let readyState: SocketReadyState = "open"
  let onMessage: ((data: Uint8Array<ArrayBuffer> | string) => void) | undefined
  let onClose: ((code: number, reason: string) => void) | undefined
  const sent: (Uint8Array<ArrayBuffer> | string)[] = []

  return {
    get readyState() {
      return readyState
    },
    send(data) {
      sent.push(data)
    },
    close(code, reason) {
      if (readyState === "closed") return
      readyState = "closed"
      if (fireCloseOnClose) onClose?.(code ?? 1000, reason ?? "")
    },
    onMessage(handler) {
      onMessage = handler
    },
    onClose(handler) {
      onClose = handler
    },
    onError() {
      // not exercised by these tests
    },
    sent,
    receive(data) {
      onMessage?.(data)
    },
  }
}
