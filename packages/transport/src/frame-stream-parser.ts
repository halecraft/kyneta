// frame-stream-parser — stateful class wrapping the pure feedBytesStep.
//
// Imperative shell for the FC/IS stream frame parser. Holds parser state
// internally and exposes a simple feed/reset API.

import type { Result, WireError } from "@kyneta/wire"
import {
  feedBytesStep,
  initialParserState,
  type StreamParserState,
} from "./frame-stream-parser-core.js"

export class FrameStreamParser {
  #state: StreamParserState = initialParserState()

  feed(
    chunk: Uint8Array,
  ): readonly Result<Uint8Array<ArrayBuffer>, WireError>[] {
    const result = feedBytesStep(this.#state, chunk)
    this.#state = result.state
    // feedBytesStep returns Uint8Array<ArrayBufferLike> from subarray/slice.
    // All frames are backed by plain ArrayBuffer, so the cast is safe.
    return result.frames as readonly Result<
      Uint8Array<ArrayBuffer>,
      WireError
    >[]
  }

  reset(): void {
    this.#state = initialParserState()
  }
}
