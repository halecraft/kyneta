// channel-directory — channel ID generation and lifecycle management.
//
// Ported from @loro-extended/repo's ChannelDirectory with Loro-specific
// types replaced by the substrate-agnostic channel types.

import type {
  Channel,
  ConnectedChannel,
  GenerateFn,
  ReceiveFn,
} from "./channel.js"
import type { ChannelId } from "./types.js"

let channelIssuanceId = 1

export class ChannelDirectory<G> {
  private readonly channels: Map<ChannelId, Channel> = new Map()

  constructor(readonly generate: GenerateFn<G>) {}

  *[Symbol.iterator](): IterableIterator<Channel> {
    yield* this.channels.values()
  }

  has(channelId: ChannelId): boolean {
    return this.channels.has(channelId)
  }

  get(channelId: ChannelId): Channel | undefined {
    return this.channels.get(channelId)
  }

  get size(): number {
    return this.channels.size
  }

  /**
   * Create a ConnectedChannel from the adapter's generate function.
   *
   * Assigns a unique channelId and wires up the onReceive handler.
   * The channel starts in "connected" state — it must complete the
   * establish handshake to become "established".
   */
  create(context: G, onReceive: ReceiveFn): ConnectedChannel {
    const channelId = channelIssuanceId++

    const generatedChannel = this.generate(context)

    const channel: ConnectedChannel = {
      ...generatedChannel,
      type: "connected",
      channelId,
      onReceive,
    }

    this.channels.set(channelId, channel)

    return channel
  }

  /**
   * Update a channel in-place (e.g. after establishment).
   */
  set(channelId: ChannelId, channel: Channel): void {
    this.channels.set(channelId, channel)
  }

  remove(channelId: ChannelId): Channel | undefined {
    const channel = this.channels.get(channelId)
    if (!channel) return undefined

    this.channels.delete(channelId)
    return channel
  }

  reset(): void {
    this.channels.clear()
  }
}