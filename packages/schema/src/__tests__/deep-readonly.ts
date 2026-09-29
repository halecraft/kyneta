// The type a read has — `Plain<S>` is readonly all the way down — written as
// a transform of the mutable shape, so type-equality tests can state an
// expected read as the plain object literal it looks like.
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T
