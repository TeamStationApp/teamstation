import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGameDetail,
  asRosterEntry,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import {} from '../../common/scoring/gumbo'
import {
  applyAction,
  ScoringSession as GameSession
} from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { scoringRoster, scoringSession } from '../../test/scoringSession'
import { CachingClient } from '../sync/cachingClient'
import { ThemeProvider } from '../theme/ThemeContext'
import { startingSetup, teamsOf } from './developmentSession'
import { CORRECTION_INSTRUCTION } from './InstructionToast'
import { gameFixture } from './isUnscoredGame.test'
import { scoringPreferences } from './scoringPreferences'
import { scoringPreferences as nativePreferences } from './scoringPreferences.native'
import type { PreferenceStorage } from './scoringPreferenceStore'
import { saveStatusText, ScoringScreen } from './ScoringScreen'
import {
  DevelopmentScoringSource,
  memoryStore,
  type ScoringSource,
  ServerScoringSource
} from './scoringSource'
import { ServerClock } from './serverClock'

let root: Root | undefined
/** The action times on a stored play's record. */
function actionTimesOf(play: unknown): string[] | undefined {
  return (play as { teamStation?: { actionTimes?: string[] } } | null)
    ?.teamStation?.actionTimes
}
function memoryStorage(): PreferenceStorage {
  const held = new Map<string, string>()
  return {
    getItem: async key => held.get(key) ?? null,
    setItem: async (key, value) => {
      held.set(key, value)
    }
  }
}
// Host replacement is limited to WebGL; controls, state and preferences are real.
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
}
async function mount(
  client: TeamStationClient,
  source?: ScoringSource
): Promise<void> {
  await unmount()
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
        />
      </ThemeProvider>
    )
  })
}
async function click(label: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(element, label).not.equals(null)
  await act(async () => {
    element?.click()
  })
}
function clientForSwitchHitter(
  bats: 'switch' | 'left' | 'right' = 'switch'
): TeamStationClient {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.roster = async team =>
    team === 'away'
      ? [
          asRosterEntry({
            userId: userIdOfGumbo(1),
            gumboId: 1,
            shortName: 'Jason K.',
            jersey: '00',
            positions: ['P'],
            isPlayer: true,
            role: 'member',
            section: 'player',
            staffRoles: [],
            inheritedFrom: null,
            bats
          }),
          ...scoringRoster(1).slice(1)
        ]
      : scoringRoster(10)
  return client
}
afterEach(async function () {
  await unmount()
  HTMLCanvasElement.prototype.getContext = getContext
})
describe('local scoring controls', function () {
  it('uses the game identity, records pitches and rewinds count and pitch count', async function () {
    await mount(clientForSwitchHitter())
    expect(document.body.textContent).includes('Owls 0 · Hawks 0 · Top 1st')
    await click('OK')
    await click('Ball')
    await click('Called Strike')
    await click('Foul Ball')
    expect(document.body.textContent).includes(
      '1 balls 2 strikes 0 outs · Pitches 3'
    )
    await click('Undo Foul Ball')
    await click('Undo Called Strike')
    await click('Undo Ball')
    expect(document.body.textContent).includes(
      '0 balls 0 strikes 0 outs · Pitches 0'
    )
  })
  it('shows help three times per user/device, counts when shown, and honors disable/reset', async function () {
    const client = clientForSwitchHitter()
    for (let appearance = 1; appearance <= 3; appearance++) {
      await mount(client)
      expect(document.body.textContent).includes('Drag hitter to other box')
      expect((await scoringPreferences.read('scorer')).shown).equals(appearance)
      await click('OK')
      expect(document.querySelector('[aria-label="OK"]')).equals(null)
    }
    await mount(client)
    expect(document.querySelector('[aria-label="OK"]')).equals(null)
    await scoringPreferences.write('scorer', { help: false, shown: 0 })
    await mount(client)
    expect(document.querySelector('[aria-label="OK"]')).equals(null)
    await scoringPreferences.write('scorer', { help: true, shown: 0 })
    await mount(client)
    expect(document.querySelector('[aria-label="OK"]')).not.equals(null)
    await click('Ball')
    expect(document.querySelector('[aria-label="OK"]')).equals(null)
  })
  it('reserves the limited batting-side tutorial for switch profiles', async function () {
    for (const side of ['left', 'right'] as const) {
      await scoringPreferences.write('scorer', { help: true, shown: 0 })
      await mount(clientForSwitchHitter(side))
      expect(document.querySelector('[aria-label="OK"]')).equals(null)
      expect((await scoringPreferences.read('scorer')).shown).equals(0)
    }
  })
  it('retries failed roster reads before opening a replaceable source and retains save recovery', async function () {
    const client = clientForSwitchHitter()
    const roster = client.roster.bind(client)
    client.roster = async () => {
      throw new Error('unavailable')
    }
    let fail = true
    const store = memoryStore()
    const save = store.save
    store.save = async (gameId, change) => {
      if (fail) throw new HttpError('offline', 'The request never left')
      return await save(gameId, change)
    }
    const source: ScoringSource = {
      open: async (game, away, home) => {
        expect(away).length(9)
        expect(home).length(9)
        return GameSession.start(store, game.id, scoringSession(game))
      }
    }
    await mount(client, source)
    expect(document.body.textContent).includes('Unable to load scoring.')
    client.roster = roster
    await click('Retry loading scoring')
    expect(document.body.textContent).includes('Owls 0 · Hawks 0')
    expect(document.querySelector('[aria-label="Save status"]')).equals(null)
    await click('Ball')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(
      document.querySelector('[aria-label="Save status"]')?.textContent
    ).equals('Offline — 1 play waiting')
    fail = false
    await click('Ball')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(document.querySelector('[aria-label="Save status"]')).equals(null)
    expect(store.games.get('g1')?.currentPlay).not.equals(null)
    await mount(client, {
      open: async () => {
        throw new Error('bad state')
      }
    })
    expect(document.body.textContent).includes('Unable to load scoring.')
  })
  it('leaves a saved game untouched when one roster fails and scores with its original lineup after retry', async function () {
    const store = memoryStore()
    const first = GameSession.start(
      store,
      gameFixture.id,
      scoringSession(gameFixture)
    )
    first.apply({ type: 'pitch', call: 'B' })
    await first.flush()
    const before = structuredClone(store.games.get(gameFixture.id))
    const client = clientForSwitchHitter('right')
    const roster = client.roster.bind(client)
    let fail = true
    let reads = 0
    let writes = 0
    client.roster = async teamId => {
      if (fail && teamId === gameFixture.homeTeamId)
        throw new HttpError('offline', 'Temporary roster failure')
      return await roster(teamId)
    }
    client.gameEvents = async gameId => {
      reads++
      return await store.load(gameId)
    }
    client.saveGameEvents = async (gameId, change) => {
      writes++
      return await store.save(gameId, change)
    }
    const source = new ServerScoringSource(client)
    await mount(client, source)
    expect(document.body.textContent).includes('Unable to load scoring.')
    expect(document.querySelector('[aria-label="Ball"]')).equals(null)
    expect(reads).equals(0)
    expect(writes).equals(0)
    expect(store.games.get(gameFixture.id)).deep.equals(before)
    fail = false
    await click('Retry loading scoring')
    expect(document.body.textContent).includes('1 balls')
    await click('Ball')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    expect(document.body.textContent).includes('2 balls')
    expect(writes).equals(1)
    const reopened = await source.open(
      gameFixture,
      await roster(gameFixture.awayTeamId),
      await roster(gameFixture.homeTeamId)
    )
    for (const side of ['away', 'home'] as const) {
      const expected = first.state.liveData.boxscore.teams[side]
      const actual = reopened.state.liveData.boxscore.teams[side]
      expect(actual.players).deep.equals(expected.players)
      expect(actual.battingOrder).deep.equals(expected.battingOrder)
      expect(actual.defense).deep.equals(expected.defense)
    }
  })
  it('runs the native preference adapter through its platform storage implementation', async function () {
    await nativePreferences.write('native-test', { help: false, shown: 2 })
    expect(await nativePreferences.read('native-test')).deep.equals({
      help: false,
      shown: 2
    })
  })
})

