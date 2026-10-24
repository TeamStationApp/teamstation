import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { type GameLineupsResponse, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { GameChangeData, GameSocketEvent } from '../../common/gameSocket'
import { cleanAction, type ScoringAction } from '../../common/scoring/actions'
import {} from '../../common/scoring/gumbo'
import {
  type EventStore,
  ScoringSession as GameSession,
  type StoredGame
} from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { scoringRoster } from '../../test/scoringSession'
import { lstrings } from '../locales/strings'
import { CachingClient } from '../sync/cachingClient'
import { ThemeProvider } from '../theme/ThemeContext'
import { startingSetup, teamsOf } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import type { GameChanges } from './rosterLive'
import { sameActions, ScoringScreen } from './ScoringScreen'
import { memoryStore, type ScoringSource } from './scoringSource'

/** The app's game socket, as the screen hears it: the test says what arrives. */
class FakeChanges implements GameChanges {
  readonly listeners = new Set<(event: GameSocketEvent) => void>()

  subscribe(
    gameId: string,
    listener: (event: GameSocketEvent) => void
  ): () => void {
    expect(gameId).equals('g1')
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async emit(event: GameSocketEvent): Promise<void> {
    await act(async () => {
      for (const listener of [...this.listeners]) listener(event)
    })
    await settle()
  }

  /** A `plays` notice; with no digest, as an older server sends it. */
  async plays(digest?: string): Promise<void> {
    const data: Omit<GameChangeData['plays'], 'digest'> = {
      plays: [],
      currentPlay: null,
      ...(digest == null ? {} : { digest })
    }
    await this.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'plays',
      at: '2026-10-12T12:00:00Z',
      data: data as GameChangeData['plays']
    })
  }

  async lineups(digest: string): Promise<void> {
    await this.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'lineups',
      at: '2026-10-12T12:00:00Z',
      data: {
        digest
      } as unknown as GameLineupsResponse
    })
  }
}

let root: Root | undefined
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
}
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
}
afterEach(async function () {
  await unmount()
  HTMLCanvasElement.prototype.getContext = getContext
})
async function click(label: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(element, label).not.equals(null)
  await act(async () => {
    element?.click()
  })
}
const shown = (label: string): boolean =>
  document.querySelector(`[aria-label="${label}"]`) != null
/** The batting order the roster sheet shows, by name. */
const order = (): string[] =>
  [...document.querySelectorAll('[aria-label^="Reorder "]')].map(
    node => node.getAttribute('aria-label')?.slice('Reorder '.length) ?? ''
  )

/**
 * A scoring screen on a saved game, with a second scorer on the same server
 * and the game socket in the test's hands. `reloads` records, for each
 * reload the screen asks of its session, whether a save was out.
 */
async function scoring(
  options: {
    readsChanged?: boolean
    lineups?: { value: string }
    digests?: boolean
  } = {}
): Promise<{
  changes: FakeChanges
  store: ReturnType<typeof memoryStore>
  other: () => Promise<GameSession>
  session: () => GameSession
  reloads: boolean[]
  digest: { value: string }
}> {
  const store = memoryStore()
  // A server that keeps a digest of the lineups, as the real one does, and
  // refuses a save built on lineups saved over since.
  // With digests, of the plays as well: the plays as JSON stand for theirs.
  const lineups = options.lineups
  if (lineups != null || options.digests === true) {
    const { load, save } = store
    const digestOf = (stored: StoredGame): string =>
      JSON.stringify([stored.plays, stored.currentPlay])
    const kept = (): { lineupsDigest?: string } =>
      lineups == null ? {} : { lineupsDigest: lineups.value }
    store.load = async gameId => {
      const read = await load(gameId)
      return { ...read, playsDigest: digestOf(read), ...kept() }
    }
    store.save = async (gameId, change) => {
      if (lineups != null && change.lineupsBase !== lineups.value)
        throw new HttpError('conflict', 'The lineups changed', { stale: true })
      const prior = digestOf(await load(gameId))
      const saved = await save(gameId, change)
      return {
        ...saved,
        playsDigest: digestOf(saved),
        priorPlaysDigest: prior,
        ...kept()
      }
    }
  }
  const reloads: boolean[] = []
  let opened: GameSession | undefined
  const open = async (): Promise<GameSession> =>
    await GameSession.open(store, 'g1', {
      gamePk: 'g1',
      teams: teamsOf(gameFixture),
      setup: startingSetup(gameFixture, scoringRoster(1), scoringRoster(10))
    })
  const source: ScoringSource = {
    persistent: true,
    open: async () => {
      const session = await open()
      const reload = session.reload.bind(session)
      session.reload = async () => {
        reloads.push(session.saving)
        const changed = await reload()
        // The server's copy can read back with its players in another order,
        // so a read after a save finds the game changed.
        return options.readsChanged === true || changed
      }
      opened = session
      return session
    }
  }
  const digest = { value: 'd1' }
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.roster = async teamId =>
    scoringRoster(teamId === gameFixture.awayTeamId ? 1 : 10)
  client.gameLineups = async () =>
    ({ digest: digest.value }) as unknown as GameLineupsResponse
  const changes = new FakeChanges()
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <ScoringScreen
          client={client}
          gameId="g1"
          userId="scorer"
          onExit={() => undefined}
          source={source}
          socket={changes}
        />
      </ThemeProvider>
    )
  })
  await settle()
  if (shown('OK')) await click('OK')
  return {
    changes,
    store,
    other: open,
    session: () => opened!,
    reloads,
    digest
  }
}

