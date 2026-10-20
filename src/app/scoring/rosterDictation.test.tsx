import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asRosterEntry, TeamStationClient } from '../../common/api'
import {
  promptContext,
  type ScoringAction,
  shortName
} from '../../common/scoring/actions'
import {
  type ChosenRosterCommand,
  ONE_CATEGORY_AT_A_TIME,
  rosterPrompt,
  type RosterQuestion,
  type SaidRosterCommand,
  type StagedRunner
} from '../../common/scoring/rosterCommands'
import { ScoringSession as GameSession } from '../../common/scoring/session'
import { copyState } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import {
  dictatingHealth,
  type FakeDictation,
  fakeDictation,
  FakeDictationSocket
} from '../../test/dictationFakes'
import { guestCreator } from '../../test/guestPlayers'
import { completeMotions } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import type { CreateRosterPlayer } from './createDictatedPlayers'
import { useDictationControls } from './DictationButton'
import { upcoming } from './dictationHook'
import { gameFixture } from './isUnscoredGame.test'
import type { ChatTurn } from './RosterChat'
import {
  rosterDictationContext,
  type RosterDictationOptions,
  useDictationHandover
} from './rosterDictation'
import { type RosterAudience, RosterEditor } from './RosterEditor'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { ScoringScreen } from './ScoringScreen'
import { memoryStore, type ScoringSource } from './scoringSource'
import type { ScoringSessionState, ScoringState } from './scoringTypes'

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
})
const node = (label: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const selected = (label: string): boolean =>
  node(label)?.getAttribute('aria-selected') === 'true'
const saveDisabled = (): boolean =>
  node('Save Rosters')!.getAttribute('aria-disabled') === 'true'
const chat = (testId: string): string[] =>
  [...document.body.querySelectorAll(`[data-testid="${testId}"]`)].map(each =>
    String(each.textContent)
  )
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function fresh(): ScoringState {
  return initialScoringState(scoringSession(gameFixture))
}

interface Mounted {
  fake: FakeDictation
  saved: Array<{
    draft: ScoringSessionState
    nextBatter?: number
    runners?: StagedRunner[]
  }>
  /** One sentence: a hold, a release, and the server's reply to it. */
  say: (
    transcript: string,
    roster: SaidRosterCommand[],
    actions?: ScoringAction[]
  ) => Promise<void>
}

async function mount(
  state: ScoringState,
  more: {
    /** A coach's save, which answers later, or fails when refused. */
    save?: () => Promise<void>
    audience?: RosterAudience
    options?: Partial<RosterDictationOptions>
    chat?: ChatTurn[]
    question?: RosterQuestion
    pending?: ChosenRosterCommand[]
    createFailure?: unknown
    create?: CreateRosterPlayer
  } = {}
): Promise<Mounted> {
  const fake = fakeDictation()
  const saved: Mounted['saved'] = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const coach = more.audience === 'coach'
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <RosterEditor
          onCreateGuest={guestCreator()}
          state={state}
          onCreatePlayer={
            more.create ??
            (async (_teamId, player) => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise an untyped transport rejection.
              if (more.createFailure != null) throw more.createFailure
              return asRosterEntry({
                userId: userIdOfGumbo(7001),
                gumboId: 7001,
                shortName: player.firstName,
                jersey: player.jersey,
                isPlayer: true,
                role: 'member',
                section: 'player',
                staffRoles: [],
                inheritedFrom: null,
                positions: [],
                bats: player.bats,
                throws: player.throws
              })
            })
          }
          audience={more.audience}
          fixedSide={coach ? 'home' : undefined}
          initialDraft={
            coach
              ? undefined
              : {
                  draft: copyState(state.session),
                  side: 'away',
                  mode: 'editRoster',
                  ...(more.chat == null ? {} : { chat: more.chat }),
                  ...(more.question == null ? {} : { question: more.question }),
                  ...(more.pending == null ? {} : { pending: more.pending })
                }
          }
          dictate={{
            health: dictatingHealth,
            url: 'ws://host/api/v1/dictation',
            gameId: 'g1',
            log: state.log,
            startEnabled: true,
            tapMs: 0,
            tailMs: 0,
            openSocket: fake.openSocket,
            openMicrophone: fake.openMicrophone,
            ...more.options
          }}
          onSave={(draft, nextBatter, runners): void | Promise<void> => {
            saved.push({
              draft,
              ...(nextBatter == null ? {} : { nextBatter }),
              ...(runners == null ? {} : { runners })
            })
            if (more.save != null) return more.save()
          }}
        />
      </ThemeProvider>
    )
  })
  await settle()
  await act(async () => {
    fake.socket().open()
  })
  const pointer = async (type: 'pointerdown' | 'pointerup'): Promise<void> => {
    await act(async () => {
      node('Dictation')!.dispatchEvent(
        new window.MouseEvent(type, { bubbles: true })
      )
    })
  }
  return {
    fake,
    saved,
    say: async (transcript, roster, actions = []) => {
      await pointer('pointerdown')
      const start = fake.socket().frames.at(-1)!
      expect(start.kind).equals('start')
      await act(async () => {
        fake.socket().reply({ kind: 'transcript', id: start.id, text: '…' })
      })
      await pointer('pointerup')
      await act(async () => {
        fake.socket().reply({
          kind: 'actions',
          id: start.id,
          transcript,
          actions,
          roster,
          dropped: []
        })
      })
    }
  }
}

