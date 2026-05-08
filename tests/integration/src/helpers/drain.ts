// drain — yield to the event loop so async transports and storage settle.
//
// Real WebSocket transport involves real I/O (microtasks + setTimeout
// hops); 40 rounds at 2ms is the proven shape across this package.

export async function drain(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 2))
  }
}
