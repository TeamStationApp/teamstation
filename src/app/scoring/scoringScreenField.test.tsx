import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asRosterEntry,
  type RosterEntry,
  TeamStationClient
} from '../../common/api'
import { tagTargets } from '../../common/eventTags'
import type { ScoringAction } from '../../common/scoring/actions'
import { baseIds, freshGame, overrideOf } from '../../common/scoring/rules'
import { applyAction, ScoringSession } from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { mintedRosterEntry } from '../../test/mintedRosterEntry'
import { F } from '../../test/scoringGames'
import { scoringRoster, scoringSession } from '../../test/scoringSession'
import type { BaseballScreen } from '../field/BaseballScreen'
import type { FieldPlacement } from '../field/fieldTypes'
import { ThemeProvider } from '../theme/ThemeContext'
import webMusic from '../walkup/walkUpMusic'
import type { WalkUpMusic } from '../walkup/walkUpMusicTypes'
import type { UseDictationOptions } from './dictationTypes'
import type { EventTagEditor } from './EventTagEditor'
import { gameFixture } from './isUnscoredGame.test'
import { scoringClock } from './scoringClock'
import { ScoringScreen } from './ScoringScreen'
import {
  DevelopmentScoringSource,
  memoryStore,
  type ScoringSource
} from './scoringSource'
import { POSITIONS } from './scoringTypes'

type Props = Parameters<typeof BaseballScreen>[0]
type FieldProps = NonNullable<Props['field']>
interface Rendered {
  id: string
  playerId?: number
  team: string
}
interface Fiber {
  type?: { name?: string } | string | null
  memoizedProps?: unknown
  child?: Fiber | null
  sibling?: Fiber | null
  memoizedState?: { memoizedState?: unknown; next?: Fiber['memoizedState'] }
}

// The screen's props to the field are read from React's own tree, so each
// field callback can be driven the way a gesture on the 3D field drives it.
let container: HTMLElement | undefined
function find(
  fiber: Fiber | null | undefined,
  name: string
): Fiber | undefined {
  for (let node = fiber; node != null; node = node.sibling) {
    if (typeof node.type === 'function' || typeof node.type === 'object')
      if (node.type?.name === name) return node
    const inside = find(node.child, name)
    if (inside != null) return inside
  }
  return undefined
}
function componentProps<T>(name: string): T {
  const key = Object.keys(container ?? {}).find(name =>
    name.startsWith('__reactContainer$')
  )
  const host = (container as unknown as Record<string, Fiber>)[key ?? '']
  // The container keeps the fiber it was created with; the tree on screen is
  // whichever of the two buffers its root committed last.
  const root = (host as { stateNode?: { current?: Fiber } }).stateNode
  const found = find(root?.current ?? host, name)
  if (found == null) throw new Error('The screen has not rendered')
  return found.memoizedProps as T
}
function props(): Props {
  return componentProps<Props>('BaseballScreen')
}
function dictate(
  transcript: string,
  actions: ScoringAction[] = [{ type: 'pitch', call: 'B' }]
): void {
  const key = Object.keys(container ?? {}).find(name =>
    name.startsWith('__reactContainer$')
  )!
  const host = (
    container as unknown as Record<
      string,
      Fiber & { stateNode?: { current?: Fiber } }
    >
  )[key]
  const panel = find(host.stateNode?.current ?? host, 'ScoringPanel')!
  for (let hook = panel.memoizedState; hook != null; hook = hook.next) {
    const ref = hook.memoizedState as
      { current?: Partial<UseDictationOptions> } | undefined
    if (ref?.current != null && typeof ref.current.onActions === 'function') {
      ref.current.onActions(transcript, actions, [])
      return
    }
  }
  throw new Error('Missing dictated scoring callback')
}
function field(): FieldProps {
  const value = props().field
  if (value == null) throw new Error('The screen rendered no field')
  return value
}
function players(): Rendered[] {
  return (field() as unknown as { players: Rendered[] }).players
}
interface Presented {
  id: string
  generation: number
  stage: string
}
interface Moving {
  motion?: { id: string; generation: number; reported?: boolean }
}
// Plays out every presentation and every runner movement, as the field would.
async function settle(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    const presented = field().presentation as Presented | null | undefined
    if (presented != null) {
      await step(() =>
        field().onPresentationContact?.(presented.id, presented.generation)
      )
      await step(() =>
        field().onPresentationDone?.(
          presented.id,
          presented.generation,
          presented.stage as never
        )
      )
      continue
    }
    const moving = (players() as Array<Rendered & Moving>).find(
      player => player.motion != null
    )
    if (moving?.motion == null) return
    const { id, generation } = moving.motion
    await step(() => field().onMovementComplete?.(id, generation))
  }
}
async function step(run: () => void): Promise<void> {
  await act(async () => {
    run()
  })
}

function placement(entityId: string): FieldPlacement {
  const event: FieldPlacement = {
    entityId,
    point: { x: 0, z: -30 },
    generation: 0,
    gestureId: 1
  }
  return event
}

let root: Root | undefined
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
type ScreenProps = React.ComponentProps<typeof ScoringScreen>
/** Renders the screen, and returns a render with some of its props changed. */
async function mount(
  source?: ScoringSource,
  rosters: Record<string, RosterEntry[]> = {
    away: scoringRoster(1),
    home: scoringRoster(10)
  },
  extra: Partial<ScreenProps> = {}
): Promise<(changed: Partial<ScreenProps>) => Promise<void>> {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.roster = async teamId => rosters[teamId] ?? []
  client.createGuestPlayer = async (_gameId, _side, player) =>
    mintedRosterEntry(player)
  client.createRosterPlayer = async (_teamId, player) =>
    mintedRosterEntry(player)
  const node = document.createElement('div')
  document.body.appendChild(node)
  container = node
  root = createRoot(node)
  const render = async (changed: Partial<ScreenProps>): Promise<void> => {
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <ScoringScreen
            client={client}
            gameId="g1"
            userId={21}
            onExit={() => undefined}
            source={source}
            {...extra}
            {...changed}
          />
        </ThemeProvider>
      )
    })
  }
  await render({})
  return render
}

