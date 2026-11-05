import { expect } from 'chai'
import { EventEmitter } from 'events'
import { beforeEach, describe, it } from 'mocha'

import { forgetCurrentKeys } from '../aiKeyFallback'
import { keytermQuery, type SttHandlers, SttSession, sttUrl } from './stt'

/** A recogniser socket the test drives by hand. */
class FakeSocket extends EventEmitter {
  sent: Array<Buffer | string> = []
  closed = false
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>
  ) {
    super()
  }

  send(data: Buffer | string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  /** The socket opens and xAI says it is ready. */
  ready(): this {
    this.emit('open')
    this.say({ type: 'transcript.created', id: 'x' })
    return this
  }

  say(message: object | string): void {
    this.emit(
      'message',
      Buffer.from(
        typeof message === 'string' ? message : JSON.stringify(message)
      )
    )
  }

  partial(text: string, speechFinal = false): void {
    this.say({
      type: 'transcript.partial',
      text,
      is_final: speechFinal,
      speech_final: speechFinal
    })
  }

  get controls(): string[] {
    return this.sent.filter((f): f is string => typeof f === 'string')
  }

  get audio(): Buffer {
    return Buffer.concat(
      this.sent.filter((f): f is Buffer => Buffer.isBuffer(f))
    )
  }

  terms(): string[] {
    return new URL(this.url).searchParams.getAll('keyterm')
  }
}

const FINALIZE = JSON.stringify({ type: 'finalize' })
const AUDIO_DONE = JSON.stringify({ type: 'audio.done' })

function setup(finalTimeoutMs = 1000): {
  session: SttSession
  sockets: FakeSocket[]
  events: string[]
} {
  const sockets: FakeSocket[] = []
  const events: string[] = []
  const handlers: SttHandlers = {
    onPartial: text => events.push(`partial ${text}`),
    onFinal: text => events.push(`final ${text}`),
    onError: message => events.push(`error ${message}`)
  }
  const session = new SttSession(
    {
      apiKey: 'key',
      finalTimeoutMs,
      connect: (url, headers) => {
        const socket = new FakeSocket(url, headers)
        sockets.push(socket)
        return socket
      }
    },
    handlers
  )
  return { session, sockets, events }
}

const pcm = (n: number): Buffer => Buffer.alloc(n, 1)

