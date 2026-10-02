// The two Node built-ins `collectGarbage` uses. Declared here rather than
// through `@types/node`, which would type the whole package, a browser
// library, against Node's globals.

declare module "node:v8" {
  export function setFlagsFromString(flags: string): void
}

declare module "node:vm" {
  export function runInNewContext(code: string): unknown
}
