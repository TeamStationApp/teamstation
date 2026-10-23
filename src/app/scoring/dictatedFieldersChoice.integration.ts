import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  actionFromTagSlots,
  promptContext,
  toolSchema
} from '../../common/scoring/actions'
import {
  rosterPrompt,
  rosterToolSchema
} from '../../common/scoring/rosterCommands'
import { Interpretation } from '../../server/dictation/interpreter'
import {
  choiceOccupancyPhrases,
  choiceRelayPhrases,
  choiceTimingPhrases
} from '../../test/fieldersChoicePhrases'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from './isUnscoredGame.test'
import { atRest, initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'

/** Explicit live Haiku run; absence of credentials is a failure, never a skip. */
describe('real dictated fielder choice animation and defensive credits', function () {
  this.timeout(180000)
  for (const example of [
    ...choiceOccupancyPhrases,
    ...choiceRelayPhrases,
    ...choiceTimingPhrases
  ])
    it(`${example.mask}/${example.startingOuts}: ${example.said}`, async function () {
      const config = JSON.parse(
        readFileSync(
          process.env.TS_DICTATION_CONFIG ?? 'serverConfig.json',
          'utf8'
        )
      ).dictation?.anthropic
      if (typeof config?.apiKey !== 'string' || config.apiKey === '')
        throw new Error(
          'Configure dictation.anthropic for the live interpreter tests'
        )
      const before = initialScoringState(scoringSession(gameFixture), true)
      for (const [index, key] of (
        ['first', 'second', 'third'] as const
      ).entries())
        before.session.liveData.linescore.offense[key] =
          (example.mask & (1 << index)) !== 0
            ? playerRef(before.session, index + 6)
            : null
      before.session.liveData.linescore.outs = example.startingOuts
      const turn = await new Interpretation(
        {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl ?? 'https://api.anthropic.com/v1',
          model: 'claude-haiku-5-5',
          api: 'messages',
          tools: toolSchema().filter(t => t.name !== 'lineup'),
          rosterTools: rosterToolSchema()
        },
        `${promptContext(before.session)}\nROSTERS\n${rosterPrompt(before.session, ['away', 'home'])}`,
        example.said
      ).start()
      expect(turn.kind, JSON.stringify(turn)).equals('actions')
      if (turn.kind !== 'actions') return
      expect(turn.dropped, JSON.stringify(turn)).deep.equals([])
      let state = scoringReducer(before, {
        type: 'DICTATED',
        transcript: example.said,
        // The model names players by tag slot, as the server's route maps them.
        actions: turn.actions.map(action =>
          actionFromTagSlots(action, before.session.meta.tagOrder)
        )
      })
      expect(
        state.dictation?.problem,
        JSON.stringify({ turn, problem: state.dictation })
      ).equals(undefined)
      expect(
        state.dictationQuestion,
        JSON.stringify({ turn, question: state.dictationQuestion })
      ).equals(undefined)
      const throws: number[][] = []
      for (let step = 0; step < 150 && !atRest(state); step++) {
        const p = state.presentation
        if (p != null) {
          if (p.kind === 'throw') throws.push([p.thrower, p.receiver])
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
        } else {
          const m = state.motions.find(m => !m.complete && m.held !== true)
          expect(m, 'reel stalled').not.equals(undefined)
          state = scoringReducer(state, {
            type: 'MOTION_DONE',
            id: m!.id,
            generation: m!.generation
          })
        }
      }
      expect(atRest(state)).equals(true)
      expect(throws, JSON.stringify(turn)).deep.equals(example.throws)
      const play =
        state.session.pending == null
          ? state.session.liveData.plays.allPlays.at(-1)!
          : state.session.liveData.plays.currentPlay!
      expect(play.source.teamstation.outcome).equals("Fielder's Choice")
      expect(
        play.runners.some(r => r.details.runner.id === 1 && r.movement.isOut)
      ).equals(false)
      expect(play.runners.filter(r => r.movement.isOut)).length(example.outs)
      if (example.runs != null)
        expect(state.session.liveData.linescore.teams.away.runs).equals(
          example.runs
        )
      expect(
        play.runners.flatMap(r =>
          r.credits
            .filter(c => c.credit === 'f_putout' || c.credit === 'f_assist')
            .map(c => [r.details.runner.id, c.player.id, c.credit])
        ),
        JSON.stringify(turn)
      ).deep.equals(example.credits)
      expect(scoringReducer(state, { type: 'UNDO' }).session).deep.equals(
        before.session
      )
      console.log(
        JSON.stringify({
          said: example.said,
          actions: turn.actions,
          throws,
          credits: example.credits
        })
      )
    })
})