describe('comparing logs', function () {
  it('finds an action read back in its cleaner’s order the same', function () {
    const tapped: ScoringAction = {
      type: 'lineup',
      kind: 'runner',
      side: 'away',
      base: '2B',
      player: 3
    }
    const read = cleanAction(JSON.parse(JSON.stringify(tapped)))
    if (!('action' in read)) throw new Error(read.problem.message)
    expect(JSON.stringify(read.action)).not.equals(JSON.stringify(tapped))
    expect(sameActions([tapped], [read.action])).equals(true)
    expect(sameActions([tapped], [{ ...tapped, base: '3B' }])).equals(false)
    expect(sameActions([tapped], [])).equals(false)
  })
})

describe('the scoring screen on the game socket', function () {
  it('reads another scorer’s plays in at rest, starting again from them', async function () {
    const { changes, other, reloads } = await scoring()
    expect(document.body.textContent).includes('0 balls 0 strikes')
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    expect(document.body.textContent).includes('0 balls 0 strikes')
    await changes.plays()
    expect(document.body.textContent).includes('2 balls 0 strikes')
    expect(reloads).deep.equals([false])
    // The next pitch goes on top of theirs.
    await click('Called Strike')
    await settle()
    const again = await other()
    expect(again.actions).deep.equals([
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' }
    ])
  })

  it('keeps its Undo when its own save comes back', async function () {
    const { changes, reloads } = await scoring({ readsChanged: true })
    await click('Ball')
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await settle()
    const remove = [
      ...document.querySelectorAll<HTMLElement>('[aria-label^="Remove "]')
    ].at(-1)
    await act(async () => {
      remove!.click()
    })
    await click('Save Rosters')
    await settle()
    expect(shown('Undo Set team roster')).equals(true)
    const asked = reloads.length
    await changes.plays()
    expect(reloads).length(asked + 1)
    expect(shown('Undo Set team roster')).equals(true)
    await click('Undo Set team roster')
    await click('Undo Ball')
    expect(document.body.textContent).includes('0 balls 0 strikes')
  })

  it('waits for rest: a play being entered, or a sheet open', async function () {
    const { changes, other, reloads } = await scoring()
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    await click('Open scoring menu')
    await click('Settings')
    await changes.plays()
    expect(reloads).deep.equals([])
    await click('Done')
    await settle()
    expect(reloads).deep.equals([false])
    expect(document.body.textContent).includes('1 balls 0 strikes')
    // Nor is a play's outcome being picked.
    await click('Swing in Play')
    expect(shown('Batter Out')).equals(true)
    const asked = reloads.length
    await changes.plays()
    expect(reloads).length(asked)
    await click('Dismiss outcomes')
    await settle()
    expect(reloads.length).greaterThan(asked)
  })

  it('follows once its own save has stopped, not while it is out', async function () {
    const { changes, store, other, reloads } = await scoring()
    // This scorer's ball is held on its way; the other scorer's two strikes
    // land just after it.
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const peer = await other()
    const save = store.save
    store.save = async (gameId, change) => {
      store.save = save
      await gate
      const answer = await save(gameId, change)
      peer.apply({ type: 'pitch', call: 'C' })
      peer.apply({ type: 'pitch', call: 'C' })
      await peer.flush()
      return answer
    }
    await click('Ball')
    await settle()
    await changes.plays()
    expect(reloads).deep.equals([])
    expect(document.body.textContent).includes('1 balls 0 strikes')
    release()
    await settle()
    expect(reloads).deep.equals([false])
    expect(document.body.textContent).includes('0 balls 2 strikes')
  })

  it('puts its pitch on top of a coach’s lineup saved between its read and the pitch', async function () {
    const lineups = { value: 'd0' }
    const { other } = await scoring({ lineups })
    await click('Ball')
    await settle()
    // A coach saves his side's order; this screen has not heard of it yet.
    const coach = await other()
    const setup = setupOf(coach.state)
    const [first, second, ...rest] = setup.sides.home.battingOrder
    setup.sides.home.battingOrder = [second, first, ...rest]
    const roster: ScoringAction = { type: 'lineup', kind: 'roster', setup }
    expect(coach.apply(roster).problems).deep.equals([])
    await coach.flush()
    lineups.value = 'coach'
    await click('Called Strike')
    await settle()
    // Refused as stale, it read the game again and saved its pitch on top.
    expect(document.body.textContent).includes('1 balls 1 strikes')
    expect(document.body.textContent).not.includes('Not saved')
    const stored = await other()
    expect(stored.actions).deep.equals([
      { type: 'pitch', call: 'B' },
      roster,
      { type: 'pitch', call: 'C' }
    ])
    expect(setupOf(stored.state).sides.home.battingOrder).deep.equals(
      setup.sides.home.battingOrder
    )
    // The screen started again from that log: its next pitch follows it.
    await click('Ball')
    await settle()
    expect((await other()).actions).deep.equals([
      { type: 'pitch', call: 'B' },
      roster,
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'B' }
    ])
  })

  it('passes over its own save’s echo, and reads another device’s plays', async function () {
    const lineups = { value: 'd0' }
    const { changes, store, other, reloads, session } = await scoring({
      lineups
    })
    await click('Ball')
    await settle()
    const echo = (await store.load('g1')).playsDigest!
    await changes.plays(echo)
    await changes.lineups('d0')
    expect(reloads).deep.equals([])
    // An echo that arrives before its save has answered is passed over too.
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const save = store.save
    store.save = async (gameId, change) => {
      store.save = save
      await gate
      return await save(gameId, change)
    }
    await click('Called Strike')
    await settle()
    expect(session().saving).equals(true)
    const late = JSON.stringify([
      (await store.load('g1')).plays,
      session().picture().current
    ])
    await changes.plays(late)
    release()
    await settle()
    expect(session().holdsPlays(late)).equals(true)
    expect(reloads).deep.equals([])
    // Another scorer's pitch, and somebody else's lineups, are read in.
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    await changes.plays((await store.load('g1')).playsDigest)
    expect(reloads).deep.equals([false])
    expect(document.body.textContent).includes('2 balls 1 strikes')
    await changes.lineups('elsewhere')
    expect(reloads).deep.equals([false, false])
  })

  it('reads in after a save that found another device’s plays, even on its own echo', async function () {
    const { changes, store, other, reloads } = await scoring({ digests: true })
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    // Unheard of here, the peer's ball is under this screen's strike.
    await click('Called Strike')
    await settle()
    await changes.plays((await store.load('g1')).playsDigest)
    expect(reloads).deep.equals([false])
  })

  it('reads in again after the socket reconnects, and stops hearing on unmount', async function () {
    const { changes, other } = await scoring()
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    await changes.emit({ type: 'resync', gameId: 'g1' })
    expect(document.body.textContent).includes('1 balls 0 strikes')
    expect(changes.listeners.size).greaterThan(0)
    await unmount()
    expect(changes.listeners.size).equals(0)
  })
})

