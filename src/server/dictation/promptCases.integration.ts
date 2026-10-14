import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type ScoringAction, toolSchema } from '../../common/scoring/actions'
import { writtenTag } from '../../common/scoring/playerTags'
import {
  type PlayerSaid,
  rosterToolSchema,
  type SaidRosterCommand
} from '../../common/scoring/rosterCommands'
import { Interpretation, type Turn } from './interpreter'

/**
 * Integration tests for dictation. Each sentence goes to Claude Haiku 5.5
 * with the real prompt and invented players, and the test checks the actions
 * the model returns. Nothing here launches the app: that is a `.e2e.ts`
 * file. A sentence whose reply cannot be scored is said once more, including
 * a batted ball that came back with no result. Not part of `npm test`,
 * which runs `*.test.ts` only.
 *
 *   node_modules/.bin/mocha -r sucrase/register --extension ts --timeout 180000 \
 *     src/server/dictation/promptCases.integration.ts
 *
 * The key is `dictation.anthropic` in serverConfig.json, which is not in git.
 * Without it the file skips.
 */
const keys = anthropic()
const scoringTools = toolSchema().filter(tool => tool.name !== 'lineup')
const rosterTools = rosterToolSchema()

const who = (id: number, name: string, jersey: string): string =>
  `${name} #${jersey} ${writtenTag(id)}`

const alex = who(1, 'Alex Lee', '11')
const blake = who(2, 'Blake Kim', '61')
const casey = who(3, 'Casey Ng', '96')
const evan = who(5, 'Evan Cole', '32')
const fran = who(6, 'Fran Diaz', '46')
const glen = who(7, 'Glen Ibarra', '67')
const harper = who(8, 'Harper Quinn', '62')
const indigo = who(9, 'Indigo Sato', '8')
const nico = who(10, 'Nico Voss', '3')
const noa = who(11, 'Noa Singh', '10')
const cam = who(12, 'Cam Ortiz', '52')
const rio = who(13, 'Rio Paz', '28')
const remy = who(14, 'Remy Cho', '20')
const sol = who(15, 'Sol Park', '90')
const mattChen = who(16, 'Matt Chen', '50')
const ren = who(17, 'Ren Lee', '65')
const sam = who(18, 'Sam Ruiz', '9')
const will = who(19, 'Will Costa', '2')

const ROSTERS = `AWAY — Hawks
  Alex Lee #11 — bats 1st, plays 2B
  Blake Kim #61 — bats 2nd, plays C
  Casey Ng #96 — bats 3rd, plays 1B
  Matt Brooks #12 — bats 4th
  Evan Cole #32 — bats 5th, plays 3B
  Fran Diaz #46 — bats 6th, plays LF
  Glen Ibarra #67 — bats 7th, plays CF
  Harper Quinn #62 — bats 8th, plays RF
  Indigo Sato #8 — bats 9th, plays SS
  Nico Voss #3 — plays P
HOME — Owls
  Noa Singh #10 — bats 1st, plays 1B
  Cam Ortiz #52 — bats 2nd, plays C
  Rio Paz #28 — bats 3rd, plays P
  Remy Cho #20 — bats 4th, plays 2B
  Sol Park #90 — bats 5th, plays SS
  Matt Chen #50 — bats 6th, plays 3B
  Ren Lee #65 — bats 7th, plays LF
  Sam Ruiz #9 — bats 8th, plays CF
  Will Costa #2 — bats 9th, plays RF
  Jared Hale #56 — bench
  Morgan Ellis #19 — bench`

const hawksField = {
  P: nico,
  C: blake,
  '1B': casey,
  '2B': alex,
  SS: indigo,
  '3B': evan,
  LF: fran,
  CF: glen,
  RF: harper
}
const owlsField = {
  P: rio,
  C: cam,
  '1B': noa,
  '2B': remy,
  SS: sol,
  '3B': mattChen,
  LF: ren,
  CF: sam,
  RF: will
}

function anthropic(): { apiKey: string; baseUrl: string } | undefined {
  try {
    const raw = JSON.parse(readFileSync('serverConfig.json', 'utf8')) as {
      dictation?: { anthropic?: { apiKey?: string; baseUrl?: string } }
    }
    const apiKey = raw.dictation?.anthropic?.apiKey
    if (apiKey == null || apiKey === '') return undefined
    return {
      apiKey,
      baseUrl:
        raw.dictation?.anthropic?.baseUrl ?? 'https://api.anthropic.com/v1'
    }
  } catch {
    return undefined
  }
}