describe('dictation on the roster screen', function () {
  const state = fresh()
  const away = state.session.liveData.boxscore.teams.away
  const home = state.session.liveData.boxscore.teams.home
  const said = (id: number): string =>
    shortName(state.session.gameData.players[id])

  it('persists a named creation handed over from the scoring screen exactly once', async () => {
    const { saved } = await mount(state, {
      pending: [
        { type: 'addPlayer', side: 'home', name: 'Ohtani', jersey: '17' }
      ]
    })
    await settle()
    await act(async () => {
      node('Save Rosters')!.click()
    })
    const named = Object.values(saved[0].draft.gameData.players).filter(
      player => player.firstName === 'Ohtani'
    )
    expect(named).length(1)
    expect(named[0]).includes({ id: 7001, local: false })
  })

  it('reuses successful player creations when retrying a failed dictated sentence', async () => {
    let fail = true
    const created: string[] = []
    const { say, saved } = await mount(state, {
      create: async (_teamId, player) => {
        if (player.firstName === 'Aaron' && fail) {
          fail = false
          throw new Error('Temporary roster failure')
        }
        created.push(player.firstName)
        return asRosterEntry({
          userId: userIdOfGumbo(7000 + created.length),
          gumboId: 7000 + created.length,
          shortName: player.firstName,
          jersey: player.jersey,
          isPlayer: true,
          role: 'member',
          section: 'player',
          staffRoles: [],
          inheritedFrom: null,
          positions: [],
          bats: 'right',
          throws: 'right'
        })
      }
    })
    const commands: SaidRosterCommand[] = [
      { type: 'addPlayer', side: 'home', name: 'Shohei Ohtani', jersey: '17' },
      { type: 'addPlayer', side: 'home', name: 'Aaron Judge', jersey: '99' }
    ]
    await say('Create Shohei Ohtani and Aaron Judge', commands)
    expect(document.body.textContent).includes('Temporary roster failure')
    await say('Create Shohei Ohtani and Aaron Judge', commands)
    expect(created).deep.equals(['Shohei', 'Aaron'])
    await act(async () => {
      node('Save Rosters')!.click()
    })
    expect(
      Object.values(saved[0].draft.gameData.players).filter(player =>
        [7001, 7002].includes(player.id)
      )
    ).length(2)
  })

  it('keeps an explicitly dictated placeholder game-only', async () => {
    const { say, saved } = await mount(state)
    await say('Create a placeholder named Ohtani', [
      { type: 'addPlayer', side: 'home', name: 'Ohtani', placeholder: true }
    ])
    await act(async () => {
      node('Save Rosters')!.click()
    })
    expect(
      Object.values(saved[0].draft.gameData.players).find(
        player => player.firstName === 'Ohtani'
      )
    ).includes({ id: 9000000, local: true })
  })

  for (const failure of [new Error('Roster save refused'), 'offline'])
    it(`reports a failed dictated roster creation without staging a player (${typeof failure})`, async () => {
      const { say, saved } = await mount(state, { createFailure: failure })
      await say('Create Ohtani', [
        { type: 'addPlayer', side: 'home', name: 'Ohtani' }
      ])
      expect(document.body.textContent).includes(
        failure instanceof Error
          ? failure.message
          : 'Unable to create the player. Please try again.'
      )
      expect(saved).length(0)
      expect(node('Dictation')!.getAttribute('aria-disabled')).not.equals(
        'true'
      )
    })

  it('starts on, in the roster scope, telling the model both rosters', async function () {
    const { fake } = await mount(state)
    // Handed over on: no tap was needed.
    expect(node('Dictation')!.getAttribute('aria-pressed')).equals('true')
    expect(node('Dictation status')!.textContent).equals('Push to talk')
    await act(async () => {
      node('Dictation')!.dispatchEvent(
        new window.MouseEvent('pointerdown', { bubbles: true })
      )
    })
    const start = fake.socket().frames.at(-1)!
    expect(start).deep.include({
      kind: 'start',
      scope: 'roster',
      target: { gameId: 'g1' },
      model: 'claude-haiku-5-5',
      context: rosterDictationContext(state.session, state.session, [
        'away',
        'home'
      ])
    })
    expect(start.context).includes('The game has not begun.')
    expect(start.context).includes('AWAY — Owls')
    expect(start.context).includes('HOME — Hawks')
  })

  it('stages a defense on Defense, a lineup on Lineup and a new player on Roster, on the team said', async function () {
    const { say, saved } = await mount(state)
    expect(selected('Roster')).equals(true)
    expect(selected('Away Team')).equals(true)
    expect(saveDisabled()).equals(true)

    await say('The Hawks’ number 1 at short and number 5 pitches', [
      {
        type: 'setPositions',
        side: 'home',
        places: [
          { player: { jersey: '1' }, position: 'SS' },
          { player: { jersey: '5' }, position: 'P' }
        ]
      }
    ])
    expect(selected('Defense')).equals(true)
    expect(selected('Home Team')).equals(true)
    expect(
      document.body.querySelector('[data-roster-target="defense-SS"]')!
        .textContent
    ).includes(state.session.gameData.players[home.battingOrder[0]].fullName)
    expect(saveDisabled()).equals(false)
    expect(chat('Roster chat said').at(-1)).equals(
      'The Hawks’ number 1 at short and number 5 pitches'
    )
    expect(chat('Roster chat line')).deep.equals([
      `${said(home.battingOrder[0])} to SS`,
      `${said(home.battingOrder[4])} to P`
    ])

    await say('Put the Owls’ number 1 fourth', [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [{ player: { jersey: '1' }, slot: 4 }]
      }
    ])
    expect(selected('Lineup')).equals(true)
    expect(selected('Away Team')).equals(true)
    expect(
      document.body.querySelector('[data-roster-target="lineup-3"]')!
        .textContent
    ).includes(
      `4. #1 ${state.session.gameData.players[away.battingOrder[0]].fullName}`
    )

    await say('Add Ohtani wearing 17', [
      { type: 'addPlayer', side: 'home', name: 'Ohtani', jersey: '17' }
    ])
    expect(selected('Roster')).equals(true)
    expect(selected('Home Team')).equals(true)
    expect(document.body.textContent).includes('Ohtani')
    // The turns stay, oldest first.
    expect(chat('Roster chat said')).deep.equals([
      'The Hawks’ number 1 at short and number 5 pitches',
      'Put the Owls’ number 1 fourth',
      'Add Ohtani wearing 17'
    ])
    expect(chat('Roster chat line').at(-1)).equals(
      'Ohtani #17 added to the roster'
    )
    await act(async () => {
      node('Save Rosters')!.click()
    })
    expect(
      Object.values(saved[0].draft.gameData.players).find(
        player => player.id === 7001
      )
    ).includes({ local: false, firstName: 'Ohtani' })
  })

  it('refuses a sentence of two kinds, and a play, staging nothing', async function () {
    const { say } = await mount(state)
    await say('Put the Owls’ 2 leadoff and their 3 at short', [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [{ player: { jersey: '2' }, slot: 1 }]
      },
      {
        type: 'setPositions',
        side: 'away',
        places: [{ player: { jersey: '3' }, position: 'SS' }]
      }
    ])
    expect(chat('Roster chat problem')).deep.equals([ONE_CATEGORY_AT_A_TIME])
    expect(selected('Roster')).equals(true)
    expect(saveDisabled()).equals(true)
    await say('Ball one', [], [{ type: 'pitch', call: 'B' }])
    expect(chat('Roster chat problem').at(-1)).equals(
      'That is a play — score it on the scoring screen'
    )
    expect(saveDisabled()).equals(true)
  })

  it('names a coach’s side in the target and the context, finds his players on it, and refuses a pinch hitter for the other team', async function () {
    const { fake, say } = await mount(state, { audience: 'coach' })
    // Whatever team is said, a coach's number 1 is his own.
    await say('Put the Owls’ number 1 fourth', [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [{ player: { jersey: '1' }, slot: 4 }]
      }
    ])
    const start = fake.socket().frames.find(frame => frame.kind === 'start')!
    expect(start.target).deep.equals({ gameId: 'g1', side: 'home' })
    expect(start.context).includes('HOME — Hawks')
    expect(start.context).not.includes('AWAY — Owls')
    expect(chat('Roster chat line')).deep.equals([
      `${said(home.battingOrder[0])} to 4th in the lineup`
    ])
    expect(saveDisabled()).equals(false)
    // The Owls are at bat before the game: a pinch hitter would be theirs.
    await say('Number 2 pinch hits', [
      { type: 'pinchHitter', player: { jersey: '2' } }
    ])
    expect(chat('Roster chat problem')).deep.equals([
      'Only the Hawks roster changes here'
    ])
  })

  it('keeps the chat while a save is out and over one refused, and closes it once saved', async function () {
    let answer = (_saved: boolean): void => undefined
    const { say, saved } = await mount(state, {
      save: async () => {
        await new Promise<void>((resolve, reject) => {
          answer = ok => {
            if (ok) resolve()
            else reject(new Error('Finish the current play first'))
          }
        })
      }
    })
    await say('The Hawks’ number 1 at short', [
      {
        type: 'setPositions',
        side: 'home',
        places: [{ player: { jersey: '1' }, position: 'SS' }]
      }
    ])
    const lines = chat('Roster chat line')
    expect(lines[0]).match(/ to SS$/)
    await act(async () => {
      node('Save Rosters')!.click()
    })
    expect(saved).has.length(1)
    expect(chat('Roster chat line')).deep.equals(lines)
    // Refused: what was staged and said is still there to read.
    await act(async () => {
      answer(false)
    })
    await settle()
    expect(chat('Roster chat line')).deep.equals(lines)
    await act(async () => {
      node('Save Rosters')!.click()
    })
    await act(async () => {
      answer(true)
    })
    await settle()
    expect(node('Dictation chat')).equals(null)
  })

  it('stages a pinch hitter and a pinch runner once the game has begun, and saves them', async function () {
    // A single: its batter is on first, and the next at-bat is due.
    let live = completeMotions(
      scoringReducer(fresh(), {
        type: 'DICTATED',
        transcript: 'single to center',
        actions: [
          { type: 'ballInPlay', contact: 'swing', fielder: 17 },
          { type: 'result', eventType: 'single' }
        ]
      })
    )
    live = completeMotions(scoringReducer(live, { type: 'CLOSE_PLAY' }))
    const added = copyState(live.session)
    const bench = 99
    added.gameData.players[bench] = {
      ...added.gameData.players[away.battingOrder[0]],
      id: bench,
      fullName: 'Betts',
      firstName: 'Betts',
      lastName: '',
      jersey: '50'
    }
    added.liveData.boxscore.teams.away.players.push(bench)
    live = { ...live, session: added }
    const runner = live.session.liveData.linescore.offense.first!.id
    const { fake, say, saved } = await mount(live)
    await say('Betts runs for the runner on first', [
      { type: 'pinchRunner', player: { name: 'betts' }, base: '1B' }
    ])
    const start = fake.socket().frames.find(frame => frame.kind === 'start')!
    expect(start.context).includes(promptContext(upcoming(live.session).state))
    expect(chat('Roster chat line')).deep.equals([
      `Betts runs for ${shortName(live.session.gameData.players[runner])}`
    ])
    expect(selected('Lineup')).equals(true)
    expect(saveDisabled()).equals(false)
    await act(async () => {
      node('Save Rosters')!.click()
    })
    expect(saved).has.length(1)
    expect(saved[0].runners).deep.equals([{ base: '1B', player: bench }])
    // The chat closes with the save.
    expect(node('Dictation chat')).equals(null)
  })

  it('opens with the turn said on the scoring screen, and adds the next under it', async function () {
    const { say } = await mount(state, {
      chat: [
        {
          key: 0,
          said: 'Number 10 subs in at third base',
          lines: [{ kind: 'done', text: 'Soto to 3B' }]
        }
      ]
    })
    expect(chat('Roster chat said')).deep.equals([
      'Number 10 subs in at third base'
    ])
    expect(chat('Roster chat line')).deep.equals(['Soto to 3B'])
    await say('Put the Owls’ number 1 fourth', [
      {
        type: 'placeInLineup',
        side: 'away',
        places: [{ player: { jersey: '1' }, slot: 4 }]
      }
    ])
    expect(chat('Roster chat said')).deep.equals([
      'Number 10 subs in at third base',
      'Put the Owls’ number 1 fourth'
    ])
    expect(chat('Roster chat line')).has.length(2)
  })

  /** The options of the question in the chat. */
  const options = (): string[] =>
    [
      ...document.body.querySelectorAll(
        '[data-testid="Roster chat"] [aria-label="Dictation question"] [role="button"]'
      )
    ].map(each => String(each.getAttribute('aria-label')))

  it('asks in the chat which player a number both teams wear means, stages nothing until he is chosen, then stages him', async function () {
    const { say } = await mount(state)
    await say('Number 3 plays third base', [
      {
        type: 'setPositions',
        places: [{ player: { jersey: '3' }, position: '3B' }]
      }
    ])
    expect(document.body.textContent).includes('Which #3?')
    const both = options()
    expect(both.slice(0, 2)).deep.equals([
      `${said(away.battingOrder[2])} #3, Owls`,
      `${said(home.battingOrder[2])} #3, Hawks`
    ])
    expect(selected('Roster')).equals(true)
    expect(saveDisabled()).equals(true)
    await act(async () => {
      node(both[1])!.click()
    })
    expect(node('Dictation question')).equals(null)
    expect(selected('Defense')).equals(true)
    expect(selected('Home Team')).equals(true)
    expect(saveDisabled()).equals(false)
    // The answer is a line of the turn it was asked about.
    expect(chat('Roster chat said')).deep.equals(['Number 3 plays third base'])
    expect(chat('Roster chat line')).deep.equals([
      `${said(home.battingOrder[2])} to 3B`,
      `${said(home.battingOrder[5])} off the field`
    ])
  })

  it('drops a question when it is dismissed or another sentence is said, and refuses a player nobody is', async function () {
    const { say } = await mount(state)
    const third = {
      type: 'setPositions' as const,
      places: [{ player: { jersey: '3' }, position: '1B' as const }]
    }
    await say('Number 3 plays first base', [third])
    expect(node('Dictation question')).not.equals(null)
    await act(async () => {
      node('Dismiss question')!.click()
    })
    expect(node('Dictation question')).equals(null)
    await say('Number 3 plays first base', [third])
    expect(node('Dictation question')).not.equals(null)
    await say('Number 42 plays first base', [
      { ...third, places: [{ player: { jersey: '42' }, position: '1B' }] }
    ])
    expect(node('Dictation question')).equals(null)
    expect(chat('Roster chat problem')).deep.equals([
      'No #42 on the Owls or the Hawks'
    ])
    expect(saveDisabled()).equals(true)
  })

  it('shows a question the model asks in the chat, and sends the answer or the dismissal back', async function () {
    const { fake } = await mount(state)
    const ask = async (): Promise<string> => {
      await act(async () => {
        node('Dictation')!.dispatchEvent(
          new window.MouseEvent('pointerdown', { bubbles: true })
        )
      })
      const start = fake.socket().frames.at(-1)!
      await act(async () => {
        node('Dictation')!.dispatchEvent(
          new window.MouseEvent('pointerup', { bubbles: true })
        )
      })
      await act(async () => {
        fake.socket().reply({
          kind: 'ask',
          id: start.id,
          question: 'Which lineup?',
          options: [{ label: 'The first' }, { label: 'The second' }]
        })
      })
      return start.id
    }
    const id = await ask()
    expect(options().slice(0, 2)).deep.equals(['The first', 'The second'])
    await act(async () => {
      node('The second')!.click()
    })
    expect(fake.socket().frames.at(-1)).deep.equals({
      kind: 'answer',
      id,
      option: 1
    })
    const again = await ask()
    await act(async () => {
      node('Dismiss question')!.click()
    })
    expect(fake.socket().frames.at(-1)).deep.equals({
      kind: 'dismiss',
      id: again
    })
  })

  it('opens asking the question of a substitution said on the scoring screen, and answers it under that turn', async function () {
    const question: RosterQuestion = {
      question: 'Which #3?',
      options: [
        {
          label: 'Owls #3',
          side: 'away',
          commands: [
            {
              type: 'setPositions',
              side: 'away',
              places: [{ player: away.battingOrder[2], position: '3B' }]
            }
          ]
        },
        {
          label: 'Hawks #3',
          side: 'home',
          commands: [
            {
              type: 'setPositions',
              side: 'home',
              places: [{ player: home.battingOrder[2], position: '3B' }]
            }
          ]
        }
      ]
    }
    await mount(state, {
      chat: [{ key: 0, said: 'Number 3 subs in at third base', lines: [] }],
      question
    })
    expect(options().slice(0, 2)).deep.equals(['Owls #3', 'Hawks #3'])
    await act(async () => {
      node('Hawks #3')!.click()
    })
    expect(selected('Defense')).equals(true)
    expect(selected('Home Team')).equals(true)
    expect(chat('Roster chat said')).deep.equals([
      'Number 3 subs in at third base'
    ])
    expect(chat('Roster chat line')[0]).equals(
      `${said(home.battingOrder[2])} to 3B`
    )
  })

  it('tells the model the rosters of the draft, after the game line once begun', function () {
    const draft = copyState(state.session)
    draft.liveData.boxscore.teams.home.battingOrder.reverse()
    expect(rosterDictationContext(state.session, draft, ['home'])).equals(
      `The game has not begun.\nROSTERS\n${rosterPrompt(draft, ['home'])}`
    )
  })
})

