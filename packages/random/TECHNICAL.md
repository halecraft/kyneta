# @kyneta/random — Technical Reference

## Purpose

Secure-context-free random ID primitives for the kyneta monorepo.

`crypto.randomUUID()` is restricted to secure contexts (HTTPS or localhost). On plain HTTP over a LAN address (e.g. `http://192.168.4.35`), it throws. `crypto.getRandomValues()` has no such restriction and is available in every modern runtime (browsers, Node, Bun, Deno, workers).

This package provides the canonical random ID primitives that all other kyneta packages depend on.

## API Surface

| Export | Signature | Description |
|---|---|---|
| `randomHex` | `(byteCount: number) => string` | Primitive: `byteCount` random bytes → `2 × byteCount` hex characters |
| `randomPeerId` | `() => string` | Semantic: `randomHex(8)` → 16-char hex peer identity |

### When to use which

- **`randomPeerId()`** — when generating an identity for a peer in the exchange network (CRDT version vectors, connection tracking, etc.)
- **`randomHex(n)`** — when generating any other opaque unique string (CAS tokens, frame IDs, nonces). The caller decides the byte count based on collision-resistance needs.

## Dependency Graph Position

Leaf package — no `@kyneta/*` dependencies.

```
@kyneta/random (leaf)
  ← @kyneta/schema (createDoc peerId)
  ← @kyneta/exchange (persistent-peer-id CAS tokens, peer IDs)
  ← @kyneta/wire (fragment frame IDs)
  ← @kyneta/websocket-transport, @kyneta/sse-transport, @kyneta/unix-socket-transport (fallback peer IDs)
```

## Design Decisions

- **No UUID format.** All consumers need opaque unique strings — not RFC 9562 UUIDs. Hex strings are simpler, consistent with the existing peer ID format, and avoid the question of RFC compliance.
- **`crypto.getRandomValues()` only.** Available in all contexts without restriction. No fallback to `Math.random()` — cryptographic quality is free and universal.
- **Two exports, not one.** `randomPeerId()` exists so callers express *intent* (identity generation), not *mechanism* (8-byte hex). The primitive `randomHex(n)` is for call sites where no semantic concept is worth naming.