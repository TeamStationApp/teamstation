import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  actionFromTagSlots,
  promptContext,
  type ScoringAction,
  toolSchema
} from '../../common/scoring/actions'
import {
  rosterPrompt,
  rosterToolSchema
} from '../../common/scoring/rosterCommands'
import { applyAction } from '../../common/scoring/session'
import { Interpretation, type Turn } from '../../server/dictation/interpreter'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from './isUnscoredGame.test'
import { atRest, initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

/**
 * Sentences of the kinds dictation got wrong — a base taken for the out, a
 * force with an overthrow, the third out — said in the unit tests' game,
 * through the live model and the scoring screen's reducer. Each prints what
 * the model called, what the play recorded, how it ended and what the field
 * drew, then checks it.
 *
 *   TS_DICTATION_CONFIG=… node_modules/.bin/mocha --exit -r sucrase/register \
 *     -r ./src/test/scoringDomSetup.cjs --extension ts --timeout 180000 \
 *     src/app/scoring/dictatedForcePlays.integration.ts
 *
 * `TS_FORCE_PLAYS_LOG_ONLY=1` prints without checking, for the game as it was
 * before. `--grep library` runs only the rules' own case, which needs no key.
 * It reads new fields optionally for that reason.
 */
const logOnly = process.env.TS_FORCE_PLAYS_LOG_ONLY === '1'
const F = { SS: 14, B1: 12, B3: 15, LF: 16 }
const FIRST = 5
const SECOND = 6
const THIRD = 7

interface Case {
  name: string
  said: string
  bases: { first?: number; second?: number; third?: number }
  outs: number
  check: (ended: Ended) => void
}
interface Ended {
  state: ScoringState
  pictures: string[]
  hit?: { contactMs: number; pitched: boolean }
  note?: string
  outs: number
  top: boolean
  runs: number
  errors: number
  bases: Array<number | null>
  batter: number
}

const CASES: Case[] = [
  {
    name: 'L1',
    said: "And it's a grounder to the shortstop. Who tags second for fielder's choice.",
    bases: { first: FIRST },
    outs: 1,
    check: ended => {
      expect(ended.outs).equals(2)
      expect(ended.bases).deep.equals([ended.batter, null, null])
      expect(ended.pictures).includes(`${F.SS}>${F.SS}`)
    }
  },
  {
    name: 'L2',
    said: 'Grounder to third, and the third baseman takes third base for the out.',
    bases: { first: FIRST, second: SECOND },
    outs: 0,
    check: ended => {
      expect(ended.outs).equals(1)
      expect(ended.bases).deep.equals([ended.batter, FIRST, null])
      expect(ended.pictures).includes(`${F.B3}>${F.B3}`)
      expect(ended.pictures).not.includes(`${F.B3}>${F.B1}`)
    }
  },
  {
    name: 'L3',
    said: "And it's a grounder to the shortstop, he tags second for the out, but overthrows first. For an error, and batter is safe.",
    bases: { first: FIRST },
    outs: 0,
    check: ended => {
      expect(ended.outs).equals(1)
      expect(ended.errors).equals(1)
      expect(ended.bases[0]).equals(ended.batter)
      expect(ended.pictures).includes(`${F.SS}>${F.B1}:wild`)
    }
  },
  {
    name: 'L4',
    said: "It's a ground ball to the shortstop, he tags. Second for the out, but overthrows first for the error.",
    bases: { first: FIRST },
    outs: 2,
    check: ended => {
      expect(ended.top).equals(false)
      expect(ended.errors).equals(0)
      expect(ended.note ?? '').matches(/the error by/)
    }
  },
  {
    name: 'L5',
    said: "Pop fly to left field. And it's caught for the out, but the runner tags up and takes home.",
    bases: { second: SECOND, third: THIRD },
    outs: 2,
    check: ended => {
      expect(ended.top).equals(false)
      expect(ended.runs).equals(0)
      expect(ended.note ?? '').matches(/scoring/)
    }
  },
  {
    name: 'L6',
    said: 'Line drive double to left center field.',
    bases: { first: FIRST },
    outs: 2,
    check: ended => {
      expect(ended.state.log.map(action => action.type)).includes('ballInPlay')
      expect(ended.pictures[0]).equals('hit')
      expect(ended.bases[1]).equals(ended.batter)
    }
  },
  {
    name: 'L7',
    said: 'Sky high pop fly, center field, but the center fielder drops it, and it is an error. And everyone advances.',
    bases: { first: FIRST },
    outs: 2,
    check: ended => {
      expect(ended.errors).equals(1)
      expect(ended.bases[0]).equals(ended.batter)
      expect(ended.bases[1]).equals(FIRST)
    }
  },
  {
    name: 'L8',
    said: 'Potential walk.',
    bases: {},
    outs: 2,
    check: ended => {
      const record = ended.state.log
      expect(record.some(action => action.type === 'pitch')).equals(false)
      expect(
        record.some(
          action =>
            action.type === 'result' && action.eventType === 'intent_walk'
        )
      ).equals(true)
    }
  },
  {
    name: 'L9',
    said: 'Line drive single to left.',
    bases: {},
    outs: 0,
    check: ended => {
      expect(ended.hit).deep.equals({ contactMs: 1050, pitched: true })
    }
  }
]

function game(c: { bases: Case['bases']; outs: number }): ScoringState {
  const state = initialScoringState(scoringSession(gameFixture), true)
  const line = state.session.liveData.linescore
  for (const key of ['first', 'second', 'third'] as const) {
    const id = c.bases[key]
    line.offense[key] = id == null ? null : playerRef(state.session, id)
  }
  line.outs = c.outs
  return state
}

/** Plays the sentence out, naming each picture, and says how it ended. */
function playOut(start: ScoringState, state: ScoringState): Ended {
  const batter = start.session.liveData.plays.currentPlay!.matchup.batter.id
  const pictures: string[] = []
  let hit: Ended['hit']
  for (let step = 0; step < 150 && !atRest(state); step++) {
    const p = state.presentation
    if (p != null) {
      if (!pictures.includes(p.id) || p.kind === 'throw')
        pictures.push(
          p.kind === 'throw'
            ? `${p.thrower}>${p.receiver}${'wild' in p && p.wild === true ? ':wild' : ''}`
            : p.kind
        )
      if (p.kind === 'hit' && hit == null)
        hit = {
          contactMs: p.contactMs,
          pitched: 'pitcher' in p && p.pitcher != null
        }
      if (p.kind === 'hit' && p.stage === 'swing')
        state = scoringReducer(state, {
          type: 'PRESENTATION_CONTACT',
          id: p.id,
          generation: p.generation
        })
      const now = state.presentation!
      state = scoringReducer(state, {
        type: 'PRESENTATION_DONE',
        id: now.id,
        generation: now.generation,
        stage: now.stage
      })
      continue
    }
    const m = state.motions.find(m => !m.complete && m.held !== true)
    if (m == null) break
    state = scoringReducer(state, {
      type: 'MOTION_DONE',
      id: m.id,
      generation: m.generation
    })
  }
  const line = state.session.liveData.linescore
  const dictation = state.dictation as { note?: string } | undefined
  return {
    state,
    pictures,
    hit,
    note: dictation?.note,
    outs: line.outs,
    top: line.isTopInning,
    runs: line.teams.away.runs,
    errors: line.teams.home.errors,
    bases: [line.offense.first, line.offense.second, line.offense.third].map(
      ref => ref?.id ?? null
    ),
    batter
  }
}

function config(): { apiKey: string; baseUrl?: string } {
  const read = JSON.parse(
    readFileSync(process.env.TS_DICTATION_CONFIG ?? 'serverConfig.json', 'utf8')
  ).dictation?.anthropic
  if (typeof read?.apiKey !== 'string' || read.apiKey === '')
    throw new Error(
      'Configure dictation.anthropic for the live interpreter tests'
    )
  return read
}

describe('dictated force plays, live', function () {
  this.timeout(180000)
  for (const c of CASES)
    it(`${c.name}: ${c.said}`, async function () {
      const anthropic = config()
      const before = game(c)
      const turn: Turn = await new Interpretation(
        {
          apiKey: anthropic.apiKey,
          baseUrl: anthropic.baseUrl ?? 'https://api.anthropic.com/v1',
          model: 'claude-haiku-5-5',
          api: 'messages',
          tools: toolSchema().filter(t => t.name !== 'lineup'),
          rosterTools: rosterToolSchema()
        },
        `${promptContext(before.session)}\nROSTERS\n${rosterPrompt(before.session, ['away', 'home'])}`,
        c.said
      ).start()
      const actions: ScoringAction[] =
        turn.kind === 'actions'
          ? turn.actions.map(action =>
              actionFromTagSlots(action, before.session.meta.tagOrder)
            )
          : []
      const said = scoringReducer(before, {
        type: 'DICTATED',
        transcript: c.said,
        actions
      })
      const ended = playOut(before, said)
      console.log(`\n${c.name} — "${c.said}"`)
      console.log(`  bases ${JSON.stringify(c.bases)}, ${c.outs} out`)
      console.log(
        `  model: ${JSON.stringify(turn.kind === 'actions' ? { actions: turn.actions, dropped: turn.dropped } : turn)}`
      )
      console.log(`  recorded: ${JSON.stringify(ended.state.log)}`)
      console.log(
        `  ended: ${ended.top ? 'top' : 'bottom'}, ${ended.outs} out, runs ${ended.runs}, errors ${ended.errors}, bases ${JSON.stringify(ended.bases)} (batter ${ended.batter})`
      )
      console.log(
        `  drawn: ${ended.pictures.join(', ')}${ended.hit == null ? '' : ` (contact ${ended.hit.contactMs} ms, ${ended.hit.pitched ? 'pitched' : 'no pitch'})`}`
      )
      console.log(
        `  note: ${ended.note ?? '—'}${said.dictation?.problem == null ? '' : `; problem: ${said.dictation.problem.message}`}`
      )
      if (logOnly) return
      expect(said.dictation?.problem, JSON.stringify(said.dictation)).equals(
        undefined
      )
      c.check(ended)
    })
})

describe('library: a run after a catch makes the third out', function () {
  it('is refused when it is said, and replayed as stored', function () {
    let state = game({
      bases: { second: SECOND, third: THIRD },
      outs: 2
    }).session
    for (const action of [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'popup',
        fielder: F.LF
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' }
    ] as ScoringAction[])
      state = applyAction(state, action).state
    const run: ScoringAction = {
      type: 'runnerMovement',
      runner: THIRD,
      to: 'home'
    }
    const said = applyAction(state, run)
    const stored = applyAction(state, run, { replay: true })
    console.log(
      `\n$ applyAction(after the catch for the third out, ${JSON.stringify(run)})`
    )
    console.log(
      `  outs ${state.liveData.linescore.outs}, runs before ${state.liveData.linescore.teams.away.runs}`
    )
    console.log(
      `  said: problems ${JSON.stringify(said.problems)}, runs ${said.state.liveData.linescore.teams.away.runs}`
    )
    console.log(
      `  replayed: problems ${JSON.stringify(stored.problems)}, runs ${stored.state.liveData.linescore.teams.away.runs}`
    )
    if (logOnly) return
    expect(said.problems.map(problem => problem.code)).deep.equals(['illegal'])
    expect(stored.problems).deep.equals([])
  })
})
