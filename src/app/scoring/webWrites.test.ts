import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { SwapSidesRead } from '../../common/api'
import { HttpError } from '../../common/errors'
import { type SwappingSession, WebWrites } from './webWrites'

/** A plate appearance in `inning`. */
const play = (atBatIndex: number, inning: number): unknown => ({
  about: { atBatIndex, inning },
  result: { eventType: 'single' },
  playEvents: [{ isPitch: true }]
})

/** A server whose swaps wait for `release`, in the order they were sent. */
function heldServer(): {
  client: ConstructorParameters<typeof WebWrites>[0]
  sent: Array<{ gameId: string; read: SwapSidesRead }>
  order: string[]
  release: (error?: Error) => void
} {
  const sent: Array<{ gameId: string; read: SwapSidesRead }> = []
  const order: string[] = []
  const waiting: Array<(error?: Error) => void> = []
  return {
    sent,
    order,
    release: error => {
      waiting.shift()?.(error)
    },
    client: {
      swapGameSides: async (gameId, read) => {
        sent.push({ gameId, read })
        order.push('swap')
        await new Promise<void>((resolve, reject) => {
          waiting.push(error => {
            if (error == null) resolve()
            else reject(error)
          })
        })
        return {
          homeTeamId: read.awayTeamId,
          awayTeamId: read.homeTeamId,
          generation: 0,
          reset: { atBats: 0, innings: 0 }
        }
      }
    }
  }
}

/** A session whose flush waits for `flushed`, with what its saves answered. */
function session(
  order: string[],
  digests: { playsDigest?: string; generation?: number } = {}
): SwappingSession & { flushed: () => void; flushes: number } {
  let done: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    done = resolve
  })
  const kept = {
    ...digests,
    flushes: 0,
    flushed: () => {
      done()
    },
    flush: async () => {
      kept.flushes++
      await held
      order.push('flush')
      // The save's answer: the digest the swap confirms.
      kept.playsDigest = 'after-save'
    }
  }
  return kept
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve))
}

const game = { homeTeamId: 'home', awayTeamId: 'away', generation: 3 }

describe('the web scoring screen’s writes', function () {
  it('answers a swap from what the screen loaded before anything is sent', async function () {
    const server = heldServer()
    const writes = new WebWrites(server.client)
    const open = session(server.order, { playsDigest: 'P1', generation: 3 })
    const answer = writes.queueSwap({
      gameId: 'g1',
      effect: 'reset',
      game,
      plays: { plays: [play(0, 1), play(1, 2)], currentPlay: null },
      session: open,
      onRefused: () => undefined
    })
    expect(answer).deep.equals({
      homeTeamId: 'away',
      awayTeamId: 'home',
      generation: 4,
      reset: { atBats: 2, innings: 2 }
    })
    expect(server.sent).deep.equals([])
    // The session's flush began at once, before the screen closed it.
    expect(open.flushes).equals(1)
  })

  it('sends the flush, then the swap with the session’s last plays digest and generation', async function () {
    const server = heldServer()
    const writes = new WebWrites(server.client)
    const open = session(server.order, { playsDigest: 'P1', generation: 3 })
    writes.queueSwap({
      gameId: 'g1',
      effect: 'reset',
      game,
      plays: { plays: [play(0, 1)], currentPlay: null },
      session: open,
      onRefused: () => undefined
    })
    await settle()
    expect(server.sent).deep.equals([])
    open.flushed()
    await settle()
    expect(server.order).deep.equals(['flush', 'swap'])
    expect(server.sent).deep.equals([
      {
        gameId: 'g1',
        read: {
          homeTeamId: 'home',
          awayTeamId: 'away',
          generation: 3,
          playsDigest: 'after-save'
        }
      }
    ])
    let settled = false
    const done = writes.settled().then(() => {
      settled = true
    })
    await settle()
    expect(settled).equals(false)
    server.release()
    await done
    expect(settled).equals(true)
  })

  it('names no plays for a swap alone, which resets nothing', async function () {
    const server = heldServer()
    const writes = new WebWrites(server.client)
    const open = session(server.order, { playsDigest: 'P1', generation: 3 })
    const answer = writes.queueSwap({
      gameId: 'g1',
      effect: 'swap',
      game,
      plays: { plays: [], currentPlay: null },
      session: open,
      onRefused: () => undefined
    })
    expect(answer.reset).deep.equals({ atBats: 0, innings: 0 })
    expect(answer.generation).equals(3)
    open.flushed()
    await settle()
    expect(server.sent[0].read).deep.equals({
      homeTeamId: 'home',
      awayTeamId: 'away'
    })
    server.release()
    await writes.settled()
  })

  it('shows a refused swap, so the screen reads the game from the server again', async function () {
    const server = heldServer()
    const writes = new WebWrites(server.client)
    const open = session(server.order)
    const refused: string[] = []
    writes.queueSwap({
      gameId: 'g1',
      effect: 'swap',
      game,
      plays: { plays: [], currentPlay: null },
      session: open,
      onRefused: message => {
        refused.push(message)
      }
    })
    open.flushed()
    await settle()
    server.release(
      new HttpError('conflict', "This game's teams changed. Open it again.")
    )
    await writes.settled()
    expect(refused).deep.equals(["This game's teams changed. Open it again."])
  })

  it('sends a second queued swap only once the first is answered, and a failed flush does not stop it', async function () {
    const server = heldServer()
    const writes = new WebWrites(server.client)
    const first = session(server.order)
    const refused: string[] = []
    writes.queueSwap({
      gameId: 'g1',
      effect: 'swap',
      game,
      plays: { plays: [], currentPlay: null },
      session: first,
      onRefused: message => {
        refused.push(message)
      }
    })
    const second: SwappingSession = {
      flush: async () => {
        throw new Error('offline')
      }
    }
    writes.queueSwap({
      gameId: 'g1',
      effect: 'swap',
      game: { homeTeamId: 'away', awayTeamId: 'home' },
      plays: { plays: [], currentPlay: null },
      session: second,
      onRefused: message => {
        refused.push(message)
      }
    })
    first.flushed()
    await settle()
    expect(server.sent.map(each => each.read.homeTeamId)).deep.equals(['home'])
    server.release()
    await settle()
    expect(server.sent.map(each => each.read.homeTeamId)).deep.equals([
      'home',
      'away'
    ])
    server.release(new Error('Load failed'))
    await writes.settled()
    expect(refused).deep.equals(['Load failed'])
  })
})
