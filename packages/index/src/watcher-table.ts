// watcher-table — re-export from @kyneta/changefeed.
//
// `WatcherTable` was hoisted to the tier-0 `@kyneta/changefeed` package
// (jj:kpywvkpr) so both `@kyneta/index` and `@kyneta/reactive` share one
// generic per-key subscription-lifecycle helper. This module re-exports it
// for back-compat — `@kyneta/index`'s internal consumers (`fromList`,
// `flatMap`, `filter`, `Index.by`) and any external importers are unchanged.

export {
  createWatcherTable,
  type WatcherEntry,
  type WatcherTable,
} from "@kyneta/changefeed"