describe('dictation recogniser', function () {
  it('keeps key terms within what xAI takes, names first', function () {
    const many = Array.from({ length: 120 }, (_, i) => `term ${i}`)
    expect(keytermQuery(many)).to.have.length(100)
    expect(keytermQuery(many)[0]).equals('term 0')
    expect(
      keytermQuery([' Noah D. ', 'noah d.', '', 'x'.repeat(51), 'gapper'])
    ).deep.equals(['Noah D.', 'gapper'])
    const url = new URL(
      sttUrl('wss://api.x.ai/v1/stt', 'm', ['Noah D.', 'six three'])
    )
    expect(url.searchParams.get('model')).equals('m')
    expect(url.searchParams.getAll('keyterm')).deep.equals([
      'Noah D.',
      'six three'
    ])
  })

  it('opens with the key in a header and the terms in the URL', function () {
    const { session, sockets } = setup()
    session.retarget(['Noah D.', 'gapper'])
    expect(sockets).to.have.length(1)
    expect(sockets[0].headers).deep.equals({ Authorization: 'Bearer key' })
    expect(sockets[0].url).match(
      /^wss:\/\/api\.x\.ai\/v1\/stt\?model=grok-voice-transcribe-2\.0&/
    )
    expect(sockets[0].terms()).deep.equals(['Noah D.', 'gapper'])
  })

  it('holds audio written before the socket opens and flushes it on open', function () {
    const { session, sockets } = setup()
    session.retarget(['Noah D.'])
    session.begin()
    session.write(pcm(4))
    session.write(pcm(6))
    session.end()
    expect(sockets[0].sent).to.have.length(0)
    sockets[0].ready()
    expect(sockets[0].audio.length).equals(10)
    expect(sockets[0].controls).deep.equals([FINALIZE])
  })

  it('reports partials, and the final from the speech_final that answers finalize', function () {
    const { session, sockets, events } = setup()
    session.retarget([])
    const socket = sockets[0].ready()
    session.begin()
    session.write(pcm(4))
    socket.partial('Noah sin')
    socket.partial('Noah singled')
    session.end()
    expect(socket.controls).deep.equals([FINALIZE])
    socket.partial('Noah singled.', true)
    expect(events).deep.equals([
      'partial Noah sin',
      'partial Noah singled',
      'final Noah singled.'
    ])
    expect(socket.closed).equals(false)
  })

  it('joins the segments a pause splits one hold into', function () {
    const { session, sockets, events } = setup()
    session.retarget([])
    const socket = sockets[0].ready()
    session.begin()
    socket.partial('Number seven steals second.', true)
    socket.partial('Throw is')
    session.end()
    socket.partial('Throw is wild.', true)
    expect(events).deep.equals([
      'partial Number seven steals second.',
      'partial Number seven steals second. Throw is',
      'final Number seven steals second. Throw is wild.'
    ])
  })

  it('serves a second utterance over the same socket', function () {
    const { session, sockets, events } = setup()
    session.retarget([])
    const socket = sockets[0].ready()
    for (const said of ['Ball.', 'Strike.']) {
      session.begin()
      session.write(pcm(2))
      session.end()
      socket.partial(said, true)
    }
    expect(sockets).to.have.length(1)
    expect(socket.controls).deep.equals([FINALIZE, FINALIZE])
    expect(events).deep.equals(['final Ball.', 'final Strike.'])
  })

  it('settles a silent hold on its empty answer, and a lost answer on a timer', async function () {
    const { session, sockets, events } = setup(20)
    session.retarget([])
    const socket = sockets[0].ready()
    session.begin()
    session.end()
    socket.partial('', true)
    expect(events).deep.equals(['final '])
    session.begin()
    socket.partial('Ball', true)
    session.end()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(events).deep.equals(['final ', 'partial Ball', 'final Ball'])
  })

  it('ignores what arrives outside an utterance, and frames that are not JSON', function () {
    const { session, sockets, events } = setup()
    session.retarget([])
    const socket = sockets[0].ready()
    socket.partial('stale', true)
    session.write(pcm(2))
    session.end()
    socket.say('not json')
    socket.say('"a string"')
    session.begin()
    socket.say({ type: 'transcript.done', text: '' })
    socket.say('also not json')
    expect(events).deep.equals([])
    expect(socket.sent).deep.equals([])
  })

  it('reports an error frame against the utterance in flight', function () {
    const { session, sockets, events } = setup()
    session.retarget([])
    const socket = sockets[0].ready()
    socket.say({ type: 'error', message: 'idle' })
    session.begin()
    socket.say({ type: 'error', message: 'bad audio' })
    socket.partial('late', true)
    session.begin()
    socket.say({ type: 'error' })
    expect(events).deep.equals([
      'error bad audio',
      'error The recogniser failed'
    ])
  })

  it('keeps 16-bit samples whole across odd-length frames', function () {
    const { session, sockets } = setup()
    session.retarget([])
    const socket = sockets[0].ready()
    session.begin()
    session.write(Buffer.from([1, 2, 3]))
    session.write(Buffer.from([4]))
    session.write(Buffer.from([5]))
    session.end()
    const frames = socket.sent.filter((f): f is Buffer => Buffer.isBuffer(f))
    expect(frames.map(f => [...f])).deep.equals([
      [1, 2],
      [3, 4]
    ])
  })

  it('sends audio.done on close and reports nothing more', function () {
    const { session, sockets, events } = setup()
    session.retarget([])
    const socket = sockets[0].ready()
    session.begin()
    session.close()
    expect(socket.controls).deep.equals([AUDIO_DONE])
    expect(socket.closed).equals(true)
    socket.emit('close')
    socket.partial('late', true)
    session.retarget(['x'])
    session.begin()
    expect(events).deep.equals([])
    expect(sockets).to.have.length(1)
  })

  describe('retarget', function () {
    it('opens the next socket and keeps the old one until the new is ready', function () {
      const { session, sockets } = setup()
      session.retarget(['Noah D.'])
      const first = sockets[0].ready()
      session.retarget(['Jack A.'])
      expect(sockets).to.have.length(2)
      expect(sockets[1].terms()).deep.equals(['Jack A.'])
      expect(first.controls).deep.equals([])
      sockets[1].emit('open')
      expect(first.controls).deep.equals([])
      sockets[1].say({ type: 'transcript.created' })
      expect(first.controls).deep.equals([AUDIO_DONE])
      expect(first.closed).equals(true)
      session.begin()
      session.write(pcm(2))
      expect(sockets[1].audio.length).equals(2)
    })

    it('never swaps under an utterance', function () {
      const { session, sockets, events } = setup()
      session.retarget(['Noah D.'])
      const first = sockets[0].ready()
      session.begin()
      session.write(pcm(2))
      session.retarget(['Jack A.'])
      sockets[1].ready()
      session.write(pcm(2))
      session.end()
      expect(first.audio.length).equals(4)
      expect(first.controls).deep.equals([FINALIZE])
      first.partial('Noah singled.', true)
      expect(events).deep.equals(['final Noah singled.'])
      expect(first.controls).deep.equals([FINALIZE, AUDIO_DONE])
      session.begin()
      session.write(pcm(2))
      expect(sockets[1].audio.length).equals(2)
    })

    it('sends a hold that begins while the next socket opens to that socket', function () {
      const { session, sockets, events } = setup()
      session.retarget(['Noah D.'])
      const first = sockets[0].ready()
      session.retarget(['Jack A.'])
      session.begin()
      expect(first.controls).deep.equals([AUDIO_DONE])
      session.write(pcm(2))
      session.end()
      expect(sockets[1].sent).deep.equals([])
      sockets[1].ready()
      expect(sockets[1].audio.length).equals(2)
      expect(sockets[1].controls).deep.equals([FINALIZE])
      sockets[1].partial('Jack walked.', true)
      expect(events).deep.equals(['final Jack walked.'])
    })

    it('opens nothing when the terms do not change', function () {
      const { session, sockets } = setup()
      session.retarget(['Noah D.'])
      session.retarget(['Noah D.', 'noah d.'])
      expect(sockets).to.have.length(1)
      session.retarget(['Jack A.'])
      session.retarget(['Jack A.'])
      expect(sockets).to.have.length(2)
      // Back to the current terms: the socket opening for others goes.
      session.retarget(['Noah D.'])
      expect(sockets).to.have.length(2)
      expect(sockets[1].closed).equals(true)
    })

    it('replaces a next socket that is superseded or drops', function () {
      const { session, sockets } = setup()
      session.retarget(['A'])
      sockets[0].ready()
      session.retarget(['B'])
      session.retarget(['C'])
      expect(sockets[1].closed).equals(true)
      expect(sockets[2].terms()).deep.equals(['C'])
      sockets[2].emit('error', new Error('refused'))
      sockets[2].emit('close')
      session.begin()
      session.write(pcm(2))
      expect(sockets[0].audio.length).equals(2)
    })
  })

  describe('a dropped socket', function () {
    it('fails the utterance in flight and reopens with the last terms', function () {
      const { session, sockets, events } = setup()
      session.retarget(['Noah D.'])
      const first = sockets[0].ready()
      session.begin()
      first.emit('error', new Error('reset'))
      first.emit('close')
      expect(events).deep.equals(['error The recogniser disconnected: reset'])
      expect(sockets).to.have.length(2)
      expect(sockets[1].terms()).deep.equals(['Noah D.'])
      session.begin()
      session.write(pcm(2))
      sockets[1].ready()
      expect(sockets[1].audio.length).equals(2)
    })

    it('promotes a next socket rather than opening another', function () {
      const { session, sockets, events } = setup()
      session.retarget(['A'])
      const first = sockets[0].ready()
      session.retarget(['B'])
      first.emit('close')
      expect(events).deep.equals([])
      expect(sockets).to.have.length(2)
      session.begin()
      session.write(pcm(2))
      sockets[1].ready()
      expect(sockets[1].audio.length).equals(2)
    })

    it('leaves a socket that never opened for the next hold', function () {
      const { session, sockets, events } = setup()
      session.retarget(['A'])
      session.begin()
      sockets[0].emit('close')
      expect(events).deep.equals(['error The recogniser disconnected'])
      expect(sockets).to.have.length(1)
      session.begin()
      expect(sockets).to.have.length(2)
      expect(sockets[1].terms()).deep.equals(['A'])
    })

    it('opens a socket for a hold that begins before any key terms', function () {
      const { session, sockets } = setup()
      session.begin()
      expect(sockets).to.have.length(1)
      expect(sockets[0].terms()).deep.equals([])
    })
  })
})