function game(input: {
  half: 'Top' | 'Bottom'
  inning: string
  outs: number
  count: string
  batting: string
  fielding: string
  batter: string
  pitcher: string
  first?: string
  second?: string
  third?: string
  next: string
  fielders: Record<string, string>
}): string {
  const fielders = ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']
    .map(position => `${position} ${input.fielders[position]}`)
    .join(', ')
  return [
    `${input.half} of the ${input.inning}, ${input.outs} ${input.outs === 1 ? 'out' : 'outs'}, count ${input.count}.`,
    `${input.batting} batting, ${input.fielding} in the field.`,
    `Batter: ${input.batter}. Pitcher: ${input.pitcher}.`,
    `On first: ${input.first ?? 'nobody'}. On second: ${input.second ?? 'nobody'}. On third: ${input.third ?? 'nobody'}.`,
    `Next batter: ${input.next}.`,
    `Fielders: ${fielders}.`,
    'ROSTERS',
    ROSTERS
  ].join('\n')
}

async function say(
  scope: 'scoring' | 'roster',
  context: string,
  said: string
): Promise<Turn> {
  const first = await ask(scope, context, said)
  if (scoreable(first)) return first
  // Haiku sometimes invents a tag, or calls undo on a sentence that is not
  // one. A second sample is the same sentence; a repeat of the miss fails.
  return await ask(scope, context, said)
}

async function ask(
  scope: 'scoring' | 'roster',
  context: string,
  said: string
): Promise<Turn> {
  const endpoint = keys
  if (endpoint == null) throw new Error('no key')
  return await new Interpretation(
    {
      apiKey: endpoint.apiKey,
      model: 'claude-haiku-5-5',
      api: 'messages',
      baseUrl: endpoint.baseUrl,
      tools: scope === 'scoring' ? scoringTools : [],
      rosterTools
    },
    context,
    said
  ).start()
}

function ballWithoutResult(actions: readonly ScoringAction[]): boolean {
  return (
    actions.some(action => action.type === 'ballInPlay') &&
    !actions.some(action => action.type === 'result')
  )
}

function scoreable(turn: Turn): boolean {
  if (turn.kind === 'ask' || turn.kind === 'error') return false
  if (problems(turn).length > 0) return false
  if (turn.kind === 'actions' && ballWithoutResult(turn.actions)) return false
  const ignoredUndo = turn.dropped.some(
    item => item.message === 'An undo the words did not ask for was ignored'
  )
  return !(
    ignoredUndo &&
    turn.actions.length === 0 &&
    (turn.roster ?? []).length === 0
  )
}

/** An undo the server ignored is not a missed play. Anything else dropped is. */
function problems(turn: Turn): Turn['dropped'] {
  if (turn.kind === 'ask' || turn.kind === 'error') return []
  return turn.dropped.filter(
    item => item.message !== 'An undo the words did not ask for was ignored'
  )
}

function decided(turn: Turn): {
  actions: ScoringAction[]
  roster: SaidRosterCommand[]
} {
  if (turn.kind === 'ask')
    expect.fail(`asked: ${turn.question} ${JSON.stringify(turn.options)}`)
  if (turn.kind === 'error') expect.fail(turn.message)
  expect(problems(turn), JSON.stringify(problems(turn))).deep.equals([])
  return { actions: turn.actions, roster: turn.roster ?? [] }
}

function resultType(actions: readonly ScoringAction[]): string | undefined {
  const result = actions.find(action => action.type === 'result')
  return result?.type === 'result' ? result.eventType : undefined
}

function ofType<T extends ScoringAction['type']>(
  action: ScoringAction | undefined,
  type: T
): Extract<ScoringAction, { type: T }> {
  if (action?.type === type)
    return action as Extract<ScoringAction, { type: T }>
  expect.fail(`${type} missing from ${JSON.stringify(action)}`)
  throw new Error(type)
}

function ball(
  actions: readonly ScoringAction[]
): ScoringAction & { type: 'ballInPlay' } {
  return ofType(
    actions.find(action => action.type === 'ballInPlay'),
    'ballInPlay'
  )
}

function running(
  actions: readonly ScoringAction[]
): Array<ScoringAction & { type: 'baseRunning' }> {
  return actions
    .filter(action => action.type === 'baseRunning')
    .map(action => ofType(action, 'baseRunning'))
}