describe('the scorekeeper’s roster sheet on the game socket', function () {
  /** The other scorer swaps the away team's first two batters. */
  async function swapLeadoff(peer: GameSession): Promise<string[]> {
    const setup = setupOf(peer.state)
    const [first, second, ...rest] = setup.sides.away.battingOrder
    setup.sides.away.battingOrder = [second, first, ...rest]
    expect(
      peer.apply({ type: 'lineup', kind: 'roster', setup }).problems
    ).deep.equals([])
    await peer.flush()
    return setup.sides.away.battingOrder.map(
      id => peer.state.gameData.players[id].fullName
    )
  }

  it('opens over another scorer’s plays not yet heard of', async function () {
    const { other, reloads } = await scoring()
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await settle()
    // Reading the digest does not hold up reading the game.
    expect(reloads).deep.equals([false])
    await click('Cancel')
    await settle()
    expect(document.body.textContent).includes('1 balls 0 strikes')
  })

  it('reads a clean draft in again, with no warning', async function () {
    const { changes, other, digest } = await scoring()
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await settle()
    const before = order()
    expect(before).length(9)
    const theirs = await swapLeadoff(await other())
    expect(theirs).not.deep.equals(before)
    digest.value = 'd2'
    await changes.plays()
    await changes.lineups('d2')
    expect(order()).deep.equals(theirs)
    expect(shown('Save Rosters')).equals(true)
    expect(document.querySelector('[data-testid="Roster conflict"]')).equals(
      null
    )
    // Its echo, heard again, changes nothing.
    await changes.lineups('d2')
    expect(order()).deep.equals(theirs)
    await click('Cancel')
  })

  it('warns over a dirty draft and keeps it; Cancel takes theirs', async function () {
    const { changes, other, digest } = await scoring()
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await settle()
    const removed = order()[8]
    await click(`Remove ${removed}`)
    const mine = order()
    expect(mine).length(8)
    const theirs = await swapLeadoff(await other())
    digest.value = 'd2'
    await changes.plays()
    await changes.lineups('d2')
    expect(order()).deep.equals(mine)
    expect(
      document.querySelector('[data-testid="Roster conflict"]')?.textContent
    ).equals(lstrings.scoring_roster_conflict)
    expect(lstrings.scoring_roster_conflict).equals(
      'Another user has edited the roster. Your pending changes may overwrite theirs. Hit Cancel to revert to their changes.'
    )
    await click('Cancel')
    await settle()
    expect(shown('Save Rosters')).equals(false)
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await settle()
    expect(order()).deep.equals(theirs)
    expect(document.querySelector('[data-testid="Roster conflict"]')).equals(
      null
    )
    await click('Cancel')
  })

  it('saves over theirs from a dirty draft: the last save wins', async function () {
    const { changes, other, digest } = await scoring()
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await settle()
    const removed = order()[8]
    await click(`Remove ${removed}`)
    const mine = order()
    await swapLeadoff(await other())
    digest.value = 'd2'
    await changes.lineups('d2')
    expect(
      document.querySelector('[data-testid="Roster conflict"]')
    ).not.equals(null)
    await click('Save Rosters')
    await settle()
    const stored = await other()
    expect(
      stored.state.liveData.boxscore.teams.away.battingOrder.map(
        id => stored.state.gameData.players[id].fullName
      )
    ).deep.equals(mine)
  })
})

