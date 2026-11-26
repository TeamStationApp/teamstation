import { expect } from 'chai'
import { describe, it } from 'mocha'

import { RECONNECT_DELAYS_MS, type WebSocketLike } from './gameSocket'
import type {
  SearchAsk,
  SearchErrorFrame,
  SearchResultsFrame
} from './search/types'
import {
  SEARCH_SIGNED_OUT_CLOSE,
  SearchSocket,
  type SearchSocketResults,
  type SearchSocketStatus,
  searchSocketUrl,
  TOKEN_CHECK_MS
} from './searchSocket'

/** A WebSocket the test opens, closes and talks through by hand. */
class FakeSocket implements WebSocketLike {
  static made: FakeSocket[] = []
  sent: Array<Record<string, unknown>> = []
  closedWith: number | undefined
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers: Record<string, string> }
  ) {
    FakeSocket.made.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code?: number): void {
    this.closedWith = code ?? 1005
  }

  open(): void {
    this.onopen?.({})
  }

  drop(code?: number): void {
    this.onclose?.(code == null ? {} : { code })
  }

  fail(): void {
    this.onerror?.({})
  }

  receive(frame: unknown): void {
    this.onmessage?.({
      data: typeof frame === 'string' ? frame : JSON.stringify(frame)
    })
  }
}

/** Timers the test fires by hand, in the order they were set. */
function manualTimers(): {
  delays: number[]
  fire: () => void
  pending: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
} {
  const waiting = new Map<number, () => void>()
  const delays: number[] = []
  let next = 1
  return {
    delays,
    fire: () => {
      const [id, run] = [...waiting.entries()][0]
      waiting.delete(id)
      run()
    },
    pending: () => waiting.size,
    setTimer: (run, ms) => {
      delays.push(ms)
      const id = next++
      waiting.set(id, run)
      return id
    },
    clearTimer: timer => {
      waiting.delete(timer as number)
    }
  }
}

const URL = 'ws://api.example.test/api/v1/search'

function makeSocket(token?: () => string | null): {
  socket: SearchSocket
  timers: ReturnType<typeof manualTimers>
  results: SearchSocketResults[]
  errors: SearchErrorFrame[]
  statuses: SearchSocketStatus[]
  logged: string[]
} {
  FakeSocket.made = []
  const logged: string[] = []
  const timers = manualTimers()
  const socket = new SearchSocket({
    url: URL,
    token,
    WebSocketImpl: FakeSocket,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    log: line => logged.push(line)
  })
  const results: SearchSocketResults[] = []
  const errors: SearchErrorFrame[] = []
  const statuses: SearchSocketStatus[] = []
  socket.onResults(each => results.push(each))
  socket.onError(each => errors.push(each))
  socket.onStatus(each => statuses.push(each))
  return { socket, timers, results, errors, statuses, logged }
}

const last = (): FakeSocket => FakeSocket.made[FakeSocket.made.length - 1]

const ask = (text: string): SearchAsk => ({
  text,
  location: null,
  mode: 'all'
})

const answer = (
  seq: number,
  stage: 'lexicographic' | 'jev' = 'lexicographic',
  name = `Answer ${seq}`
): SearchResultsFrame => ({
  type: 'results',
  seq,
  stage,
  results: [
    {
      kind: 'team',
      id: 'tem_1',
      name,
      imageUrl: null,
      cityLine: null,
      associations: '',
      follow: null
    }
  ],
  locations: []
})

