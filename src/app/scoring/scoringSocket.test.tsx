import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  type GameLineupsResponse,
  type GamePlansResponse,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type { GameChangeData, GameSocketEvent } from '../../common/gameSocket'
import { cleanAction, type ScoringAction } from '../../common/scoring/actions'
import {} from '../../common/scoring/gumbo'
import { overrideOf } from '../../common/scoring/rules'
import {
  type EventStore,
  type SaveChange,
  ScoringSession as GameSession,
  type StoredGame
} from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import {
  namesIn,
  withNames,
  withoutNames
} from '../../common/scoring/storedNames'
import { dictatingHealth, FakeDictationSocket } from '../../test/dictationFakes'
import {
  PLAN_SWAPPED,
  scoringPlans,
  scoringSidePlan
} from '../../test/scoringPlans'
import { scoringRoster } from '../../test/scoringSession'
import type { BaseballScreen } from '../field/BaseballScreen'
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

  /**
   * A `playEdits` notice leaving the plays at `digest`; with none, one that
   * says only to read the game again.
   */
  async plays(digest?: string): Promise<void> {
    const data: GameChangeData['playEdits'] =
      digest == null
        ? {
            generation: 0,
            fromDigest: null,
            digest: null,
            namesDigest: null,
            edits: null
          }
        : {
            generation: 0,
            fromDigest: 'before',
            digest,
            namesDigest: 'names',
            edits: [],
            currentPlay: null
          }
    await this.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'playEdits',
      at: '2026-10-12T12:00:00Z',
      data
    })
  }

  /**
   * A `playEdits` notice saying to read the game again, naming the digest a
   * post left, as a post bringing in a newcomer sends: with none, as other
   * writers send.
   */
  async reread(digest?: string): Promise<void> {
    await this.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'playEdits',
      at: '2026-10-12T12:00:00Z',
      data: {
        generation: 0,
        fromDigest: null,
        digest: digest ?? null,
        namesDigest: null,
        edits: null
      }
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
// Drive the exact field callbacks used by a canceled physical runner drag.
function field(): NonNullable<Parameters<typeof BaseballScreen>[0]['field']> {
  interface Fiber {
    type?: { name?: string }
    memoizedProps?: Parameters<typeof BaseballScreen>[0]
    child?: Fiber
    sibling?: Fiber
  }
  const find = (fiber?: Fiber): Fiber | undefined => {
    for (let node = fiber; node != null; node = node.sibling) {
      if (node.type?.name === 'BaseballScreen') return node
      const child = find(node.child)
      if (child != null) return child
    }
    return undefined
  }
  return find(
    (root as unknown as { _internalRoot: { current: Fiber } })._internalRoot
      .current
  )!.memoizedProps!.field
}
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
    /** What every read says a swap does. */
    swap?: { value: StoredGame['swap'] }
    /** What every read of the game plans answers. */
    plans?: { value: GamePlansResponse }
    dictation?: boolean
  } = {}
): Promise<{
  /** How many times the screen read the game plans. */
  planReads: () => number
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
      // The memory store answers the whole game it keeps.
      const saved = (await save(gameId, change)) as StoredGame
      return {
        ...saved,
        playsDigest: digestOf(saved),
        priorPlaysDigest: prior,
        ...kept()
      }
    }
  }
  const swap = options.swap
  if (swap != null) {
    const { load } = store
    store.load = async gameId => ({ ...(await load(gameId)), swap: swap.value })
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
      session.reload = async canAdopt => {
        reloads.push(session.saving)
        const changed = await reload(canAdopt)
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
  if (options.dictation === true) client.health = dictatingHealth
  client.game = async () => gameFixture
  client.roster = async teamId =>
    scoringRoster(teamId === gameFixture.awayTeamId ? 1 : 10)
  client.gameLineups = async () =>
    ({ digest: digest.value }) as unknown as GameLineupsResponse
  let planReads = 0
  client.gamePlans = async () => {
    planReads++
    return options.plans?.value ?? { away: null, home: null }
  }
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
    planReads: () => planReads,
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
  it('accepts a pitch immediately after its own echoed save without waiting for a read', async function () {
    const { changes, store, other, reloads } = await scoring({ digests: true })
    await click('Ball')
    await settle()
    const digest = (await store.load('g1')).playsDigest!
    await act(async () => {
      for (const listener of changes.listeners)
        listener({
          type: 'change',
          gameId: 'g1',
          kind: 'playEdits',
          at: '2026-11-05T12:00:00Z',
          data: {
            generation: 0,
            fromDigest: 'before',
            namesDigest: 'names',
            edits: [],
            currentPlay: null,
            digest
          }
        })
      document
        .querySelector<HTMLElement>('[aria-label="Called Strike"]')!
        .click()
    })
    await settle()
    // Once the new pitch saves, the older notice needs a canonical read:
    // the same digest could also have been restored by another scorer.
    expect(reloads).deep.equals([false])
    expect(document.body.textContent).not.includes(
      'Check the play and try again'
    )
    expect((await other()).actions).deep.equals([
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' }
    ])
  })

  it('keeps a local appearance editable while an older read finishes', async function () {
    const { changes, other, store } = await scoring()
    await click('Ball')
    await settle()
    const load = store.load
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let first = true
    store.load = async id => {
      const snapshot = await load(id)
      if (first) {
        first = false
        await held
      }
      return snapshot
    }
    await changes.plays()
    await click('Ball')
    release()
    await settle()
    expect(document.body.textContent).includes('2 balls 0 strikes')
    expect((await other()).actions).deep.equals([
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' }
    ])
  })

  it('accepts the first local pitch while an older peer read is pending', async function () {
    const { changes, other, store } = await scoring()
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    const load = store.load
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let first = true
    store.load = async id => {
      const snapshot = await load(id)
      if (first) {
        first = false
        await held
      }
      return snapshot
    }
    await changes.plays()
    await click('Called Strike')
    expect(document.body.textContent).includes('0 balls 1 strikes')
    release()
    await settle()
    expect(document.body.textContent).includes('0 balls 1 strikes')
    expect((await other()).actions).deep.equals([{ type: 'pitch', call: 'C' }])
  })

  it('hands off on the first tap after displaying a peer pitch even while another read is pending', async function () {
    const { changes, other, store } = await scoring()
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    await changes.plays()
    expect(document.body.textContent).includes('1 balls 0 strikes')
    const load = store.load
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let first = true
    store.load = async id => {
      const snapshot = await load(id)
      if (first) {
        first = false
        await held
      }
      return snapshot
    }
    const save = store.save
    let saves = 0
    store.save = async (id, change) => {
      saves++
      return await save(id, change)
    }
    await changes.plays()
    await click('Called Strike')
    expect(document.body.textContent).includes('1 balls 1 strikes')
    release()
    await settle()
    expect(document.body.textContent).includes('1 balls 1 strikes')
    expect(saves).equals(1)
    expect((await other()).actions).deep.equals([
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' }
    ])
  })

  it('retries a failed remote read without waiting for another pitch', async function () {
    const { changes, other, store } = await scoring()
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    const load = store.load
    let fail = true
    store.load = async id => {
      if (fail) {
        fail = false
        throw new Error('Temporary connection loss')
      }
      return await load(id)
    }
    await changes.plays()
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100))
    })
    await settle()
    expect(document.body.textContent).includes('1 balls 0 strikes')
  })

  it('follows a winning unfinished award after its own pitch is superseded', async () => {
    const { other, store, session } = await scoring()
    const peer = await other()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const save = store.save
    let saves = 0
    store.save = async () => {
      saves++
      await held
      return { ...(await store.load('g1')), superseded: true }
    }
    await click('Ball')
    peer.apply({ type: 'result', eventType: 'hit_by_pitch' })
    // Save the peer independently while the screen's earlier request is held.
    store.save = save
    await peer.flush()
    const stored = store.games.get('g1')!
    stored.scoringMutation = {
      at: Date.now() + 1000,
      id: 'peer-award',
      revision: 0,
      frontier: 0
    }
    store.save = async () => {
      saves++
      return await store.load('g1')
    }
    const before = JSON.stringify(await store.load('g1'))
    release()
    await settle()
    expect(session().rebaseFollowsPeer).equals(true)
    expect(saves).equals(1)
    expect(JSON.stringify(await store.load('g1'))).equals(before)
    expect(
      session().actions.some(
        action => action.type === 'gameFlow' && action.kind === 'closePlay'
      )
    ).equals(false)
  })

  it('keeps a peer award passive after a roster-only Undo rebases', async () => {
    const { other, store, session } = await scoring()
    await click('Ball')
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await settle()
    const last = [
      ...document.querySelectorAll<HTMLElement>('[aria-label^="Reorder "]')
    ].at(-1)!
    for (const key of ['Enter', 'ArrowUp', 'Enter'])
      await act(async () => {
        last.dispatchEvent(
          new window.KeyboardEvent('keydown', { key, bubbles: true })
        )
      })
    await click('Save Rosters')
    await settle()
    const peer = await other()
    const save = store.save
    let entered = false
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    store.save = async () => {
      entered = true
      await held
      throw new HttpError('conflict', 'Scoring changed', { stale: true })
    }
    await click('Undo Set team roster')
    for (let i = 0; i < 50; i++) {
      if (entered) break
      await settle()
    }
    expect(entered).equals(true)
    store.save = save
    peer.apply({ type: 'result', eventType: 'hit_by_pitch' })
    await peer.flush()
    const posts: SaveChange[] = []
    store.save = async (id, change) => {
      posts.push(change)
      return await save(id, change)
    }
    release()
    await settle()
    expect(session().rebases).equals(1)
    expect(session().rebaseFollowsPeer).equals(true)
    expect(
      session().actions.some(
        action => action.type === 'gameFlow' && action.kind === 'closePlay'
      )
    ).equals(false)
    expect(
      posts.every(
        post => post.scoringMutation == null && post.plays.length === 0
      )
    ).equals(true)
    const stored = await other()
    expect(stored.state.pending).not.equals(null)
  })

  it('never saves a close synthesized while displaying a remote award', async function () {
    const { changes, other, store } = await scoring()
    const peer = await other()
    peer.apply({ type: 'result', eventType: 'hit_by_pitch' })
    await peer.flush()
    const before = JSON.stringify(await store.load('g1'))
    await changes.plays()
    await settle()
    expect(JSON.stringify(await store.load('g1'))).equals(before)
  })

  it('keeps following after refused dictation on a peer’s unfinished play', async () => {
    const originalSocket = globalThis.WebSocket
    const devices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    const sockets: FakeDictationSocket[] = []
    globalThis.WebSocket = class extends FakeDictationSocket {
      constructor(url: string) {
        super(url)
        sockets.push(this)
      }
    } as unknown as typeof WebSocket
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => await new Promise(() => {}) }
    })
    try {
      const { changes, other, session } = await scoring({ dictation: true })
      const peer = await other()
      peer.apply({ type: 'ballInPlay', contact: 'swing' })
      peer.apply({ type: 'result', eventType: 'single' })
      await peer.flush()
      await changes.plays()
      const press = async (type: string): Promise<void> => {
        await act(async () => {
          document
            .querySelector('[aria-label="Dictation"]')!
            .dispatchEvent(new window.MouseEvent(type, { bubbles: true }))
        })
      }
      await press('pointerdown')
      await press('pointerup')
      await settle()
      await act(async () => {
        sockets.at(-1)!.open()
      })
      await press('pointerdown')
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 350))
      })
      const start = sockets.at(-1)!.frames.at(-1)!
      expect(start.kind).equals('start')
      await press('pointerup')
      const before = session().actions
      await act(async () => {
        sockets.at(-1)!.reply({
          kind: 'actions',
          id: start.id,
          transcript: 'Runner steals home',
          actions: [
            {
              type: 'baseRunning',
              kind: 'steal',
              runner: 9,
              to: 'home'
            }
          ],
          roster: [],
          dropped: []
        })
      })
      await settle()
      expect(session().actions).deep.equals(before)
      expect(document.body.textContent).includes('That runner is not on base')
      peer.apply({ type: 'gameFlow', kind: 'closePlay' })
      peer.apply({ type: 'pitch', call: 'B' })
      await peer.flush()
      await changes.plays()
      expect(document.body.textContent).includes('1 balls 0 strikes 0 outs')
      expect(session().actions).deep.equals(peer.actions)
    } finally {
      globalThis.WebSocket = originalSocket
      if (devices == null)
        delete (navigator as { mediaDevices?: unknown }).mediaDevices
      else Object.defineProperty(navigator, 'mediaDevices', devices)
    }
  })
  it('keeps following after adopting a peer’s unfinished single', async function () {
    const { changes, other, session } = await scoring()
    const peer = await other()
    peer.apply({ type: 'ballInPlay', contact: 'swing' })
    peer.apply({ type: 'result', eventType: 'single' })
    await peer.flush()
    await changes.plays()
    expect(shown('Finish at-bat')).equals(true)
    peer.apply({ type: 'gameFlow', kind: 'closePlay' })
    await peer.flush()
    await changes.plays()
    expect(document.body.textContent).includes('0 balls 0 strikes 0 outs')
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    await changes.plays()
    expect(document.body.textContent).includes('1 balls 0 strikes 0 outs')
    expect(session().actions).deep.equals(peer.actions)
  })

  for (const notice of ['plans', 'resync'] as const)
    it(`keeps following an unfinished single after a ${notice} plan refresh`, async () => {
      const plans = { value: scoringPlans({}) }
      const { changes, other, session, store, planReads } = await scoring({
        plans
      })
      const peer = await other()
      peer.apply({ type: 'ballInPlay', contact: 'swing' })
      peer.apply({ type: 'result', eventType: 'single' })
      await peer.flush()
      await changes.plays()
      expect(shown('Finish at-bat')).equals(true)
      const saved = JSON.stringify(await store.load('g1'))
      plans.value = scoringPlans({
        home: scoringSidePlan(10, { 2: PLAN_SWAPPED })
      })
      await changes.emit(
        notice === 'resync'
          ? { type: 'resync', gameId: 'g1' }
          : {
              type: 'change',
              gameId: 'g1',
              kind: 'plans',
              at: '2026-10-12T12:00:00Z',
              data: { teamId: 'home' }
            }
      )
      expect(planReads()).equals(2)
      expect(JSON.stringify(await store.load('g1'))).equals(saved)
      peer.apply({ type: 'gameFlow', kind: 'closePlay' })
      await peer.flush()
      await changes.plays()
      expect(session().actions).deep.equals(peer.actions)
      peer.apply({ type: 'pitch', call: 'B' })
      await peer.flush()
      await changes.plays()
      expect(document.body.textContent).includes('1 balls 0 strikes 0 outs')
      expect(session().actions).deep.equals(peer.actions)
    })

  it('adopts a peer Undo that restores one of its earlier saved digests', async () => {
    const { changes, other, session, store } = await scoring({ digests: true })
    await click('Ball')
    await session().flush()
    const earlier = (await store.load('g1')).playsDigest!
    await click('Called Strike')
    await session().flush()
    expect(session().holdsPlays(earlier)).equals(false)
    const peer = await other()
    expect(peer.undo().problems).deep.equals([])
    await peer.flush()
    expect((await store.load('g1')).playsDigest).equals(earlier)
    await changes.plays(earlier)
    expect(session().actions).deep.equals(peer.actions)
    expect(document.body.textContent).includes('1 balls 0 strikes')
  })

  it('reads a delayed older echo without rolling back the current score or Undo', async () => {
    const { changes, session, store } = await scoring({ digests: true })
    await click('Ball')
    await session().flush()
    const earlier = (await store.load('g1')).playsDigest!
    await click('Called Strike')
    await session().flush()
    await changes.plays(earlier)
    expect(document.body.textContent).includes('1 balls 1 strikes')
    await click('Undo Called Strike')
    await session().flush()
    expect(document.body.textContent).includes('1 balls 0 strikes')
  })

  it('adopts a peer Undo while its own third-out presentation is still running', async () => {
    const { changes, other, session } = await scoring()
    const setup = await other()
    const initial = overrideOf(setup.state)
    expect(
      setup.apply({
        type: 'gameFlow',
        kind: 'override',
        ...initial,
        batter: initial.batter ?? undefined,
        pitcher: initial.pitcher ?? undefined,
        outs: 2
      }).problems
    ).deep.equals([])
    setup.apply({ type: 'pitch', call: 'C' })
    setup.apply({ type: 'pitch', call: 'C' })
    await setup.flush()
    await changes.plays()
    await click('Called Strike')
    await session().flush()
    const animated = field()
    const motion = (
      animated as unknown as {
        players: Array<{ motion?: { id: string; generation: number } }>
      }
    ).players.find(player => player.motion != null)?.motion
    expect(motion).not.equals(undefined)
    const peer = await other()
    expect(peer.undo().problems).deep.equals([])
    while (peer.state.liveData.linescore.outs === 3)
      expect(peer.undo().problems).deep.equals([])
    await peer.flush()
    await changes.plays()
    expect(session().actions).deep.equals(peer.actions)
    expect(document.body.textContent).includes('0 balls 2 strikes 2 outs')
    await act(async () => {
      animated.onMovementComplete?.(motion!.id, motion!.generation)
    })
    await session().flush()
    expect(session().actions).deep.equals(peer.actions)
  })

  it('keeps following peer completion after a canceled runner drag', async () => {
    const { changes, other, session } = await scoring()
    const peer = await other()
    peer.apply({ type: 'ballInPlay', contact: 'swing' })
    peer.apply({ type: 'result', eventType: 'single' })
    await peer.flush()
    await changes.plays()
    expect(shown('Finish at-bat')).equals(true)
    await act(async () => {
      field().onGestureActive?.(true)
    })
    peer.apply({ type: 'gameFlow', kind: 'closePlay' })
    await peer.flush()
    await changes.plays()
    expect(shown('Finish at-bat')).equals(true)
    await act(async () => {
      field().onGestureActive?.(false)
    })
    await settle()
    expect(shown('Finish at-bat')).equals(false)
    expect(session().actions).deep.equals(peer.actions)
  })

  it('resumes peer following after Undo cancels an uncommitted runner out', async () => {
    const { changes, other, session } = await scoring()
    const peer = await other()
    peer.apply({ type: 'ballInPlay', contact: 'swing' })
    peer.apply({ type: 'result', eventType: 'single' })
    await peer.flush()
    await changes.plays()
    const before = [...session().actions]
    await act(async () => {
      const view = field()
      const runner = view.players.find(
        player =>
          player.playerId === peer.state.liveData.linescore.offense.first?.id
      )!
      view.onRunnerDrop!(runner.id, 2, 'out', view.interaction!.generation)
    })
    expect(document.body.textContent).includes('Tap or drag a player')
    peer.apply({ type: 'gameFlow', kind: 'closePlay' })
    await peer.flush()
    await changes.plays()
    expect(session().actions).deep.equals(before)
    await click(
      document
        .querySelector('[aria-label^="Undo "]')!
        .getAttribute('aria-label')!
    )
    await settle()
    expect(session().actions).deep.equals(peer.actions)
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    await changes.plays()
    expect(document.body.textContent).includes('1 balls 0 strikes 0 outs')
  })

  it('keeps following after a same-base Safe drop and its batched gesture release', async () => {
    const { changes, other, session } = await scoring()
    const peer = await other()
    peer.apply({ type: 'ballInPlay', contact: 'swing' })
    peer.apply({ type: 'result', eventType: 'single' })
    await peer.flush()
    await changes.plays()
    await act(async () => {
      field().onGestureActive?.(true)
    })
    await act(async () => {
      const view = field()
      const runner = view.players.find(
        player =>
          player.playerId === peer.state.liveData.linescore.offense.first?.id
      )!
      view.onRunnerDrop!(runner.id, 1, 'safe', view.interaction!.generation)
      view.onGestureActive?.(false)
    })
    peer.apply({ type: 'gameFlow', kind: 'closePlay' })
    await peer.flush()
    await changes.plays()
    expect(session().actions).deep.equals(peer.actions)
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    await changes.plays()
    expect(document.body.textContent).includes('1 balls 0 strikes 0 outs')
  })

  it('keeps a committed runner advance locally owned through gesture release', async () => {
    const { changes, other, session } = await scoring()
    const peer = await other()
    peer.apply({ type: 'ballInPlay', contact: 'swing' })
    peer.apply({ type: 'result', eventType: 'single' })
    await peer.flush()
    await changes.plays()
    await act(async () => {
      const view = field()
      const runner = view.players.find(
        player =>
          player.playerId === peer.state.liveData.linescore.offense.first?.id
      )!
      view.onRunnerDrop!(runner.id, 2, 'safe', view.interaction!.generation)
      view.onGestureActive?.(false)
    })
    await session().flush()
    const authored = [...session().actions]
    expect(authored.at(-1)).deep.includes({ type: 'runnerMovement', to: '2B' })
    peer.apply({ type: 'gameFlow', kind: 'closePlay' })
    await peer.flush()
    await changes.plays()
    expect(session().actions).deep.equals(authored)
  })

  it('authors the explicit Finish tap after following an unfinished play', async function () {
    const { changes, other, session, store } = await scoring()
    const peer = await other()
    peer.apply({ type: 'result', eventType: 'hit_by_pitch' })
    await peer.flush()
    await changes.plays()
    const posts: SaveChange[] = []
    const save = store.save.bind(store)
    store.save = async (id, change) => {
      posts.push(change)
      return await save(id, change)
    }
    const before = Date.now()
    await click('Finish at-bat')
    await session().flush()
    expect(posts).has.length(1)
    expect(posts[0].scoringMutation?.at).within(before, Date.now())
    expect(posts[0].plays).has.length(1)
  })

  it('passes the original Undo tap identity into saved history', async () => {
    const { changes, other, session, store } = await scoring()
    const peer = await other()
    peer.apply({ type: 'pitch', call: 'B' })
    await peer.flush()
    await changes.plays()
    const tap = {
      at: Date.now() - 1000,
      id: 'undo-input',
      revision: 0,
      frontier: 0
    }
    session().captureScoringAction = () => tap
    const posts: SaveChange[] = []
    const save = store.save.bind(store)
    store.save = async (id, change) => {
      posts.push(change)
      return await save(id, change)
    }
    await click('Undo Last play')
    await session().flush()
    expect(posts).has.length(1)
    expect(posts[0].scoringMutation).includes({ at: tap.at, id: tap.id })
    expect(document.body.textContent).includes('0 balls 0 strikes')
  })

  for (const dropped of [false, true])
    it(`follows ${dropped ? 'dropped' : 'ordinary'} third strike through the next batter`, async () => {
      const { changes, other, session } = await scoring()
      const peer = await other()
      const publish = async (): Promise<void> => {
        await peer.flush()
        await changes.plays()
      }
      peer.apply({ type: 'pitch', call: 'C' })
      peer.apply({ type: 'pitch', call: 'C' })
      await publish()
      if (dropped) {
        peer.apply({ type: 'result', eventType: 'strikeout' })
        await publish()
        const batter = peer.state.liveData.plays.currentPlay!.matchup.batter.id
        peer.apply({ type: 'runnerMovement', runner: batter, to: '1B' })
      } else peer.apply({ type: 'pitch', call: 'C' })
      await publish()
      peer.apply({ type: 'gameFlow', kind: 'closePlay' })
      await publish()
      peer.apply({ type: 'pitch', call: 'B' })
      await publish()
      expect(document.body.textContent).includes('1 balls 0 strikes')
      expect(session().actions).deep.equals(peer.actions)
    })

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
    // A pitch is in: the last two batters change places.
    const last = [
      ...document.querySelectorAll<HTMLElement>('[aria-label^="Reorder "]')
    ].at(-1)!
    for (const key of ['Enter', 'ArrowUp', 'Enter'])
      await act(async () => {
        last.dispatchEvent(
          new window.KeyboardEvent('keydown', { key, bubbles: true })
        )
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

  it('defers a remote read that finishes after More opens, then follows when it closes', async function () {
    const { changes, other, store } = await scoring()
    const peer = await other()
    peer.apply({ type: 'ballInPlay', contact: 'swing' })
    peer.apply({ type: 'result', eventType: 'single' })
    await peer.flush()
    const load = store.load
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let first = true
    store.load = async id => {
      const snapshot = await load(id)
      if (first) {
        first = false
        await held
      }
      return snapshot
    }
    await changes.plays()
    await click('More')
    expect(shown('More scoring actions')).equals(true)
    release()
    await settle()
    expect(shown('More scoring actions')).equals(true)
    expect(shown('Finish at-bat')).equals(false)
    await click('Dismiss More')
    await settle()
    expect(shown('Finish at-bat')).equals(true)
    expect((await other()).actions).deep.equals(peer.actions)
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
    // As the store will answer the at-bat: kept unnamed, read back named.
    const current = session().picture().current
    const late = JSON.stringify([
      (await store.load('g1')).plays,
      current == null
        ? current
        : withNames(withoutNames(current), namesIn(current))
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

  it('passes over its own post’s re-read echo, which names the digest it wrote, as when the post brought in a newcomer', async function () {
    const { changes, store, reloads } = await scoring({
      lineups: { value: 'd0' }
    })
    await click('Ball')
    await settle()
    const echo = (await store.load('g1')).playsDigest!
    await changes.reread(echo)
    expect(reloads).deep.equals([])
    // One naming no digest is read, as another writer's.
    await changes.reread()
    expect(reloads).deep.equals([false])
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

  it('reads the game plans again on a plans change and a resync, not on a song', async function () {
    const plans = { value: scoringPlans({}) }
    const { changes, planReads } = await scoring({ plans })
    expect(planReads()).equals(1)
    // A coach turns his plan on: the next inning's end follows it.
    plans.value = scoringPlans({
      home: scoringSidePlan(10, { 2: PLAN_SWAPPED })
    })
    await changes.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'plans',
      at: '2026-10-12T12:00:00Z',
      data: { teamId: 'home' }
    })
    expect(planReads()).equals(2)
    await changes.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'walkUpSong',
      at: '2026-10-12T12:00:00Z',
      data: { teamId: 'home', userId: 'u1', song: null }
    })
    expect(planReads()).equals(2)
    await changes.emit({ type: 'resync', gameId: 'g1' })
    expect(planReads()).equals(3)
    for (let half = 0; half < 2; half++) {
      await click('Open scoring menu')
      await click('End Half Inning')
      await click('Confirm End Half Inning')
      await settle()
    }
    expect(document.body.textContent).includes('Inning 2 plan applied')
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

describe('the scoring menu’s swap on the game socket', function () {
  const MENU = 'Open scoring menu'
  const SWAP = 'Swap Home and Away'
  const row = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[aria-label="${SWAP}"]`)
  const game = async (
    changes: FakeChanges,
    data: Partial<GameChangeData['game']>
  ): Promise<void> => {
    await changes.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'game',
      at: '2026-10-12T12:00:00Z',
      data: {
        status: 'scheduled',
        awayScore: null,
        homeScore: null,
        ...data
      }
    })
  }

  it('offers no swap once a team withdraws, though the menu is open and nothing else moved', async function () {
    const swap = { value: 'swap' as StoredGame['swap'] }
    const { changes, reloads } = await scoring({ swap })
    await click(MENU)
    expect(row()?.getAttribute('aria-disabled')).not.equals('true')
    swap.value = 'withdrawn'
    await game(changes, { status: 'cancelled', withdrawn: true })
    expect(reloads).length(1)
    expect(row()?.getAttribute('aria-disabled')).equals('true')
    expect(row()?.textContent).includes('game was withdrawn')
    // The same status again reads nothing more.
    await game(changes, { status: 'cancelled', withdrawn: true })
    expect(reloads).length(1)
  })

  it('offers the swap again once a game called scored elsewhere for its status is unmarked', async function () {
    const swap = { value: 'scoredElsewhere' as StoredGame['swap'] }
    const { changes, reloads } = await scoring({ swap })
    await click(MENU)
    expect(row()?.getAttribute('aria-disabled')).equals('true')
    swap.value = 'swap'
    await game(changes, { status: 'scheduled', withdrawn: false })
    expect(reloads).length(1)
    expect(row()?.getAttribute('aria-disabled')).not.equals('true')
    // Read once for that status, not on every notice after.
    await game(changes, { status: 'scheduled', withdrawn: false })
    expect(reloads).length(1)
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

  it('refreshes a clean roster when its first remote reload is deferred', async () => {
    const { changes, other, digest, session } = await scoring()
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await settle()
    const before = order()
    const theirs = await swapLeadoff(await other())
    expect(theirs).not.deep.equals(before)
    const reload = session().reload.bind(session())
    let first = true
    session().reload = async guard => {
      if (first) {
        first = false
        return false
      }
      return await reload(guard)
    }
    digest.value = 'd2'
    await changes.lineups('d2')
    await settle()
    expect(
      session().state.liveData.boxscore.teams.away.battingOrder.map(
        id => session().state.gameData.players[id].fullName
      )
    ).deep.equals(theirs)
    expect(order()).deep.equals(theirs)
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
        session.reload = async canAdopt => {
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