function movements(
  actions: readonly ScoringAction[]
): Array<ScoringAction & { type: 'runnerMovement' }> {
  return actions
    .filter(action => action.type === 'runnerMovement')
    .map(action => ofType(action, 'runnerMovement'))
}

function resultOf(
  actions: readonly ScoringAction[]
): ScoringAction & { type: 'result' } {
  return ofType(
    actions.find(action => action.type === 'result'),
    'result'
  )
}

/**
 * Fielders left off are the game's to fill. A chain the model did send has
 * to be one of these, in order.
 */
function credited(
  fielders: readonly number[] | undefined,
  accepted: ReadonlyArray<readonly number[]>,
  dumped: string
): void {
  const got = fielders ?? []
  if (got.length === 0) return
  const ok = accepted.some(
    one =>
      one.length === got.length && one.every((id, index) => id === got[index])
  )
  expect(ok, `${dumped} fielders ${JSON.stringify([...got])}`).equals(true)
}

function handledBy(
  id: number | undefined,
  accepted: number,
  dumped: string
): void {
  expect(
    id == null || id === accepted,
    `${dumped} fielder ${String(id)}`
  ).equals(true)
}

/** Hawks batting, Owls in the field: Matt Chen at third, Remy at second, Sol at short. */
function hawksBatting(input: {
  batter: string
  next: string
  first?: string
  second?: string
  third?: string
}): string {
  return game({
    half: 'Top',
    inning: '4th',
    outs: 0,
    count: '0-0',
    batting: 'Hawks',
    fielding: 'Owls',
    batter: input.batter,
    pitcher: rio,
    next: input.next,
    first: input.first,
    second: input.second,
    third: input.third,
    fielders: owlsField
  })
}

function places(
  roster: SaidRosterCommand[],
  position: string,
  fieldingSide?: 'home' | 'away'
): PlayerSaid {
  expect(roster, JSON.stringify(roster)).to.have.length(1)
  const command = roster[0]
  expect(command.type, JSON.stringify(command)).equals('setPositions')
  if (command.type !== 'setPositions') throw new Error('setPositions')
  expect(
    command.side == null || command.side === fieldingSide,
    JSON.stringify(command)
  ).equals(true)
  expect(command.places).to.have.length(1)
  expect(command.places[0].position).equals(position)
  return command.places[0].player
}

const CASEY = 3
const EVAN = 5
const NOA = 11
const CAM = 12
const RIO_ID = 13
const REMY = 14
const SOL = 15
const MATT = 16
const REN = 17
const SAM = 18

const live = keys != null

