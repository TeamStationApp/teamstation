import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  correctedGame,
  finalGame,
  importedThenScoredGame,
  inProgressGame,
  MemoryStore,
  rallyGame,
  REPLAY_TEAMS,
  replayContext,
  replaySetup
} from '../../test/replayGameFixture'
import { game, TEAMS } from '../../test/scoringGames'
import {
  expectNamesRoundTrip,
  withoutHalves
} from '../../test/storedNamesRoundTrip'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import type { EventSaid } from './document'
import { newSetup } from './lineup'
import { ScoringSession, type SessionContext, type StoredGame } from './session'
import { setupOf } from './state'
import {
  creditLabel,
  eventSaid,
  namesIn,
  saidFromDescription,
  storedForm,
  structuredCredit,
  withNames,
  withoutNames,
  withStructuredCredits
} from './storedNames'

type Json = Record<string, unknown>
interface Event extends Json {
  index: number
  details: Json & { description?: string; eventType?: string }
  said?: EventSaid
}

const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const pitch = (call: 'B' | 'C' | 'S' | 'F'): ScoringAction => ({
  type: 'pitch',
  call
})
const fourBalls = [pitch('B'), pitch('B'), pitch('B'), pitch('B'), close]
const endHalf: ScoringAction = { type: 'gameFlow', kind: 'endHalf' }

// The replay fixture's players: the visitors bat in this order, then the
// bench; the home side fields Betts at short, Smith behind the plate and
// Glasnow on the mound.
const SOTO = 9101
const JUDGE = 9102
const TORRES = 9104
const VOLPE = 9105
const GARCIA = 9106
const STANTON = 9110
const GIL = 9111
const BETTS = 9201
const SMITH = 9204
const GLASNOW = 9209
const PHILLIPS = 9210

/** Scores the actions through a session and returns what the server holds. */
async function scoredWith(
  actions: readonly ScoringAction[],
  context: SessionContext = replayContext()
): Promise<StoredGame> {
  const store = new MemoryStore()
  const session = await ScoringSession.open(store, context.gamePk, context, {
    now: () => new Date('2026-09-26T17:00:00Z'),
    setTimer: () => null,
    clearTimer: () => undefined
  })
  for (const [index, action] of actions.entries()) {
    const applied = session.apply(action)
    if (applied.problems.length > 0)
      throw new Error(
        `action ${index} ${JSON.stringify(action)}: ${applied.problems[0].message}`
      )
  }
  await session.flush()
  return store.stored()
}

function documentsOf(game: StoredGame): Array<GumboPlay | CurrentPlay> {
  return [
    ...game.plays,
    ...(game.currentPlay == null ? [] : [game.currentPlay])
  ]
}

function eventsOf(play: unknown): Event[] {
  return (play as { playEvents?: Event[] }).playEvents ?? []
}

/** Every event of the game of this type, with the play it is in. */
function eventsOfType(
  stored: StoredGame,
  eventType: string
): Array<{ play: Json; event: Event }> {
  return documentsOf(stored).flatMap(play =>
    eventsOf(play)
      .filter(event => event.details.eventType === eventType)
      .map(event => ({ play, event }))
  )
}

/** The one event of the game of this type. */
function onlyEvent(
  stored: StoredGame,
  eventType: string
): { play: Json; event: Event } {
  const found = eventsOfType(stored, eventType)
  expect(found, eventType).to.have.length(1)
  return found[0]
}

/** The play with every event's `said` taken off, as a build before it posts. */
function withoutSaid<T>(play: T): T {
  const copy = JSON.parse(JSON.stringify(play)) as Json
  for (const event of eventsOf(copy)) delete event.said
  return copy as T
}

/** The play with labels only on its credits, as one stored before M1. */
function labelsOnly<T>(play: T): T {
  const copy = JSON.parse(JSON.stringify(play)) as Json
  for (const credit of (copy.credits ?? []) as Json[]) {
    delete credit.head
    delete credit.assists
    delete credit.assistWord
  }
  return copy as T
}

/** Each sentence and credit label a named play reads. */
function readings(play: unknown): string[] {
  const json = play as Json
  return [
    ...eventsOf(json).map(event => String(event.details.description)),
    ...((json.credits ?? []) as Json[]).map(credit => String(credit.label))
  ]
}

const halfInningActions = (): ScoringAction[] =>
  JSON.parse(
    readFileSync('src/common/scoring/fixtures/halfInning.actions.json', 'utf8')
  ) as ScoringAction[]

const situationActions = (): ScoringAction[] =>
  (
    JSON.parse(
      readFileSync(
        'src/common/scoring/fixtures/scoreboardSituations.actions.json',
        'utf8'
      )
    ) as Array<ScoringAction | { point: string }>
  ).filter((entry): entry is ScoringAction => 'type' in entry)

function situationsContext(): SessionContext {
  const teams = {
    away: { id: 'away', name: 'Away', logoUrl: null },
    home: { id: 'home', name: 'Home', logoUrl: null }
  }
  const roster = (
    start: number,
    side: string
  ): Array<{ gumboId: number; shortName: string }> =>
    Array.from({ length: 9 }, (_, i) => ({
      gumboId: start + i,
      shortName: `${side} ${i + 1}`
    }))
  return {
    gamePk: 'gam_situations',
    teams,
    setup: newSetup(teams, {
      away: roster(1, 'Away'),
      home: roster(10, 'Home')
    })
  }
}

/**
 * Games with every kind of sentence the engine words: substitutions of each
 * kind, a courtesy runner, and actions naming the pitcher, the catcher, the
 * batter and a runner, with other runners moving.
 */
