import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { type GameLineupsResponse, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { GameChangeData, GameSocketEvent } from '../../common/gameSocket'
import { cleanAction, type ScoringAction } from '../../common/scoring/actions'
import {
  ScoringSession as GameSession,
  type StoredGame
} from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { scoringRoster } from '../../test/scoringSession'
import { lstrings } from '../locales/strings'
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
