import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type Amf,
  amfDecodeAll,
  amfEncodeAll,
  ChunkReader,
  MSG,
  type RtmpMessage,
  type RtmpSocket,
  writeChunks
} from './rtmpPublish'

/**
 * A pretend RTMP server on the far end of a fake socket, for the publisher's tests:
 * it answers the handshake, connect, createStream and publish as an ingest does, and
 * keeps every message the client sent.
 */
export interface FakeServerOptions {
  refuseConnect?: boolean
  publishCode?: string
  /** Sent right after the handshake, before anything else. */
  greet?: RtmpMessage[]
  /** Hold the handshake reply back until `answer()`. */
  hold?: boolean
}

export class FakeRtmpServer {
  readonly received: RtmpMessage[] = []
  readonly socket: RtmpSocket & { destroyed: boolean }
  readonly written: Buffer[] = []
  private readonly reader = new ChunkReader()
  private readonly listeners = new Map<string, Array<(arg: any) => void>>()
  private handshakeBytes = 0
  private answered = false
  host = ''
  port = 0

  constructor(private readonly options: FakeServerOptions = {}) {
    const socket = {
      destroyed: false,
      write: (data: Buffer) => {
        this.onClient(data)
        return true
      },
      on: (event: string, listener: (arg: any) => void) => {
        this.listeners.set(event, [
          ...(this.listeners.get(event) ?? []),
          listener
        ])
      },
      destroy: () => {
        socket.destroyed = true
      }
    }
    this.socket = socket
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg)
  }

  private toClient(message: RtmpMessage): void {
    this.emit('data', writeChunks(message, 128))
  }

  reply(values: Amf[], streamId = 0): void {
    this.toClient({
      csid: 3,
      type: MSG.command,
      streamId,
      timestamp: 0,
      payload: amfEncodeAll(values)
    })
  }

  answer(): void {
    this.answered = true
    const s = Buffer.alloc(1 + 1536 * 2, 1)
    s[0] = 3
    this.emit('data', s)
    for (const message of this.options.greet ?? []) this.toClient(message)
  }

  commands(): Amf[][] {
    return this.received
      .filter(message => message.type === MSG.command)
      .map(message => amfDecodeAll(message.payload))
  }

  private onClient(data: Buffer): void {
    this.written.push(Buffer.from(data))
    if (this.handshakeBytes < 1537 + 1536) {
      this.handshakeBytes += data.length
      if (this.handshakeBytes === 1537 && this.options.hold !== true)
        this.answer()
      return
    }
    for (const message of this.reader.push(data)) {
      this.received.push(message)
      if (message.type !== MSG.command) continue
      const [name, txn] = amfDecodeAll(message.payload)
      if (name === 'connect') {
        if (this.options.refuseConnect === true) {
          this.reply(['_error', txn, null, { description: 'not allowed' }])
        } else
          this.reply([
            '_result',
            txn,
            null,
            { code: 'NetConnection.Connect.Success' }
          ])
      }
      if (name === 'createStream') this.reply(['_result', txn, null, 1])
      if (name === 'publish') {
        this.reply(
          ['onStatus', 0, null, { code: 'NetStream.Publish.Pending' }],
          1
        )
        this.reply(
          [
            'onStatus',
            0,
            null,
            { code: this.options.publishCode ?? 'NetStream.Publish.Start' }
          ],
          1
        )
      }
    }
  }
}

describe('the fake RTMP server', function () {
  it('answers the handshake once the client has sent C0 and C1', function () {
    const server = new FakeRtmpServer()
    const seen: Buffer[] = []
    server.socket.on('data', (data: Buffer) => seen.push(data))
    server.socket.write(Buffer.alloc(1537))
    expect(seen[0].length).equals(3073)
  })
})
