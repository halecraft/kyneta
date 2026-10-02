// undo.test — the Yjs substrate's undo, through the shared suite.

import { createRef, createSubstrate, unwrap } from "@kyneta/schema"
import {
  UndoFixture,
  type UndoPeer,
  undoConformance,
} from "@kyneta/schema/testing"
import type * as Y from "yjs"
import { yjs } from "../bind-yjs.js"

const bound = yjs.bind(UndoFixture)
let next = 0

function build(peerId: string): UndoPeer {
  const substrate = createSubstrate(
    bound.factory({ peerId, binding: bound.identityBinding }),
    UndoFixture,
  )
  const doc = createRef(UndoFixture, substrate)
  Object.defineProperty(doc, PEER, { value: peerId })
  return { substrate, doc }
}

const PEER = Symbol("peer")

function peerOf(peer: UndoPeer): string {
  return (peer.doc as { [PEER]: string })[PEER]
}

undoConformance(
  {
    create: () => build(`peer-${++next}`),
    reload(peer) {
      const fresh = build(peerOf(peer))
      fresh.substrate.merge(peer.substrate.exportEntirety())
      return fresh
    },
    sync(a, b) {
      b.substrate.merge(
        a.substrate.exportSince(b.substrate.version()) ??
          a.substrate.exportEntirety(),
      )
      a.substrate.merge(
        b.substrate.exportSince(a.substrate.version()) ??
          b.substrate.exportEntirety(),
      )
    },
    nativeInsert(peer, index, text) {
      const ydoc = unwrap(peer.doc) as Y.Doc
      const title = unwrap(peer.doc.title) as Y.Text
      ydoc.transact(() => title.insert(index, text))
    },
  },
  { label: "yjs" },
)