describe('saving from the scoring screen', function () {
  it('says what the save is doing in one line', function () {
    const base = { pending: 0, offline: false, readOnly: false, problem: null }
    expect(saveStatusText(base)).equals(null)
    expect(saveStatusText({ ...base, pending: 2 })).equals('Saving…')
    expect(saveStatusText({ ...base, pending: 1, offline: true })).equals(
      'Offline — 1 play waiting'
    )
    expect(saveStatusText({ ...base, pending: 3, offline: true })).equals(
      'Offline — 3 plays waiting'
    )
    expect(
      saveStatusText({ ...base, pending: 1, problem: 'play 0: bad' })
    ).equals('Not saved: play 0: bad')
    expect(saveStatusText({ ...base, readOnly: true, problem: 'No' })).equals(
      null
    )
  })

  it('goes read-only with the server’s reason when a save is refused', async function () {
    const store = memoryStore()
    store.save = async () => {
      throw new HttpError(
        'forbidden',
        'Only someone who can score this game may change its plays'
      )
    }
    const source: ScoringSource = {
      open: async game =>
        GameSession.start(store, game.id, scoringSession(game))
    }
    await mount(clientForSwitchHitter('right'), source)
    await click('Ball')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    const overlay = document.querySelector(
      '[aria-label="Scoring is read-only"]'
    )
    expect(overlay?.textContent).includes(
      'Only someone who can score this game may change its plays'
    )
    // The refused ball is not shown as scored, and nothing more can be.
    expect(document.body.textContent).includes('0 balls')
    expect(document.body.textContent).not.includes('1 balls')
    for (const label of ['Ball', 'Called Strike', 'Swing in Play']) {
      const control = document.querySelector(`[aria-label="${label}"]`)
      expect(
        control?.getAttribute('aria-disabled') === 'true' ||
          (control as { disabled?: boolean } | null)?.disabled === true,
        label
      ).equals(true)
    }
    expect(document.querySelector('[aria-label="Undo Last play"]')).equals(null)
    // The game menu still leaves, but changes nothing.
    await click('Open scoring menu')
    for (const label of [
      'Overrides',
      'End Half Inning',
      'Set Team Rosters',
      'End Game'
    ])
      expect(
        document
          .querySelector(`[aria-label="${label}"]`)
          ?.getAttribute('aria-disabled'),
        label
      ).equals('true')
    expect(
      document
        .querySelector('[aria-label="Exit Current Game"]')
        ?.getAttribute('aria-disabled')
    ).not.equals('true')
  })

  it('offers nothing to finish once a refused Done makes the screen read-only', async function () {
    const store = memoryStore()
    store.save = async () => {
      throw new HttpError('forbidden', 'Not yours')
    }
    const source: ScoringSource = {
      open: async game => {
        let decided = scoringSession(game)
        for (const action of [
          { type: 'ballInPlay', contact: 'swing' },
          { type: 'result', eventType: 'single' }
        ] as const)
          decided = applyAction(decided, action).state
        return GameSession.start(store, game.id, decided)
      }
    }
    await mount(clientForSwitchHitter('right'), source)
    expect(document.body.textContent).includes(CORRECTION_INSTRUCTION)
    await click('Finish at-bat')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(
      document.querySelector('[aria-label="Scoring is read-only"]')
    ).not.equals(null)
    expect(document.querySelector('[aria-label="Finish at-bat"]')).equals(null)
    expect(document.body.textContent).not.includes(CORRECTION_INSTRUCTION)
  })

  it('reads the game from the server on the way into the rosters', async function () {
    const store = memoryStore()
    const client = clientForSwitchHitter('right')
    const source: ScoringSource = {
      persistent: true,
      open: async (game, away, home) =>
        await GameSession.open(store, game.id, {
          gamePk: game.id,
          teams: teamsOf(game),
          setup: startingSetup(game, away, home)
        })
    }
    await mount(client, source)
    expect(document.body.textContent).includes('0 balls')
    // Another scorer saves two balls while this screen is open.
    const [away, home] = await Promise.all([
      client.roster(gameFixture.awayTeamId),
      client.roster(gameFixture.homeTeamId)
    ])
    const other = await source.open(gameFixture, away, home)
    other.apply({ type: 'pitch', call: 'B' })
    other.apply({ type: 'pitch', call: 'B' })
    await other.flush()
    expect(document.body.textContent).includes('0 balls')
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(document.querySelector('[aria-label="Save Rosters"]')).not.equals(
      null
    )
    await click('Cancel')
    expect(document.body.textContent).includes('2 balls')
  })

  it('keeps the Undo history through opening and cancelling the rosters', async function () {
    const store = memoryStore()
    const source: ScoringSource = {
      persistent: true,
      open: async (game, away, home) => {
        const session = await GameSession.open(store, game.id, {
          gamePk: game.id,
          teams: teamsOf(game),
          setup: startingSetup(game, away, home)
        })
        // The server's copy of a new game reads back with its players in
        // another order, so the first read after a save finds the game
        // changed although its plays are the same.
        const reload = session.reload.bind(session)
        session.reload = async () => {
          await reload()
          return true
        }
        return session
      }
    }
    await mount(clientForSwitchHitter('right'), source)
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
      })
    }
    await click('Ball')
    await click('Called Strike')
    await settle()
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await settle()
    await click('Cancel')
    await settle()
    await click('Undo Called Strike')
    expect(document.body.textContent).includes('1 balls 0 strikes')
    await click('Undo Ball')
    expect(document.body.textContent).includes('0 balls 0 strikes')
  })

  it('undoes a play scored before the screen opened', async function () {
    const source = new DevelopmentScoringSource()
    const client = clientForSwitchHitter('right')
    const first = await source.open(
      gameFixture,
      scoringRoster(1),
      scoringRoster(10)
    )
    first.apply({ type: 'pitch', call: 'B' })
    first.apply({ type: 'pitch', call: 'B' })
    await first.flush()
    await mount(client, source)
    expect(document.body.textContent).includes('2 balls')
    await click('Undo Last play')
    expect(document.body.textContent).includes('1 balls')
    await click('Undo Last play')
    expect(document.body.textContent).includes('0 balls')
    expect(document.querySelector('[aria-label="Undo Last play"]')).equals(null)
  })

  it('takes every Undo tap one step back, in order, though the taps come before the screen redraws', async function () {
    const source = new DevelopmentScoringSource()
    const first = await source.open(
      gameFixture,
      scoringRoster(1),
      scoringRoster(10)
    )
    for (let i = 0; i < 3; i++) first.apply({ type: 'pitch', call: 'B' })
    await first.flush()
    await mount(clientForSwitchHitter('right'), source)
    await click('Called Strike')
    await click('Foul Ball')
    await click('Foul Ball')
    expect(document.body.textContent).includes('3 balls 2 strikes')
    // Taps landing together, as they do while an Undo is still being
    // rebuilt: nothing is drawn between them.
    const taps = async (label: string, times: number): Promise<void> => {
      const element = document.querySelector<HTMLElement>(
        `[aria-label="${label}"]`
      )
      expect(element, label).not.equals(null)
      await act(async () => {
        for (let i = 0; i < times; i++) element?.click()
      })
    }
    await taps('Undo Foul Ball', 2)
    expect(document.body.textContent).includes('3 balls 1 strikes')
    // One step left on this screen, then two into the saved game.
    await taps('Undo Called Strike', 3)
    expect(document.body.textContent).includes('1 balls 0 strikes')
    // The last saved pitch, and a tap with nothing left, which does nothing.
    await taps('Undo Last play', 2)
    expect(document.body.textContent).includes('0 balls 0 strikes')
    expect(document.querySelector('[aria-label="Undo Last play"]')).equals(null)
  })

  it('opens a game saved with a ball in play and no result at the pitch before it', async function () {
    const source = new DevelopmentScoringSource()
    const first = await source.open(
      gameFixture,
      scoringRoster(1),
      scoringRoster(10)
    )
    first.apply({ type: 'pitch', call: 'B' })
    first.apply({ type: 'ballInPlay', contact: 'swing' })
    await first.flush()
    await mount(clientForSwitchHitter('right'), source)
    expect(document.body.textContent).includes('1 balls')
    expect(document.body.textContent).includes('Pitches 1')
    // Opening it saved nothing…
    const kinds = async (): Promise<string[]> =>
      (
        await source.open(gameFixture, scoringRoster(1), scoringRoster(10))
      ).actions.map(action => action.type)
    expect(await kinds()).deep.equals(['pitch', 'ballInPlay'])
    // …and the scorer's next pitch saves the game from the pitch before.
    await click('Ball')
    expect(document.body.textContent).includes('2 balls')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    expect(await kinds()).deep.equals(['pitch', 'pitch'])
  })

  it('undoes a saved ball in play back to the pitch before it, not to a ball without a result', async function () {
    const source = new DevelopmentScoringSource()
    const first = await source.open(
      gameFixture,
      scoringRoster(1),
      scoringRoster(10)
    )
    for (const action of [
      { type: 'pitch', call: 'B' },
      { type: 'ballInPlay', contact: 'swing' },
      {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 15,
        location: { x: 5, z: -80 },
        fielder: 17
      },
      { type: 'result', eventType: 'single' },
      { type: 'gameFlow', kind: 'closePlay' }
    ] as const)
      expect(first.apply(action).problems).deep.equals([])
    await first.flush()
    await mount(clientForSwitchHitter('right'), source)
    await click('Undo Last play')
    await click('Undo Last play')
    expect(document.body.textContent).includes('1 balls')
    await click('Ball')
    expect(document.body.textContent).includes('2 balls')
  })

  it('takes a saved hit by pitch back in one Undo tap', async function () {
    const source = new DevelopmentScoringSource()
    const client = clientForSwitchHitter('right')
    const screenPitches = (): string =>
      /Pitches \d+/.exec(document.body.textContent ?? '')?.[0] ?? ''
    // The saved game ends with a hit by pitch and the next batter's empty
    // appearance.
    const first = await source.open(
      gameFixture,
      scoringRoster(1),
      scoringRoster(10)
    )
    first.apply({ type: 'pitch', call: 'B' })
    expect(
      first.apply({ type: 'result', eventType: 'hit_by_pitch' }).problems
    ).deep.equals([])
    expect(
      first.apply({ type: 'gameFlow', kind: 'closePlay' }).problems
    ).deep.equals([])
    await first.flush()
    await mount(client, source)
    expect(screenPitches()).equals('Pitches 2')
    const up = document.body.textContent
    await click('Undo Last play')
    // One tap: the hit by pitch is taken back, and its pitch with it.
    expect(document.body.textContent).not.equals(up)
    expect(screenPitches()).equals('Pitches 1')
    expect(document.body.textContent).includes('1 balls')
  })

  it('logs the close of a saved hit by pitch the screen closes as it opens', async function () {
    const source = new DevelopmentScoringSource()
    const first = await source.open(
      gameFixture,
      scoringRoster(1),
      scoringRoster(10)
    )
    first.apply({ type: 'result', eventType: 'hit_by_pitch' })
    await first.flush()
    await mount(clientForSwitchHitter('right'), source)
    await click('Ball')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    const saved = await source.open(
      gameFixture,
      scoringRoster(1),
      scoringRoster(10)
    )
    expect(saved.actions.map(action => action.type)).deep.equals([
      'result',
      'gameFlow',
      'pitch'
    ])
    expect(saved.state.liveData.plays.allPlays.length).equals(1)
  })

  it('keeps the server clock while it is open, stamps each action on it, and stops when it closes (U43)', async function () {
    const client = clientForSwitchHitter('right')
    const store = memoryStore()
    const timers = new Set<unknown>()
    // The server's clock is 90 s ahead of this device's.
    const clock = new ServerClock(
      async () => Date.now() + 90_000,
      memoryStorage(),
      {
        setInterval: () => {
          const timer = {}
          timers.add(timer)
          return timer
        },
        clearInterval: timer => timers.delete(timer)
      }
    )
    const source: ScoringSource = {
      persistent: true,
      keepTime: () => clock.keepTime(),
      open: async (game, away, home) =>
        await GameSession.open(
          store,
          game.id,
          {
            gamePk: game.id,
            teams: teamsOf(game),
            setup: startingSetup(game, away, home)
          },
          { now: () => clock.now() }
        )
    }
    await mount(client, source)
    expect(timers.size).equals(1)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(clock.offset).within(89_000, 91_000)
    await click('Ball')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    const [time] = actionTimesOf(store.games.get('g1')?.currentPlay) ?? []
    expect(Date.parse(time) - Date.now()).within(88_000, 91_000)
    await unmount()
    expect(timers.size).equals(0)
  })

  it('plays the game to the fence the server gives it, 200 feet when it gives none', async function () {
    const fieldOf = (session: {
      state: { gameData: { venue?: { fieldInfo: object } } }
    }): object | undefined => session.state.gameData.venue?.fieldInfo
    const sized = asGameDetail({ ...gameFixture, fenceDistanceFt: 250 })
    const older = asGameDetail({ ...gameFixture, fenceDistanceFt: undefined })
    expect(older.fenceDistanceFt).equals(200)

    const development = new DevelopmentScoringSource()
    expect(fieldOf(await development.open(sized, [], []))).deep.equals({
      leftLine: 250,
      center: 250,
      rightLine: 250
    })
    expect(scoringSession(sized).gameData.venue?.fieldInfo.center).equals(250)

    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.gameEvents = async () => ({ plays: [], currentPlay: null })
    const server = new ServerScoringSource(client)
    expect(
      fieldOf(await server.open({ ...sized, id: 'g2' }, [], [])),
      'server'
    ).deep.equals({ leftLine: 250, center: 250, rightLine: 250 })
    expect(fieldOf(await server.open(older, [], []))).deep.equals({
      leftLine: 200,
      center: 200,
      rightLine: 200
    })
  })
})

