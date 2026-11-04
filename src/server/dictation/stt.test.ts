import { expect } from 'chai'
import { EventEmitter } from 'events'
import { describe, it } from 'mocha'

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
  function pooled(
    keys = ['a', 'b'],
    timeout = 1000
  ): {
    session: SttSession
    sockets: FakeSocket[]
    finals: string[]
    errors: string[]
  } {
    const sockets: FakeSocket[] = []
    const finals: string[] = []
    const errors: string[] = []
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
        onPartial: () => undefined,
        onFinal: text => finals.push(text),
        onError: error => errors.push(error)
      }
    )
    return { session, sockets, finals, errors }
  }
  it('replays held audio once with another key and ignores stale sockets', () => {
    const h = pooled(['a', 'b', 'a'])
    h.session.retarget(['Trout'])
    h.session.begin()
    h.session.write(Buffer.from([1, 2, 3, 4]))
    h.session.end()
    h.sockets[0].emit(
      'message',
      JSON.stringify({
        type: 'transcript.partial',
        speech_final: false,
        text: 'partial'
      })
    )
    h.sockets[0].emit('error', new Error('Unexpected server response: 401'))
    h.sockets[0].emit('close')
    expect(h.sockets).length(2)
    expect(h.sockets[0].headers.Authorization).not.equals(
      h.sockets[1].headers.Authorization
    )
    h.sockets[1].ready()
    expect(
      h.sockets[1].sent.some(
        frame =>
          Buffer.isBuffer(frame) && frame.equals(Buffer.from([1, 2, 3, 4]))
      )
    ).equals(true)
    h.sockets[0].emit(
      'message',
      JSON.stringify({
        type: 'transcript.partial',
        speech_final: true,
        text: 'stale'
      })
    )
    h.sockets[1].emit(
      'message',
      JSON.stringify({
        type: 'transcript.partial',
        speech_final: true,
        text: 'Recovered'
      })
    )
    expect(h.finals).deep.equals(['Recovered'])
    expect(h.errors).deep.equals([])
    h.session.close()
  })
  it('returns only the latest failure after exhausting distinct keys', () => {
    const h = pooled()
    h.session.begin()
    h.sockets[0].emit('error', new Error('Unexpected server response: 401'))
    h.sockets[0].emit('close')
    h.sockets[1].emit('error', new Error('Unexpected server response: 529'))
    h.sockets[1].emit('close')
    expect(h.errors).deep.equals(['The recogniser answered 529'])
    expect(h.sockets).length(2)
    h.session.close()
  })
  it('does not retry nonretryable HTTP failures or canceled holds', () => {
    const h = pooled()
    h.session.begin()
    h.sockets[0].emit('error', new Error('Unexpected server response: 400'))
    h.sockets[0].emit('close')
    expect(h.sockets).length(1)
    expect(h.errors).deep.equals(['The recogniser answered 400'])
    h.session.begin()
    h.session.close()
    h.sockets[1].emit('close')
    h.session.begin()
    h.session.retarget([])
    h.session.write(Buffer.from([1, 2]))
    h.session.end()
    expect(h.sockets).length(2)
  })
  it('bounds handshake/final waits and reports timeouts, not incomplete transcript success', async () => {
    const h = pooled(['a', 'b'], 5)
    h.session.begin()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(h.sockets).length(2)
    expect(h.errors).deep.equals(['The recogniser timed out'])
    h.session.close()
    const final = pooled(['a', 'b'], 5)
    final.session.begin()
    final.sockets[0].ready()
    final.session.end()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(final.finals).deep.equals([])
    expect(final.errors).deep.equals(['The recogniser timed out'])
    final.session.close()
  })
  it('handles empty pools and bounded replay storage', () => {
    const empty = pooled([])
    empty.session.begin()
    expect(empty.errors).deep.equals(['No API keys are configured'])
    empty.session.close()
    const full = pooled()
    full.session.begin()
    full.session.write(Buffer.alloc(4 * 1024 * 1024 + 1))
    expect(full.errors).deep.equals(['The voice request is too long'])
    full.session.close()
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
})