;(live ? describe : describe.skip)(
  'dictation prompt cases, Haiku 5.5',
  function () {
    this.timeout(180_000)

    const owlsUp = game({
      half: 'Bottom',
      inning: '2nd',
      outs: 0,
      count: '0-0',
      batting: 'Owls',
      fielding: 'Hawks',
      batter: ren,
      pitcher: nico,
      next: sam,
      fielders: hawksField
    })

    it('scores a bunt safe at first, with the bases empty, as a single', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          owlsUp,
          "A bunt down the third baseline and he's safe at first."
        )
      )
      expect(ball(actions).contact).equals('bunt')
      expect(resultType(actions)).equals('single')
      expect(actions.some(action => action.type === 'runnerMovement')).equals(
        false
      )
    })

    it('does not make a force out of a bunt the scorer only called safe', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          game({
            half: 'Bottom',
            inning: '2nd',
            outs: 0,
            count: '0-0',
            batting: 'Owls',
            fielding: 'Hawks',
            batter: sam,
            pitcher: nico,
            first: ren,
            next: will,
            fielders: hawksField
          }),
          "He bunted down to third. And he's safe at first."
        )
      )
      expect(ball(actions).contact).equals('bunt')
      expect(resultType(actions)).equals('single')
      expect(
        actions.some(
          action => action.type === 'runnerMovement' && action.out === true
        )
      ).equals(false)
    })

    it('records one called strike and the steal when four pitches were mentioned', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          game({
            half: 'Bottom',
            inning: '2nd',
            outs: 1,
            count: '0-0',
            batting: 'Owls',
            fielding: 'Hawks',
            batter: will,
            pitcher: nico,
            first: sam,
            next: noa,
            fielders: hawksField
          }),
          'Four pitches a strike and Sam steals second.'
        )
      )
      const pitches = actions.filter(action => action.type === 'pitch')
      expect(pitches.map(action => ofType(action, 'pitch').call)).deep.equals([
        'C'
      ])
      const steal = ofType(
        actions.find(action => action.type === 'baseRunning'),
        'baseRunning'
      )
      expect(steal.kind).equals('steal')
      expect(steal.runner).equals(18)
      expect(steal.to).equals('2B')
    })

    it('sends the pitch with a wild pitch when the count is empty', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          game({
            half: 'Bottom',
            inning: '2nd',
            outs: 2,
            count: '0-0',
            batting: 'Owls',
            fielding: 'Hawks',
            batter: rio,
            pitcher: nico,
            third: sam,
            next: remy,
            fielders: hawksField
          }),
          'Wild pitch and Sam takes home.'
        )
      )
      const pitches = actions.filter(action => action.type === 'pitch')
      expect(pitches).to.have.length(1)
      expect(ofType(pitches[0], 'pitch').call).equals('B')
      const event = ofType(
        actions.find(action => action.type === 'batteryEvent'),
        'batteryEvent'
      )
      expect(event.kind).equals('wild_pitch')
      expect(event.advances).deep.equals([{ runner: 18, to: 'home' }])
    })

    it('calls the third disengagement a balk', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          game({
            half: 'Bottom',
            inning: '3rd',
            outs: 1,
            count: '0-0',
            batting: 'Owls',
            fielding: 'Hawks',
            batter: mattChen,
            pitcher: nico,
            first: sol,
            next: ren,
            fielders: hawksField
          }),
          'And Sol takes second due to the third disengagement.'
        )
      )
      expect(
        actions.some(
          action => action.type === 'batteryEvent' && action.kind === 'balk'
        )
      ).equals(true)
      expect(actions.some(action => action.type === 'baseRunning')).equals(
        false
      )
    })

    it('scores a ground out without moving a runner to the batter', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          game({
            half: 'Top',
            inning: '3rd',
            outs: 0,
            count: '0-0',
            batting: 'Hawks',
            fielding: 'Owls',
            batter: indigo,
            pitcher: rio,
            next: alex,
            fielders: owlsField
          }),
          'Grounder to third. And Matt throws him out at first.'
        )
      )
      expect(ball(actions).contact).equals('swing')
      expect(ball(actions).trajectory).equals('ground_ball')
      const result = ofType(
        actions.find(action => action.type === 'result'),
        'result'
      )
      expect(result.eventType).equals('field_out')
      expect(result.outBy).equals('throw')
      const moved = actions.filter(action => action.type === 'runnerMovement')
      expect(moved.length, JSON.stringify(moved)).equals(0)
    })

    it('puts a ground ball in trajectory, and the force where it was said', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          game({
            half: 'Top',
            inning: '4th',
            outs: 0,
            count: '0-0',
            batting: 'Hawks',
            fielding: 'Owls',
            batter: indigo,
            pitcher: rio,
            first: casey,
            next: nico,
            fielders: owlsField
          }),
          "And it's a ground ball to third. The throw gets him out at second. But the throw to first is late, and he's safe at first."
        )
      )
      expect(ball(actions).contact).equals('swing')
      expect(ball(actions).trajectory).equals('ground_ball')
      expect(resultType(actions), JSON.stringify(actions)).equals(
        'fielders_choice'
      )
      const out = ofType(
        actions.find(
          action => action.type === 'runnerMovement' && action.out === true
        ),
        'runnerMovement'
      )
      expect(out.runner).equals(3)
      expect(out.to).equals('2B')
    })

    it("scores the bat hitting the catcher's mitt as interference alone", async function () {
      const { actions } = decided(
        await say(
          'scoring',
          game({
            half: 'Top',
            inning: '4th',
            outs: 1,
            count: '0-0',
            batting: 'Hawks',
            fielding: 'Owls',
            batter: indigo,
            pitcher: rio,
            first: casey,
            next: nico,
            fielders: owlsField
          }),
          "And the bat hits the catcher's mitt. For interference and the runner advances."
        )
      )
      expect(resultType(actions), JSON.stringify(actions)).equals(
        'catcher_interference'
      )
      expect(actions.some(action => action.type === 'gameFlow')).equals(false)
      expect(actions.some(action => action.type === 'runnerMovement')).equals(
        false
      )
    })

    it('puts a misheard bench player into the lineup instead of adding him', async function () {
      const { roster } = decided(
        await say(
          'roster',
          game({
            half: 'Bottom',
            inning: '2nd',
            outs: 2,
            count: '0-0',
            batting: 'Owls',
            fielding: 'Hawks',
            batter: noa,
            pitcher: nico,
            third: sam,
            next: cam,
            fielders: hawksField
          }),
          'Add Jarrett to the lineup.'
        )
      )
      const spelled = JSON.stringify(roster)
      expect(spelled.toLowerCase(), spelled).to.not.include('jarrett')
      expect(roster).to.have.length(1)
      const command = roster[0]
      expect(command.type).equals('placeInLineup')
      if (command.type !== 'placeInLineup') return
      expect(command.places).to.have.length(1)
      expect(command.places[0].player.name?.toLowerCase()).to.include('jared')
      const slot = command.places[0].slot
      expect(slot === 'end' || (typeof slot === 'number' && slot >= 10)).equals(
        true
      )
    })

    it('puts that same misheard player third, still without adding him', async function () {
      const { roster } = decided(
        await say(
          'roster',
          game({
            half: 'Bottom',
            inning: '2nd',
            outs: 2,
            count: '0-0',
            batting: 'Owls',
            fielding: 'Hawks',
            batter: noa,
            pitcher: nico,
            third: sam,
            next: cam,
            fielders: hawksField
          }),
          'Add Jarrett third in the lineup.'
        )
      )
      const spelled = JSON.stringify(roster)
      expect(spelled.toLowerCase(), spelled).to.not.include('jarrett')
      const command = roster[0]
      expect(command.type).equals('placeInLineup')
      if (command.type !== 'placeInLineup') return
      expect(command.places[0].player.name?.toLowerCase()).to.include('jared')
      expect(command.places[0].slot).equals(3)
    })

    it('replaces the named batter in the order instead of inserting beside him', async function () {
      const { roster } = decided(
        await say(
          'roster',
          game({
            half: 'Bottom',
            inning: '2nd',
            outs: 2,
            count: '0-0',
            batting: 'Owls',
            fielding: 'Hawks',
            batter: noa,
            pitcher: nico,
            third: sam,
            next: cam,
            fielders: hawksField
          }),
          'Substitute Nico for Matt in the lineup.'
        )
      )
      expect(roster).to.have.length(1)
      const command = roster[0]
      expect(command.type).equals('setLineup')
      if (command.type !== 'setLineup') return
      const order = command.order.map(player => said(player))
      const listed = order.join(', ')
      expect(
        order.some(name => name.includes('nico')),
        listed
      ).equals(true)
      expect(
        order.some(name => name.includes('matt')),
        listed
      ).equals(false)
      for (const name of ['alex', 'blake', 'casey', 'evan'])
        expect(
          order.some(item => item.includes(name)),
          name
        ).equals(true)
    })

    it('brings Matt in to pitch without choosing which Matt or naming a team', async function () {
      const { actions, roster } = decided(
        await say(
          'scoring',
          game({
            half: 'Bottom',
            inning: '2nd',
            outs: 2,
            count: '0-0',
            batting: 'Owls',
            fielding: 'Hawks',
            batter: rio,
            pitcher: nico,
            third: sam,
            next: remy,
            fielders: hawksField
          }),
          'And Matt comes in as pitcher.'
        )
      )
      expect(actions).to.have.length(0)
      expect(roster).to.have.length(1)
      const command = roster[0]
      expect(command.type).equals('setPositions')
      if (command.type !== 'setPositions') return
      expect(command.side).equals(undefined)
      expect(command.places).to.have.length(1)
      expect(command.places[0].position).equals('P')
      expect(command.places[0].player.name?.toLowerCase()).to.include('matt')
    })

    it('credits a caught fly in right center to the center fielder', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex }),
          "Pop fly to right center field, it's caught."
        )
      )
      const played = ball(actions)
      expect(played.direction).equals('right_center')
      expect(played.contact).equals('swing')
      handledBy(played.fielder, SAM, JSON.stringify(played))
      const result = resultOf(actions)
      expect(result.eventType).equals('field_out')
      expect(result.outBy).equals('catch')
    })

    it('credits a caught fly in left center to the center fielder', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex }),
          "Pop fly to left center field, it's caught."
        )
      )
      const played = ball(actions)
      expect(played.direction).equals('left_center')
      expect(played.contact).equals('swing')
      handledBy(played.fielder, SAM, JSON.stringify(played))
      const result = resultOf(actions)
      expect(result.eventType).equals('field_out')
      expect(result.outBy).equals('catch')
    })

    it('credits the second baseman when a ground ball to third is out at second', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          'Ground ball to third. Runner is out at second, but safe at first.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.trajectory).equals('ground_ball')
      handledBy(played.fielder, MATT, JSON.stringify(played))
      expect(resultType(actions), JSON.stringify(actions)).equals(
        'fielders_choice'
      )
      const out = outAt(actions, CASEY, '2B')
      credited(out.fielders, [[MATT, REMY], [REMY]], JSON.stringify(out))
    })

    it("credits Sol's putout when his throw to first is late", async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          "Ground ball to third, out at second, but Sol's throw to first is late."
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.trajectory).equals('ground_ball')
      handledBy(played.fielder, MATT, JSON.stringify(played))
      expect(resultType(actions), JSON.stringify(actions)).equals(
        'fielders_choice'
      )
      const out = outAt(actions, CASEY, '2B')
      credited(out.fielders, [[MATT, SOL], [SOL]], JSON.stringify(out))
    })

    it('keeps a grounder a swing when the throw at second goes to Remy', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          'Grounder to third. The throw out to second to Remy, but the throw to first is late.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.trajectory).equals('ground_ball')
      handledBy(played.fielder, MATT, JSON.stringify(played))
      expect(resultType(actions), JSON.stringify(actions)).equals(
        'fielders_choice'
      )
      const out = outAt(actions, CASEY, '2B')
      credited(out.fielders, [[MATT, REMY], [REMY]], JSON.stringify(out))
    })

    it('scores a sacrifice bunt to third as a throw out at first', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex }),
          'Sacrifice bunt to third base, and thrown out at first.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('bunt')
      handledBy(played.fielder, MATT, JSON.stringify(played))
      const result = resultOf(actions)
      expect(result.eventType).equals('field_out')
      expect(result.outBy).equals('throw')
      expect(movements(actions), JSON.stringify(actions)).to.have.length(0)
    })

    it('records a safe pickoff as no out', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          "Pickoff attempt at first, and he's safe."
        )
      )
      const plays = running(actions)
      expect(plays, JSON.stringify(plays)).to.have.length(1)
      expect(plays[0].kind).equals('pickoff_safe')
      expect(plays[0].runner).equals(CASEY)
      credited(plays[0].fielders, [], JSON.stringify(plays[0]))
      expect(actions.some(action => action.type === 'result')).equals(false)
    })

    it('splits a double steal when the lead runner is thrown out at third', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({
            batter: fran,
            next: glen,
            first: casey,
            second: evan
          }),
          'Double steal, but Evan is thrown out at third.'
        )
      )
      const plays = running(actions)
      const caught = plays.find(play => play.kind === 'caught_stealing')
      const stole = plays.find(play => play.kind === 'steal')
      expect(caught, JSON.stringify(plays)).to.not.equal(undefined)
      expect(stole, JSON.stringify(plays)).to.not.equal(undefined)
      if (caught == null || stole == null) return
      expect(caught.runner).equals(EVAN)
      expect(caught.to).equals('3B')
      credited(caught.fielders, [[CAM, MATT]], JSON.stringify(caught))
      expect(stole.runner).equals(CASEY)
      expect(stole.to).equals('2B')
      expect(plays.some(play => (play.fielders ?? []).includes(RIO_ID))).equals(
        false
      )
    })

    it('credits the shortstop when a ground ball to first is out at second', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          'Ground ball to first. The runner is out at second, but safe at first.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.trajectory).equals('ground_ball')
      handledBy(played.fielder, NOA, JSON.stringify(played))
      expect(resultType(actions), JSON.stringify(actions)).equals(
        'fielders_choice'
      )
      const out = outAt(actions, CASEY, '2B')
      credited(out.fielders, [[NOA, SOL], [SOL]], JSON.stringify(out))
    })

    it('credits a tag out at home to the left fielder and the catcher', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, third: casey }),
          'Pop fly to left. The runner tags and is thrown out at home.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.direction).equals('left')
      handledBy(played.fielder, REN, JSON.stringify(played))
      const result = resultOf(actions)
      expect(result.eventType).equals('field_out')
      expect(result.outBy).equals('catch')
      const out = outAt(actions, CASEY, 'home')
      credited(out.fielders, [[REN, CAM]], JSON.stringify(out))
    })

    it('credits a tag out at second to the left fielder and the shortstop', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          'Pop fly to left. The runner tags and is thrown out at second.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.direction).equals('left')
      handledBy(played.fielder, REN, JSON.stringify(played))
      expect(resultOf(actions).outBy).equals('catch')
      const out = outAt(actions, CASEY, '2B')
      credited(out.fielders, [[REN, SOL]], JSON.stringify(out))
    })

    it('credits a tag out at second to the third baseman and the second baseman', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          'Pop up to third. The runner tags and is thrown out at second.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      handledBy(played.fielder, MATT, JSON.stringify(played))
      expect(resultOf(actions).outBy).equals('catch')
      const out = outAt(actions, CASEY, '2B')
      credited(out.fielders, [[MATT, REMY]], JSON.stringify(out))
    })

    it("credits a left-center single's throw to the center fielder and the shortstop", async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          'Single to left center. The runner is thrown out at second.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.direction).equals('left_center')
      handledBy(played.fielder, SAM, JSON.stringify(played))
      expect(resultType(actions)).equals('single')
      const out = outAt(actions, CASEY, '2B')
      credited(out.fielders, [[SAM, SOL], [SOL]], JSON.stringify(out))
    })

    it('credits a pickoff at second to the pitcher and the shortstop', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, second: evan }),
          'Picked off at second.'
        )
      )
      const plays = running(actions)
      expect(plays, JSON.stringify(plays)).to.have.length(1)
      expect(plays[0].kind).equals('pickoff')
      expect(plays[0].runner).equals(EVAN)
      expect(plays[0].to).equals('2B')
      credited(plays[0].fielders, [[RIO_ID, SOL]], JSON.stringify(plays[0]))
    })

    it('credits a caught stealing at second to the catcher and the shortstop', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          'Caught stealing at second.'
        )
      )
      const plays = running(actions)
      expect(plays, JSON.stringify(plays)).to.have.length(1)
      expect(plays[0].kind).equals('caught_stealing')
      expect(plays[0].runner).equals(CASEY)
      expect(plays[0].to).equals('2B')
      credited(plays[0].fielders, [[CAM, SOL]], JSON.stringify(plays[0]))
    })

    it('puts number 3 in at third base, not the third baseman already there', async function () {
      const { actions, roster } = decided(
        await say('scoring', owlsUp, 'Number 3 subs in at third base.')
      )
      expect(actions).to.have.length(0)
      const player = places(roster, '3B')
      const name = (player.name ?? '').toLowerCase()
      expect(
        player.jersey === '3' || name.includes('nico'),
        JSON.stringify(player)
      ).equals(true)
      expect(name.includes('evan'), JSON.stringify(player)).equals(false)
    })

    it('moves Jared to short without naming a team', async function () {
      const { actions, roster } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex }),
          'Jared moves to short.'
        )
      )
      expect(actions).to.have.length(0)
      const name = (places(roster, 'SS').name ?? '').toLowerCase()
      expect(name, JSON.stringify(roster)).to.include('jared')
      expect(name.includes('sol'), JSON.stringify(roster)).equals(false)
    })

    it('brings Morgan in for the pitcher without a scoring play', async function () {
      const { actions, roster } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex }),
          'Morgan subs in for the pitcher.'
        )
      )
      expect(actions).to.have.length(0)
      const name = (places(roster, 'P', 'home').name ?? '').toLowerCase()
      expect(name, JSON.stringify(roster)).to.include('morgan')
      expect(name.includes('rio'), JSON.stringify(roster)).equals(false)
    })

    it('scores the runner who comes home on a sacrifice bunt', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, third: casey }),
          'Sacrifice bunt to third base, and thrown out at first. But Casey scores.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('bunt')
      handledBy(played.fielder, MATT, JSON.stringify(played))
      const result = resultOf(actions)
      expect(result.eventType).equals('field_out')
      expect(result.outBy).equals('throw')
      moved(actions, CASEY, 'home')
    })

    it('advances the runner who tags on a caught fly in right center', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, second: casey }),
          "Pop fly to right center field, it's caught. Casey tags up and takes third."
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.direction).equals('right_center')
      handledBy(played.fielder, SAM, JSON.stringify(played))
      const result = resultOf(actions)
      expect(result.eventType).equals('field_out')
      expect(result.outBy).equals('catch')
      expect(result.foulCaught).not.equals(true)
      moved(actions, CASEY, '3B')
    })

    it('scores a line drive triple to right center and the runner who scores', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          'Line drive, triple to right center field, and Casey takes home.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.direction).equals('right_center')
      expect(played.trajectory).equals('line_drive')
      handledBy(played.fielder, SAM, JSON.stringify(played))
      expect(resultType(actions)).equals('triple')
      moved(actions, CASEY, 'home')
    })

    it('advances the runner on a sacrifice bunt to the shortstop', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, second: casey }),
          'Sacrifice bunt to the shortstop, and Casey takes third.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('bunt')
      handledBy(played.fielder, SOL, JSON.stringify(played))
      const result = resultOf(actions)
      expect(result.eventType).equals('field_out')
      expect(result.outBy).equals('throw')
      moved(actions, CASEY, '3B')
    })

    it('keeps a named center fielder on a catch that robs a home run', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex }),
          'Popped up to left center, at the wall, but Sam catches it, robbing the home run.'
        )
      )
      const played = ball(actions)
      expect(played.contact).equals('swing')
      expect(played.direction).equals('left_center')
      expect(played.fielder, JSON.stringify(played)).equals(SAM)
      const result = resultOf(actions)
      expect(result.eventType).equals('field_out')
      expect(result.outBy).equals('catch')
      expect(movements(actions), JSON.stringify(actions)).to.have.length(0)
    })

    it('records a second safe pickoff at the base the runner is on', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          "A second pickoff attempt, and he's safe."
        )
      )
      const plays = running(actions)
      expect(plays, JSON.stringify(plays)).to.have.length(1)
      expect(plays[0].kind).equals('pickoff_safe')
      expect(plays[0].runner).equals(CASEY)
      expect(
        plays[0].to == null || plays[0].to === '1B',
        JSON.stringify(plays[0])
      ).equals(true)
      credited(plays[0].fielders, [], JSON.stringify(plays[0]))
      expect(actions.some(action => action.type === 'result')).equals(false)
    })

    it('records a third safe pickoff as another attempt, not an out at third', async function () {
      const { actions } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex, first: casey }),
          "Third pickoff attempt and he's still safe."
        )
      )
      const plays = running(actions)
      expect(plays, JSON.stringify(plays)).to.have.length(1)
      expect(plays[0].kind).equals('pickoff_safe')
      expect(plays[0].runner).equals(CASEY)
      expect(
        plays[0].to == null || plays[0].to === '1B',
        JSON.stringify(plays[0])
      ).equals(true)
      credited(plays[0].fielders, [], JSON.stringify(plays[0]))
      expect(actions.some(action => action.type === 'result')).equals(false)
    })

    it('puts Jared at the position of the fielder he comes in for', async function () {
      const { actions, roster } = decided(
        await say(
          'scoring',
          hawksBatting({ batter: indigo, next: alex }),
          'Jared comes in for Sol.'
        )
      )
      expect(actions).to.have.length(0)
      const name = (places(roster, 'SS', 'home').name ?? '').toLowerCase()
      expect(name, JSON.stringify(roster)).to.include('jared')
      expect(name.includes('sol'), JSON.stringify(roster)).equals(false)
    })
  }
)

/** A runner the scorer said advanced, and did not call out. */
function moved(
  actions: readonly ScoringAction[],
  runner: number,
  to: string
): ScoringAction & { type: 'runnerMovement' } {
  const advances = movements(actions).filter(move => move.out !== true)
  expect(advances, JSON.stringify(actions)).to.have.length(1)
  expect(advances[0].runner).equals(runner)
  expect(advances[0].to).equals(to)
  expect(movements(actions).some(move => move.out === true)).equals(false)
  expect(movements(actions).some(move => move.to === 'batter')).equals(false)
  return advances[0]
}

function outAt(
  actions: readonly ScoringAction[],
  runner: number,
  to: string
): ScoringAction & { type: 'runnerMovement' } {
  const outs = movements(actions).filter(move => move.out === true)
  expect(outs, JSON.stringify(actions)).to.have.length(1)
  expect(outs[0].runner).equals(runner)
  expect(outs[0].to).equals(to)
  expect(movements(actions).some(move => move.to === 'batter')).equals(false)
  return outs[0]
}

function said(player: PlayerSaid): string {
  return (player.name ?? '').toLowerCase()
}