describe('the scoring screen’s microphone, handed to the roster sheet', function () {
  /** The screen's control and, while the sheet is open, the sheet's. */
  function Screen(props: {
    fake: FakeDictation
    open: boolean
    seen: { screen: boolean[]; sheet: boolean[] }
  }): React.ReactElement {
    const { fake, open, seen } = props
    const common = {
      health: dictatingHealth,
      url: 'ws://host/api/v1/dictation',
      gameId: 'g1',
      session: fresh().session,
      log: [],
      onActions: () => undefined,
      tapMs: 0,
      tailMs: 0,
      openSocket: fake.openSocket,
      openMicrophone: fake.openMicrophone
    }
    const screen = useDictationControls({ ...common, suspended: open })
    const startEnabled = useDictationHandover(open, screen)
    seen.screen.push(screen.enabled)
    return (
      <>
        {screen.control}
        {open && (
          <Sheet common={common} startEnabled={startEnabled} seen={seen} />
        )}
      </>
    )
  }
  function Sheet(props: {
    common: Parameters<typeof useDictationControls>[0]
    startEnabled: boolean
    seen: { sheet: boolean[] }
  }): React.ReactElement {
    const sheet = useDictationControls({
      ...props.common,
      shape: 'round',
      startEnabled: props.startEnabled
    })
    props.seen.sheet.push(sheet.enabled)
    return <>{sheet.control}</>
  }
  const render = async (
    fake: FakeDictation,
    open: boolean,
    seen: { screen: boolean[]; sheet: boolean[] }
  ): Promise<void> => {
    if (root == null) {
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
    }
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <Screen fake={fake} open={open} seen={seen} />
        </ThemeProvider>
      )
    })
    await settle()
  }
  const tapScreen = async (): Promise<void> => {
    const button = node('Dictation')!
    for (const type of ['pointerdown', 'pointerup'])
      await act(async () => {
        button.dispatchEvent(new window.MouseEvent(type, { bubbles: true }))
      })
  }

  it('suspends the screen’s while the sheet is open, starts the sheet’s on, and gives it back on', async function () {
    const fake = fakeDictation()
    const seen = { screen: [] as boolean[], sheet: [] as boolean[] }
    await render(fake, false, seen)
    await tapScreen()
    expect(seen.screen.at(-1)).equals(true)
    const screenSocket = fake.socket()
    await render(fake, true, seen)
    expect(seen.screen.at(-1)).equals(false)
    expect(screenSocket.closed).equals(true)
    expect(seen.sheet.at(-1)).equals(true)
    expect(fake.sockets).has.length(2)
    // Closed, by Save or Cancel alike: the screen's is on again.
    await render(fake, false, seen)
    expect(seen.screen.at(-1)).equals(true)
    expect(fake.sockets).has.length(3)
    expect(fake.sockets[1].closed).equals(true)
  })

  it('leaves both off when the screen’s was off as the sheet opened', async function () {
    const fake = fakeDictation()
    const seen = { screen: [] as boolean[], sheet: [] as boolean[] }
    await render(fake, false, seen)
    await render(fake, true, seen)
    expect(seen.sheet.at(-1)).equals(false)
    await render(fake, false, seen)
    expect(seen.screen.at(-1)).equals(false)
    expect(fake.sockets).has.length(0)
  })
})