const SCENARIOS: Record<string, ScoringAction[]> = {
  // Phillips relieves Glasnow after a wild pitch moves two runners up, then
  // walks Rizzo; a balk follows.
  pitchingChange: [
    ...fourBalls,
    ...fourBalls,
    pitch('B'),
    {
      type: 'batteryEvent',
      kind: 'wild_pitch',
      advances: [
        { runner: SOTO, to: '3B' },
        { runner: JUDGE, to: '2B' }
      ]
    },
    {
      type: 'lineup',
      kind: 'substitute',
      side: 'home',
      player: PHILLIPS,
      replaces: GLASNOW,
      position: 'P'
    },
    pitch('B'),
    pitch('B'),
    pitch('B'),
    close,
    { type: 'batteryEvent', kind: 'balk' }
  ],
  // Stanton pinch-hits for Soto and stays in, in left; Gil takes over in
  // left when the visitors next field.
  pinchHitter: [
    pitch('B'),
    {
      type: 'lineup',
      kind: 'substitute',
      side: 'away',
      player: STANTON,
      replaces: SOTO
    },
    pitch('B'),
    pitch('B'),
    pitch('B'),
    close,
    endHalf,
    {
      type: 'lineup',
      kind: 'substitute',
      side: 'away',
      player: GIL,
      replaces: STANTON
    },
    pitch('B')
  ],
  // Stanton runs for Soto while Judge strikes out, then Gil replaces him in
  // left.
  pinchRunner: [
    ...fourBalls,
    {
      type: 'lineup',
      kind: 'pinchRunner',
      side: 'away',
      player: STANTON,
      base: '1B'
    },
    pitch('S'),
    pitch('S'),
    pitch('S'),
    close,
    endHalf,
    {
      type: 'lineup',
      kind: 'substitute',
      side: 'away',
      player: GIL,
      replaces: STANTON
    },
    pitch('B')
  ],
  // Stanton hits for Soto and stays in, in left, as the visitors field.
  staysIn: [
    pitch('B'),
    {
      type: 'lineup',
      kind: 'substitute',
      side: 'away',
      player: STANTON,
      replaces: SOTO
    },
    pitch('B'),
    pitch('B'),
    pitch('B'),
    close,
    endHalf,
    pitch('B')
  ],
  // Betts moves from short to third; three visitors change places in the
  // order; Stanton runs for Soto as a courtesy runner; Soto steals, Judge is
  // walked intentionally, Smith lets a passed ball by, and Soto is caught.
  switchAndOrder: [
    pitch('B'),
    {
      type: 'lineup',
      kind: 'position',
      side: 'home',
      position: '3B',
      player: BETTS
    },
    {
      type: 'lineup',
      kind: 'battingOrder',
      side: 'away',
      order: [SOTO, JUDGE, 9103, VOLPE, GARCIA, TORRES, 9107, 9108, 9109]
    },
    pitch('B'),
    pitch('B'),
    pitch('B'),
    close,
    {
      type: 'lineup',
      kind: 'runner',
      side: 'away',
      player: STANTON,
      base: '1B'
    },
    { type: 'baseRunning', kind: 'steal', runner: STANTON, to: '2B' },
    { type: 'result', eventType: 'intent_walk' },
    close,
    pitch('B'),
    {
      type: 'batteryEvent',
      kind: 'passed_ball',
      advances: [
        { runner: STANTON, to: '3B' },
        { runner: JUDGE, to: '2B' }
      ]
    },
    {
      type: 'baseRunning',
      kind: 'caught_stealing',
      runner: JUDGE,
      to: '3B',
      fielders: [SMITH]
    }
  ]
}

/**
 * The home side, in the field, puts Phillips in Betts's place in its order,
 * where he waits to appear; moves Freeman ahead of him; then sends him to
 * short. The reorder names only Freeman, and Phillips comes in to field.
 */
function waitingFielder(): ScoringAction[] {
  const roster = (
    change: (setup: ReturnType<typeof replaySetup>) => void
  ): ScoringAction => {
    const setup = replaySetup()
    change(setup)
    return { type: 'lineup', kind: 'roster', setup }
  }
  const home = replaySetup().sides.home.battingOrder
  const waiting = [PHILLIPS, ...home.slice(1)]
  const reordered = [waiting[1], PHILLIPS, ...waiting.slice(2)]
  return [
    pitch('B'),
    roster(setup => {
      setup.sides.home.battingOrder = waiting
    }),
    pitch('B'),
    roster(setup => {
      setup.sides.home.battingOrder = reordered
    }),
    pitch('B'),
    roster(setup => {
      setup.sides.home.battingOrder = reordered
      setup.sides.home.defense.SS = PHILLIPS
    }),
    pitch('B')
  ]
}
SCENARIOS.waitingFielder = waitingFielder()

async function scenario(name: keyof typeof SCENARIOS): Promise<StoredGame> {
  return await scoredWith(SCENARIOS[name])
}

/** Every game the fixtures and the scenarios here build, by name. */
async function fixtureGames(): Promise<Array<[string, StoredGame]>> {
  const games: Array<[string, StoredGame]> = [
    ['final', await finalGame()],
    ['inProgress', await inProgressGame()],
    ['corrected', await correctedGame()],
    ['rally', await rallyGame()],
    ['importedThenScored', await importedThenScoredGame()],
    [
      'halfInning',
      await scoredWith(halfInningActions(), {
        gamePk: 'g1',
        teams: TEAMS,
        setup: setupOf(game())
      })
    ],
    ['situations', await scoredWith(situationActions(), situationsContext())]
  ]
  for (const name of Object.keys(SCENARIOS))
    games.push([name, await scenario(name)])
  return games
}