describe('scoring screen field wiring', function () {
  for (const previous of [false, true])
    it(`limits passed-ball pitch entry to three controls, previous pitch ${previous}`, async () => {
      const initial = scoringSession(gameFixture)
      const live = ScoringSession.start(memoryStore(), 'g1', initial, {
        requireCurrentSetup: true
      })
      live.apply({
        type: 'gameFlow',
        kind: 'placeRunner',
        runner: 2,
        base: '1B'
      })
      if (previous) live.apply({ type: 'pitch', call: 'B' })
      await mount({ persistent: false, open: async () => live })
      await step(() =>
        field().onRunnerDrop?.(
          'offense-2',
          2,
          'safe',
          field().interaction!.generation
        )
      )
      const click = async (label: string): Promise<void> => {
        await step(() => {
          document
            .querySelector<HTMLElement>(`[aria-label="${label}"]`)!
            .click()
        })
      }
      await click('Passed Ball')
      if (previous) {
        expect(document.body.textContent).includes(
          'Was the passed ball the previous pitch?'
        )
        await click('NO')
      }
      expect(props().instruction).includes('Tap Ball')
      expect(props().enabledPitchKinds).deep.equals(['ball', 'called', 'swing'])
      expect(props().canPitch).equals(true)
      for (const label of ['Ball', 'Called Strike', 'Swing and Miss'])
        expect(
          document
            .querySelector(`[aria-label="${label}"]`)
            ?.getAttribute('aria-disabled')
        ).not.equals('true')
      for (const label of ['Foul Ball', 'Swing in Play', 'Bunt in Play']) {
        const control = document.querySelector(`[aria-label="${label}"]`)!
        expect(
          control.hasAttribute('disabled') ||
            control.getAttribute('aria-disabled') === 'true',
          label
        ).equals(true)
      }
      const count = live.state.liveData.linescore.balls
      await step(() => {
        props().onPitch('foul')
      })
      expect(live.state.liveData.linescore.balls).equals(count)
      await step(() => {
        props().onPitch('called')
      })
      await settle()
      expect(baseIds(live.state)).deep.equals([null, 2, null])
      expect(live.state.liveData.linescore.strikes).equals(1)
      expect(props().enabledPitchKinds).equals(undefined)
      await step(() => {
        props().onUndo()
      })
      expect(baseIds(live.state)).deep.equals([2, null, null])
    })
  for (const reason of ['Throwing Error', 'Fielding Error'])
    it(`requires tapping a defender on the field for ${reason}`, async () => {
      const initial = scoringSession(gameFixture)
      const live = ScoringSession.start(memoryStore(), 'g1', initial, {
        requireCurrentSetup: true
      })
      expect(
        live.apply({
          type: 'gameFlow',
          kind: 'placeRunner',
          runner: 2,
          base: '1B'
        }).problems
      ).deep.equals([])
      expect(live.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
      await mount({ persistent: false, open: async () => live })
      await step(() =>
        field().onRunnerDrop?.(
          'offense-2',
          2,
          'safe',
          field().interaction!.generation
        )
      )
      await step(() => {
        document.querySelector<HTMLElement>(`[aria-label="${reason}"]`)!.click()
      })
      expect(props().instruction).equals(
        `Tap the defender who made the ${reason.toLowerCase()}.`
      )
      expect(field().acceptDefenderTap).equals(true)
      const pitcher = players().find(
        player =>
          player.playerId === initial.liveData.linescore.defense.P!.id &&
          player.team === 'defense'
      )!
      expect(field().interaction!.selectableIds).includes(pitcher.id)
      await step(() =>
        field().onFieldPlacement?.({
          ...placement(pitcher.id),
          generation: field().interaction!.generation
        })
      )
      await settle()
      expect(baseIds(live.state)).deep.equals([null, 2, null])
      expect(live.state.liveData.linescore.teams.home.errors).equals(1)
      expect(
        live.state.liveData.plays.currentPlay!.runners.at(-1)!.credits[0].player
          .id
      ).equals(pitcher.playerId)
      await step(() => {
        props().onUndo?.()
      })
      expect(baseIds(live.state)).deep.equals([2, null, null])
      expect(live.state.liveData.linescore.teams.home.errors).equals(0)
    })
  it('does not overwrite a defensive choice when cancelled roster player creation finishes', async () => {
    const initial = scoringSession(gameFixture)
    initial.liveData.boxscore.teams.home.defense.P = null
    const live = ScoringSession.start(memoryStore(), 'g1', initial, {
      requireCurrentSetup: true
    })
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => gameFixture
    client.roster = async teamId =>
      scoringRoster(teamId === gameFixture.awayTeamId ? 1 : 10)
    let finish!: (entry: RosterEntry) => void
    let requested = false
    client.createGuestPlayer = async (_gameId, _side, player) =>
      mintedRosterEntry(player)
    client.createRosterPlayer = async () => {
      requested = true
      return await new Promise(resolve => {
        finish = resolve
      })
    }
    await mount({ persistent: false, open: async () => live }, {}, { client })
    const click = async (label: string): Promise<void> => {
      await step(() => {
        const selector =
          label === 'Create Player'
            ? '[aria-label="Create Player"], [aria-label="Add Player"]'
            : `[aria-label="${label}"]`
        Array.from(document.querySelectorAll<HTMLElement>(selector))
          .at(-1)!
          .click()
      })
    }
    await step(() => field().onPlayerTap?.('empty-P'))
    await click('Create Player')
    await step(() => {
      const input = document.querySelector('[aria-label="First Name"]')!
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, 'Mookie')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await click('Create Player')
    expect(requested).equals(true)
    await click('Cancel')
    await click('Assign P #2 Player 2')
    const assigned = live.state.liveData.boxscore.teams.home.defense.P
    expect(assigned).not.equals(null)
    await step(() => {
      finish(
        mintedRosterEntry({
          firstName: 'Mookie',
          lastName: '',
          jersey: '',
          positions: [],
          bats: 'right',
          throws: 'right'
        })
      )
    })
    expect(live.state.liveData.boxscore.teams.home.defense.P).equals(assigned)
    expect(live.state.liveData.boxscore.teams.home.players).has.length(
      initial.liveData.boxscore.teams.home.players.length
    )
  })
  for (const stage of ['settings', 'bases', 'runner'] as const)
    it(`does not open Undo history during tiebreaker ${stage} selection`, async () => {
      const source = new DevelopmentScoringSource()
      const game = await source.open(
        gameFixture,
        scoringRoster(1),
        scoringRoster(10)
      )
      game.apply({
        type: 'gameFlow',
        kind: 'placeRunner',
        runner: 9,
        base: '2B'
      })
      await game.flush()
      await mount(source)
      expect(props().onHistoryOpen).to.be.a('function')
      const press = async (label: string): Promise<void> => {
        await step(() => {
          document
            .querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)
            .item(
              document.querySelectorAll(`[aria-label="${label}"]`).length - 1
            )
            .click()
        })
      }
      await press('More')
      await press('Place a Runner (Tiebreaker)')
      if (stage !== 'settings') {
        await press('Place runner on base')
        await step(() =>
          field().onBaseProjection?.({
            width: 390,
            height: 844,
            bases: [
              { x: 195, y: 580 },
              { x: 280, y: 450 },
              { x: 195, y: 360 },
              { x: 110, y: 450 }
            ]
          })
        )
      }
      if (stage === 'runner') await press('Place runner on 1B')
      const undo = document.querySelector<HTMLElement>(
        '[aria-label="Undo Last play"]'
      )!
      expect(undo).not.equals(null)
      // Exercise BaseballScreen's actual press responder beyond its 500ms
      // threshold: a guarded parent callback alone would still open the popup.
      await act(async () => {
        undo.dispatchEvent(
          new window.MouseEvent('mousedown', { bubbles: true, button: 0 })
        )
        await new Promise(resolve => setTimeout(resolve, 650))
      })
      expect(
        document.querySelector('[aria-label="Dismiss scoring history"]')
      ).equals(null)
      expect(props().onHistoryOpen).equals(undefined)
      expect(baseIds(game.state)).deep.equals([null, 9, null])
      expect(props().canPitch).equals(false)
      expect(document.body.textContent).includes(
        stage === 'runner'
          ? 'Select Runner for 1B'
          : stage === 'settings'
            ? 'Place runner on base'
            : 'Cancel'
      )
      await step(() => {
        document.dispatchEvent(
          new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
        )
      })
      expect(
        document.querySelector('[aria-label="Dismiss scoring history"]')
      ).equals(null)
    })

  for (const change of ['runner', 'outs'] as const)
    it(`keeps the ${change} setup description after persistence and reopening`, async () => {
      const initial = scoringSession(gameFixture)
      const store = memoryStore()
      const original = ScoringSession.start(store, 'g1', initial, {
        requireCurrentSetup: true
      })
      original.apply({
        type: 'gameFlow',
        kind: 'placeRunner',
        runner: 9,
        base: '2B'
      })
      if (change === 'outs')
        original.apply({
          type: 'gameFlow',
          kind: 'override',
          ...overrideOf(original.state),
          batter: overrideOf(original.state).batter ?? undefined,
          pitcher: overrideOf(original.state).pitcher ?? undefined,
          outs: 2
        })
      await original.flush()
      const live = await ScoringSession.open(
        store,
        'g1',
        {
          gamePk: 'g1',
          teams: initial.gameData.teams,
          setup: setupOf(initial)
        },
        { requireCurrentSetup: true }
      )
      await mount({ persistent: true, open: async () => live })
      expect(props().historyDetail?.primary).equals(
        change === 'runner' ? 'Player 9. placed on 2B' : 'Set outs to 2'
      )
    })
  it('places runners through projected bases, preserves outs setup and unwinds each change with normal Undo', async () => {
    const initial = scoringSession(gameFixture)
    const live = ScoringSession.start(memoryStore(), 'g1', initial, {
      requireCurrentSetup: true
    })
    await mount({ open: async () => live })
    const press = async (label: string): Promise<void> => {
      const control = document.querySelector<HTMLElement>(
        `[aria-label="${label}"]`
      )
      expect(control, label).not.equals(null)
      await step(() => {
        control!.click()
      })
    }
    await press('More')
    await press('Place a Runner (Tiebreaker)')
    expect(document.body.textContent).includes('Place runner on base')
    expect(props().canPitch).equals(false)
    expect(
      document.querySelector('[aria-label="Set Outs 0"][aria-selected="true"]')
    ).not.equals(null)
    await press('Place runner on base')
    expect(players().some(player => player.team === 'defense')).equals(false)
    expect(field().interaction?.gestures).deep.equals([])
    expect(field().interaction?.selectableIds).deep.equals([])
    expect(field().tapIds).deep.equals([])
    await step(() => {
      props().onPitch('ball')
    })
    await step(() => {
      props().onMenu()
    })
    expect(live.actions).has.length(0)
    await step(() =>
      field().onBaseProjection?.({
        width: 390,
        height: 844,
        bases: [
          { x: 195, y: 580 },
          { x: 280, y: 450 },
          { x: 195, y: 360 },
          { x: 110, y: 450 }
        ]
      })
    )
    expect(
      document.querySelectorAll('[aria-label^="Place runner on "]')
    ).has.length(3)
    expect(document.querySelector('[aria-label="Place runner on 4B"]')).equals(
      null
    )
    await press('Place runner on 2B')
    expect(document.body.textContent).includes('Select Runner for 2B')
    expect(document.body.textContent).includes('Recently Batted Players')
    expect(
      [...document.querySelectorAll('[aria-label^="Select runner "]')].map(
        node => node.getAttribute('aria-label')
      )
    ).deep.equals(
      Array.from(
        { length: 8 },
        (_, i) => `Select runner #${9 - i} Player ${9 - i}`
      )
    )
    await press('Select runner #9 Player 9')
    expect(props().historyLabel).equals('Place Player 9 on 2B')
    expect(props().historyDetail?.primary).equals('Player 9. placed on 2B')
    expect(baseIds(live.state)).deep.equals([null, 9, null])
    expect(document.body.textContent).includes('Place runner on base')
    await press('Set Outs 1')
    await press('Set Outs 2')
    expect(props().historyLabel).equals('Set Outs')
    expect(props().historyDetail?.primary).equals('Set outs to 2')
    expect(live.state.liveData.linescore.outs).equals(2)
    expect(baseIds(live.state)).deep.equals([null, 9, null])
    expect(live.state.liveData.boxscore).deep.equals(initial.liveData.boxscore)
    await press('Place runner on base')
    expect(
      document.querySelector(
        '[aria-label="Place runner on 2B"][aria-disabled="true"]'
      )
    ).not.equals(null)
    await press('Place runner on 1B')
    expect(
      document.querySelector('[aria-label="Select runner #9 Player 9"]')
    ).equals(null)
    await press('Select runner #8 Player 8')
    await press('Cancel')
    expect(props().canPitch).equals(true)
    expect(players().some(player => player.team === 'defense')).equals(true)
    for (const [outs, bases] of [
      [2, [null, 9, null]],
      [1, [null, 9, null]],
      [0, [null, 9, null]],
      [0, [null, null, null]]
    ] as const) {
      await step(() => {
        props().onUndo()
      })
      expect(live.state.liveData.linescore.outs).equals(outs)
      expect(baseIds(live.state)).deep.equals(bases)
    }
    await step(() => {
      props().onPitch('ball')
    })
    await press('More')
    expect(
      document.querySelector(
        '[aria-label="Place a Runner (Tiebreaker)"]:disabled'
      )
    ).not.equals(null)
    await press('Dismiss More')
    await step(() => {
      props().onUndo()
    })
    await press('More')
    expect(
      document.querySelector(
        '[aria-label="Place a Runner (Tiebreaker)"]:disabled'
      )
    ).equals(null)
    await press('Dismiss More')
  })

  it('cancels runner selection back to bases, restores the field on cancellation and dismisses on account/game changes', async () => {
    await mount()
    const press = async (label: string): Promise<void> => {
      await step(() => {
        document
          .querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)
          .item(document.querySelectorAll(`[aria-label="${label}"]`).length - 1)
          .click()
      })
    }
    await press('More')
    await press('Place a Runner (Tiebreaker)')
    await press('Place runner on base')
    await step(() =>
      field().onBaseProjection?.({
        width: 390,
        height: 844,
        bases: Array.from({ length: 4 }, () => ({ x: 195, y: 420 }))
      })
    )
    await press('Place runner on 3B')
    await press('Cancel')
    expect(
      document.querySelector('[aria-label="Place runner on 3B"]')
    ).not.equals(null)
    await press('Cancel runner placement')
    expect(props().canPitch).equals(true)
    expect(players().some(player => player.team === 'defense')).equals(true)
    await press('More')
    await press('Place a Runner (Tiebreaker)')
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => gameFixture
    client.roster = async teamId =>
      scoringRoster(teamId === gameFixture.awayTeamId ? 1 : 10)
    await step(() => {
      root!.render(
        <ThemeProvider>
          <ScoringScreen
            client={client}
            gameId="g2"
            userId={22}
            onExit={() => undefined}
          />
        </ThemeProvider>
      )
    })
    expect(document.querySelector('[aria-label="Set Outs 0"]')).equals(null)
    expect(props().canPitch).equals(true)
  })
  for (const route of ['menu', 'lineup'] as const)
    for (const jersey of ['99', null])
      it(`keeps saved player details when saving ${route} with current jersey ${String(jersey)}`, async function () {
        const initial = scoringSession(gameFixture)
        const away = initial.liveData.boxscore.teams.away
        away.battingOrder.pop()
        const id = away.players[0]
        const person = initial.gameData.players[id]
        person.local = false
        person.userId = id
        person.fullName = 'Mookie B'
        person.jersey = '7'
        const savedPlayer = { ...person }
        const store = memoryStore()
        const live = ScoringSession.start(store, 'g1', initial)
        await mount(
          { open: async () => live },
          {
            away: [
              asRosterEntry({
                userId: id,
                shortName: 'Mike T',
                jersey,
                positions: [],
                isPlayer: true,
                role: 'member',
                section: 'player',
                staffRoles: [],
                inheritedFrom: null
              })
            ]
          }
        )
        const click = async (label: string): Promise<void> => {
          const node = document.querySelector<HTMLElement>(
            `[aria-label="${label}"]`
          )
          expect(node, label).not.equals(null)
          await step(() => {
            node!.click()
          })
        }
        const openEditor = async (): Promise<void> => {
          if (route === 'menu') {
            await click('Open scoring menu')
            await click('Set Team Rosters')
          } else
            await step(() => {
              props().setupToast?.onSetLineup?.()
            })
        }
        await openEditor()
        expect(document.body.textContent).includes(
          jersey == null ? '1. Mike T' : '1. #99 Mike T'
        )
        expect(live.state.gameData.players[id]).deep.equals(savedPlayer)
        // The game has recorded nothing, so Save Rosters is lit to accept
        // its lineups. The roster's current labels are shown, not saved:
        // Cancel logs no roster.
        expect(
          document
            .querySelector('[aria-label="Save Rosters"]')!
            .getAttribute('aria-disabled')
        ).equals(null)
        await click('Cancel')
        expect(
          live.actions.some(
            action => action.type === 'lineup' && action.kind === 'roster'
          )
        ).equals(false)
        await openEditor()
        await click('Remove Player 2')
        await click('Save Rosters')
        await live.flush()
        expect(live.state.gameData.players[id]).deep.equals(savedPlayer)
        const roster = live.actions.findLast(
          action => action.type === 'lineup' && action.kind === 'roster'
        )
        expect(roster?.type).equals('lineup')
        if (roster?.type === 'lineup' && roster.kind === 'roster')
          expect(roster.setup?.players[id]).deep.equals(savedPlayer)
        const reopened = await ScoringSession.open(store, 'g1', {
          gamePk: 'g1',
          teams: initial.gameData.teams,
          setup: setupOf(initial)
        })
        expect(reopened.state.gameData.players[id]).deep.equals(savedPlayer)
      })
  it('keeps a two-ball appearance gated after a resting defender move', async function () {
    const initial = scoringSession(gameFixture)
    const live = ScoringSession.start(memoryStore(), 'g1', initial, {
      requireCurrentSetup: true
    })
    live.apply({ type: 'pitch', call: 'B' })
    live.apply({ type: 'pitch', call: 'B' })
    await mount({ open: async () => live })
    await step(() =>
      field().onPlayerTap?.(
        field().players.find(player => player.label === 'P')!.id
      )
    )
    await step(() => {
      document
        .querySelector<HTMLElement>('[aria-label="Assign P #2 Player 2"]')!
        .click()
    })
    expect(props().canPitch).equals(false)
    expect(props().summary).includes('2 balls')
    await step(() => {
      props().onPitch('ball')
    })
    expect(props().summary).includes('2 balls')
    expect(live.state.liveData.boxscore.teams.home.defense.C).equals(null)
  })
  for (const problem of ['partial', 'defense'] as const)
    it(`resolves reopened pending play with ${problem} setup, then blocks the next action`, async function () {
      const initial = scoringSession(gameFixture)
      if (problem === 'partial')
        initial.liveData.boxscore.teams.away.battingOrder.pop()
      else initial.liveData.boxscore.teams.home.defense.C = null
      const store = memoryStore()
      const context = {
        gamePk: 'g1',
        teams: initial.gameData.teams,
        setup: setupOf(initial)
      }
      const legacy = ScoringSession.start(
        store,
        'g1',
        freshGame('g1', initial.gameData.teams, setupOf(initial))
      )
      for (const action of [
        { type: 'gameFlow', kind: 'placeRunner', runner: 2, base: '1B' },
        {
          type: 'ballInPlay',
          contact: 'swing',
          fielder: initial.liveData.boxscore.teams.home.defense.SS!,
          location: { x: 0, z: -30 }
        },
        { type: 'result', eventType: 'fielders_choice' }
      ] as ScoringAction[])
        expect(legacy.apply(action).problems).deep.equals([])
      await legacy.flush()
      const live = await ScoringSession.open(store, 'g1', context, {
        requireCurrentSetup: true
      })
      await mount({ persistent: true, open: async () => live })
      expect(field().interaction?.runnerIds).deep.equals([])
      expect(field().tapIds ?? []).deep.equals([])
      // A reopened choice collects its fielding sequence before runner calls.
      const fielder = players().find(
        player =>
          player.playerId ===
            initial.liveData.boxscore.teams.home.defense['1B'] &&
          player.team === 'defense'
      )!
      await step(() =>
        field().onFieldPlacement?.({
          ...placement(fielder.id),
          generation: field().interaction!.generation
        })
      )
      await step(() => props().onFinish?.())
      await settle()
      await step(() => {
        document
          .querySelector<HTMLElement>(
            `[aria-label="Out ${initial.gameData.players[2].fullName}"]`
          )!
          .click()
      })
      await settle()
      await step(() => props().onFinish?.())
      await live.flush()
      expect(live.state.pending).equals(null)
      expect(live.state.liveData.plays.allPlays).has.length(1)
      expect(props().canPitch).equals(false)
      expect(field().interaction?.runnerIds).deep.equals([])
      const reopened = await ScoringSession.open(store, 'g1', context)
      expect(reopened.state.liveData.plays.allPlays).has.length(1)
    })
  for (const problem of ['defense', 'lineup'] as const)
    it(`repairs ${problem} setup after reopening an automatically closed third out`, async function () {
      const initial = scoringSession(gameFixture)
      const away = initial.liveData.boxscore.teams.away
      const home = initial.liveData.boxscore.teams.home
      const catcher = away.defense.C!
      if (problem === 'defense') away.defense.C = null
      else home.battingOrder = []
      const store = memoryStore()
      const context = {
        gamePk: 'g1',
        teams: initial.gameData.teams,
        setup: setupOf(initial)
      }
      const original = ScoringSession.start(store, 'g1', initial, {
        requireCurrentSetup: true
      })
      for (let i = 0; i < 9; i++)
        expect(
          original.apply({ type: 'pitch', call: 'C' }).problems
        ).deep.equals([])
      await original.flush()
      const live = await ScoringSession.open(store, 'g1', context, {
        requireCurrentSetup: true
      })
      expect(live.state.pending).not.equals(null)
      expect(live.actions).has.length(9)
      await mount({ persistent: true, open: async () => live })
      expect(props().summary).includes('Bottom 1st')
      expect(props().canPitch).equals(false)
      const click = async (label: string): Promise<void> => {
        const button = document.querySelector<HTMLElement>(
          `[aria-label="${label}"]`
        )
        expect(button, label).not.equals(null)
        await step(() => {
          button!.click()
        })
      }
      if (problem === 'defense') {
        await step(() => field().onPlayerTap?.('empty-C'))
        expect(
          document.querySelector('[aria-label="Defensive roster"]')
        ).not.equals(null)
        await click('Create Player')
        await click('Create Placeholder Player')
        await click('Create')
        expect(
          document.querySelector('[aria-label="Defensive roster"]')
        ).not.equals(null)
        expect(live.state.liveData.boxscore.teams.away.players).has.length(10)
        expect(live.state.liveData.boxscore.teams.away.defense.C).equals(null)
        await click(
          `Assign C #${initial.gameData.players[catcher].jersey} Player 2`
        )
        expect(live.state.liveData.boxscore.teams.away.defense.C).equals(
          catcher
        )
      } else {
        await step(() => props().setupToast?.onSetLineup?.())
        expect(
          document.querySelector(
            '[aria-label="Home Team"][aria-selected="true"]'
          )
        ).not.equals(null)
        for (const id of home.players)
          await click(`Add ${initial.gameData.players[id].fullName} to Lineup`)
        await click('Save Rosters')
        expect(live.state.liveData.boxscore.teams.home.battingOrder).has.length(
          9
        )
      }
      await live.flush()
      const rosterIndex = live.actions.findIndex(
        action => action.type === 'lineup' && action.kind === 'roster'
      )
      expect(rosterIndex).greaterThan(9)
      expect(live.actions[9]).deep.equals({
        type: 'gameFlow',
        kind: 'closePlay'
      })
      const reopened = await ScoringSession.open(store, 'g1', context, {
        requireCurrentSetup: true
      })
      expect(reopened.state.liveData.linescore.isTopInning).equals(false)
      expect(reopened.state.liveData.plays.allPlays).has.length(3)
      expect(props().canPitch).equals(true)
      await step(() => {
        props().onPitch('ball')
      })
      await live.flush()
      expect(live.state.liveData.linescore.balls).equals(1)
    })
  it('saves only the completed prior-half dictated prefix before newly current lineup acceptance', async function () {
    const initial = scoringSession(gameFixture)
    initial.liveData.boxscore.teams.home.battingOrder.pop()
    const store = memoryStore()
    const session = ScoringSession.start(store, 'g1', initial, {
      requireCurrentSetup: true
    })
    for (let i = 0; i < 8; i++)
      expect(session.apply({ type: 'pitch', call: 'C' }).problems).deep.equals(
        []
      )
    await mount({ open: async () => session })
    await step(() => {
      dictate('Strike three, then Ball', [
        { type: 'pitch', call: 'C' },
        { type: 'pitch', call: 'B' }
      ])
    })
    await settle()
    expect(props().summary).includes('Bottom 1st')
    expect(props().summary).includes('0 balls')
    expect(props().canPitch).equals(false)
    await session.flush()
    expect(session.state.liveData.plays.allPlays).has.length(3)
    expect(
      session.actions.some(
        action => action.type === 'pitch' && action.call === 'B'
      )
    ).equals(false)
    const reopened = await ScoringSession.open(store, 'g1', {
      gamePk: 'g1',
      teams: initial.gameData.teams,
      setup: setupOf(initial)
    })
    expect(reopened.state.liveData.plays.allPlays).has.length(3)
    expect(reopened.state.liveData.linescore.balls).equals(0)
  })
  for (const problem of ['partial', 'defense'] as const)
    it(`locks resting runner entry while ${problem} setup is incomplete`, async function () {
      const initial = scoringSession(gameFixture)
      if (problem === 'partial')
        initial.liveData.boxscore.teams.away.battingOrder.pop()
      else initial.liveData.boxscore.teams.home.defense.C = null
      const game = freshGame('g1', initial.gameData.teams, setupOf(initial))
      game.liveData.linescore.offense.first = {
        id: 2,
        fullName: game.gameData.players[2].fullName
      }
      await mount({
        open: async () => ScoringSession.start(memoryStore(), 'g1', game)
      })
      expect(props().canPitch).equals(false)
      expect(field().interaction?.runnerIds).deep.equals([])
      expect(field().interaction?.selectableIds).not.includes('offense-2')
      if (problem === 'partial') {
        await step(() => props().setupToast?.onAcceptLineup?.())
        expect(field().interaction?.runnerIds).includes('offense-2')
      }
    })
  it('refuses the same-index peer replacement of the originally unresolved play without writing', async function () {
    const initial = scoringSession(gameFixture)
    const store = memoryStore()
    const context = {
      gamePk: 'g1',
      teams: initial.gameData.teams,
      setup: setupOf(initial)
    }
    const legacy = ScoringSession.start(store, 'g1', initial)
    const ball: ScoringAction = {
      type: 'ballInPlay',
      contact: 'swing',
      fielder: initial.liveData.boxscore.teams.home.defense.RF!,
      location: { x: 20, z: -60 },
      launchAngle: 15
    }
    legacy.apply(ball)
    await legacy.flush()
    const live = await ScoringSession.open(store, 'g1', context, {
      requireCurrentSetup: true
    })
    await mount({ persistent: true, open: async () => live })
    const peer = await ScoringSession.open(store, 'g1', context, {
      requireCurrentSetup: true
    })
    peer.undo()
    peer.apply({ type: 'pitch', call: 'B' })
    peer.apply({ ...ball, location: { x: -10, z: -50 } })
    await peer.flush()
    const saved = JSON.stringify(store.games.get('g1'))
    await step(() =>
      field().onPlayerTap?.(
        field().players.find(player => player.label === 'P')!.id
      )
    )
    await live.flush()
    expect(JSON.stringify(store.games.get('g1'))).equals(saved)
    expect(document.querySelector('[aria-label="Defensive roster"]')).equals(
      null
    )
    const reopened = await ScoringSession.open(store, 'g1', context)
    expect(
      reopened.actions.some(action => action.type === 'ballInPlay')
    ).equals(true)
  })
  it('offers safe setup for an old unresolved partial-defense play without writing when the picker opens', async function () {
    const initial = scoringSession(gameFixture)
    const setup = setupOf(initial)
    setup.sides.home.defense.C = null
    const before = applyAction(initial, {
      type: 'lineup',
      kind: 'roster',
      setup
    }).state
    const store = memoryStore()
    const legacy = ScoringSession.start(store, 'g1', before)
    legacy.apply({
      type: 'ballInPlay',
      contact: 'swing',
      fielder: initial.liveData.boxscore.teams.home.defense.RF!,
      launchAngle: 15,
      location: { x: 20, z: -60 }
    })
    await legacy.flush()
    const context = {
      gamePk: 'g1',
      teams: initial.gameData.teams,
      setup: setupOf(initial)
    }
    const live = await ScoringSession.open(store, 'g1', context, {
      requireCurrentSetup: true
    })
    const saved = JSON.stringify(store.games.get('g1'))
    await mount({ persistent: true, open: async () => live })
    expect(props().canPitch).equals(false)
    await step(() => field().onPlayerTap?.('empty-C'))
    expect(JSON.stringify(store.games.get('g1'))).equals(saved)
    expect(
      document.querySelector('[aria-label="Defensive roster"]')
    ).not.equals(null)
    await step(() => {
      document
        .querySelector<HTMLElement>('[aria-label="Assign C #2 Player 2"]')!
        .click()
    })
    expect(props().canPitch).equals(true)
    expect(live.state.liveData.plays.allPlays).has.length(0)
  })
  it('does not mutate a peer-started active play after a picker refresh', async function () {
    const initial = scoringSession(gameFixture)
    const store = memoryStore()
    const context = {
      gamePk: 'g1',
      teams: initial.gameData.teams,
      setup: setupOf(initial)
    }
    const first = await ScoringSession.open(store, 'g1', context)
    const peer = await ScoringSession.open(store, 'g1', context)
    await mount({ persistent: true, open: async () => first })
    await step(() =>
      field().onPlayerTap?.(
        field().players.find(player => player.label === 'P')!.id
      )
    )
    peer.apply({
      type: 'ballInPlay',
      contact: 'swing',
      fielder: initial.liveData.boxscore.teams.home.defense.RF!
    })
    await peer.flush()
    const saved = JSON.stringify(store.games.get('g1'))
    await step(() => {
      document
        .querySelector<HTMLElement>('[aria-label="Assign P #2 Player 2"]')!
        .click()
    })
    expect(JSON.stringify(store.games.get('g1'))).equals(saved)
    expect(document.querySelector('[aria-label="Defensive roster"]')).equals(
      null
    )
  })
  it('gates the actual dictated callback until a partial current lineup is accepted', async function () {
    const initial = scoringSession(gameFixture)
    initial.liveData.boxscore.teams.away.battingOrder.pop()
    await mount({
      open: async () => ScoringSession.start(memoryStore(), 'g1', initial)
    })
    await step(() => {
      dictate('Ball')
    })
    expect(props().summary).includes('0 balls')
    await step(() => props().setupToast?.onAcceptLineup?.())
    await step(() => {
      dictate('Ball')
    })
    expect(props().summary).includes('1 balls')
  })
  for (const route of ['lineup', 'defender', 'placeholder'] as const)
    it(`preserves another scorer's saved pitches through ${route} setup`, async function () {
      const initial = scoringSession(gameFixture)
      initial.liveData.boxscore.teams.away.battingOrder.pop()
      if (route === 'placeholder') {
        const home = initial.liveData.boxscore.teams.home
        home.players.pop()
        home.battingOrder.pop()
        home.defense.RF = null
      }
      const prepared = freshGame(
        initial.gamePk,
        initial.gameData.teams,
        setupOf(initial)
      )
      const context = {
        gamePk: 'g1',
        teams: prepared.gameData.teams,
        setup: setupOf(prepared)
      }
      const store = memoryStore()
      const first = await ScoringSession.open(store, 'g1', context)
      const peer = await ScoringSession.open(store, 'g1', context)
      await mount({ persistent: true, open: async () => first })
      if (route === 'defender')
        await step(() =>
          field().onPlayerTap?.(
            field().players.find(player => player.label === 'P')!.id
          )
        )
      if (route === 'placeholder')
        await step(() => field().onPlayerTap?.('empty-RF'))
      expect(peer.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
      expect(peer.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
      await peer.flush()
      if (route === 'lineup') {
        await step(() => props().setupToast?.onSetLineup?.())
        await step(() => {
          document
            .querySelector<HTMLElement>('[aria-label="Save Rosters"]')!
            .click()
        })
      } else if (route === 'defender') {
        await step(() => {
          document
            .querySelector<HTMLElement>('[aria-label="Assign P #2 Player 2"]')!
            .click()
        })
      } else {
        await step(() => {
          document
            .querySelectorAll<HTMLElement>('[aria-label="Create Player"]')
            .item(
              document.querySelectorAll('[aria-label="Create Player"]').length -
                1
            )
            .click()
        })
        await step(() => {
          document
            .querySelector<HTMLElement>(
              '[aria-label="Create Placeholder Player"]'
            )!
            .click()
        })
        await step(() => {
          document
            .querySelector<HTMLElement>('[aria-label="Player count 2"]')!
            .click()
        })
        await step(() => {
          document.querySelector<HTMLElement>('[aria-label="Create"]')!.click()
        })
      }
      await step(() => undefined)
      await first.flush()
      const saved = await ScoringSession.open(store, 'g1', context)
      expect(saved.state.liveData.linescore.balls).equals(2)
      if (route === 'defender')
        expect(saved.state.liveData.linescore.defense.P?.id).equals(
          prepared.liveData.boxscore.teams.home.defense.C
        )
      if (route === 'placeholder')
        expect(saved.state.liveData.boxscore.teams.home.players).has.length(10)
    })
  it('revalidates the defending side when a peer changes halves while the picker is open', async function () {
    const initial = scoringSession(gameFixture)
    const context = {
      gamePk: 'g1',
      teams: initial.gameData.teams,
      setup: setupOf(initial)
    }
    const store = memoryStore()
    const first = await ScoringSession.open(store, 'g1', context)
    const peer = await ScoringSession.open(store, 'g1', context)
    await mount({ persistent: true, open: async () => first })
    await step(() =>
      field().onPlayerTap?.(
        field().players.find(player => player.label === 'P')!.id
      )
    )
    peer.apply({ type: 'gameFlow', kind: 'endHalf' })
    await peer.flush()
    await step(() => {
      document
        .querySelector<HTMLElement>('[aria-label="Assign P #2 Player 2"]')!
        .click()
    })
    await first.flush()
    expect(first.state.liveData.linescore.isTopInning).equals(false)
    expect(first.state.liveData.boxscore.teams.away.defense).deep.equals(
      initial.liveData.boxscore.teams.away.defense
    )
    expect(first.state.liveData.boxscore.teams.home.defense).deep.equals(
      initial.liveData.boxscore.teams.home.defense
    )
    expect(document.querySelector('[aria-label="Defensive roster"]')).equals(
      null
    )
  })
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    HTMLCanvasElement.prototype.getContext = getContext
    container?.remove()
    container = undefined
  })

  for (const change of ['close', 'reselect', 'account', 'unmount'] as const)
    it(`does not issue a tag request after ${change} while scoring flush is pending`, async () => {
      const source = new DevelopmentScoringSource()
      await mount(source)
      await step(() => {
        props().onPitch?.('ball')
      })
      await settle()
      const document = source.store.games.get('g1')?.currentPlay
      expect(document).not.equals(null)
      const target = tagTargets(document!)[0]
      await step(() => {
        props().onTagSelect?.(target)
      })
      const editor =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      const panel = componentProps<{
        game: { flush: () => Promise<void> }
        client: TeamStationClient
      }>('ScoringPanel')
      let release!: () => void
      panel.game.flush = async () => {
        await new Promise<void>(resolve => {
          release = resolve
        })
      }
      let calls = 0
      source.saveTag = async (_game, targetId, tag) => {
        calls++
        return { targetId, tag, revision: '1' }
      }
      const saving = editor
        .saveTag('great catch')
        .catch((error: unknown) => error)
      if (change === 'unmount') {
        await act(async () => {
          root?.unmount()
        })
        root = undefined
      } else if (change === 'account') {
        panel.client.token = 'changed-account-test-token'
      } else {
        await step(() => {
          editor.onClose()
        })
        if (change === 'reselect')
          await step(() => {
            props().onTagSelect?.(target)
          })
      }
      release()
      const result = await saving
      expect(result).instanceOf(Error)
      expect((result as Error).message).includes('tag selection changed')
      expect(calls).equals(0)
    })

  it('keeps a pitch description when a deferred batting-team roster change is the newest Undo action', async () => {
    const source = new DevelopmentScoringSource()
    const original = await source.open(
      gameFixture,
      scoringRoster(1),
      scoringRoster(10)
    )
    original.apply({ type: 'pitch', call: 'B' })
    const setup = setupOf(original.state)
    const defense = setup.sides.away.defense
    ;[defense.P, defense.SS] = [defense.SS, defense.P]
    original.apply({ type: 'lineup', kind: 'roster', setup })
    await original.flush()
    const target = original.eventTargets[0]
    await mount(source)
    expect(props().historyDetail?.primary).equals('Roster changed')
    await step(() => {
      props().onHistoryOpen?.()
    })
    expect(props().historyRows).has.length(1)
    expect(props().historyRows![0]).deep.includes({
      id: target.id,
      title: 'Ball',
      description: 'Ball'
    })
    expect(props().tagHistoryDetail).equals(undefined)
    await step(() => {
      props().onTagSelect?.(props().historyRows![0])
    })
    const editor =
      componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
    expect(editor.target.description).equals('Ball')
    await editor.saveTag('pitch label')
    expect(
      tagTargets(source.store.games.get('g1')!.currentPlay!)[0]
    ).deep.includes({ id: target.id, tag: 'pitch label' })
  })

  it('tags the visible resumed ball rather than the stored unfinished in-play pitch', async () => {
    const source = new DevelopmentScoringSource()
    const original = await source.open(
      gameFixture,
      scoringRoster(1),
      scoringRoster(10)
    )
    original.apply({ type: 'pitch', call: 'B' })
    original.apply({
      type: 'ballInPlay',
      contact: 'swing',
      location: { x: 0, z: -30 },
      fielder: F.CF
    })
    await original.flush()
    const targets = original.eventTargets
    expect(targets).has.length(2)
    await mount(source)
    await step(() => {
      props().onHistoryOpen?.()
    })
    const visible = props().historyRows!
    expect(visible).has.length(1)
    expect(visible[0].id).equals(targets[0].id)
    expect(visible[0].title).equals('Ball')
    await step(() => {
      props().onTagSelect?.(visible[0])
    })
    await componentProps<Parameters<typeof EventTagEditor>[0]>(
      'EventTagEditor'
    ).saveTag('correct pitch')
    const stored = tagTargets(source.store.games.get('g1')!.currentPlay!)
    expect(stored[0]).deep.includes({ id: targets[0].id, tag: 'correct pitch' })
    expect(stored[1].tag).equals(null)
  })

  for (const opening of ['before', 'after'] as const)
    it(`reconciles a dismissed save when history opens ${opening} acknowledgment`, async () => {
      const source = new DevelopmentScoringSource()
      await mount(source)
      await step(() => {
        props().onPitch?.('ball')
      })
      await settle()
      const target = tagTargets(source.store.games.get('g1')!.currentPlay!)[0]
      let finish!: () => void
      const save = source.saveTag.bind(source)
      source.saveTag = async (...args) => {
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return await save(...args)
      }
      await step(() => {
        props().onTagSelect?.(target)
      })
      const editor =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      let saving!: Promise<void>
      await act(async () => {
        saving = editor.saveTag('great pitch')
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await step(() => {
        editor.onClose()
      })
      if (opening === 'before')
        await step(() => {
          props().onHistoryOpen?.()
        })
      await act(async () => {
        finish()
        await saving
      })
      expect(
        tagTargets(source.store.games.get('g1')!.currentPlay!)[0].tag
      ).equals('great pitch')
      expect(container?.textContent).not.includes('New tag')
      if (opening === 'after')
        await step(() => {
          props().onHistoryOpen?.()
        })
      expect(props().historyRows![0].tag).equals('great pitch')
      await step(() => {
        props().onTagSelect?.(props().historyRows![0])
      })
      expect(
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
          .target.tag
      ).equals('great pitch')
      expect(
        document.querySelector<HTMLInputElement>('[aria-label="New tag"]')!
          .value
      ).equals('great pitch')
      expect(document.body.textContent).includes('Remove tag')
    })

  for (const selection of ['after', 'pristine', 'empty', 'draft'] as const) {
    const input = (): HTMLInputElement =>
      document.querySelector<HTMLInputElement>('[aria-label="New tag"]')!
    const select = async (): Promise<void> => {
      await step(() => props().onTagSelect?.(props().historyRows!.at(-1)!))
      if (selection === 'empty' || selection === 'draft')
        await act(async () => {
          if (selection === 'empty') {
            Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              'value'
            )!.set!.call(input(), 'discarded draft')
            input().dispatchEvent(new window.Event('input', { bubbles: true }))
          }
          Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          )!.set!.call(input(), selection === 'draft' ? 'my draft' : '')
          input().dispatchEvent(new window.Event('input', { bubbles: true }))
        })
    }
    const expected = (tag: string): string =>
      selection === 'draft' ? 'my draft' : selection === 'empty' ? '' : tag

    it(`refreshes open history after roster reload with ${selection} editor selection`, async () => {
      const development = new DevelopmentScoringSource()
      const source: ScoringSource = {
        persistent: true,
        open: development.open.bind(development),
        saveTag: development.saveTag.bind(development),
        tagChoices: development.tagChoices.bind(development)
      }
      await mount(source)
      await step(() => {
        props().onPitch?.('ball')
      })
      await settle()
      const game = componentProps<{ game: ScoringSession }>('ScoringPanel').game
      const target = game.eventTargets[0]
      await development.saveTag(game, target.id, 'peer roster tag', 'peer')
      const load = development.store.load.bind(development.store)
      let release!: () => void
      let reads = 0
      development.store.load = async (...args) => {
        const snapshot = structuredClone(await load(...args))
        if (++reads === 1)
          await new Promise<void>(resolve => {
            release = resolve
          })
        return snapshot
      }
      await step(() => {
        props().onMenu()
      })
      await step(() => {
        document
          .querySelector<HTMLElement>('[aria-label="Set Team Rosters"]')!
          .click()
      })
      await step(() => {
        componentProps<{ onClose: () => void }>('ScoringSheet').onClose()
      })
      await step(() => props().onHistoryOpen?.())
      expect(props().historyRows![0].tag).equals(null)
      if (selection !== 'after') await select()
      await act(async () => {
        release()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(game.eventTargets[0].tag).equals('peer roster tag')
      expect(props().historyRows![0]).deep.includes({
        id: target.id,
        tag: 'peer roster tag'
      })
      if (selection === 'after') await select()
      expect(
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
          .target.tag
      ).equals('peer roster tag')
      expect(input().value).equals(expected('peer roster tag'))
      expect(document.querySelector('[aria-label="Remove tag"]')).not.equals(
        null
      )
    })

    it(`refreshes completed terminal history with ${selection} editor selection`, async () => {
      const original = { ...scoringClock }
      let time = 0
      let serial = 0
      const timers = new Map<number, () => void>()
      scoringClock.now = () => time
      scoringClock.schedule = callback => {
        timers.set(++serial, callback)
        return serial
      }
      scoringClock.cancel = id => {
        timers.delete(id as number)
      }
      try {
        const source = new DevelopmentScoringSource()
        await mount(source)
        const outcome = props().ballInPlayControl as React.ReactElement<{
          onChoose: (value: string) => void
        }>
        await step(() => {
          outcome.props.onChoose('Single')
        })
        const fielder = players().find(
          player => player.playerId === 10 && player.team !== 'offense'
        )
        await step(() =>
          field().onFieldPlacement?.(placement(fielder?.id ?? ''))
        )
        await step(() =>
          field().onTrajectoryAccepted?.(
            25,
            field().interaction?.generation ?? 0
          )
        )
        await settle()
        const game = componentProps<{ game: ScoringSession }>(
          'ScoringPanel'
        ).game
        await act(async () => {
          await game.flush()
        })
        const target = game.eventTargets.at(-1)!
        const save = source.saveTag.bind(source)
        let finish!: () => void
        source.saveTag = async (...args) => {
          await new Promise<void>(resolve => {
            finish = resolve
          })
          return await save(...args)
        }
        await step(() => props().onTagSelect?.(target))
        const old =
          componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
        let saving!: Promise<void>
        await act(async () => {
          saving = old.saveTag('late terminal tag')
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        await step(() => {
          old.onClose()
        })
        await act(async () => {
          time += 10000
          const due = [...timers.values()]
          timers.clear()
          for (const callback of due) callback()
        })
        await settle()
        await act(async () => {
          await game.flush()
        })
        await step(() => props().onHistoryOpen?.())
        const completed = props().historyRows!.at(-1)!
        expect(completed.completed).equals(true)
        expect(completed.id).not.equals(target.id)
        expect(completed.tag).equals(null)
        if (selection !== 'after') await select()
        await act(async () => {
          finish()
          await saving
        })
        expect(props().historyRows!.at(-1)).deep.includes({
          id: target.id,
          tag: 'late terminal tag',
          completed: true
        })
        if (selection === 'after') await select()
        expect(
          componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
            .target
        ).deep.includes({
          id: target.id,
          tag: 'late terminal tag',
          completed: true
        })
        expect(input().value).equals(expected('late terminal tag'))
        expect(document.querySelector('[aria-label="Remove tag"]')).not.equals(
          null
        )
      } finally {
        Object.assign(scoringClock, original)
      }
    })
  }

  for (const editing of [false, true])
    it(`updates a reopened pending tag editor while preserving ${editing ? 'new typing' : 'pristine input'}`, async () => {
      const source = new DevelopmentScoringSource()
      await mount(source)
      await step(() => {
        props().onPitch?.('ball')
      })
      await settle()
      const target = tagTargets(source.store.games.get('g1')!.currentPlay!)[0]
      let finish!: () => void
      const save = source.saveTag.bind(source)
      source.saveTag = async (...args) => {
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return await save(...args)
      }
      await step(() => {
        props().onTagSelect?.(target)
      })
      const old =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      let saving!: Promise<void>
      await act(async () => {
        saving = old.saveTag('great pitch')
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await step(() => {
        old.onClose()
      })
      await step(() => {
        props().onHistoryOpen?.()
      })
      await step(() => {
        props().onTagSelect?.(props().historyRows![0])
      })
      if (editing)
        await act(async () => {
          const input = document.querySelector<HTMLInputElement>(
            '[aria-label="New tag"]'
          )!
          Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          )!.set!.call(input, 'my draft')
          input.dispatchEvent(new window.Event('input', { bubbles: true }))
        })
      await act(async () => {
        finish()
        await saving
      })
      expect(
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
          .target.tag
      ).equals('great pitch')
      expect(
        document.querySelector<HTMLInputElement>('[aria-label="New tag"]')!
          .value
      ).equals(editing ? 'my draft' : 'great pitch')
      expect(document.querySelector('[aria-label="Remove tag"]')).not.equals(
        null
      )
    })

  for (const order of ['response', 'commit'] as const)
    it(`retains authoritative tags after peer roster reload when A's ${order} is delayed`, async () => {
      const development = new DevelopmentScoringSource()
      const write = development.saveTag.bind(development)
      let finish!: () => void
      const source: ScoringSource = {
        persistent: true,
        open: development.open.bind(development),
        tagChoices: development.tagChoices.bind(development),
        saveTag: async (...args) => {
          const gate = async (): Promise<void> => {
            await new Promise<void>(resolve => {
              finish = resolve
            })
          }
          if (order === 'commit') await gate()
          const result = await write(...args)
          if (order === 'response') await gate()
          return result
        }
      }
      await mount(source)
      await step(() => {
        props().onPitch?.('ball')
      })
      await settle()
      const target = tagTargets(
        development.store.games.get('g1')!.currentPlay!
      )[0]
      const game = componentProps<{ game: ScoringSession }>('ScoringPanel').game
      await step(() => {
        props().onTagSelect?.(target)
      })
      const old =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      let saving!: Promise<void>
      await act(async () => {
        saving = old.saveTag('older label')
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await step(() => {
        old.onClose()
      })
      await write(game, target.id, 'newer label', 'peer')
      await step(() => {
        props().onMenu()
      })
      await step(() => {
        document
          .querySelector<HTMLElement>('[aria-label="Set Team Rosters"]')!
          .click()
      })
      expect(game.eventTargets[0].tag).equals('newer label')
      await act(async () => {
        finish()
        await saving
      })
      const expected = order === 'commit' ? 'older label' : 'newer label'
      expect(game.eventTargets[0].tag).equals(expected)
      expect(
        tagTargets(development.store.games.get('g1')!.currentPlay!)[0].tag
      ).equals(expected)
    })

  for (const change of ['reload', 'account'] as const)
    it(`guards a tag refresh when ${change} changes during its authoritative read`, async () => {
      const development = new DevelopmentScoringSource()
      const write = development.saveTag.bind(development)
      let finish!: () => void
      const source: ScoringSource = {
        persistent: true,
        open: development.open.bind(development),
        tagChoices: development.tagChoices.bind(development),
        saveTag: async (...args) => {
          const result = await write(...args)
          await new Promise<void>(resolve => {
            finish = resolve
          })
          return result
        }
      }
      await mount(source)
      await step(() => {
        props().onPitch?.('ball')
      })
      await settle()
      const target = tagTargets(
        development.store.games.get('g1')!.currentPlay!
      )[0]
      const game = componentProps<{ game: ScoringSession }>('ScoringPanel').game
      await step(() => {
        props().onTagSelect?.(target)
      })
      const old =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      let saving!: Promise<unknown>
      await act(async () => {
        saving = old.saveTag('older label').catch((error: unknown) => error)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await step(() => {
        old.onClose()
      })
      await write(game, target.id, 'newer label', 'peer')
      await act(async () => {
        await game.reload()
      })
      const load = development.store.load.bind(development.store)
      let finishRead!: () => void
      let reads = 0
      development.store.load = async (...args) => {
        const result = await load(...args)
        if (++reads === 1)
          await new Promise<void>(resolve => {
            finishRead = resolve
          })
        return result
      }
      await act(async () => {
        finish()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(reads).equals(1)
      if (change === 'reload')
        await act(async () => {
          await write(game, target.id, 'latest label', 'peer')
          await game.reload()
        })
      else
        componentProps<{ client: TeamStationClient }>(
          'ScoringPanel'
        ).client.token = 'SyntheticReplacementSession'
      let result: unknown
      await act(async () => {
        finishRead()
        result = await saving
      })
      if (change === 'reload') {
        expect(game.eventTargets[0].tag).equals('latest label')
        expect(reads).equals(3)
        expect(result).equals(undefined)
      } else {
        expect(game.eventTargets[0].tag).equals('newer label')
        expect(result).instanceOf(Error)
        expect((result as Error).message).includes('selection changed')
      }
    })

  for (const order of ['response', 'commit'] as const)
    it(`reconciles committed tags when A's ${order} follows B on the same target`, async () => {
      const source = new DevelopmentScoringSource()
      await mount(source)
      await step(() => {
        props().onPitch?.('ball')
      })
      await settle()
      const target = tagTargets(source.store.games.get('g1')!.currentPlay!)[0]
      const finish = new Map<string, () => void>()
      const save = source.saveTag.bind(source)
      source.saveTag = async (...args) => {
        const label = args[2]!
        const gate = async (): Promise<void> => {
          await new Promise<void>(resolve => {
            finish.set(label, resolve)
          })
        }
        if (order === 'commit' && label === 'older label') await gate()
        const result = await save(...args)
        if (order === 'response' || label === 'newer label') await gate()
        return result
      }
      await step(() => {
        props().onTagSelect?.(target)
      })
      const older =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      let oldSave!: Promise<unknown>
      await act(async () => {
        oldSave = older.saveTag('older label').catch((error: unknown) => error)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await step(() => {
        older.onClose()
        props().onTagSelect?.(target)
      })
      const newer =
        componentProps<Parameters<typeof EventTagEditor>[0]>('EventTagEditor')
      let newSave!: Promise<void>
      await act(async () => {
        newSave = newer.saveTag('newer label')
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await act(async () => {
        finish.get('newer label')!()
        await newSave
      })
      const game = componentProps<{
        game: { eventTargets: Array<typeof target> }
      }>('ScoringPanel').game
      expect(game.eventTargets[0].tag).equals('newer label')
      await act(async () => {
        finish.get('older label')!()
        await oldSave
      })
      const expected = order === 'commit' ? 'older label' : 'newer label'
      expect(game.eventTargets[0].tag).equals(expected)
      expect(
        tagTargets(source.store.games.get('g1')!.currentPlay!)[0].tag
      ).equals(expected)
    })

  it('resumes the correction countdown after history dismissal and tag save', async function () {
    const original = { ...scoringClock }
    let time = 0
    let serial = 0
    const timers = new Map<number, () => void>()
    scoringClock.now = () => time
    scoringClock.schedule = callback => {
      timers.set(++serial, callback)
      return serial
    }
    scoringClock.cancel = id => {
      timers.delete(id as number)
    }
    const advance = async (ms: number): Promise<void> => {
      await act(async () => {
        time += ms
        const due = [...timers.values()]
        timers.clear()
        for (const callback of due) callback()
      })
    }
    try {
      const source = new DevelopmentScoringSource()
      await mount(source)
      const outcome = props().ballInPlayControl as React.ReactElement<{
        onChoose: (outcome: string) => void
      }>
      await step(() => {
        outcome.props.onChoose('Single')
      })
      const fielder = players().find(
        player => player.playerId === 10 && player.team !== 'offense'
      )
      await step(() => field().onFieldPlacement?.(placement(fielder?.id ?? '')))
      await step(() =>
        field().onTrajectoryAccepted?.(25, field().interaction?.generation ?? 0)
      )
      await settle()
      const remaining = props().remainingMs
      expect(remaining).to.be.a('number')
      expect(timers.size).greaterThan(0)
      await step(() => props().onHistoryOpen?.())
      const detail = props().historyDetail?.primary
      if (detail != null)
        expect(props().historyRows?.at(-1)?.description).includes(detail)
      expect(timers.size).equals(0)
      await advance(10000)
      expect(props().remainingMs).equals(remaining)
      await step(() => props().onHistoryClose?.())
      expect(timers.size).greaterThan(0)
      await advance(250)
      expect(props().remainingMs).lessThan(remaining!)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      const current = source.store.games.get('g1')?.currentPlay
      expect(current).not.equals(null)
      const target = tagTargets(current!)[0]
      await step(() => props().onTagSelect?.(target))
      expect(timers.size).equals(0)
      const input = document.querySelector<HTMLInputElement>(
        '[aria-label="New tag"]'
      )!
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(input, 'quick release')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
        document.querySelector<HTMLElement>('[aria-label="Save tag"]')!.click()
      })
      expect(document.querySelector('[aria-label="New tag"]')).equals(null)
      expect(timers.size).greaterThan(0)
      const resumed = props().remainingMs
      await advance(250)
      expect(props().remainingMs).lessThan(resumed!)
      await advance(10000)
      await step(() => {
        props().onPitch?.('ball')
      })
      await step(() => {
        props().onHistoryOpen?.()
      })
      const older = props().historyRows?.find(row => row.completed === true)
      expect(detail).to.be.a('string')
      expect(older?.description).includes(detail!)
      expect(props().historyRows?.at(-1)?.completed).not.equals(true)
      await step(() => {
        props().onHistoryClose?.()
      })
    } finally {
      await act(async () => {
        root?.unmount()
        root = undefined
      })
      Object.assign(scoringClock, original)
    }
  })

  it('counts pitches from the pitch control and ignores the play button', async function () {
    await mount()
    expect(props().summary).includes('0 balls')
    await step(() => {
      props().onPitch?.('ball')
    })
    expect(props().summary).includes('1 balls')
    await step(() => {
      props().onPitch?.('play')
    })
    expect(props().summary).includes('1 balls')
    await step(() => {
      props().onUndo?.()
    })
    expect(props().summary).includes('0 balls')
  })

  it('opens and closes the game menu, and records camera gestures', async function () {
    await mount()
    await step(() => {
      props().onMenu?.()
    })
    await step(() => {
      props().onMenu?.()
    })
    await step(() => props().onCameraGesture?.(true))
    await step(() => props().onCameraGesture?.(false))
    expect(props().canPitch).equals(true)
  })

  it('switches a switch hitter by placing the batter on the other side', async function () {
    await mount()
    const selectable = field().selectableIds ?? []
    for (const id of selectable)
      await step(() => field().onPlayerPlacement?.(id, { x: 3, z: 0 }))
    await step(() => field().onPlayerPlacement?.('nobody', { x: 3, z: 0 }))
    await step(() => props().onDismissHint?.())
    expect(props().accessibilitySummary).includes('Batter')
  })

  it('scores an error from outcome to fielder, trajectory and defender', async function () {
    await mount()
    const outcome = props().ballInPlayControl as React.ReactElement<{
      onActive: (active: boolean) => void
      onChoose: (outcome: string, contact?: string) => void
    }>
    await step(() => {
      outcome.props.onActive(true)
    })
    await step(() => {
      outcome.props.onActive(false)
    })
    await step(() => {
      outcome.props.onChoose('Error')
    })
    expect(props().instruction).not.equals(undefined)

    const fielder = players().find(
      player => player.playerId === 10 && player.team !== 'offense'
    )
    expect(fielder, 'shortstop on the field').not.equals(undefined)
    await step(() => field().onLandingPreview?.({ x: 0, z: -30 }))
    await step(() => field().onFieldPlacement?.(placement(fielder?.id ?? '')))
    await step(() => field().onTrajectoryAccepted?.(25, 0))
    expect(props().instructionDetail ?? '').not.includes('°')

    await settle()
    expect(props().onFinish, 'the defender can be confirmed').to.be.a(
      'function'
    )
    // Confirming the defender dispatches through the screen's runner wrapper.
    await step(() => props().onFinish?.())
    await settle()

    const runner = players().find(player => player.team === 'runner')
    if (runner != null) {
      const verdict = field().runnerSafeError?.(runner.id, 2)
      expect(verdict === undefined || typeof verdict === 'string').equals(true)
      await step(() => field().onRunnerDrag?.(null))
      await step(() => field().onRunnerDrop?.(runner.id, 2, 'safe', 99))
    }
    expect(field().runnerSafeError?.('nobody', 2)).equals('Runner unavailable')
    await step(() => field().onGestureActive?.(true))
    await step(() => field().onGestureActive?.(false))
    await step(() => props().onFinish?.())
    await settle()
    for (let undo = 0; undo < 8; undo++)
      await step(() => {
        props().onUndo?.()
      })
    expect(props().accessibilitySummary).includes('0 outs')
  })

  it("sends the launch angle as the scorer's only when he moved it", async function () {
    const source = new DevelopmentScoringSource()
    await mount(source)
    const outcome = props().ballInPlayControl as React.ReactElement<{
      onChoose: (outcome: string, contact?: string) => void
    }>
    const shortstop = players().find(
      player => player.playerId === 10 && player.team !== 'offense'
    )
    /** The launch angle on the stored ball in play, if it has one. */
    const storedAngle = async (): Promise<unknown> => {
      await settle()
      const stored = source.store.games.get(String(gameFixture.id))
      const play = stored?.currentPlay ?? stored?.plays.at(-1)
      const events = (play?.playEvents ?? []) as Array<{
        details: { isInPlay?: boolean }
        hitData?: { launchAngle?: number }
      }>
      const hit = events.find(event => event.details.isInPlay === true)
      expect(hit, 'the ball in play is stored').not.equals(undefined)
      return hit?.hitData?.launchAngle
    }
    const generation = (): number => field().interaction?.generation ?? 0
    const accept = async (
      angle: number,
      dragged?: boolean
    ): Promise<unknown> => {
      await step(() => {
        outcome.props.onChoose('Single')
      })
      await step(() =>
        field().onFieldPlacement?.({
          ...placement(shortstop?.id ?? ''),
          generation: generation()
        })
      )
      await step(() =>
        field().onTrajectoryAccepted?.(angle, generation(), dragged)
      )
      const stored = await storedAngle()
      for (let undo = 0; undo < 8; undo++)
        await step(() => {
          props().onUndo?.()
        })
      return stored
    }
    // A tap on the untouched 45°, and the keyboard's Enter on it: no angle.
    expect(await accept(45, false)).equals(undefined)
    expect(await accept(45)).equals(undefined)
    // A drag that turned it, even back to 45°, and the keyboard's arrows
    // moving it off 45° then Enter or a tap: the scorer's own.
    expect(await accept(45, true)).equals(45)
    expect(await accept(30)).equals(30)
    expect(await accept(30, false)).equals(30)
  })

  it('offers the more menu and a runner draft that can be cancelled', async function () {
    await mount()
    const more = props().moreControl as React.ReactElement<{
      onActive: (active: boolean) => void
      onChoose: (input: unknown) => void
    }>
    await step(() => {
      more.props.onActive(true)
    })
    await step(() => {
      more.props.onActive(false)
    })
    await step(() => {
      more.props.onChoose({ action: 'Place a Runner (Tiebreaker)' })
    })
    await step(() => {
      more.props.onChoose({ action: 'Hit by Pitch' })
    })
    expect(props().summary).to.be.a('string')
  })
  it('assigns current defense from the field, reuses placeholder quantity and dismisses complete warnings', async function () {
    this.timeout(10000)
    const session = scoringSession(gameFixture)
    const home = session.liveData.boxscore.teams.home
    home.players = home.players.slice(0, 8)
    home.battingOrder = [...home.players]
    for (const slot of POSITIONS) home.defense[slot] = null
    const prepared = freshGame(
      session.gamePk,
      session.gameData.teams,
      setupOf(session)
    )
    await mount({
      open: async () => ScoringSession.start(memoryStore(), 'g1', prepared)
    })
    expect(props().canPitch).equals(false)
    expect(
      field().players.filter(player => player.emptyPosition === true)
    ).has.length(9)
    await step(() => field().onPlayerTap?.('empty-P'))
    expect(document.body.textContent).includes('Create Player')
    const click = async (label: string): Promise<void> => {
      await step(() => {
        document
          .querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)
          .item(document.querySelectorAll(`[aria-label="${label}"]`).length - 1)
          .click()
      })
    }
    await click('Create Player')
    await click('Create Placeholder Player')
    await click('Player count 2')
    await click('Create')
    expect(document.querySelectorAll('[aria-label^="Assign P "]')).has.length(
      10
    )
    expect(document.querySelector('[aria-label="Create Player"]')).not.equals(
      null
    )
    await click('Assign P #1 Player 1')
    expect(props().instruction).not.includes('P,')
    const pitcher = field().players.find(player => player.label === 'P')!
    await step(() => field().onPlayerTap?.(pitcher.id))
    expect(document.querySelector('[aria-label="Create Player"]')).not.equals(
      null
    )
    await click('Cancel')
    for (const [index, slot] of POSITIONS.entries()) {
      if (slot === 'P') continue
      await step(() => field().onPlayerTap?.(`empty-${slot}`))
      await click(
        index < 8
          ? `Assign ${slot} #${index + 1} Player ${index + 1}`
          : `Assign ${slot} Hawks A`
      )
    }
    expect(props().instruction).equals(undefined)
    expect(props().canPitch).equals(true)
  })
  for (const [cover, title] of [
    [
      'runner error reuse',
      'holds the walk-up songs notice until the runner error choice closes'
    ],
    [
      'hidden scorer',
      'holds the walk-up songs notice while the scorer is retained behind Settings'
    ],
    [
      'defensive roster',
      'holds the walk-up songs notice while the defensive roster is open'
    ],
    [
      'tag history',
      'holds the walk-up songs notice while the tag history is open'
    ],
    [
      'tiebreaker setup',
      'holds the walk-up songs notice while the tiebreaker setup is open'
    ],
    [
      'tiebreaker runner',
      'holds the walk-up songs notice while the tiebreaker runner roster is open'
    ],
    [
      'scorer change',
      'shows the walk-up songs notice once a new scorer’s panel replaces one with a sheet up'
    ]
  ] as const)
    it(title, async function () {
      // Each case waits out the notice's settle twice; on a loaded machine
      // that is slow, not wrong.
      this.timeout(30000)
      const session = scoringSession(gameFixture)
      if (cover !== 'runner error reuse')
        for (const slot of POSITIONS)
          session.liveData.boxscore.teams.home.defense[slot] = null
      const prepared = freshGame(
        session.gamePk,
        session.gameData.teams,
        setupOf(session)
      )
      const phone: WalkUpMusic = {
        ...webMusic,
        available: true,
        djSupported: true,
        prepareOffline: async ids => ({
          authorized: true,
          subscribed: true,
          syncLibrary: true,
          songs: ids.map(providerId => ({ providerId, state: 'pending' }))
        })
      }
      const live = ScoringSession.start(
        memoryStore(),
        'g1',
        cover === 'runner error reuse' ? session : prepared
      )
      if (cover === 'runner error reuse') {
        live.apply({
          type: 'gameFlow',
          kind: 'placeRunner',
          runner: 2,
          base: '1B'
        })
        live.apply({ type: 'pitch', call: 'B' })
        expect(
          live.apply({
            type: 'runnerMovement',
            runner: 2,
            to: '2B',
            reason: 'Throwing Error',
            error: session.liveData.linescore.defense.P!.id,
            fielders: [session.liveData.linescore.defense.P!.id]
          }).problems
        ).deep.equals([])
      }
      // The tag history needs a source that saves tags, and a pitch to show.
      const tagging = new DevelopmentScoringSource()
      if (cover === 'tag history') {
        const game = await tagging.open(
          gameFixture,
          scoringRoster(1),
          scoringRoster(10)
        )
        game.apply({ type: 'pitch', call: 'B' })
        await game.flush()
      }
      const rerender = await mount(
        cover === 'tag history' ||
          cover === 'tiebreaker setup' ||
          cover === 'tiebreaker runner'
          ? tagging
          : {
              open: async () => live
            },
        {
          [gameFixture.awayTeamId]: [
            asRosterEntry({
              userId: 1,
              shortName: 'Mike T',
              jersey: '7',
              positions: [],
              isPlayer: true,
              role: 'member',
              section: 'player',
              staffRoles: [],
              inheritedFrom: null,
              walkUpSong: {
                provider: 'appleMusic',
                providerId: '111',
                isrc: null,
                title: 'Centerfield',
                artist: 'Band',
                album: null,
                artworkUrl: null,
                durationMs: 90000,
                startMs: 10000,
                endMs: 25000
              }
            }),
            ...scoringRoster(1).slice(1)
          ],
          [gameFixture.homeTeamId]: scoringRoster(10)
        },
        {
          music: phone,
          readiness: {
            read: async () => ({ onboarded: true, promptShown: false }),
            write: async () => undefined
          }
        }
      )
      const notice = 'Some walk-up songs still need to be downloaded.'
      const settle = async (): Promise<void> => {
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 700))
        })
      }
      const press = async (label: string): Promise<void> => {
        await step(() => {
          document
            .querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)
            .item(
              document.querySelectorAll(`[aria-label="${label}"]`).length - 1
            )
            .click()
        })
      }
      if (cover === 'runner error reuse') {
        await step(() =>
          field().onRunnerDrop?.(
            'offense-2',
            3,
            'safe',
            field().interaction!.generation
          )
        )
        await press('Throwing Error')
        const pitcher = players().find(
          player =>
            player.playerId === session.liveData.linescore.defense.P!.id &&
            player.team === 'defense'
        )!
        await step(() =>
          field().onFieldPlacement?.({
            ...placement(pitcher.id),
            generation: field().interaction!.generation
          })
        )
        expect(document.body.textContent, props().instruction).includes(
          'Was this the same error?'
        )
        await settle()
        expect(document.body.textContent).not.includes(notice)
        await press('Cancel')
        await settle()
        expect(document.body.textContent).includes(notice)
        return
      }
      if (cover === 'hidden scorer') {
        await rerender({ active: false })
        await settle()
        expect(document.body.textContent).not.includes(notice)
        await rerender({ active: true })
        await settle()
        expect(document.body.textContent).includes(notice)
        expect(field().presentationPaused).equals(true)
        return
      }
      if (cover === 'tiebreaker setup' || cover === 'tiebreaker runner') {
        await press('More')
        await press('Place a Runner (Tiebreaker)')
        expect(document.body.textContent).includes('Place runner on base')
      }
      if (cover === 'tiebreaker runner') {
        // The bases on the field are no Modal; the runner roster is.
        await press('Place runner on base')
        await step(() =>
          field().onBaseProjection?.({
            width: 390,
            height: 844,
            bases: [
              { x: 195, y: 580 },
              { x: 280, y: 450 },
              { x: 195, y: 360 },
              { x: 110, y: 450 }
            ]
          })
        )
        await press('Place runner on 2B')
        expect(document.body.textContent).includes('Select Runner for 2B')
      } else if (cover === 'tiebreaker setup') {
        // Opened above.
      } else if (cover !== 'tag history') {
        await step(() => field().onPlayerTap?.('empty-P'))
        expect(document.body.textContent).includes('Create Player')
      } else {
        expect(props().onHistoryOpen).not.equals(undefined)
        await step(() => props().onHistoryOpen?.())
      }
      await settle()
      expect(document.body.textContent).not.includes(notice)
      if (
        cover === 'defensive roster' ||
        cover === 'tiebreaker setup' ||
        cover === 'tiebreaker runner'
      ) {
        await press('Cancel')
      } else if (cover === 'scorer change') {
        // A new scorer is a new panel: the old one goes with its sheet up.
        await rerender({ userId: 22 })
        expect(document.body.textContent).not.includes('Create Player')
      } else {
        await step(() => props().onHistoryClose?.())
      }
      await settle()
      expect(document.body.textContent).includes(notice)
      // A replay waits under the notice, as the clock does.
      expect(field().presentationPaused).equals(true)
    })
  for (const persistent of [false, true])
    it(`creates named and placeholder bench players through the same picker and persists them (${persistent})`, async function () {
      this.timeout(10000)
      const initial = scoringSession(gameFixture)
      initial.liveData.boxscore.teams.home.defense.P = null
      const store = memoryStore()
      const live = persistent
        ? await ScoringSession.open(
            store,
            'g1',
            {
              gamePk: 'g1',
              teams: initial.gameData.teams,
              setup: setupOf(initial)
            },
            { requireCurrentSetup: true }
          )
        : ScoringSession.start(store, 'g1', initial, {
            requireCurrentSetup: true
          })
      await mount({ persistent, open: async () => live })
      const click = async (label: string): Promise<void> => {
        await step(() => {
          document
            .querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)
            .item(
              document.querySelectorAll(`[aria-label="${label}"]`).length - 1
            )
            .click()
        })
      }
      const input = async (label: string, value: string): Promise<void> => {
        await step(() => {
          const node = document.querySelector(`[aria-label="${label}"]`)!
          Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          )!.set!.call(node, value)
          node.dispatchEvent(new window.Event('input', { bubbles: true }))
        })
      }
      await step(() => field().onPlayerTap?.('empty-P'))
      await click('Create Player')
      await input('First Name', 'Mookie')
      await input('Last Name', 'Betts')
      await input('Jersey Number', '0')
      await click('Save and Create Another Player')
      await input('First Name', 'Mike')
      await input('Last Name', 'Trout')
      await click('Create Player')
      expect(document.body.textContent).includes('Assign pitcher')
      expect(document.body.textContent).includes('Mookie B #0')
      expect(document.body.textContent).includes('Mike T')
      expect(document.querySelector('[aria-label="First Name"]')).equals(null)
      await click('Create Player')
      await click('Create Placeholder Player')
      await click('Player count 2')
      await click('Create')
      expect(document.body.textContent).includes('Hawks A')
      expect(document.querySelector('[aria-label="First Name"]')).equals(null)
      expect(live.state.liveData.boxscore.teams.home.players).has.length(13)
      expect(live.state.liveData.boxscore.teams.home.battingOrder).deep.equals(
        initial.liveData.boxscore.teams.home.battingOrder
      )
      expect(live.state.liveData.boxscore.teams.home.defense).deep.equals(
        initial.liveData.boxscore.teams.home.defense
      )
      await live.flush()
      const reopened = await ScoringSession.open(store, 'g1', {
        gamePk: 'g1',
        teams: initial.gameData.teams,
        setup: setupOf(initial)
      })
      expect(reopened.state.liveData.boxscore.teams.home.players).has.length(13)
      expect(
        Object.values(reopened.state.gameData.players).some(
          player => player.fullName === 'Mookie B' && player.jersey === '0'
        )
      ).equals(true)
      await click('Assign P #0 Mookie B')
      expect(props().canPitch).equals(true)
      await step(() =>
        field().onPlayerTap?.(
          field().players.find(player => player.label === 'P')!.id
        )
      )
      await click('Assign P #2 Player 2')
      expect(live.state.liveData.boxscore.teams.home.defense.C).equals(null)
      await step(() => {
        props().onUndo?.()
      })
      expect(live.state.liveData.boxscore.teams.home.defense.C).equals(
        initial.liveData.boxscore.teams.home.defense.C
      )
      await step(() => {
        props().onUndo?.()
      })
      await step(() => {
        props().onUndo?.()
      })
      expect(live.state.liveData.boxscore.teams.home.players).has.length(11)
    })

  it('keeps player entry recoverable after a failed refresh and retries without duplicating', async function () {
    const initial = scoringSession(gameFixture)
    const store = memoryStore()
    const load = store.load
    let fail = false
    store.load = async id => {
      if (fail) throw new Error('Offline')
      return await load(id)
    }
    const live = await ScoringSession.open(store, 'g1', {
      gamePk: 'g1',
      teams: initial.gameData.teams,
      setup: setupOf(initial)
    })
    await mount({ persistent: true, open: async () => live })
    await step(() =>
      field().onPlayerTap?.(
        field().players.find(player => player.label === 'P')!.id
      )
    )
    await step(() => {
      document
        .querySelectorAll<HTMLElement>('[aria-label="Create Player"]')
        .item(
          document.querySelectorAll('[aria-label="Create Player"]').length - 1
        )
        .click()
    })
    await step(() => {
      const node = document.querySelector('[aria-label="First Name"]')!
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(node, 'Mookie')
      node.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    fail = true
    await step(() => {
      document
        .querySelectorAll<HTMLElement>('[aria-label="Create Player"]')
        .item(
          document.querySelectorAll('[aria-label="Create Player"]').length - 1
        )
        .click()
    })
    expect(document.body.textContent).includes(
      'Unable to create the player. Please try again.'
    )
    expect(live.state.liveData.boxscore.teams.home.players).has.length(9)
    fail = false
    await step(() => {
      document
        .querySelectorAll<HTMLElement>('[aria-label="Create Player"]')
        .item(
          document.querySelectorAll('[aria-label="Create Player"]').length - 1
        )
        .click()
    })
    expect(live.state.liveData.boxscore.teams.home.players).has.length(10)
    expect(document.querySelector('[aria-label="First Name"]')).equals(null)
  })

  it('keeps a completed game out of defensive setup', async function () {
    const initial = scoringSession(gameFixture)
    const live = ScoringSession.start(memoryStore(), 'g1', initial)
    expect(
      live.apply({ type: 'gameFlow', kind: 'endGame' }).problems
    ).deep.equals([])
    await mount({ open: async () => live })
    const pitcher = field().players.find(player => player.label === 'P')!
    expect(field().tapIds).not.includes(pitcher.id)
    await step(() => field().onPlayerTap?.(pitcher.id))
    expect(document.querySelector('[aria-label="Defensive roster"]')).equals(
      null
    )
    expect(document.body.textContent).includes('Game over')
    expect(props().setupToast).equals(undefined)
    expect(live.state.liveData.boxscore.teams.home.players).has.length(9)
  })

  for (const change of ['half', 'active', 'read-only', 'final'] as const)
    it(`blocks player creation when a peer makes the game ${change}`, async function () {
      const initial = scoringSession(gameFixture)
      const context = {
        gamePk: 'g1',
        teams: initial.gameData.teams,
        setup: setupOf(initial)
      }
      const store = memoryStore()
      const live = await ScoringSession.open(store, 'g1', context)
      const peer = await ScoringSession.open(store, 'g1', context)
      await mount({ persistent: true, open: async () => live })
      await step(() =>
        field().onPlayerTap?.(
          field().players.find(player => player.label === 'P')!.id
        )
      )
      await step(() => {
        document
          .querySelectorAll<HTMLElement>('[aria-label="Create Player"]')
          .item(
            document.querySelectorAll('[aria-label="Create Player"]').length - 1
          )
          .click()
      })
      await step(() => {
        const node = document.querySelector('[aria-label="First Name"]')!
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(node, 'Mookie')
        node.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      if (change === 'read-only')
        Object.defineProperty(live, 'readOnly', { get: () => true })
      else {
        expect(
          peer.apply(
            change === 'half'
              ? { type: 'gameFlow', kind: 'endHalf' }
              : change === 'final'
                ? { type: 'gameFlow', kind: 'endGame' }
                : {
                    type: 'ballInPlay',
                    contact: 'swing',
                    fielder: initial.liveData.boxscore.teams.home.defense.SS!,
                    location: { x: 0, z: -30 }
                  }
          ).problems
        ).deep.equals([])
        await peer.flush()
      }
      await step(() => {
        document
          .querySelectorAll<HTMLElement>('[aria-label="Create Player"]')
          .item(
            document.querySelectorAll('[aria-label="Create Player"]').length - 1
          )
          .click()
      })
      expect(live.state.liveData.boxscore.teams.home.players).has.length(9)
      expect(live.state.liveData.boxscore.teams.away.players).has.length(9)
      expect(document.querySelector('[aria-label="Defensive roster"]')).equals(
        null
      )
    })

  it('shows zero and partial current batting warnings with accurate routes, acceptance and guards', async function () {
    const session = scoringSession(gameFixture)
    session.liveData.boxscore.teams.away.battingOrder = []
    const prepared = freshGame(
      session.gamePk,
      session.gameData.teams,
      setupOf(session)
    )
    await mount({
      open: async () => ScoringSession.start(memoryStore(), 'g1', prepared)
    })
    expect(props().canPitch).equals(false)
    expect(field().scoreboard?.batter.firstName).equals('')
    await step(() => {
      props().onPitch('ball')
    })
    expect(props().summary).includes('0 balls')
    expect(props().instruction).equals('Insufficient batting lineup.')
    expect(props().setupToast?.message).equals('No players in lineup')
    expect(props().setupToast?.onAcceptLineup).equals(undefined)
    await step(() => props().setupToast?.onSetLineup?.())
    expect(
      document.querySelector('[aria-label="Away Team"][aria-selected="true"]')
    ).not.equals(null)
    await step(() => {
      document
        .querySelector<HTMLElement>('[aria-label="Add Player 1 to Lineup"]')!
        .click()
    })
    await step(() => {
      document
        .querySelector<HTMLElement>('[aria-label="Save Rosters"]')!
        .click()
    })
    expect(props().setupToast?.message).equals('Only one player in lineup')
    expect(props().canPitch).equals(false)
    await step(() => props().setupToast?.onAcceptLineup?.())
    expect(props().instruction).equals(undefined)
    expect(props().canPitch).equals(true)
    await step(() => {
      props().onPitch('ball')
    })
    expect(props().summary).includes('1 balls')
  })
})