describe('pooled voice recognition', () => {
  beforeEach(forgetCurrentKeys)
  function pooled(
    keys = ['a', 'b'],
    timeout = 1000
  ): {
    session: SttSession
    sockets: FakeSocket[]
    events: string[]
  } {
    const sockets: FakeSocket[] = []
    const events: string[] = []
    const session = new SttSession(
      {
        apiKey: keys,
        finalTimeoutMs: timeout,
        handshakeTimeoutMs: timeout,
        connect: (url, headers) => {
          const socket = new FakeSocket(url, headers)
          sockets.push(socket)
          return socket
        }
      },
      {
        onPartial: text => events.push(`partial ${text}`),
        onFinal: text => events.push(`final ${text}`),
        onError: message => events.push(`error ${message}`)
      }
    )
    return { session, sockets, events }
  }
  const key = (socket: FakeSocket): string =>
    socket.headers.Authorization.replace('Bearer ', '')
  const refuse = (socket: FakeSocket, statusCode: number): void => {
    socket.emit('unexpected-response', {}, { statusCode })
    expect(socket.closed).equals(true)
    socket.emit('close')
  }
  const wait = async (ms: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  it('keeps one socket across holds on a healthy key, and opens ahead on retarget', () => {
    const h = pooled()
    h.session.retarget(['Noah D.'])
    expect(h.sockets).length(1)
    const first = h.sockets[0].ready()
    for (const said of ['Ball.', 'Strike.']) {
      h.session.begin()
      h.session.write(pcm(2))
      h.session.end()
      first.partial(said, true)
    }
    expect(h.sockets).length(1)
    expect(first.controls).deep.equals([FINALIZE, FINALIZE])
    expect(first.closed).equals(false)
    h.session.retarget(['Jack A.'])
    expect(h.sockets).length(2)
    expect(h.sockets[1].terms()).deep.equals(['Jack A.'])
    expect(key(h.sockets[1])).equals(key(first))
    h.sockets[1].ready()
    expect(first.controls).deep.equals([FINALIZE, FINALIZE, AUDIO_DONE])
    h.session.begin()
    h.session.write(pcm(2))
    h.session.end()
    h.sockets[1].partial('Jack walked.', true)
    expect(h.sockets).length(2)
    expect(h.sockets[1].audio.length).equals(2)
    expect(h.events).deep.equals([
      'final Ball.',
      'final Strike.',
      'final Jack walked.'
    ])
    h.session.close()
    expect(h.sockets[1].closed).equals(true)
  })

  it('replays a refused hold on another key, then keeps that key for the next hold', () => {
    const h = pooled(['a', 'b', 'a'])
    h.session.retarget(['Trout'])
    h.session.begin()
    h.session.write(Buffer.from([1, 2, 3]))
    h.session.write(Buffer.from([4]))
    h.session.end()
    h.sockets[0].partial('partial')
    refuse(h.sockets[0], 401)
    expect(h.sockets).length(2)
    expect([key(h.sockets[0]), key(h.sockets[1])]).deep.equals(['a', 'b'])
    expect(h.sockets[1].terms()).deep.equals(['Trout'])
    h.sockets[1].ready()
    expect([...h.sockets[1].audio]).deep.equals([1, 2, 3, 4])
    expect(h.sockets[1].controls).deep.equals([FINALIZE])
    h.sockets[0].partial('stale', true)
    h.sockets[1].partial('Recovered', true)
    expect(h.events).deep.equals([
      'partial partial',
      'partial ',
      'final Recovered'
    ])
    h.session.begin()
    h.session.write(pcm(2))
    h.session.end()
    h.sockets[1].partial('Again', true)
    expect(h.sockets).length(2)
    expect(h.events.at(-1)).equals('final Again')
    h.session.close()
    // The pool stays on the key that took over, for the next connection too.
    const next = pooled(['a', 'b', 'a'])
    next.session.begin()
    expect(key(next.sockets[0])).equals('b')
    next.session.close()
  })

  it('replays a hold whose socket drops, and never relays the transport text', () => {
    const h = pooled()
    h.session.retarget([])
    const first = h.sockets[0].ready()
    h.session.begin()
    h.session.write(pcm(4))
    first.emit('error', new Error('reset; Authorization: Bearer a'))
    first.emit('close')
    expect(h.sockets).length(2)
    expect(key(h.sockets[1])).not.equals(key(first))
    h.sockets[1].ready()
    expect(h.sockets[1].audio.length).equals(4)
    // A refusal that names no status is a lost socket like any other.
    h.sockets[1].emit('unexpected-response', {}, {})
    h.sockets[1].emit('close')
    expect(h.events).deep.equals(['error The recogniser could not be reached'])
    expect(h.sockets).length(2)
  })

  it("reports only the latest failure once every key is spent, then starts again at the pool's key", () => {
    const h = pooled()
    h.session.begin()
    refuse(h.sockets[0], 401)
    refuse(h.sockets[1], 529)
    expect(h.events).deep.equals(['error The recogniser answered 529'])
    expect(h.sockets).length(2)
    h.session.write(pcm(2))
    h.session.end()
    h.session.begin()
    expect(h.sockets).length(3)
    h.session.close()
  })

  it('does not retry a status no other key would change, or a closed session', () => {
    const h = pooled()
    h.session.begin()
    refuse(h.sockets[0], 400)
    expect(h.sockets).length(1)
    expect(h.events).deep.equals(['error The recogniser answered 400'])
    h.session.begin()
    expect(h.sockets).length(2)
    expect(key(h.sockets[1])).equals(key(h.sockets[0]))
    h.session.close()
    h.sockets[1].emit('close')
    h.session.begin()
    h.session.retarget([])
    h.session.write(Buffer.from([1, 2]))
    h.session.end()
    expect(h.sockets).length(2)
    expect(h.events).length(1)
  })

  it('reports an error from xAI once, redacted, on the same socket', () => {
    // One key in a pool takes the single-key path, which redacts as well.
    const h = pooled(['secret-key'])
    h.session.retarget([])
    const socket = h.sockets[0].ready()
    h.session.begin()
    h.session.write(pcm(2))
    socket.say({
      type: 'error',
      message: `Unsupported audio for secret-key ${'x'.repeat(300)}`
    })
    expect(h.sockets).length(1)
    expect(h.events).length(1)
    expect(h.events[0]).equals(
      `error ${`Unsupported audio for [redacted] ${'x'.repeat(300)}`.slice(0, 200)}`
    )
    h.session.write(pcm(2))
    h.session.begin()
    socket.say({ type: 'error' })
    expect(h.events.at(-1)).equals('error The recogniser failed')
    h.session.begin()
    h.session.end()
    socket.partial('Ball.', true)
    expect(h.sockets).length(1)
    expect(h.events.at(-1)).equals('final Ball.')
    expect(socket.audio.length).equals(2)
    h.session.close()
  })

  it('settles a timed-out answer on the segments it has', async () => {
    const h = pooled(['a', 'b'], 5)
    h.session.retarget([])
    const socket = h.sockets[0].ready()
    h.session.begin()
    socket.partial('Ball one.', true)
    h.session.end()
    await wait(25)
    expect(h.events).deep.equals(['partial Ball one.', 'final Ball one.'])
    expect(h.sockets).length(1)
    expect(socket.closed).equals(false)
    h.session.close()
  })

  it('ends a hold whose socket never becomes ready, without trying another key', async () => {
    const h = pooled(['a', 'b'], 5)
    h.session.begin()
    h.session.write(pcm(2))
    await wait(25)
    expect(h.sockets).length(1)
    expect(h.sockets[0].closed).equals(true)
    expect(h.events).deep.equals(['error The recogniser timed out'])
    h.session.begin()
    expect(h.sockets).length(2)
    expect(key(h.sockets[1])).equals(key(h.sockets[0]))
    h.sockets[1].ready()
    await wait(25)
    expect(h.events).length(1)
    h.session.close()
  })

  it('ends a hold that gets no answer, without trying another key', async () => {
    const h = pooled(['a', 'b'], 5)
    h.session.retarget([])
    const socket = h.sockets[0].ready()
    h.session.begin()
    socket.partial('Ball')
    h.session.end()
    await wait(25)
    expect(h.events).deep.equals([
      'partial Ball',
      'error The recogniser timed out'
    ])
    expect(h.sockets).length(1)
    expect(socket.closed).equals(true)
    h.session.close()
  })

  it('handles empty pools and bounded replay storage', () => {
    const empty = pooled([])
    empty.session.retarget(['Trout'])
    empty.session.begin()
    expect(empty.sockets).length(0)
    expect(empty.events).deep.equals(['error No API keys are configured'])
    empty.session.close()
    // Past the replay buffer a hold goes on, but no longer moves to another key.
    const full = pooled()
    full.session.begin()
    full.session.write(Buffer.alloc(4 * 1024 * 1024 + 1))
    expect(full.events).deep.equals([])
    expect(full.sockets[0].closed).equals(false)
    full.sockets[0].emit('close')
    expect(full.events).deep.equals([
      'error The recogniser could not be reached'
    ])
    expect(full.sockets).length(1)
    full.session.close()
    // A pool of one has nothing to replay on, and keeps no buffer at all.
    const one = pooled(['only'])
    one.session.begin()
    one.session.write(Buffer.alloc(4 * 1024 * 1024 + 2))
    one.session.end()
    one.sockets[0].ready().partial('Long.', true)
    expect(one.events).deep.equals(['final Long.'])
    one.session.close()
  })
})

describe('pooled voice connection failures', () => {
  it('bounds synchronous connection failures and rejects late audio', () => {
    const errors: string[] = []
    let calls = 0
    const session = new SttSession(
      {
        apiKey: ['a', 'b'],
        connect: () => {
          calls++
          throw new Error('private transport failure')
        }
      },
      {
        onPartial: () => undefined,
        onFinal: () => expect.fail('no success'),
        onError: message => errors.push(message)
      }
    )
    session.write(Buffer.from([0, 0]))
    session.end()
    session.begin()
    session.write(Buffer.from([0, 0]))
    session.end()
    expect(calls).equals(2)
    expect(errors).deep.equals(['The recogniser could not be reached'])
    session.close()
  })

  it('leaves a socket that cannot open on retarget for the next hold to report', () => {
    const errors: string[] = []
    let calls = 0
    const session = new SttSession(
      {
        apiKey: ['a', 'b'],
        connect: () => {
          calls++
          throw new Error('private transport failure')
        }
      },
      {
        onPartial: () => undefined,
        onFinal: () => expect.fail('no success'),
        onError: message => errors.push(message)
      }
    )
    session.retarget(['Trout'])
    expect(calls).equals(1)
    expect(errors).deep.equals([])
    session.begin()
    expect(calls).equals(3)
    expect(errors).deep.equals(['The recogniser could not be reached'])
    session.close()
  })
})
