// @kyneta/machine — universal Mealy machine algebra with effect interpreter.
//
// Program<Msg, Model, Fx> is the pure algebra: init + update + done.
// runtime() is the interpreter: wires dispatch to update, executes effects.
// Effects are continuations (dispatch) => void — opaque to the runtime.
//
// createObservableProgram() is the data-effect counterpart to runtime().
// It accepts a custom executor for data effects and provides state
// observation: subscribeToTransitions, waitForState, waitForStatus.

export type {
  DispatcherHandle,
  DispatcherOptions,
  Lease,
  LeaseOptions,
} from "./dispatcher.js"
export {
  BudgetExhaustedError,
  createDispatcher,
  createLease,
} from "./dispatcher.js"
export type { Dispatch, Disposer, Effect, Program } from "./machine.js"
export { runtime } from "./machine.js"
export type {
  ObservableHandle,
  StateTransition,
  TransitionListener,
} from "./observable.js"
export { createObservableProgram } from "./observable.js"
