// local-update-signal — `Substrate.subscribeLocalUpdates` for substrates that
// have no native signal of their own.
//
// A CRDT reports its own local updates (Yjs `update`, Loro
// `subscribeLocalUpdates`). Plain and ephemeral have only Kyneta writers, so
// each notifies at the end of an authored batch that wrote something; they
// differ only in how they know it wrote.

export interface LocalUpdateSignal {
  /** Add a listener; returns its unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void
  /** Call every current listener. */
  readonly notify: () => void
}

export function createLocalUpdateSignal(): LocalUpdateSignal {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      // A wrapper, so subscribing the same function twice gives two
      // independent subscriptions, as the CRDT signals do.
      const entry = (): void => listener()
      listeners.add(entry)
      return () => {
        listeners.delete(entry)
      }
    },
    notify() {
      // A snapshot: a listener that unsubscribes during the notification
      // does not change who hears this one.
      for (const listener of [...listeners]) listener()
    },
  }
}
