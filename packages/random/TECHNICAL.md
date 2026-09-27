# @kyneta/random — Technical Reference

## Purpose

Secure-context-free random ID primitives for the kyneta monorepo.

`crypto.randomUUID()` is restricted to secure contexts (HTTPS or localhost). On plain HTTP over a LAN address (e.g. `http://192.168.4.35`), it throws. `crypto.getRandomValues()` has no such restriction and is available in every modern runtime (browsers, Node, Bun, Deno, workers).

This package provides the canonical random ID primitives that all other kyneta packages depend on.

## API Surface

| Export | Signature | Description |
|---|---|---|
| `randomHex` | `(byteCount: number) => string` | Primitive: `byteCount` random bytes → `2 × byteCount` hex characters |
| `randomPeerId` | `() => string` | Semantic: `randomHex(16)` → 32-char hex peer identity, 128 bits |

### When to use which

- **`randomPeerId()`** — when generating an identity for a peer in the exchange network (CRDT version vectors, connection tracking, etc.). The exchange's Runtime issues every seat from it, and a seat must be unique with overwhelming probability across every writing session a document sees: at 128 bits, a 1% chance of any collision takes about 2.6×10¹⁸ sessions. The CRDT backends hash it down to 53 or 64 bits; that is the narrower bound (`packages/schema/TECHNICAL.md` §"Width, and why it never changes").
- **`randomHex(n)`** — when generating any other opaque unique string (CAS tokens, frame IDs, nonces). The caller decides the byte count based on collision-resistance needs.

## Dependency Graph Position

Leaf package — no `@kyneta/*` dependencies.

```
@kyneta/random (leaf)
  ← @kyneta/schema (createDoc peerId)
  ← @kyneta/exchange (Runtime seats)
  ← @kyneta/wire (fragment frame IDs)
  ← @kyneta/websocket-transport, @kyneta/sse-transport, @kyneta/unix-socket-transport (fallback peer IDs)
```

## Design Decisions

- **No UUID format.** All consumers need opaque unique strings — not RFC 9562 UUIDs. Hex strings are simpler, consistent with the existing peer ID format, and avoid the question of RFC compliance.
- **`crypto.getRandomValues()` only.** Available in all contexts without restriction. No fallback to `Math.random()` — cryptographic quality is free and universal.
- **Two exports, not one.** `randomPeerId()` exists so callers express *intent* (identity generation), not *mechanism* (16-byte hex). The primitive `randomHex(n)` is for call sites where no semantic concept is worth naming.