describe('SearchSocket', function () {
  it('finds its address from the API base URL', function () {
    expect(searchSocketUrl('https://app.example.test/api/v1')).equals(
      'wss://app.example.test/api/v1/search'
    )
    expect(
      searchSocketUrl('/api/v1', 'http://localhost.example.test:8080/home')
    ).equals('ws://localhost.example.test:8080/api/v1/search')
  })

  it('connects at once, signed out or with the token it reads for each connection', function () {
    makeSocket()
    expect(last().url).equals(URL)
    expect(last().options).equals(undefined)
    let token: string | null = 'tok_first'
    const { timers } = makeSocket(() => token)
    expect(last().options).deep.equals({
      headers: { Authorization: 'Bearer tok_first' }
    })
    token = null
    last().drop()
    timers.fire()
    expect(last().options).equals(undefined)
  })

  it('numbers each search and sends it once open, then at once', function () {
    const { socket } = makeSocket()
    expect(socket.latestSeq).equals(0)
    expect(socket.search(ask('san'))).equals(1)
    expect(last().sent).deep.equals([])
    last().open()
    expect(last().sent).deep.equals([
      { type: 'search', seq: 2, text: 'san', location: null, mode: 'all' }
    ])
    expect(
      socket.search({ ...ask('san d'), mode: 'people', forTeam: 'tem_1' })
    ).equals(3)
    expect(last().sent[1]).deep.equals({
      type: 'search',
      seq: 3,
      text: 'san d',
      location: null,
      mode: 'people',
      forTeam: 'tem_1'
    })
  })

  it('hears only the latest seq, both stages, and drops an older one', function () {
    const { socket, results } = makeSocket()
    last().open()
    socket.search(ask('san'))
    socket.search(ask('san d'))
    last().receive(answer(1))
    last().receive(answer(2))
    last().receive(answer(1, 'jev'))
    last().receive(answer(2, 'jev', 'Ranked'))
    expect(results.map(each => `${each.seq}:${each.stage}`)).deep.equals([
      '2:lexicographic',
      '2:jev'
    ])
    expect(results[1].results[0].name).equals('Ranked')
    expect(results[1].locations).deep.equals([])
  })

  it('ignores what it cannot read, and says so', function () {
    const { socket, results, errors, logged } = makeSocket()
    last().open()
    socket.search(ask('san'))
    last().receive('not json')
    last().receive({ type: 'results', seq: 1 })
    last().onmessage?.({ data: new Uint8Array([1]) })
    expect(results).deep.equals([])
    expect(errors).deep.equals([])
    expect(logged).length(2)
    expect(logged[0]).match(/^search: unreadable frame: /)
  })

  it('leaves out only a row it cannot read, logs it, and shows the rest', function () {
    const { socket, results, logged } = makeSocket()
    last().open()
    socket.search(ask('san'))
    const good = answer(1)
    last().receive({
      ...good,
      results: [
        { ...good.results[0], associations: 'x'.repeat(2000) },
        ...good.results
      ]
    })
    expect(results).length(1)
    expect(results[0].results).deep.equals(good.results)
    expect(logged).length(1)
    expect(logged[0]).match(/^search: left out results\[0\]: /)
  })

  it('warns on the console by default', function () {
    const warned: unknown[] = []
    const warn = console.warn
    console.warn = (line: unknown) => warned.push(line)
    try {
      FakeSocket.made = []
      const socket = new SearchSocket({ url: URL, WebSocketImpl: FakeSocket })
      last().open()
      socket.search(ask('san'))
      last().receive('not json')
      socket.close()
    } finally {
      console.warn = warn
    }
    expect(warned).length(1)
  })

  it('hears an error for the latest seq or for none, not for an older one', function () {
    const { socket, errors } = makeSocket()
    last().open()
    socket.search(ask('san'))
    socket.search(ask('san d'))
    const refusal = (seq?: number): SearchErrorFrame => ({
      type: 'error',
      ...(seq == null ? {} : { seq }),
      code: 'notFound',
      message: 'Not found'
    })
    last().receive(refusal(1))
    last().receive(refusal(2))
    last().receive(refusal())
    expect(errors).deep.equals([refusal(2), refusal()])
  })

  it('reconnects on the schedule and sends the current search again under a new seq', function () {
    const { socket, timers, results } = makeSocket()
    last().open()
    socket.search(ask('san diego'))
    const before = last()
    before.drop()
    for (let at = 0; at < RECONNECT_DELAYS_MS.length + 1; at++) {
      timers.fire()
      if (at < RECONNECT_DELAYS_MS.length) last().drop()
    }
    expect(timers.delays).deep.equals([...RECONNECT_DELAYS_MS, 15000])
    last().open()
    expect(last().sent).deep.equals([
      {
        type: 'search',
        seq: 2,
        text: 'san diego',
        location: null,
        mode: 'all'
      }
    ])
    before.receive(answer(1))
    last().receive(answer(1))
    last().receive(answer(2))
    expect(results.map(each => each.seq)).deep.equals([2])
    // Opened again, the schedule starts over.
    last().drop()
    expect(timers.delays.at(-1)).equals(1000)
  })

  it('honors 1013 across reopened sockets and makes room for both the handshake and search', function () {
    const { socket, timers, results } = makeSocket()
    last().open()
    socket.search(ask('ballpark'))
    const limited = (reason?: string): void => {
      last().onclose?.({ code: 1013, reason })
      timers.fire()
      last().open()
    }
    limited('Try again in 3 seconds')
    limited('Try again in 1 seconds')
    limited()
    expect(timers.delays).deep.equals([6000, 2000, 4000])
    last().receive(answer(socket.latestSeq))
    expect(results).length(1)
    last().drop()
    expect(timers.delays.at(-1)).equals(1000)
  })

  it('reconnects after an error, once, though the close follows it', function () {
    const { timers } = makeSocket()
    const first = last()
    first.fail()
    expect(first.closedWith).equals(1005)
    first.drop()
    expect(timers.pending()).equals(1)
    timers.fire()
    expect(FakeSocket.made).length(2)
  })

  it('reports connecting, then open, then offline until it opens again', function () {
    const { socket, timers, statuses } = makeSocket()
    expect(socket.status).equals('connecting')
    last().open()
    expect(socket.status).equals('open')
    last().drop(1006)
    expect(socket.status).equals('offline')
    timers.fire()
    expect(socket.status).equals('offline')
    last().open()
    expect(statuses).deep.equals(['open', 'offline', 'open'])
  })

  it('stops at 4401, never reconnects with the refused token, and connects again once the token changes', function () {
    let token: string | null = 'tok_dead'
    const { socket, timers, statuses } = makeSocket(() => token)
    last().open()
    socket.search(ask('mookie'))
    last().drop(SEARCH_SIGNED_OUT_CLOSE)
    expect(socket.status).equals('unauthorized')
    expect(statuses).deep.equals(['open', 'unauthorized'])
    // Only the token is read: no connection while it is the refused one.
    expect(timers.delays).deep.equals([TOKEN_CHECK_MS])
    timers.fire()
    timers.fire()
    socket.search(ask('mookie b'))
    expect(FakeSocket.made).length(1)
    expect(timers.pending()).equals(1)
    // A new sign-in: the next check connects with it and asks again.
    token = 'tok_new'
    timers.fire()
    expect(FakeSocket.made).length(2)
    expect(last().options).deep.equals({
      headers: { Authorization: 'Bearer tok_new' }
    })
    expect(timers.pending()).equals(0)
    last().open()
    expect(socket.status).equals('open')
    expect(last().sent.map(frame => frame.text)).deep.equals(['mookie b'])
    // Refused again, and then signed out: a search connects at once, with
    // no token.
    last().drop(SEARCH_SIGNED_OUT_CLOSE)
    token = null
    socket.search(ask('falcons'))
    expect(FakeSocket.made).length(3)
    expect(last().options).equals(undefined)
    expect(timers.pending()).equals(0)
    // Closed while refused, it reads the token no more.
    last().drop(SEARCH_SIGNED_OUT_CLOSE)
    expect(timers.pending()).equals(1)
    socket.close()
    expect(timers.pending()).equals(0)
  })

  it('closes for good: no reconnect, no more answers', function () {
    const { socket, timers, results, statuses } = makeSocket()
    last().open()
    socket.search(ask('san'))
    const open = last()
    socket.close()
    expect(open.closedWith).equals(1000)
    expect(statuses).deep.equals(['open', 'offline'])
    open.receive(answer(1))
    open.drop()
    expect(results).deep.equals([])
    expect(timers.pending()).equals(0)
    socket.close()
    socket.search(ask('san d'))
    expect(open.sent).length(1)
  })

  it('closes while waiting to reconnect', function () {
    const { socket, timers } = makeSocket()
    last().drop()
    expect(timers.pending()).equals(1)
    socket.close()
    expect(timers.pending()).equals(0)
    expect(FakeSocket.made).length(1)
  })

  it('stops hearing when asked', function () {
    const { socket } = makeSocket()
    const heard: string[] = []
    const stops = [
      socket.onResults(() => heard.push('results')),
      socket.onError(() => heard.push('error')),
      socket.onStatus(() => heard.push('status'))
    ]
    for (const stop of stops) stop()
    last().open()
    socket.search(ask('san'))
    last().receive(answer(2))
    last().receive({ type: 'error', code: 'internal', message: 'x' })
    expect(heard).deep.equals([])
  })

  it('needs a WebSocket', function () {
    const global = globalThis as { WebSocket?: unknown }
    const saved = global.WebSocket
    global.WebSocket = undefined
    try {
      expect(() => new SearchSocket({ url: URL })).throws('no WebSocket')
    } finally {
      global.WebSocket = saved
    }
  })
})
