import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGameDetail,
  type DefaultLineup,
  type SwapSidesRead
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { game as scoredGame, TEAMS } from '../../test/scoringGames'
import {
  type OpenedReads,
  type SwappingSession,
  unsavedRefusal,
  WebWrites
} from './webWrites'

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
    pending: 0,
    readOnly: false,
    stopped: false,
    replaced: false,
    closes: 0,
    subscribe: () => () => undefined,
    close: () => {
      kept.closes++
    },
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

/** A session with nothing unsaved. */
const idle = (more: Partial<SwappingSession> = {}): SwappingSession => ({
  pending: 0,
  readOnly: false,
  stopped: false,
  replaced: false,
  subscribe: () => () => undefined,
  close: () => undefined,
  flush: async () => undefined,
  ...more
})

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
      pending: 0,
      readOnly: false,
      stopped: false,
      replaced: false,
      subscribe: () => () => undefined,
      close: () => undefined,
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

  describe('a swap behind changes the server has not taken', function () {
    /**
     * A server in memory whose saves fail with each error in `fails` first,
     * and a real session over it whose retries run on `retry()`.
     */
    async function failingSession(fails: Error[]): Promise<{
      session: ScoringSession
      saves: () => number
      retry: () => void
    }> {
      let plays: GumboPlay[] = []
      let current: CurrentPlay | null = null
      let saves = 0
      const store: EventStore = {
        load: async (): Promise<StoredGame> => ({
          plays,
          currentPlay: current
        }),
        save: async (_gameId: string, change: SaveChange) => {
          const failure = fails.shift()
          if (failure != null) throw failure
          saves++
          plays = [...plays, ...change.plays]
          if (change.currentPlay !== undefined) current = change.currentPlay
          return { plays, currentPlay: current, playsDigest: `P${saves}` }
        }
      }
      const timers: Array<() => void> = []
      const session = await ScoringSession.open(
        store,
        'g1',
        { gamePk: 'g1', teams: TEAMS, setup: setupOf(scoredGame()) },
        {
          setTimer: run => timers.push(run),
          clearTimer: () => undefined
        }
      )
      return {
        session,
        saves: () => saves,
        retry: () => {
          for (const run of timers.splice(0)) run()
        }
      }
    }

    it('sends the swap only once a save that 503s has been sent again and taken', async function () {
      const server = heldServer()
      const writes = new WebWrites(server.client)
      const open = await failingSession([
        new HttpError('internal', 'Service Unavailable')
      ])
      expect(
        open.session.apply({ type: 'pitch', call: 'B' }).problems
      ).deep.equals([])
      expect(open.session.pending).greaterThan(0)
      const refused: string[] = []
      writes.queueSwap({
        gameId: 'g1',
        effect: 'reset',
        game,
        plays: { plays: [], currentPlay: null },
        session: open.session,
        onRefused: message => {
          refused.push(message)
        }
      })
      await settle()
      // The 503 left the ball unsaved: the swap waits behind it.
      expect(open.saves()).equals(0)
      expect(open.session.pending).greaterThan(0)
      expect(server.sent).deep.equals([])
      open.retry()
      await settle()
      expect(open.saves()).equals(1)
      expect(open.session.pending).equals(0)
      expect(server.sent).deep.equals([
        {
          gameId: 'g1',
          read: {
            homeTeamId: 'home',
            awayTeamId: 'away',
            playsDigest: 'P1'
          }
        }
      ])
      server.release()
      await writes.settled()
      expect(refused).deep.equals([])
      // Nothing more is saved behind the swap.
      expect(
        open.session.apply({ type: 'pitch', call: 'B' }).problems
      ).deep.equals([])
      open.retry()
      await settle()
      expect(open.saves()).equals(1)
    })

    it('refuses the swap, counting what was lost, when the server will never take the changes ahead of it', async function () {
      const server = heldServer()
      const writes = new WebWrites(server.client)
      const open = await failingSession([
        new HttpError('forbidden', 'Not yours to score')
      ])
      open.session.apply({ type: 'pitch', call: 'B' })
      const unsaved = open.session.pending
      expect(unsaved).greaterThan(0)
      const refused: string[] = []
      writes.queueSwap({
        gameId: 'g1',
        effect: 'swap',
        game,
        plays: { plays: [], currentPlay: null },
        session: open.session,
        onRefused: message => {
          refused.push(message)
        }
      })
      await writes.settled()
      expect(open.session.readOnly).equals(true)
      expect(server.sent).deep.equals([])
      expect(refused).deep.equals([unsavedRefusal(unsaved)])
      expect(writes.held('g1')).equals(undefined)
    })

    it('says one change or several', function () {
      expect(unsavedRefusal(1)).contains(
        '1 change made before the swap, so it was'
      )
      expect(unsavedRefusal(3)).contains(
        '3 changes made before the swap, so they were'
      )
    })
  })

  describe('the swapped copy the screen opens on while a swap is out', function () {
    const detail = asGameDetail({
      nonMemberView: false,
      id: 'g1',
      awayTeamId: 'away',
      homeTeamId: 'home',
      awayTeamName: 'Owls',
      homeTeamName: 'Hawks',
      seasonId: null,
      startAt: null,
      venue: null,
      status: 'inProgress',
      homeScore: 1,
      awayScore: 0,
      ingestStatus: 'pending',
      ingestMessage: null,
      canScore: true,
      videos: []
    })
    const awayDefault = {
      batters: [],
      defense: {}
    } as unknown as DefaultLineup['lineup']
    const opened: OpenedReads = {
      game: detail,
      roles: undefined,
      rights: { away: true, home: false },
      rosters: { away: [], home: [] },
      defaults: { away: awayDefault, home: null }
    }

    it('answers the opened game with its sides exchanged, the plays as the swap leaves them, until the server takes it', async function () {
      const server = heldServer()
      const writes = new WebWrites(server.client)
      writes.keep('g1', opened)
      const landed: string[] = []
      const stop = writes.onLanded('g1', () => landed.push('g1'))
      writes.onLanded('g2', () => landed.push('g2'))
      const open = session(server.order, { generation: 3 })
      writes.queueSwap({
        gameId: 'g1',
        effect: 'swap',
        game: { homeTeamId: 'home', awayTeamId: 'away', generation: 3 },
        plays: { plays: [play(0, 1)], currentPlay: null },
        session: { ...open, serverSwap: 'reset', flush: open.flush },
        onRefused: () => undefined
      })
      const held = writes.held('g1')!
      expect(held.game).deep.include({
        homeTeamId: 'away',
        awayTeamId: 'home',
        homeTeamName: 'Owls',
        awayTeamName: 'Hawks',
        homeScore: 0,
        awayScore: 1,
        generation: 3
      })
      expect(held.rights).equals(opened.rights)
      expect(held.defaults).deep.equals({ away: null, home: awayDefault })
      expect(held.events).deep.equals({
        plays: [play(0, 1)],
        currentPlay: null,
        lineupsDigest: 'web:1',
        generation: 3,
        swap: 'reset'
      })
      expect(writes.held('g2')).equals(undefined)
      let answered = false
      const settled = held.landed.then(() => {
        answered = true
      })
      open.flushed()
      await settle()
      expect(answered).equals(false)
      expect(landed).deep.equals([])
      server.release()
      await settled
      expect(writes.held('g1')).equals(undefined)
      expect(landed).deep.equals(['g1'])
      // Unsubscribed, it is told no more.
      stop()
      writes.keep('g1', opened)
      writes.queueSwap({
        gameId: 'g1',
        effect: 'swap',
        game: { homeTeamId: 'home', awayTeamId: 'away' },
        plays: { plays: [], currentPlay: null },
        session: idle(),
        onRefused: () => undefined
      })
      await settle()
      server.release()
      await writes.settled()
      expect(landed).deep.equals(['g1'])
    })

    it('holds a reset’s copy with no plays and its generation on, and keeps a later swap’s while an earlier one lands', async function () {
      const server = heldServer()
      const writes = new WebWrites(server.client)
      writes.keep('g1', opened)
      const first = session(server.order, { generation: 3 })
      writes.queueSwap({
        gameId: 'g1',
        effect: 'reset',
        game: { homeTeamId: 'home', awayTeamId: 'away', generation: 3 },
        plays: { plays: [play(0, 1)], currentPlay: null },
        session: first,
        onRefused: () => undefined
      })
      expect(writes.held('g1')!.events).deep.equals({
        plays: [],
        currentPlay: null,
        lineupsDigest: 'web:1',
        generation: 4,
        swap: 'swap'
      })
      writes.keep('g1', writes.held('g1')!)
      writes.queueSwap({
        gameId: 'g1',
        effect: 'swap',
        game: { homeTeamId: 'away', awayTeamId: 'home', generation: 4 },
        plays: { plays: [], currentPlay: null },
        session: idle({ generation: 4 }),
        onRefused: () => undefined
      })
      const second = writes.held('g1')!
      expect(second.game).deep.include({ homeTeamId: 'home', generation: 4 })
      expect(second.events).not.have.property('swap')
      first.flushed()
      await settle()
      server.release()
      await settle()
      expect(writes.held('g1')).equals(second)
      server.release()
      await second.landed
      expect(writes.held('g1')).equals(undefined)
    })

    it('holds nothing for a game the screen kept nothing of, and gives a refused swap’s copy up', async function () {
      const server = heldServer()
      const writes = new WebWrites(server.client)
      writes.queueSwap({
        gameId: 'g1',
        effect: 'swap',
        game,
        plays: { plays: [], currentPlay: null },
        session: idle(),
        onRefused: () => undefined
      })
      expect(writes.held('g1')).equals(undefined)
      writes.keep('g1', opened)
      const landed: string[] = []
      writes.onLanded('g1', () => landed.push('g1'))
      const refused: string[] = []
      writes.queueSwap({
        gameId: 'g1',
        effect: 'swap',
        game,
        plays: { plays: [], currentPlay: null },
        session: idle(),
        onRefused: message => refused.push(message)
      })
      const held = writes.held('g1')!
      let why: unknown
      const failed = held.landed.catch((error: unknown) => {
        why = error
      })
      await settle()
      server.release()
      await settle()
      expect(refused).deep.equals([])
      server.release('teams changed' as unknown as Error)
      await failed
      expect((why as Error).message).equals('teams changed')
      expect(refused).deep.equals(['teams changed'])
      expect(writes.held('g1')).equals(undefined)
      expect(landed).deep.equals(['g1'])
    })
  })
})
