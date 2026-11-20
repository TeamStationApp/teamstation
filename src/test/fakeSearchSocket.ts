import type { WebSocketConstructor, WebSocketLike } from '../common/gameSocket'
import type {
  Location,
  SearchErrorCode,
  SearchFrame,
  SearchResult,
  SearchStage
} from '../common/search/types'
import {
  SEARCH_SIGNED_OUT_CLOSE,
  SearchSocket,
  type SearchSocketOptions
} from '../common/searchSocket'

/** What the fake server answers a frame with, when it answers by itself. */
export interface FakeSearchAnswer {
  results: SearchResult[]
  locations?: Location[]
}

/**
 * A search server for app tests: the `SearchSocket`s the screen makes
 * through `factory` talk to it over a fake WebSocket, so no test opens a
 * real one.
 *
 * Its sockets open on the next tick while it is `online`, and fail to while
 * it is not. With `answer` set, each `search` frame is answered on the next
 * tick with that answer, as the lexicographic stage; without it, the test
 * answers by hand with `reply`.
 */
export class FakeSearchServer {
  /** Every `search` frame received, in order. */
  readonly frames: SearchFrame[] = []
  /** Every socket made, in order. */
  readonly sockets: FakeSearchWebSocket[] = []
  /** The options each `SearchSocket` was made with. */
  readonly made: SearchSocketOptions[] = []
  online = true
  answer: ((frame: SearchFrame) => FakeSearchAnswer) | undefined

  constructor(answer?: (frame: SearchFrame) => FakeSearchAnswer) {
    this.answer = answer
  }

  /** The screen's way of making its socket. */
  readonly factory = (options: SearchSocketOptions): SearchSocket => {
    this.made.push(options)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this
    const Impl = class extends FakeSearchWebSocket {
      constructor(url: string) {
        super(server, url)
      }
    } as unknown as WebSocketConstructor
    return new SearchSocket({ ...options, WebSocketImpl: Impl })
  }

  /** The newest socket. */
  get socket(): FakeSearchWebSocket | undefined {
    return this.sockets.at(-1)
  }

  /** The last frame received. */
  get last(): SearchFrame | undefined {
    return this.frames.at(-1)
  }

  /** Answers a frame (the last, by default). */
  reply(
    answer: FakeSearchAnswer,
    {
      frame = this.last,
      stage = 'lexicographic'
    }: { frame?: SearchFrame; stage?: SearchStage } = {}
  ): void {
    if (frame == null) throw new Error('No search frame to answer')
    this.socket?.receive({
      type: 'results',
      seq: frame.seq,
      stage,
      results: answer.results,
      locations: answer.locations ?? []
    })
  }

  /** Refuses a frame (the last, by default). */
  refuse(code: SearchErrorCode, message: string, frame = this.last): void {
    this.socket?.receive({
      type: 'error',
      ...(frame == null ? {} : { seq: frame.seq }),
      code,
      message
    })
  }

  /**
   * Closes the open socket as the server does a session it no longer takes
   * (4401).
   */
  signOut(): void {
    this.socket?.drop(SEARCH_SIGNED_OUT_CLOSE)
  }

  /** Drops the open socket and refuses new ones until `online` again. */
  disconnect(): void {
    this.online = false
    this.socket?.drop()
  }
}

export class FakeSearchWebSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  closed = false

  constructor(
    private readonly server: FakeSearchServer,
    readonly url: string
  ) {
    server.sockets.push(this)
    setTimeout(() => {
      if (this.closed) return
      if (server.online) this.onopen?.({})
      else this.drop()
    }, 0)
  }

  send(data: string): void {
    const frame = JSON.parse(data) as SearchFrame
    this.server.frames.push(frame)
    const answer = this.server.answer
    if (answer == null) return
    setTimeout(() => {
      if (this.closed) return
      this.server.reply(answer(frame), { frame })
    }, 0)
  }

  close(): void {
    this.closed = true
  }

  receive(frame: unknown): void {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) })
  }

  drop(code?: number): void {
    this.closed = true
    this.onclose?.(code == null ? {} : { code })
  }
}