describe('stored and named forms of a game document', function () {
  describe('the round trip', function () {
    it('names every play the engine builds back from its stored form, which holds none of its names', async function () {
      for (const [name, stored] of await fixtureGames())
        for (const play of documentsOf(stored))
          expectNamesRoundTrip(play, `${name} play ${play.about.atBatIndex}`)
    })

    it('reads each sentence of every fixture game back from its words alone', async function () {
      let read = 0
      for (const [name, stored] of await fixtureGames())
        for (const play of documentsOf(stored)) {
          const old = withoutSaid(play)
          for (const [i, event] of eventsOf(play).entries()) {
            if (event.said == null) continue
            const found = saidFromDescription(old, eventsOf(old)[i])
            const at = `${name} ${play.about.atBatIndex}:${i}`
            expect(found?.reproduced, at).equals(true)
            expect(
              eventSaid(play, { ...event, said: found!.said }, namesIn(play)),
              at
            ).equals(event.details.description)
            read++
          }
          // A play from before sentences carried `said`, and credits their
          // structure, stores the same sentences and labels.
          const before = labelsOnly(old)
          const counted = storedForm(before)
          expect(counted.unreproduced).equals(0)
          expect(
            readings(withNames(counted.document, namesIn(play))),
            `${name} ${play.about.atBatIndex}`
          ).deep.equals(readings(play))
          const text = JSON.stringify(counted.document)
          for (const each of namesIn(play).values())
            expect(text).not.include(each)
        }
      expect(read).to.be.greaterThan(20)
    })
  })

  describe('each kind of sentence', function () {
    it('names the pitcher who comes in and the one he replaces', async function () {
      const { play, event } = onlyEvent(
        await scenario('pitchingChange'),
        'pitching_substitution'
      )
      expect(event.said).deep.equals({
        kind: 'pitching',
        player: PHILLIPS,
        replaced: GLASNOW
      })
      expect(event.details.description).equals(
        'Pitching Change: Evan Phillips replaces Tyler Glasnow.'
      )
      expect(eventSaid(play, event, namesIn(play))).equals(
        event.details.description
      )
      // One who comes in with nobody on the mound.
      const comes = { ...event, said: { kind: 'pitching', player: PHILLIPS } }
      expect(eventSaid(play, comes, namesIn(play))).equals(
        'Pitching Change: Evan Phillips comes in to pitch.'
      )
      expect(
        saidFromDescription(play, {
          ...comes,
          said: undefined,
          details: {
            ...event.details,
            description: 'Pitching Change: Evan Phillips comes in to pitch.'
          }
        })
      ).deep.equals({
        said: { kind: 'pitching', player: PHILLIPS },
        reproduced: true
      })
    })

    it('names the pitcher on the mound for a wild pitch and a balk, and the runners they moved', async function () {
      const stored = await scenario('pitchingChange')
      const wild = onlyEvent(stored, 'wild_pitch')
      expect(wild.event.said).deep.equals({
        kind: 'action',
        eventType: 'wild_pitch',
        lead: { player: GLASNOW, role: 'pitcher' }
      })
      expect(wild.event.details.description).equals(
        'Wild pitch by Tyler Glasnow. Juan Soto to 3rd. Aaron Judge to 2nd.'
      )
      // The matchup names the reliever, the sentence the man who threw it.
      expect((wild.play.matchup as Json).pitcher).deep.equals({
        id: PHILLIPS,
        fullName: 'Evan Phillips'
      })
      const balk = onlyEvent(stored, 'balk')
      expect(balk.event.said).deep.equals({
        kind: 'action',
        eventType: 'balk',
        lead: { player: PHILLIPS, role: 'pitcher' }
      })
      expect(balk.event.details.description).equals(
        'Balk by Evan Phillips. Anthony Rizzo to 2nd. Aaron Judge to 3rd. Juan Soto scores.'
      )
      for (const { play, event } of [wild, balk])
        expect(eventSaid(play, event, namesIn(play))).equals(
          event.details.description
        )
    })

    it('names a pinch hitter and a pinch runner, and who replaces each in the field', async function () {
      const hit = await scenario('pinchHitter')
      expect(onlyEvent(hit, 'offensive_substitution').event.said).deep.equals({
        kind: 'pinch',
        player: STANTON,
        replaced: SOTO,
        running: false
      })
      const fielded = onlyEvent(hit, 'defensive_substitution')
      expect(fielded.event.said).deep.equals({
        kind: 'defensive',
        player: GIL,
        replaced: STANTON,
        position: 'LF',
        pinch: 'PH'
      })
      expect(fielded.event.details.description).equals(
        'Defensive Substitution: Luis Gil replaces pinch-hitter Giancarlo Stanton, playing left field.'
      )
      const ran = await scenario('pinchRunner')
      const runner = onlyEvent(ran, 'offensive_substitution')
      expect(runner.event.said).deep.equals({
        kind: 'pinch',
        player: STANTON,
        replaced: SOTO,
        running: true
      })
      expect(runner.event.details.description).equals(
        'Offensive Substitution: Pinch-runner Giancarlo Stanton replaces Juan Soto.'
      )
      const replaced = onlyEvent(ran, 'defensive_substitution')
      expect(replaced.event.said).deep.include({ pinch: 'PR' })
      expect(replaced.event.details.description).equals(
        'Defensive Substitution: Luis Gil replaces pinch-runner Giancarlo Stanton, playing left field.'
      )
      for (const { play, event } of [
        onlyEvent(hit, 'offensive_substitution'),
        fielded,
        runner,
        replaced
      ])
        expect(eventSaid(play, event, namesIn(play))).equals(
          event.details.description
        )
      // With nobody replaced, each comes in.
      const names = namesIn(fielded.play)
      const said = (value: EventSaid): string | undefined =>
        eventSaid(fielded.play, { ...fielded.event, said: value }, names)
      expect(said({ kind: 'pinch', player: STANTON, running: false })).equals(
        'Offensive Substitution: Pinch-hitter Giancarlo Stanton comes in.'
      )
      expect(said({ kind: 'pinch', player: STANTON, running: true })).equals(
        'Offensive Substitution: Pinch-runner Giancarlo Stanton comes in.'
      )
      expect(said({ kind: 'defensive', player: GIL, position: 'CF' })).equals(
        'Defensive Substitution: Luis Gil comes in, playing center field.'
      )
      expect(
        said({ kind: 'defensive', player: GIL, replaced: SOTO, position: 'RF' })
      ).equals(
        'Defensive Substitution: Luis Gil replaces Juan Soto, playing right field.'
      )
      for (const sentence of [
        'Offensive Substitution: Pinch-hitter Giancarlo Stanton comes in.',
        'Offensive Substitution: Pinch-runner Giancarlo Stanton comes in.',
        'Defensive Substitution: Luis Gil comes in, playing center field.',
        'Defensive Substitution: Luis Gil replaces Juan Soto, playing right field.'
      ]) {
        const eventType = sentence.startsWith('Offensive')
          ? 'offensive_substitution'
          : 'defensive_substitution'
        const event = {
          ...fielded.event,
          said: undefined,
          details: {
            ...fielded.event.details,
            eventType,
            description: sentence
          }
        }
        const found = saidFromDescription(fielded.play, event)
        expect(found?.reproduced, sentence).equals(true)
        expect(said(found!.said)).equals(sentence)
      }
    })

    it('names a switch with and without where the player played before', async function () {
      const moved = onlyEvent(
        await scenario('switchAndOrder'),
        'defensive_switch'
      )
      expect(moved.event.said).deep.equals({
        kind: 'switch',
        player: BETTS,
        position: '3B',
        fromPosition: 'SS'
      })
      expect(moved.event.details.description).equals(
        'Defensive switch from shortstop to third base for Mookie Betts.'
      )
      const stays = onlyEvent(await scenario('staysIn'), 'defensive_switch')
      expect(stays.event.said).deep.equals({
        kind: 'switch',
        player: STANTON,
        position: 'LF'
      })
      expect(stays.event.details.description).equals(
        'Giancarlo Stanton remains in the game as the left fielder.'
      )
      for (const { play, event } of [moved, stays])
        expect(eventSaid(play, event, namesIn(play))).equals(
          event.details.description
        )
    })

    it('names each of three players a batting-order change moves', async function () {
      const { play, event } = onlyEvent(
        await scenario('switchAndOrder'),
        'ts_batting_order'
      )
      expect(event.said).deep.equals({
        kind: 'order',
        moved: [
          { player: VOLPE, bats: 4 },
          { player: GARCIA, bats: 5 },
          { player: TORRES, bats: 6 }
        ]
      })
      expect(event.details.description).equals(
        'Batting order change: Anthony Volpe bats 4th, Luis Garcia bats 5th, Gleyber Torres bats 6th.'
      )
      expect(eventSaid(play, event, namesIn(play))).equals(
        event.details.description
      )
    })

    it('names a courtesy runner and the man he runs for', async function () {
      const { play, event } = onlyEvent(
        await scenario('switchAndOrder'),
        'ts_courtesy_runner'
      )
      expect(event.said).deep.equals({
        kind: 'courtesy',
        player: STANTON,
        replaced: SOTO
      })
      expect(eventSaid(play, event, namesIn(play))).equals(
        'Pinch-runner Giancarlo Stanton runs for Juan Soto; the batting order is unchanged'
      )
    })

    it('names the runner of a steal and of an out, the batter of an award, and the catcher of a passed ball', async function () {
      const stored = await scenario('switchAndOrder')
      const cases: Array<[string, EventSaid, string]> = [
        [
          'stolen_base_2b',
          {
            kind: 'action',
            eventType: 'stolen_base_2b',
            lead: { player: STANTON, role: 'runner' }
          },
          'Giancarlo Stanton steals second.'
        ],
        [
          'intent_walk',
          {
            kind: 'action',
            eventType: 'intent_walk',
            lead: { player: JUDGE, role: 'batter' }
          },
          'Aaron Judge is walked intentionally.'
        ],
        [
          'passed_ball',
          {
            kind: 'action',
            eventType: 'passed_ball',
            lead: { player: SMITH, role: 'catcher' }
          },
          'Passed ball by Will Smith. Giancarlo Stanton to 3rd. Aaron Judge to 2nd.'
        ],
        [
          'caught_stealing_3b',
          {
            kind: 'action',
            eventType: 'caught_stealing_3b',
            lead: { player: JUDGE, role: 'runner' }
          },
          'Caught stealing third, Aaron Judge.'
        ]
      ]
      for (const [eventType, said, sentence] of cases) {
        const { play, event } = onlyEvent(stored, eventType)
        expect(event.said, eventType).deep.equals(said)
        expect(event.details.description, eventType).equals(sentence)
        expect(eventSaid(play, event, namesIn(play)), eventType).equals(
          sentence
        )
      }
      // A passed ball with no catcher names nobody first.
      const { play, event } = onlyEvent(stored, 'passed_ball')
      const nobody: EventSaid = { kind: 'action', eventType: 'passed_ball' }
      expect(eventSaid(play, { ...event, said: nobody }, namesIn(play))).equals(
        'Passed ball. Giancarlo Stanton to 3rd. Aaron Judge to 2nd.'
      )
      expect(
        saidFromDescription(play, {
          ...event,
          said: undefined,
          details: {
            ...event.details,
            description:
              'Passed ball. Giancarlo Stanton to 3rd. Aaron Judge to 2nd.'
          }
        })
      ).deep.equals({ said: nobody, reproduced: true })
    })
  })

  describe('credit labels', function () {
    const names = new Map([
      [1, 'Jordan P'],
      [2, 'Casey B'],
      [3, 'Luke T']
    ])
    const nameOf = (id: number): string | undefined => names.get(id)
    type Credit = Parameters<typeof creditLabel>[0]
    const credit = (fields: Json): Credit => {
      const made: Json = {
        eventType: 'field_out',
        teamId: 'home',
        creditUserId: 1,
        credit: { role: 'fielder', position: null },
        ...fields
      }
      return made as unknown as Credit
    }

    it('words every shape of credit', function () {
      expect(
        creditLabel(
          credit({ head: 'Pickoff at 1st', creditUserId: null, credit: null }),
          nameOf
        )
      ).equals('Pickoff at 1st')
      expect(creditLabel(credit({ head: 'Run' }), nameOf)).equals(
        'Run: Jordan P'
      )
      expect(
        creditLabel(
          credit({
            head: 'Fly out',
            credit: { role: 'fielder', position: 'LF' }
          }),
          nameOf
        )
      ).equals('Fly out: Jordan P (LF)')
      expect(
        creditLabel(credit({ head: 'Strikeout', suffix: ' pitching' }), nameOf)
      ).equals('Strikeout: Jordan P pitching')
      expect(
        creditLabel(
          credit({
            head: 'Out at 2nd',
            credit: { role: 'fielder', position: '2B' },
            assists: [
              { creditUserId: 2, position: 'SS' },
              { creditUserId: 3, position: '3B' }
            ],
            assistWord: 'from'
          }),
          nameOf
        )
      ).equals('Out at 2nd: Jordan P (2B) from Casey B (SS), Luke T (3B)')
      expect(
        creditLabel(
          credit({
            head: 'Double play',
            credit: { role: 'fielder', position: 'LF' },
            assists: [
              { creditUserId: 2, position: '2B' },
              { creditUserId: 3, position: '1B' }
            ],
            assistWord: 'to'
          }),
          nameOf
        )
      ).equals('Double play: Jordan P (LF) to Casey B (2B) to Luke T (1B)')
      // Typed names, for people with no id.
      expect(
        creditLabel(
          credit({
            head: 'Ground out',
            creditUserId: null,
            credit: { role: 'fielder', position: 'SS', name: 'Visiting SS' },
            assists: [{ creditUserId: null, position: '1B', name: 'Casey B' }],
            assistWord: 'to'
          }),
          nameOf
        )
      ).equals('Ground out: Visiting SS (SS) to Casey B (1B)')
      // An assist with no position is named alone.
      expect(
        creditLabel(
          credit({
            head: 'Out',
            assists: [{ creditUserId: 2, position: null }]
          }),
          nameOf
        )
      ).equals('Out: Jordan P from Casey B')
    })
  })

  describe("an outside scorer's credits", function () {
    const outside = (
      label: string,
      name: string | null,
      position: string | null = null,
      creditUserId: number | null = 7
    ): Json => ({
      eventType: 'field_out',
      label,
      teamId: 'home',
      creditUserId,
      credit: name == null ? null : { name, role: 'fielder', position }
    })
    const idOf = (name: string): number | undefined =>
      ({ 'Casey B': 2, 'Luke T': 3 })[name]

    it('reads every label shape it sends and words it again exactly', function () {
      const cases: Array<[Json, Json]> = [
        [
          outside('Strikeout: Ava M pitching', 'Ava M'),
          { head: 'Strikeout', suffix: ' pitching' }
        ],
        [
          outside(
            'Ground out: Jordan P (SS) to Casey B (1B)',
            'Jordan P',
            'SS'
          ),
          {
            head: 'Ground out',
            assists: [{ creditUserId: 2, position: '1B' }],
            assistWord: 'to'
          }
        ],
        [
          outside(
            'Double play: Jordan P (LF) to Casey B (2B) to Luke T (1B)',
            'Jordan P',
            'LF'
          ),
          {
            head: 'Double play',
            assists: [
              { creditUserId: 2, position: '2B' },
              { creditUserId: 3, position: '1B' }
            ],
            assistWord: 'to'
          }
        ],
        [
          outside('Caught stealing 2nd: Mia R (P)', 'Mia R', 'P'),
          { head: 'Caught stealing 2nd' }
        ],
        [
          outside('Pickoff at 1st', null, null, null),
          { head: 'Pickoff at 1st' }
        ],
        [outside('Run: Hunter P', 'Hunter P'), { head: 'Run' }]
      ]
      for (const [sent, want] of cases) {
        const stored = structuredCredit(sent, {
          idOf,
          names: ['Casey B', 'Luke T']
        }) as Json
        expect(stored, String(sent.label)).deep.include(want)
        expect(stored).not.have.property('label')
        if (sent.creditUserId != null)
          expect(stored.credit).not.have.property('name')
        const named = new Map([
          [7, (sent.credit as Json | null)?.name as string],
          [2, 'Casey B'],
          [3, 'Luke T']
        ])
        expect(
          creditLabel(stored as never, id => named.get(id)),
          String(sent.label)
        ).equals(sent.label)
      }
    })

    it('keeps a typed opponent and an assist it cannot name by id', function () {
      const stored = structuredCredit(
        outside(
          'Ground out: Visiting SS (SS) to Jordan Q (1B)',
          'Visiting SS',
          'SS',
          null
        ),
        { idOf }
      ) as Json
      expect(stored).deep.equals({
        eventType: 'field_out',
        teamId: 'home',
        creditUserId: null,
        credit: { name: 'Visiting SS', role: 'fielder', position: 'SS' },
        head: 'Ground out',
        assists: [{ creditUserId: null, position: '1B', name: 'Jordan Q' }],
        assistWord: 'to'
      })
      expect(creditLabel(stored as never, () => undefined)).equals(
        'Ground out: Visiting SS (SS) to Jordan Q (1B)'
      )
    })

    it('keeps the head and the person of a label it cannot word again', function () {
      for (const [label, name, position] of [
        ['Single: Jordan P on a soft liner', 'Mia R', null],
        ['Fly out: Jordan P', 'Jordan P', 'LF'],
        ['Run: Jordan P scores on Casey B', 'Jordan P', null],
        ['Pickoff at 1st', 'Jordan P', null]
      ] as Array<[string, string, string | null]>) {
        const stored = structuredCredit(outside(label, name, position), {
          idOf,
          names: ['Casey B']
        }) as Json
        expect(stored, label).deep.equals({
          eventType: 'field_out',
          teamId: 'home',
          creditUserId: 7,
          credit: { role: 'fielder', position },
          head: label.split(': ')[0]
        })
      }
    })

    it('leaves a credit with no label and no structure as it is', function () {
      const odd = { eventType: 'run', creditUserId: 3 }
      expect(structuredCredit(odd)).equals(odd)
      expect(structuredCredit('text')).equals('text')
    })

    it('names a fielder by the id the credit itself gives him there, and drops what it cannot word again', function () {
      const sent = {
        ...outside(
          'Ground out: Jordan P (SS) to Casey B (1B)',
          'Jordan P',
          'SS'
        ),
        // The sender's own assists: Casey at first by his id, a name at
        // another position, and things that are not assists.
        assists: [
          { name: 'Casey B', position: '2B', creditUserId: 8 },
          { name: 'Casey B', position: '1B', creditUserId: 9 },
          { name: 'Casey B', position: '1B' },
          'odd'
        ]
      }
      expect(structuredCredit(sent, { idOf })).deep.include({
        assists: [{ creditUserId: 9, position: '1B' }],
        assistWord: 'to'
      })
      // A label it cannot word again keeps none of the sender's structure.
      const unread = structuredCredit(
        {
          ...sent,
          label: 'Ground out: J. P (SS) to Casey B (1B)',
          suffix: ' sliding',
          assistWord: 'to'
        },
        { idOf }
      ) as Json
      expect(unread).not.have.property('assists')
      expect(unread).not.have.property('suffix')
      expect(unread).not.have.property('assistWord')
      expect(unread.head).equals('Ground out')
    })
  })

  describe('withStructuredCredits', function () {
    const play = (credits: unknown): Json => ({
      about: { atBatIndex: 0 },
      result: { eventType: 'field_out' },
      matchup: {
        batter: { id: 2, fullName: 'Casey B' },
        pitcher: { id: 7, fullName: 'Jordan P' }
      },
      ...(credits === undefined ? {} : { credits })
    })

    it('structures each credit, keeping its label and its name', function () {
      const sent = {
        eventType: 'field_out',
        label: 'Ground out: Jordan P (P) to Casey B (1B)',
        teamId: 'home',
        creditUserId: 7,
        credit: { name: 'Jordan P', role: 'fielder', position: 'P' }
      }
      const stored = withStructuredCredits(play([sent, 'odd']))
      expect(stored.credits).deep.equals([
        {
          ...sent,
          head: 'Ground out',
          assists: [{ creditUserId: 2, position: '1B' }],
          assistWord: 'to'
        },
        'odd'
      ])
    })

    it('leaves an engine credit and a play with no credits as they are', function () {
      const engine = {
        eventType: 'single',
        label: 'Single: Casey B',
        teamId: 'away',
        creditUserId: 2,
        credit: { name: 'Casey B', role: 'batter', position: null },
        head: 'Single',
        assists: [],
        assistWord: 'from'
      }
      expect(withStructuredCredits(play([engine])).credits).deep.equals([
        engine
      ])
      const bare = play(undefined)
      expect(withStructuredCredits(bare)).equals(bare)
      expect(withStructuredCredits('text')).equals('text')
      // A credit with neither label nor person keeps having neither.
      expect(
        withStructuredCredits(play([{ eventType: 'run', head: 'Run' }])).credits
      ).deep.equals([{ eventType: 'run', head: 'Run' }])
    })
  })

  describe('what stays', function () {
    it('keeps the name of a reference with no id, and names nobody by it', function () {
      const play = {
        about: {
          atBatIndex: 0,
          inning: 1,
          halfInning: 'top',
          isComplete: true
        },
        result: { eventType: 'single', description: 'Single' },
        matchup: {
          batter: { id: null, fullName: 'Visiting Batter' },
          pitcher: { id: 4, fullName: 'Max Fried' }
        },
        runners: [
          {
            movement: { start: null, end: '1B', isOut: false },
            details: {
              runner: { id: null, fullName: 'Visiting Batter' },
              responsiblePitcher: { id: 4, fullName: 'Max Fried' }
            },
            credits: [{ player: { id: 4, fullName: 'Max Fried' } }]
          }
        ],
        offense: { first: { id: null, fullName: 'Visiting Batter' } },
        credits: [
          {
            eventType: 'single',
            label: 'Single: Visiting Batter',
            teamId: 'away',
            creditUserId: null,
            credit: { name: 'Visiting Batter', role: 'batter', position: null }
          }
        ]
      }
      const stored = withoutNames(play) as unknown as Json
      expect((stored.matchup as Json).batter).deep.equals({
        id: null,
        fullName: 'Visiting Batter'
      })
      expect((stored.matchup as Json).pitcher).deep.equals({ id: 4 })
      expect(stored.offense).deep.equals(play.offense)
      expect(stored.credits).deep.equals([
        {
          eventType: 'single',
          teamId: 'away',
          creditUserId: null,
          credit: { name: 'Visiting Batter', role: 'batter', position: null },
          head: 'Single'
        }
      ])
      expect(JSON.stringify(stored)).not.include('Max Fried')
      const named = withNames(stored, new Map([[4, 'Max Fried']]))
      expect(named.matchup).deep.equals(play.matchup)
      expect((named.credits as Json[])[0].label).equals(
        'Single: Visiting Batter'
      )
      // A responsible pitcher is named by his id alone.
      expect(
        ((named.runners as Json[])[0].details as Json).responsiblePitcher
      ).deep.equals({ id: 4 })
    })

    it("keeps a manual play's descriptions, and every pitch and result description", function () {
      const play = {
        about: {
          atBatIndex: 3,
          inning: 1,
          halfInning: 'top',
          isComplete: true
        },
        result: {
          eventType: 'strikeout',
          description: 'Max Fried struck him out'
        },
        matchup: {
          batter: { id: 5, fullName: 'Ozzie Albies' },
          pitcher: { id: 4, fullName: 'Max Fried' },
          batSide: { code: 'R', description: 'Right' },
          pitchHand: { code: 'L', description: 'Left' }
        },
        playEvents: [
          {
            index: 0,
            isPitch: true,
            type: 'pitch',
            details: {
              call: { code: 'S', description: 'Swinging Strike' },
              description: 'Swinging Strike',
              type: { code: 'FF', description: 'Four-Seam Fastball' }
            },
            player: { id: 4, fullName: 'Max Fried' }
          },
          {
            index: 1,
            isPitch: false,
            type: 'action',
            details: {
              eventType: 'wild_pitch',
              description: 'Wild pitch by Max Fried.'
            },
            player: { id: 4, fullName: 'Max Fried' }
          }
        ]
      }
      const stored = withoutNames(play, { source: 'manual' }) as unknown as Json
      const events = eventsOf(stored)
      expect(events[0].details).deep.equals(play.playEvents[0].details)
      expect(events[1]).not.have.property('said')
      expect(events[1].details.description).equals('Wild pitch by Max Fried.')
      expect(events[1].player).deep.equals({ id: 4 })
      expect(stored.result).deep.equals(play.result)
      expect((stored.matchup as Json).pitchHand).deep.equals(
        play.matchup.pitchHand
      )
      expect((stored.matchup as Json).batSide).deep.equals(play.matchup.batSide)
      // With no record and no source, a play is read as a person's own.
      expect(eventsOf(withoutNames(play))[1].details.description).equals(
        'Wild pitch by Max Fried.'
      )
    })

    it("keeps 'Game over' and an event that names nobody", async function () {
      const final = (await finalGame()).plays.at(-1)!
      expect(final.result.description).equals('Game over')
      expect(withoutNames(final).result).deep.equals(final.result)
      const quiet = {
        about: { atBatIndex: 0 },
        playEvents: [
          {
            index: 0,
            isPitch: false,
            type: 'action',
            details: { eventType: 'mound_visit', description: 'Mound visit.' }
          }
        ],
        teamStation: { version: 2, setupBefore: { players: {} }, actions: [] }
      }
      // Its sentence is worded again from its type alone.
      const stored = withoutNames(quiet)
      expect(eventsOf(stored)[0].said).deep.equals({
        kind: 'action',
        eventType: 'mound_visit'
      })
      expect(withNames(stored, () => undefined)).deep.equals({
        ...quiet,
        playEvents: [{ ...quiet.playEvents[0], said: eventsOf(stored)[0].said }]
      })
      // One whose words no reading gives, naming nobody, stays as it is.
      const odd = {
        ...quiet,
        playEvents: [
          {
            ...quiet.playEvents[0],
            details: { eventType: 'mound_visit', description: 'A long talk.' }
          }
        ]
      }
      expect(withoutNames(odd)).deep.equals(odd)
    })

    it('counts a sentence it cannot read back, and words it from the event itself', async function () {
      const { play, event } = onlyEvent(
        await scenario('pitchingChange'),
        'pitching_substitution'
      )
      const old = withoutSaid(play)
      const index = eventsOf(play).indexOf(event)
      eventsOf(old)[index].details.description =
        'Pitching Change: Evan Phillips takes over from Tyler Glasnow.'
      const counted = storedForm(old)
      expect(counted.unreproduced).equals(1)
      const stored = eventsOf(counted.document)[index]
      expect(stored.said).deep.equals({ kind: 'pitching', player: PHILLIPS })
      expect(stored.details).not.have.property('description')
      expect(
        eventsOf(withNames(counted.document, namesIn(play)))[index].details
          .description
      ).equals('Pitching Change: Evan Phillips comes in to pitch.')
    })
  })

  describe('records', function () {
    it('stores a pregame record with no names, and names it again', async function () {
      const stored = await scoredWith([
        {
          type: 'lineup',
          kind: 'addPlayer',
          side: 'home',
          player: 9301,
          name: 'Bobby Witt'
        }
      ])
      const record = (stored.currentPlay as Json).teamStation as Json
      expect(record.version).equals(3)
      const names = namesIn(record)
      expect(names.get(9301)).equals('Bobby Witt')
      expect(names.get(SOTO)).equals('Juan Soto')
      const unnamed = withoutNames(record)
      const text = JSON.stringify(unnamed)
      for (const name of names.values()) expect(text).not.include(name)
      expect(withNames(unnamed, names)).deep.equals(withoutHalves(record))
      expect(storedForm(record).refused).equals(0)
    })

    it("restores an addPlayer action's name from its player id", function () {
      const record = {
        version: 2,
        setupBefore: replaySetup(),
        actions: [
          {
            type: 'lineup',
            kind: 'addPlayer',
            side: 'home',
            player: 9301,
            name: 'Bobby Witt'
          }
        ]
      }
      const unnamed = withoutNames(record) as Json
      expect((unnamed.actions as Json[])[0]).not.have.property('name')
      const named = withNames(unnamed, id =>
        id === 9301 ? 'Bobby Witt' : undefined
      )
      expect((named.actions as Json[])[0].name).equals('Bobby Witt')
    })

    const legacy = (): Json => ({
      version: 1,
      setupBefore: {
        players: {
          1: {
            id: 1,
            userId: 501,
            teamId: REPLAY_TEAMS.away.id,
            fullName: 'Juan Soto',
            jersey: '22',
            bats: 'left',
            throws: 'left',
            positions: ['LF'],
            local: false
          },
          2: {
            id: 2,
            userId: 502,
            teamId: REPLAY_TEAMS.home.id,
            fullName: 'Tyler Glasnow',
            jersey: '31',
            bats: 'right',
            throws: 'right',
            positions: ['P'],
            local: false
          }
        },
        sides: {
          away: {
            players: [1],
            battingOrder: [1],
            battingIndex: 0,
            defense: {
              P: null,
              C: null,
              '1B': null,
              '2B': null,
              SS: null,
              '3B': null,
              LF: 1,
              CF: null,
              RF: null
            },
            pitchCounts: {}
          },
          home: {
            players: [2],
            battingOrder: [2],
            battingIndex: 0,
            defense: {
              P: 2,
              C: null,
              '1B': null,
              '2B': null,
              SS: null,
              '3B': null,
              LF: null,
              CF: null,
              RF: null
            },
            pitchCounts: {}
          }
        },
        identities: {
          sourceToSession: { 501: 1, 502: 2, 503: 3 },
          sessionToSource: { 1: 501, 2: 502, 3: 503 },
          nextId: 3
        }
      },
      actions: [
        { type: 'pitch', call: 'B' },
        {
          type: 'lineup',
          kind: 'addPlayer',
          side: 'away',
          name: 'Bobby Witt'
        }
      ]
    })

    it('upgrades a version 1 record before taking its names out', function () {
      const play = {
        about: {
          atBatIndex: 0,
          inning: 1,
          halfInning: 'top',
          isComplete: false
        },
        matchup: {
          batter: { id: 501, fullName: 'Juan Soto' },
          pitcher: { id: 502, fullName: 'Tyler Glasnow' }
        },
        playEvents: [],
        teamStation: legacy()
      }
      const counted = storedForm(play)
      expect(counted.refused).equals(0)
      const record = (counted.document as Json).teamStation as Json
      expect(record.version).equals(2)
      expect(Object.keys(record.setupBefore as Json)).to.include('players')
      expect(
        Object.keys((record.setupBefore as Json).players as Json)
      ).deep.equals(['501', '502'])
      expect((record.actions as Json[])[1]).deep.equals({
        type: 'lineup',
        kind: 'addPlayer',
        side: 'away',
        player: 503
      })
      const text = JSON.stringify(counted.document)
      for (const name of ['Juan Soto', 'Tyler Glasnow', 'Bobby Witt'])
        expect(text).not.include(name)
      const names = new Map([
        [501, 'Juan Soto'],
        [502, 'Tyler Glasnow'],
        [503, 'Bobby Witt']
      ])
      const named = withNames(counted.document, names) as Json
      const setup = (named.teamStation as Json).setupBefore as Json
      expect(((setup.players as Json)[501] as Json).fullName).equals(
        'Juan Soto'
      )
      expect(((named.teamStation as Json).actions as Json[])[1].name).equals(
        'Bobby Witt'
      )
      expect(named.matchup).deep.equals(play.matchup)
      // A version 1 record met on a read is upgraded the same way.
      const read = withNames(play, names) as Json
      expect((read.teamStation as Json).version).equals(2)
    })

    it('keeps a version 1 record it cannot upgrade at version 1, its players unnamed', function () {
      const record = legacy()
      ;((record.setupBefore as Json).identities as Json).sessionToSource = {
        1: 501
      }
      const play = { about: { atBatIndex: 0 }, teamStation: record }
      const counted = storedForm(play)
      expect(counted.refused).equals(1)
      const kept = (counted.document as Json).teamStation as Json
      expect(kept.version).equals(1)
      const text = JSON.stringify(kept)
      for (const name of ['Juan Soto', 'Tyler Glasnow', 'Bobby Witt'])
        expect(text).not.include(name)
      expect(((kept.setupBefore as Json).players as Json)[1]).not.have.property(
        'fullName'
      )
      // Nothing reads its names, so naming leaves it as it is.
      expect(withNames(counted.document, () => 'Anyone')).deep.equals(
        counted.document
      )
      expect(storedForm(record).refused).equals(1)
    })
  })

  it('writes a man who waited in the order as coming in to field, and a reorder without him', async function () {
    const stored = await scenario('waitingFielder')
    const fielded = onlyEvent(stored, 'defensive_substitution')
    expect(fielded.event.said).deep.equals({
      kind: 'defensive',
      player: PHILLIPS,
      replaced: BETTS,
      position: 'SS'
    })
    expect(fielded.event.details.description).equals(
      'Defensive Substitution: Evan Phillips replaces Mookie Betts, playing shortstop.'
    )
    const order = onlyEvent(stored, 'ts_batting_order')
    expect(order.event.said).deep.equals({
      kind: 'order',
      moved: [{ player: 9202, bats: 1 }]
    })
    expect(order.event.details.description).equals(
      'Batting order change: Freddie Freeman bats 1st.'
    )
    for (const { play, event } of [fielded, order])
      expect(eventSaid(play, event, namesIn(play))).equals(
        event.details.description
      )
  })

  describe('a sentence no reading words again', function () {
    it("is given a said from each kind of event's own fields, and counted", async function () {
      const games = [
        await scenario('pitchingChange'),
        await scenario('pinchHitter'),
        await scenario('pinchRunner'),
        await scenario('staysIn'),
        await scenario('switchAndOrder')
      ]
      const want: Record<string, unknown> = {
        offensive_substitution: {
          kind: 'pinch',
          player: STANTON,
          replaced: SOTO,
          running: false
        },
        defensive_substitution: {
          kind: 'defensive',
          player: GIL,
          position: 'LF'
        },
        defensive_switch: { kind: 'switch', player: BETTS, position: '3B' },
        ts_batting_order: {
          kind: 'order',
          moved: [{ player: VOLPE, bats: 1 }]
        },
        ts_courtesy_runner: {
          kind: 'courtesy',
          player: STANTON,
          replaced: SOTO
        },
        wild_pitch: {
          kind: 'action',
          eventType: 'wild_pitch',
          lead: { player: SOTO, role: 'pitcher' }
        },
        passed_ball: {
          kind: 'action',
          eventType: 'passed_ball'
        },
        intent_walk: {
          kind: 'action',
          eventType: 'intent_walk',
          lead: { player: JUDGE, role: 'batter' }
        },
        stolen_base_2b: {
          kind: 'action',
          eventType: 'stolen_base_2b',
          lead: { player: STANTON, role: 'runner' }
        }
      }
      for (const [eventType, said] of Object.entries(want)) {
        const player = (said as { player?: unknown }).player
        const found = games
          .flatMap(game => eventsOfType(game, eventType))
          .find(
            ({ event }) =>
              player == null ||
              (event.said as { player?: unknown } | undefined)?.player ===
                player
          )!
        const old = withoutSaid(found.play)
        const index = eventsOf(found.play).indexOf(found.event)
        const event = eventsOf(old)[index]
        event.details.description = `${String(event.details.description)} Juan Soto agrees.`
        const read = saidFromDescription(old, event)
        expect(read?.reproduced, eventType).equals(false)
        // The fields give what they can; the switch and the substitution
        // have no fields for where from or whom, the order no list.
        if (
          eventType === 'defensive_switch' ||
          eventType === 'defensive_substitution'
        )
          expect(read!.said, eventType).deep.include(said)
        else if (eventType === 'ts_batting_order')
          expect((read!.said as { kind: string }).kind).equals('order')
        else if (eventType !== 'passed_ball' && eventType !== 'wild_pitch')
          expect(read!.said, eventType).deep.equals(said)
        expect(storedForm(old).unreproduced, eventType).equals(1)
      }
    })

    it('reads an event with nothing to go on as best it can', function () {
      const play = { about: { atBatIndex: 0 }, runners: [], playEvents: [] }
      const bare = (eventType: string, extra: Json = {}): Json => ({
        index: 0,
        isPitch: false,
        type: 'action',
        details: { eventType, description: 'Juan Soto did it' },
        player: { id: SOTO, fullName: 'Juan Soto' },
        ...extra
      })
      const read = (eventType: string, extra?: Json): unknown =>
        saidFromDescription(play, bare(eventType, extra))?.said
      expect(read('pitching_substitution')).deep.equals({
        kind: 'pitching',
        player: SOTO
      })
      expect(read('defensive_substitution')).deep.equals({
        kind: 'defensive',
        player: SOTO,
        position: 'P'
      })
      expect(
        read('offensive_substitution', {
          position: { abbreviation: 'PR' },
          replacedPlayer: { id: JUDGE, fullName: 'Aaron Judge' }
        })
      ).deep.equals({
        kind: 'pinch',
        player: SOTO,
        replaced: JUDGE,
        running: true
      })
      expect(
        read('defensive_switch', { position: { abbreviation: 'SS' } })
      ).deep.equals({
        kind: 'switch',
        player: SOTO,
        position: 'SS'
      })
      expect(read('ts_batting_order', { battingOrder: '301' })).deep.equals({
        kind: 'order',
        moved: [{ player: SOTO, bats: 3 }]
      })
      expect(read('ts_courtesy_runner')).deep.equals({
        kind: 'courtesy',
        player: SOTO,
        replaced: SOTO
      })
      expect(read('balk', { pitcher: { id: GLASNOW } })).deep.equals({
        kind: 'action',
        eventType: 'balk',
        lead: { player: GLASNOW, role: 'pitcher' }
      })
      expect(read('passed_ball', { catcher: { id: SMITH } })).deep.equals({
        kind: 'action',
        eventType: 'passed_ball',
        lead: { player: SMITH, role: 'catcher' }
      })
      expect(read('passed_ball')).deep.equals({
        kind: 'action',
        eventType: 'passed_ball'
      })
      expect(read('catcher_interf')).deep.equals({
        kind: 'action',
        eventType: 'catcher_interf',
        lead: { player: { name: '' }, role: 'batter' }
      })
      expect(read('other_advance')).deep.equals({
        kind: 'action',
        eventType: 'other_advance'
      })
      // With no sentence, or no play, there is nothing to read.
      expect(
        saidFromDescription(play, { ...bare('balk'), details: {} })
      ).equals(undefined)
      expect(saidFromDescription(null, bare('balk'))).equals(undefined)
      expect(saidFromDescription(play, 'event')).equals(undefined)
      expect(
        saidFromDescription(play, {
          ...bare('balk'),
          details: { code: 'balk', description: 'Balk by Juan Soto.' }
        })
      ).deep.equals({
        said: {
          kind: 'action',
          eventType: 'balk',
          lead: { player: SOTO, role: 'pitcher' }
        },
        reproduced: true
      })
      expect(
        saidFromDescription(play, {
          ...bare('balk'),
          details: { code: 7, description: 'Juan Soto' }
        })?.reproduced
      ).equals(false)
    })
  })

  describe('a said it cannot read', function () {
    it('words nothing from a said that is not one', function () {
      const play = { runners: 'none' }
      for (const said of [
        undefined,
        'pitching',
        { kind: 3 },
        { kind: 'unknown', player: 1 },
        { kind: 'pitching', player: 'one' },
        { kind: 'order', moved: 'all' },
        { kind: 'order', moved: [{ player: 1 }] },
        { kind: 'action' },
        { kind: 'action', eventType: 'balk', lead: 'pitcher' },
        {
          kind: 'action',
          eventType: 'balk',
          lead: { player: 1, role: 'umpire' }
        },
        {
          kind: 'action',
          eventType: 'balk',
          lead: { player: [], role: 'pitcher' }
        }
      ])
        expect(
          eventSaid(play, { index: 0, said }, () => 'X'),
          JSON.stringify(said)
        ).equals(undefined)
      expect(eventSaid(play, 'event', () => 'X')).equals(undefined)
      // A play whose runners cannot be read moves nobody.
      expect(
        eventSaid(
          null,
          {
            index: 0,
            said: {
              kind: 'action',
              eventType: 'balk',
              lead: { player: 1, role: 'pitcher' }
            }
          },
          () => 'Max Fried'
        )
      ).equals('Balk by Max Fried.')
      expect(
        eventSaid(
          {
            runners: [
              'runner',
              { details: 'none' },
              {
                details: { playIndex: 0, runner: { fullName: 'Typed Runner' } }
              }
            ]
          },
          {
            index: 0,
            said: {
              kind: 'action',
              eventType: 'wild_pitch',
              lead: { player: { name: 'Typed Pitcher' }, role: 'pitcher' }
            }
          },
          () => undefined
        )
      ).equals('Wild pitch by Typed Pitcher.')
      // An order with an unknown position words the code itself.
      expect(
        eventSaid(
          {},
          {
            said: {
              kind: 'switch',
              player: 1,
              position: 'DH',
              fromPosition: 'EH'
            }
          },
          () => 'Bo Bichette'
        )
      ).equals('Defensive switch from EH to DH for Bo Bichette.')
      expect(
        eventSaid(
          {},
          { said: { kind: 'switch', player: 1, position: 'DH' } },
          new Map()
        )
      ).equals(' remains in the game as the DH.')
    })
  })

  describe('documents it does not expect', function () {
    it('leaves what is not a document as it is', function () {
      for (const value of [null, 'play', 3, [1, 2]]) {
        expect(withoutNames(value)).equals(value)
        expect(withNames(value, () => 'X')).equals(value)
      }
      const odd = {
        about: { atBatIndex: 0 },
        matchup: 'nobody',
        runners: ['runner', { details: 'none', credits: ['credit'] }],
        playEvents: ['event', { details: 'none' }],
        offense: 'none',
        credits: ['credit', { label: 3 }],
        teamStation: 'record'
      }
      expect(withoutNames(odd, { source: 'teamstation' })).deep.equals(odd)
      expect(withNames(odd, () => 'X')).deep.equals(odd)
      expect(
        namesIn({
          ...odd,
          teamStation: { version: 2, actions: ['x', { setup: 'none' }] }
        }).size
      ).equals(0)
    })

    it('names a reference the book does not know by the name it holds, or none', function () {
      const play = {
        matchup: {
          batter: { id: 1, fullName: 'Kept Name' },
          pitcher: { id: 2 }
        },
        teamStation: {
          version: 2,
          setupBefore: {
            players: { 3: { id: 3 }, 4: { id: 4, fullName: 'Kept' }, x: 'none' }
          },
          actions: [
            { type: 'lineup', kind: 'addPlayer', player: 5 },
            {
              type: 'lineup',
              kind: 'addPlayer',
              player: 6,
              name: 'Bobby Witt'
            },
            { type: 'lineup', kind: 'addPlayer', name: 'No Id' }
          ]
        },
        credits: [{ head: 'Run', creditUserId: 2, credit: { role: 'runner' } }]
      }
      const named = withNames(play, id =>
        id === 6 ? 'Bobby Witt' : undefined
      ) as Json
      expect(named.matchup).deep.equals({
        batter: { id: 1, fullName: 'Kept Name' },
        pitcher: { id: 2, fullName: '' }
      })
      const record = named.teamStation as Json
      expect((record.setupBefore as Json).players).deep.equals({
        3: { id: 3, fullName: '' },
        4: { id: 4, fullName: 'Kept' },
        x: 'none'
      })
      expect(record.actions).deep.equals(play.teamStation.actions)
      expect((named.credits as Json[])[0]).deep.include({
        label: 'Run: ',
        credit: { role: 'runner', name: '' }
      })
      // An addPlayer action with no id keeps the only name it has.
      expect(
        ((withoutNames(play) as Json).teamStation as Json).actions
      ).deep.equals([
        { type: 'lineup', kind: 'addPlayer', player: 5 },
        { type: 'lineup', kind: 'addPlayer', player: 6 },
        { type: 'lineup', kind: 'addPlayer', name: 'No Id' }
      ])
    })
  })

  describe('namesIn', function () {
    it('reads the names a document pairs with ids, the first for each', function () {
      expect([
        ...namesIn({
          matchup: { batter: { id: 1, fullName: 'Juan Soto' } },
          offense: { second: { id: 2, fullName: 'Aaron Judge' } },
          credits: [
            { creditUserId: 3, credit: { name: 'Gerrit Cole' } },
            { creditUserId: 1, credit: { name: 'Someone Else' } },
            { creditUserId: null, credit: { name: 'Typed' } }
          ]
        })
      ]).deep.equals([
        [1, 'Juan Soto'],
        [2, 'Aaron Judge'],
        [3, 'Gerrit Cole']
      ])
      expect([...namesIn(null)]).deep.equals([])
    })
  })
})