describe('a game swapped under the scoring screen on the socket', function () {
  const UNLOADED = 'Unable to load scoring.'
  const UNREAD = 'could not be read back'
  /**
   * A scoring screen on a game whose lineups are saved, and the server's
   * swap of its home and away teams, as a test makes it.
   */
  async function swappable(
    options: {
      /** The swap commits just after the screen first reads the game. */
      swapAfterFirstRead?: boolean
      /** Saves wait until the test releases them. */
      holdSaves?: boolean
      /** The held save is refused as stale once released. */
      staleOnRelease?: boolean
      /** The held save is refused once released: the game was reset. */
      resetOnRelease?: boolean
      /** That reset swapped home and away too, as Reset and Swap does. */
      swapOnReset?: boolean
      /** A phone, whose outbox holds this many writes per chain. */
      phone?: Record<string, number>
      /** How long the swap notice stays up once drawn. */
      swapNoticeMs?: number
      /** Each read of the game after the first takes this long. */
      slowReadsMs?: number
    } = {}
  ): Promise<{
    changes: FakeChanges
    opens: () => number
    reloads: () => number
    session: () => GameSession
    release: () => void
    /** The games whose queued writes were given up. */
    discarded: string[]
    /** The opened sessions' listeners still subscribed. */
    listening: () => number
    swap: () => void
    /** The server's reset: the plays gone, the next generation. */
    reset: () => void
    notice: (teams: {
      homeTeamId?: string
      awayTeamId?: string
      generation?: number
    }) => Promise<void>
  }> {
    const store = memoryStore()
    let game = gameFixture
    const context = (
      detail: typeof gameFixture
    ): Parameters<typeof GameSession.open>[2] => ({
      gamePk: 'g1',
      teams: teamsOf(detail),
      setup: startingSetup(
        detail,
        scoringRoster(detail.awayTeamId === 'away' ? 1 : 10),
        scoringRoster(detail.homeTeamId === 'home' ? 10 : 1)
      )
    })
    const seed = await GameSession.open(store, 'g1', context(game))
    seed.apply({
      type: 'lineup',
      kind: 'roster',
      setup: setupOf(seed.state),
      confirmed: ['away', 'home']
    })
    await seed.flush()
    const pregame = store.games.get('g1')!
    let opens = 0
    let reloads = 0
    let listening = 0
    let opened: GameSession | undefined
    // As the server source does: every read gives the context for the
    // game's teams as they stand.
    const reads: EventStore = {
      load: async gameId => ({
        ...(await store.load(gameId)),
        context: context(game)
      }),
      save: async (gameId, change) => await store.save(gameId, change)
    }
    const source: ScoringSource = {
      persistent: true,
      open: async detail => {
        opens++
        const session = await GameSession.open(reads, 'g1', context(detail))
        const subscribe = session.subscribe.bind(session)
        session.subscribe = listener => {
          listening++
          const stop = subscribe(listener)
          let stopped = false
          return () => {
            if (!stopped) listening--
            stopped = true
            stop()
          }
        }
        const reload = session.reload.bind(session)
        session.reload = async () => {
          reloads++
          return await reload()
        }
        opened = session
        return session
      }
    }
    const swap = (): void => {
      game = {
        ...gameFixture,
        homeTeamId: gameFixture.awayTeamId,
        awayTeamId: gameFixture.homeTeamId,
        homeTeamName: gameFixture.awayTeamName,
        awayTeamName: gameFixture.homeTeamName
      }
      const stored = store.games.get('g1')!
      store.games.set('g1', {
        ...stored,
        currentPlay: {
          ...stored.currentPlay!,
          teamStation: (stored.currentPlay as { teamStation?: unknown })
            .teamStation
        }
      })
    }
    const reset = (): void => {
      game = { ...game, generation: game.generation + 1 }
      store.games.set('g1', pregame)
    }
    let release = (): void => undefined
    if (options.holdSaves === true) {
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const save = store.save.bind(store)
      let refused = options.staleOnRelease !== true
      store.save = async (gameId, change) => {
        await held
        if (options.resetOnRelease === true) {
          if (options.swapOnReset === true) swap()
          reset()
          throw new HttpError(
            'conflict',
            'This game was reset since it was read',
            {
              stale: true,
              generation: game.generation
            }
          )
        }
        if (!refused) {
          refused = true
          throw new HttpError('conflict', 'The lineups changed', {
            stale: true
          })
        }
        return await save(gameId, change)
      }
    }
    let gameReads = 0
    const discarded: string[] = []
    const queued = options.phone
    const client: TeamStationClient =
      queued == null
        ? new TeamStationClient({ baseUrl: '/api/v1' })
        : Object.assign(
            new CachingClient({
              baseUrl: '/api/v1',
              openCache: async () => {
                throw new Error('No cache in this test')
              },
              outbox: { setTimer: () => 0, clearTimer: () => undefined }
            }),
            {
              drainOutbox: async () => undefined,
              outboxSummary: async () => ({
                count: Object.values(queued).reduce((sum, n) => sum + n, 0),
                chains: discarded.length > 0 ? {} : queued,
                games: {},
                teams: {}
              }),
              discardGame: async (gameId: string) => {
                discarded.push(gameId)
                return true
              }
            }
          )
    client.game = async () => {
      if (options.slowReadsMs != null && gameReads > 0)
        await new Promise(resolve => setTimeout(resolve, options.slowReadsMs))
      const read = game
      if (options.swapAfterFirstRead === true && gameReads === 0) swap()
      gameReads++
      return read
    }
    client.roster = async teamId => scoringRoster(teamId === 'away' ? 1 : 10)
    client.gameLineups = async () =>
      ({ digest: 'd1' }) as unknown as GameLineupsResponse
    const changes = new FakeChanges()
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
    const node = document.createElement('div')
    document.body.appendChild(node)
    root = createRoot(node)
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <ScoringScreen
            client={client}
            gameId="g1"
            userId="scorer"
            onExit={() => undefined}
            source={source}
            socket={changes}
            swapNoticeMs={options.swapNoticeMs}
          />
        </ThemeProvider>
      )
    })
    await settle()
    if (shown('OK')) await click('OK')
    return {
      changes,
      opens: () => opens,
      reloads: () => reloads,
      session: () => opened!,
      release,
      discarded,
      listening: () => listening,
      swap,
      reset,
      notice: async teams => {
        await changes.emit({
          type: 'change',
          gameId: 'g1',
          kind: 'game',
          at: '2026-10-23T12:00:00Z',
          data: {
            status: 'scheduled',
            awayScore: null,
            homeScore: null,
            ...teams
          }
        })
      }
    }
  }

  it('opens the game again on its new sides when a notice names swapped teams', async function () {
    const screen = await swappable()
    expect(screen.opens()).equals(1)
    expect(screen.session().state.liveData.linescore.offense.batter?.id).equals(
      1
    )
    screen.swap()
    await screen.notice({ homeTeamId: 'away', awayTeamId: 'home' })
    await settle()
    expect(screen.opens()).equals(2)
    const state = screen.session().state
    expect(state.gameData.teams.home.id).equals('away')
    expect(state.gameData.teams.away.id).equals('home')
    // The hosts, away now, bat first.
    expect(state.liveData.linescore.offense.batter?.id).equals(10)
    expect(document.body.textContent).not.includes(UNLOADED)
    expect(document.body.textContent).not.includes(UNREAD)
    expect(shown('Called Strike')).equals(true)
  })

  it('passes over a notice naming the teams it opened, as its own saves’ echoes do', async function () {
    const screen = await swappable()
    await screen.notice({ homeTeamId: 'home', awayTeamId: 'away' })
    await settle()
    expect(screen.opens()).equals(1)
    expect(screen.reloads()).equals(0)
  })

  it('passes over a notice from an older server, naming no teams', async function () {
    const screen = await swappable()
    screen.swap()
    await screen.notice({})
    await settle()
    expect(screen.opens()).equals(1)
    expect(screen.reloads()).equals(0)
  })

  it('opens the game again when the swap came while it was opening, its notice unheard', async function () {
    const screen = await swappable({ swapAfterFirstRead: true })
    await settle()
    expect(screen.opens()).equals(2)
    const state = screen.session().state
    expect(state.gameData.teams.home.id).equals('away')
    expect(state.liveData.linescore.offense.batter?.id).equals(10)
    expect(document.body.textContent).not.includes(UNREAD)
    expect(document.body.textContent).includes('Home and away were swapped.')
  })

  it('waits for a save on its way before opening the game again, and says why', async function () {
    const screen = await swappable({ holdSaves: true })
    await click('Called Strike')
    await settle()
    expect(screen.session().saving).equals(true)
    screen.swap()
    await screen.notice({ homeTeamId: 'away', awayTeamId: 'home' })
    await settle()
    expect(screen.opens()).equals(1)
    screen.release()
    await settle()
    await settle()
    expect(screen.opens()).equals(2)
    // The pitch was saved before the swap and went with it: nothing lost.
    expect(document.body.textContent).includes('Home and away were swapped.')
    expect(document.body.textContent).not.includes('were not kept')
  })

  it('tells the scorer of changes a stale save lost to the swap', async function () {
    const screen = await swappable({ holdSaves: true, staleOnRelease: true })
    await click('Called Strike')
    await settle()
    expect(screen.session().saving).equals(true)
    screen.swap()
    await screen.notice({ homeTeamId: 'away', awayTeamId: 'home' })
    screen.release()
    await settle()
    await settle()
    expect(screen.opens()).equals(2)
    expect(document.body.textContent).includes(
      'Home and away were swapped, so changes not yet saved before the swap were not kept.'
    )
    expect(screen.session().state.gameData.teams.home.id).equals('away')
  })

  it('on a phone, gives up the writes queued for the game before the swap', async function () {
    const screen = await swappable({ phone: { 'game:g1': 1 } })
    const before = screen.session()
    screen.swap()
    await screen.notice({ homeTeamId: 'away', awayTeamId: 'home' })
    await settle()
    expect(screen.discarded).deep.equals(['g1'])
    expect(screen.opens()).equals(2)
    expect(screen.session()).not.equals(before)
    expect(screen.session().readOnly).equals(false)
    expect(document.body.textContent).includes(
      'changes not yet saved before the swap were not kept'
    )
  })

  it('stops waiting for a save on its way when the screen goes', async function () {
    const screen = await swappable({ holdSaves: true })
    await click('Called Strike')
    await settle()
    screen.swap()
    await screen.notice({ homeTeamId: 'away', awayTeamId: 'home' })
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(screen.listening()).equals(0)
    screen.release()
    await settle()
    expect(screen.opens()).equals(1)
  })

  it('opens the game again when a swap made while the socket was down comes to light on resync', async function () {
    const screen = await swappable()
    screen.swap()
    await screen.changes.emit({ type: 'resync', gameId: 'g1' })
    await settle()
    expect(screen.opens()).equals(2)
    expect(screen.session().state.gameData.teams.home.id).equals('away')
    expect(document.body.textContent).includes('Home and away were swapped.')
  })

  it('opens the game again, and says it was reset, when a notice names another generation (A6)', async function () {
    const screen = await swappable()
    await click('Called Strike')
    await settle()
    expect(
      screen.session().state.liveData.plays.currentPlay?.count.strikes
    ).equals(1)
    await screen.notice({
      homeTeamId: 'home',
      awayTeamId: 'away',
      generation: 0
    })
    await settle()
    expect(screen.opens()).equals(1)
    screen.reset()
    await screen.notice({
      homeTeamId: 'home',
      awayTeamId: 'away',
      generation: 1
    })
    await settle()
    expect(screen.opens()).equals(2)
    expect(document.body.textContent).includes('This game was reset.')
    const state = screen.session().state
    expect(state.liveData.plays.currentPlay?.count.strikes ?? 0).equals(0)
    expect(state.gameData.teams.home.id).equals('home')
  })

  it('waits for a save on its way, and counts what a reset left unsaved (A6)', async function () {
    const waits = await swappable({ holdSaves: true })
    await click('Called Strike')
    await settle()
    waits.reset()
    await waits.notice({
      homeTeamId: 'home',
      awayTeamId: 'away',
      generation: 1
    })
    await settle()
    expect(waits.opens()).equals(1)
    waits.release()
    await settle()
    await settle()
    expect(waits.opens()).equals(2)
    await act(async () => {
      root?.unmount()
    })
    root = undefined

    // The save itself is refused: the plays it was made on are gone.
    const refused = await swappable({ holdSaves: true, resetOnRelease: true })
    await click('Called Strike')
    await settle()
    refused.release()
    await settle()
    await settle()
    expect(refused.opens()).equals(2)
    expect(document.body.textContent).includes(
      'This game was reset, so 1 change not yet saved before the reset was not kept.'
    )
  })

  it('says home and away were swapped too when the refused save comes before any notice (A6)', async function () {
    const screen = await swappable({
      holdSaves: true,
      resetOnRelease: true,
      swapOnReset: true
    })
    await click('Called Strike')
    await settle()
    screen.release()
    await settle()
    await settle()
    expect(screen.opens()).equals(2)
    expect(document.body.textContent).includes(
      'Home and away were swapped and the game was reset, so 1 change not yet saved before the reset was not kept.'
    )
    expect(screen.session().state.gameData.teams.home.id).equals('away')
  })

  it('on a phone, gives up the writes queued before a reset (A7)', async function () {
    const screen = await swappable({ phone: { 'game:g1': 1 } })
    screen.reset()
    await screen.notice({
      homeTeamId: 'home',
      awayTeamId: 'away',
      generation: 1
    })
    await settle()
    expect(screen.discarded).deep.equals(['g1'])
    expect(screen.opens()).equals(2)
    expect(document.body.textContent).includes(
      'This game was reset, so 1 change not yet saved before the reset was not kept.'
    )
  })

  it('keeps the notice up for its time once the slow reopen is drawn', async function () {
    const screen = await swappable({ swapNoticeMs: 100, slowReadsMs: 300 })
    screen.swap()
    await screen.notice({ homeTeamId: 'away', awayTeamId: 'home' })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    await settle()
    expect(screen.opens()).equals(2)
    expect(document.body.textContent).includes('Home and away were swapped.')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(document.body.textContent).not.includes(
      'Home and away were swapped.'
    )
  })
})
