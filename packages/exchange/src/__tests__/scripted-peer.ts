// scripted-peer — a transport whose every message is written by the test, so
// a test can send what no real peer would.

import {
  type ChannelMsg,
  type ConnectedChannel,
  type GeneratedChannel,
  Transport,
} from "@kyneta/transport"

/** A peer whose every message is written by the test. */
export class ScriptedPeer extends Transport<void> {
  readonly sent: ChannelMsg[] = []
  #channel: ConnectedChannel | undefined

  constructor() {
    super({ transportType: "scripted", transportId: "scripted" })
  }

  protected generate(): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: msg => {
        this.sent.push(msg)
      },
      stop: () => {},
    }
  }

  async onStart(): Promise<void> {
    const channel = this.addChannel(undefined)
    this.#channel = channel
    this.establishChannel(channel.channelId)
  }

  async onStop(): Promise<void> {}

  receive(msg: ChannelMsg): void {
    if (!this.#channel) throw new Error("the scripted peer has not started")
    this.#channel.onReceive(msg)
  }

  sentOf<T extends ChannelMsg["type"]>(
    type: T,
  ): Extract<ChannelMsg, { type: T }>[] {
    return this.sent.filter(
      (m): m is Extract<ChannelMsg, { type: T }> => m.type === type,
    )
  }
}