describe('swapping from the scoring menu', function () {
  const MENU = 'Open scoring menu'
  const SWAP = 'Swap Home and Away'
  const UNSAVED = "Save the game's changes before swapping. Try again."
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
      })
  }
  const menuLabels = (): string[] =>
    [...document.querySelectorAll('[aria-label]')]
      .map(node => node.getAttribute('aria-label') ?? '')
      .filter(label =>
        [
          'Exit Current Game',
          'Settings',
          'Overrides',
          'End Half Inning',
          'Set Team Rosters',
          SWAP,
          'End Game'
        ].includes(label)
      )
  const disabled = (label: string): boolean =>
    document
      .querySelector(`[aria-label="${label}"]`)
      ?.getAttribute('aria-disabled') === 'true'

  /**
   * A saved game with its lineups, on a server the test swaps when asked,
   * through `client` (a phone's `CachingClient` when `phone` is given).
   */
  async function swappable(
    options: {
      persistent?: boolean
      refuse?: Error
      phone?: { chains: Record<string, number>; games: Record<string, unknown> }
      pendingAfterFlush?: boolean
      /** The session's own notice, as a rebase that dropped a change leaves. */
      dropped?: string
    } = {}
  ): Promise<{
    opens: () => number
    swaps: () => number
    drains: () => number
    session: () => GameSession
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
    let opens = 0
    let swaps = 0
    let drains = 0
    let opened: GameSession | undefined
    const source: ScoringSource = {
      persistent: options.persistent ?? true,
      open: async detail => {
        opens++
        const session = await GameSession.open(store, 'g1', context(detail))
        if (options.pendingAfterFlush === true) {
          session.flush = async () => undefined
          Object.defineProperty(session, 'pending', { get: () => 1 })
        }
        const dropped = options.dropped
        if (dropped != null && opens === 1)
          Object.defineProperty(session, 'problem', { get: () => dropped })
        opened = session
        return session
      }
    }
    const client: TeamStationClient =
      options.phone == null
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
              drainOutbox: async () => {
                drains++
              },
              outboxSummary: async () => ({
                count: Object.values(options.phone!.chains).reduce(
                  (sum, n) => sum + n,
                  0
                ),
                chains: options.phone!.chains,
                games: options.phone!.games,
                teams: {}
              })
            }
          )
    client.game = async () => game
    client.roster = async teamId => scoringRoster(teamId === 'away' ? 1 : 10)
    client.swapGameSides = async (_gameId, read) => {
      swaps++
      expect(read).deep.equals({
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId
      })
      if (options.refuse != null) throw options.refuse
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
      return { homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId }
    }
    await mount(client, source)
    await settle()
    if (document.querySelector('[aria-label="OK"]') != null) await click('OK')
    return {
      opens: () => opens,
      swaps: () => swaps,
      drains: () => drains,
      session: () => opened!
    }
  }

  it('sits right above End Game, swaps before the first pitch, and opens the game again', async function () {
    const screen = await swappable()
    await click(MENU)
    expect(menuLabels().slice(-2)).deep.equals([SWAP, 'End Game'])
    expect(disabled(SWAP)).equals(false)
    await click(SWAP)
    await settle()
    expect(document.body.textContent).includes(
      'Hawks will bat first, and Owls will be at home.'
    )
    await click('Confirm Swap')
    await settle()
    expect(screen.swaps()).equals(1)
    expect(screen.opens()).equals(2)
    const state = screen.session().state
    expect(state.gameData.teams.home.id).equals('away')
    expect(state.liveData.linescore.offense.batter?.id).equals(10)
    expect(document.body.textContent).includes('Home and away were swapped.')
  })

  it('is off after a pitch, while nothing is kept on the server, and while read-only', async function () {
    const pitched = await swappable()
    await click('Ball')
    await settle()
    await click(MENU)
    expect(disabled(SWAP)).equals(true)
    await unmount()
    await swappable({ persistent: false })
    await click(MENU)
    expect(disabled(SWAP)).equals(true)
    expect(pitched.swaps()).equals(0)
  })

  it('shows the server’s refusal and opens nothing again', async function () {
    const screen = await swappable({
      refuse: new HttpError(
        'conflict',
        'Home and away can be swapped only before the first pitch'
      )
    })
    await click(MENU)
    await click(SWAP)
    await click('Confirm Swap')
    await settle()
    expect(screen.swaps()).equals(1)
    expect(screen.opens()).equals(1)
    expect(document.querySelector('[role="alert"]')?.textContent).equals(
      'Home and away can be swapped only before the first pitch'
    )
    await click('Cancel')
    await settle()
  })

  it('refuses while a change has not reached the server, and asks nothing of it', async function () {
    const screen = await swappable({ pendingAfterFlush: true })
    await click(MENU)
    await click(SWAP)
    await click('Confirm Swap')
    await settle()
    expect(screen.swaps()).equals(0)
    expect(screen.opens()).equals(1)
    expect(document.body.textContent).includes(UNSAVED)
    await click('Cancel')
    await settle()
  })

  it('swaps past the notice of a change a rebase dropped, with nothing left to save', async function () {
    const screen = await swappable({
      dropped:
        'A change could not follow another device’s lineup change: the player left the lineup.'
    })
    expect(screen.session().pending).equals(0)
    await click(MENU)
    await click(SWAP)
    await click('Confirm Swap')
    await settle()
    expect(screen.swaps()).equals(1)
    expect(screen.opens()).equals(2)
    expect(document.body.textContent).not.includes(UNSAVED)
  })

  it('on a phone, waits on the game’s queued writes only', async function () {
    const queued = await swappable({
      phone: { chains: { 'game:g1': 1 }, games: {} }
    })
    await click(MENU)
    await click(SWAP)
    await click('Confirm Swap')
    await settle()
    expect(queued.drains()).equals(1)
    expect(queued.swaps()).equals(0)
    expect(document.body.textContent).includes(UNSAVED)
    await click('Cancel')
    await settle()
    await unmount()
    const elsewhere = await swappable({
      phone: {
        chains: { 'game:g2': 1 },
        games: { g2: { state: 'parked', message: 'stale' } }
      }
    })
    await click(MENU)
    await click(SWAP)
    await click('Confirm Swap')
    await settle()
    expect(elsewhere.drains()).equals(1)
    expect(elsewhere.swaps()).equals(1)
    expect(elsewhere.opens()).equals(2)
  })

  it('leaves room for all seven rows in a window a phone held sideways is', async function () {
    // react-native-web measures the window by its root element.
    const root = document.documentElement
    Object.defineProperty(root, 'clientHeight', {
      value: 412,
      configurable: true
    })
    window.dispatchEvent(new window.Event('resize'))
    try {
      await swappable()
      await click(MENU)
      const row = document.querySelector<HTMLElement>(`[aria-label="${SWAP}"]`)
      let menu: HTMLElement | null = row
      while (menu?.style.maxHeight === '') menu = menu.parentElement
      expect(menu, 'the menu').not.equals(null)
      expect(Number.parseFloat(menu!.style.maxHeight)).at.least(7 * 44)
    } finally {
      delete (root as { clientHeight?: number }).clientHeight
      window.dispatchEvent(new window.Event('resize'))
    }
  })
})
