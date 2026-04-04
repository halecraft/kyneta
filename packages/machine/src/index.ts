// @kyneta/machine — universal Mealy machine algebra with effect interpreter.
//
// Program<Msg, Model, Fx> is the pure algebra: init + update + done.
// runtime() is the interpreter: wires dispatch to update, executes effects.
// Effects are continuations (dispatch) => void — opaque to the runtime.

export type { Dispatch, Disposer, Effect, Program } from "./machine.js"
export { runtime } from "./machine.js"