describe('a substitution said on the scoring screen', function () {
  const NativeSocket = globalThis.WebSocket
  const devices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const getContext = HTMLCanvasElement.prototype.getContext
  let sockets: FakeDictationSocket[] = []
  beforeEach(function () {
    sockets = []
    globalThis.WebSocket = class extends FakeDictationSocket {
      constructor(url: string) {
        super(url)
        sockets.push(this)
      }
    } as unknown as typeof WebSocket
    // A microphone that never opens: the sentences come from the server.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => await new Promise(() => {}) }
    })
    HTMLCanvasElement.prototype.getContext = () => null
  })
  afterEach(function () {
    globalThis.WebSocket = NativeSocket
    if (devices == null)
      delete (navigator as { mediaDevices?: unknown }).mediaDevices
    else Object.defineProperty(navigator, 'mediaDevices', devices)
    HTMLCanvasElement.prototype.getContext = getContext
  })
  const wait = async (ms: number): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  }
  const press = async (type: 'pointerdown' | 'pointerup'): Promise<void> => {
    await act(async () => {
      node('Dictation')!.dispatchEvent(
        new window.MouseEvent(type, { bubbles: true })
      )
    })
  }

  /** The scoring screen over a saved game, its microphone on. */
  async function scoring(): Promise<{
    say: (
      transcript: string,
      roster: SaidRosterCommand[],
      actions?: ScoringAction[]
    ) => Promise<void>
  }> {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => gameFixture
    client.roster = async () => []
    client.health = dictatingHealth
    const store = memoryStore()
    const source: ScoringSource = {
      persistent: true,
      open: async game =>
        GameSession.start(store, game.id, scoringSession(game))
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
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
    await wait(10)
    if (node('OK') != null)
      await act(async () => {
        node('OK')!.click()
      })
    // A tap switches it on.
    await press('pointerdown')
    await press('pointerup')
    await wait(10)
    await act(async () => {
      sockets.at(-1)!.open()
    })
    return {
      say: async (transcript, roster, actions = []) => {
        // Held past a tap, it talks.
        await press('pointerdown')
        await wait(350)
        const start = sockets.at(-1)!.frames.at(-1)!
        expect(start.kind).equals('start')
        await press('pointerup')
        await act(async () => {
          sockets.at(-1)!.reply({
            kind: 'actions',
            id: start.id,
            transcript,
            actions,
            roster,
            dropped: []
          })
        })
        await wait(10)
      }
    }
  }
  it('opens the roster sheet on the change, staged, with the chat showing it', async function () {
    const { say } = await scoring()
    expect(node('Save Rosters')).equals(null)
    await say('The Hawks’ number 1 subs in at short', [
      {
        type: 'setPositions',
        side: 'home',
        places: [{ player: { jersey: '1' }, position: 'SS' }]
      }
    ])
    expect(node('Save Rosters')).not.equals(null)
    expect(selected('Defense')).equals(true)
    expect(selected('Home Team')).equals(true)
    expect(saveDisabled()).equals(false)
    expect(chat('Roster chat said')).deep.equals([
      'The Hawks’ number 1 subs in at short'
    ])
    expect(chat('Roster chat line')[0]).match(/ to SS$/)
    // The sheet has the microphone now, on as the screen's was, and gives
    // it back on when it closes.
    expect(
      document.body
        .querySelector('[data-testid="Roster mic"] [aria-label="Dictation"]')!
        .getAttribute('aria-pressed')
    ).equals('true')
    await act(async () => {
      node('Cancel')!.click()
    })
    await wait(10)
    expect(node('Save Rosters')).equals(null)
    expect(node('Dictation')!.getAttribute('aria-pressed')).equals('true')
  })

  it('refuses a play and a substitution together, and a change that does not apply, in the log', async function () {
    const { say } = await scoring()
    await say(
      'Ball one, and the Hawks’ number 1 subs in at short',
      [
        {
          type: 'setPositions',
          side: 'home',
          places: [{ player: { jersey: '1' }, position: 'SS' }]
        }
      ],
      [{ type: 'pitch', call: 'B' }]
    )
    expect(node('Dictation message')!.textContent).equals(
      'Say a substitution separately from a play'
    )
    expect(document.body.textContent).includes('0 balls 0 strikes')
    expect(node('Save Rosters')).equals(null)
    await say('Number 1 pinch hits', [
      { type: 'pinchHitter', player: { jersey: '1', name: 'Player 1' } }
    ])
    expect(node('Dictation message')!.textContent).equals(
      'Pinch hitters only once the game has begun'
    )
    expect(node('Save Rosters')).equals(null)
    await say('Number 42 subs in at short', [
      {
        type: 'setPositions',
        places: [{ player: { jersey: '42' }, position: 'SS' }]
      }
    ])
    expect(node('Dictation message')!.textContent).equals(
      'No #42 on the Owls or the Hawks'
    )
    expect(node('Save Rosters')).equals(null)
  })

  it('opens the sheet asking which player when one said fits two, and stages the one chosen', async function () {
    const { say } = await scoring()
    await say('Number 1 subs in at short', [
      {
        type: 'setPositions',
        places: [{ player: { jersey: '1' }, position: 'SS' }]
      }
    ])
    expect(node('Save Rosters')).not.equals(null)
    expect(selected('Defense')).equals(true)
    // Nothing is staged yet, but the game has recorded nothing: its lineups
    // wait to be accepted, so Save is lit already.
    expect(saveDisabled()).equals(false)
    expect(chat('Roster chat said')).deep.equals(['Number 1 subs in at short'])
    expect(document.body.textContent).includes('Which #1?')
    const hawks = [
      ...document.body.querySelectorAll(
        '[data-testid="Roster chat"] [aria-label="Dictation question"] [role="button"]'
      )
    ]
      .map(each => String(each.getAttribute('aria-label')))
      .find(label => label.endsWith(', Hawks'))!
    await act(async () => {
      node(hawks)!.click()
    })
    expect(selected('Home Team')).equals(true)
    expect(saveDisabled()).equals(false)
    expect(chat('Roster chat line')[0]).match(/ to SS$/)
    await act(async () => {
      node('Cancel')!.click()
    })
    await wait(10)
    expect(node('Save Rosters')).equals(null)
  })
})
