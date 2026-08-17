# Plan Documents

_How changes are designed before they are written, where the resulting documents live, and how to read them — or write your own, if the system appeals to you._

---

## Why this doc exists

Most substantial changes in this repo were designed in a plan document first. Those plans are long — far too long to live in a commit message — but the reasoning in them is the most valuable part of the change, and losing it means every future reader would have to guess or try to re-derive the context or conclusions.

So the plans are kept, in a git ref namespace of their own, and the commit that implements one carries a short `PLAN-YYYY-MM-DD-slug` reference to it.

**This is a working style, not a repo standard.** Nothing here is required to contribute. If you want to read the plans behind a change, the "Reading plans" section is all you need. If the workflow appeals to you, the rest of the doc describes it.

## Where plans live

Plans are stored in `refs/plans/store`: an orphan history with no relationship to the main branch, much like `gh-pages`. The files are genuinely in git and permanently recorded, but they are never checked out, so the working tree never accumulates design docs that go stale the day they ship.

They can also be browsed on the web, at [github.com/halecraft/kyneta/tree/plans](https://github.com/halecraft/kyneta/tree/plans).

Note that plans publish to the `github` remote, not to `origin` — this repo's `origin` is Gerrit, which gates pushes to ordinary branches and so cannot carry the browsable mirror. Both remotes are configured to *fetch* the store, so a plan pushed from anywhere is picked up either way.

## Reading plans

The CLI ships as a dev dependency, so `pnpm install` already put it in place. What remains is one-time git config, so that `git fetch` keeps a local view of the store up to date. Git config is per-clone and cannot be checked in, which is why a fresh clone needs this:

```bash
git config plans.remote github   # publish to github, not to Gerrit
pnpm exec plans init
pnpm exec plans sync
```

Then:

```bash
plans list                                # every plan in the store
plans show 2026-08-13-replicate-promotion # read one
plans grep hydration                      # search across all of them
plans status                              # what is stored, what is unpublished
```

`plans show` accepts the commit-message form too, so a `PLAN-` token pastes straight in.

The store is ordinary git underneath, if you would rather use it directly (there is no checkout, and there are no working-tree files):

```bash
git ls-tree -r --name-only refs/plans/store
git cat-file blob refs/plans/store:plans/2026-08-13-replicate-promotion.md
git grep -l "hydration" refs/plans/store
git log --oneline refs/plans/store
```

## Writing plans

Author the plan anywhere untracked, then record it under a plan ID of the form `YYYY-MM-DD-slug`. This repo's drafts are written in `.jj/plans/`, which is untracked because it sits inside jj's own directory; anywhere else untracked works just as well.

```bash
plans add .jj/plans/2026-08-13-replicate-promotion.md   # local, offline, instant
plans sync                                              # publish, whenever
```

That ID is the plan's permanent address: it becomes the `PLAN-` reference, so it must be unique, and it is validated on the way in. The date is what lets anyone mint an ID offline without collision; the slug separates two plans on the same day. If your draft is named something else — a stack position like `01-feat-auth.md`, say — mint the ID explicitly:

```bash
plans add .jj/plans/01-feat-auth.md --as 2026-07-23-feat-auth
```

`plans add` writes a blob, builds a tree and moves a ref — it never touches the working tree or the git index. Re-running it on an unchanged file is a no-op; re-running it after editing the plan records a revision, and because the store's history is append-only, earlier versions stay recoverable:

```bash
git log --oneline refs/plans/store -- plans/2026-08-13-replicate-promotion.md
git show <sha>:plans/2026-08-13-replicate-promotion.md
```

Revisions are matched by plan ID alone, so keep the original ID when revising — a new slug stores a second copy rather than a revision.

Then reference the plan from the commit message:

```
feat(exchange)!: get() promotes a replicate document when given its schema

# Summary
...

PLAN-2026-08-13-replicate-promotion
```

A plan should be **self-contained for a reader who only has the repo**: no references to local draft paths, which are invisible to everyone else — only checked-in artifacts, such as `docs/*.md`, the nearest `TECHNICAL.md` / `PRODUCT.md`, source paths, and schemas.

## How the namespace works

The store deliberately mirrors the structure that makes branches work offline. `refs/plans/store` is local and authoritative; `refs/plans/<remote>/store` — here `refs/plans/github/store` — is the last-known state of the remote. Fetching only ever moves the tracking ref, so unpushed plans cannot be lost, and the remote enforces fast-forward on the store exactly as it does on a branch.

`plans sync` therefore behaves much as `git pull` then `git push` would: fast-forward when you are behind, push when you are ahead, and merge when both happened. Because every plan is a distinct date+slug path, concurrent additions are disjoint and merge cleanly, with no force-push. The one case that stops it is two people adding a plan under the same ID — rename yours and re-add it.

Publishing also updates the `plans` branch, a plain projection of the store that makes plans browsable on the web and gives the `PLAN-` autolink something to resolve against. Store and mirror move together, so "published" has one meaning.

Because the namespace is reflogged (`plans init` sets `core.logAllRefUpdates always`), a ref move you regret is recoverable with `git reflog show refs/plans/store`.

## One property to respect

A **pushed** plan is permanent, exactly like a pushed commit. Deleting the ref removes reachability, not the objects — so don't put a live credential or other secret in a plan you intend to push. Working notes are the most likely place one slips in.
