# @kyneta/random

Random identifiers for Kyneta, from `crypto.getRandomValues`.

`crypto.randomUUID()` exists only in secure contexts (HTTPS or localhost), so a page served over plain HTTP on a LAN address cannot call it. `crypto.getRandomValues()` works everywhere, and these functions use only it.

```ts
import { randomHex, randomPeerId } from "@kyneta/random"

randomHex(8) // 16 hex characters from 8 random bytes
randomPeerId() // 128 bits, as 32 hex characters
```

| Export | What it returns |
|--------|-----------------|
| `randomHex(byteCount)` | `byteCount` random bytes as a lowercase hex string. |
| `randomPeerId()` | A fresh peer id: 128 random bits. A Runtime issues itself one when it has no store to hold a durable one. |
