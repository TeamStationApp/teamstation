import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { promptContext, toolSchema } from '../../common/scoring/actions'
import {
  rosterPrompt,
  rosterToolSchema
} from '../../common/scoring/rosterCommands'
import { Interpretation } from '../../server/dictation/interpreter'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { atRest, initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'

/** Real interpreter through canonical scoring, Gumbo credits and every throw.
 * Run explicitly with mocha -r sucrase/register --timeout 180000.
 * The service credential is read from the ignored local configuration.
 */
describe('dictated defensive routes through the real interpreter', function () {
  this.timeout(180000)
  for (const example of [
    {
      said: '6-4-3 double play',
      runner: true,
      throws: ['14>13', '13>12'],
      credits: [
        [5, 14, 'f_assist'],
        [5, 13, 'f_putout'],
        [1, 13, 'f_assist'],
        [1, 12, 'f_putout']
      ],
      outs: 2
    },
    {
      said: 'Grounder fielded by the first baseman and thrown to the pitcher for the out',
      runner: false,
      throws: ['12>10'],
      credits: [
        [1, 12, 'f_assist'],
        [1, 10, 'f_putout']
      ],
      outs: 1
    }
  ])
    it(example.said, async function () {
      const config = JSON.parse(
        readFileSync(
          process.env.TS_DICTATION_CONFIG ?? 'serverConfig.json',
          'utf8'
        )
      ).dictation?.anthropic
      if (typeof config?.apiKey !== 'string' || config.apiKey === '')
        throw new Error(
          'Configure dictation.anthropic before running interpreter integration tests'
        )
      const before = initialScoringState(
        createDevelopmentSession(gameFixture, [], []),
        true
      )
      if (example.runner)
        before.session.liveData.linescore.offense.first = playerRef(
          before.session,
          5
        )
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
      let state = scoringReducer(before, {
        type: 'DICTATED',
        transcript: example.said,
        actions: turn.actions
      })
      expect(state.dictationQuestion).equals(undefined)
      const throws: string[] = []
      for (let i = 0; i < 60 && !atRest(state); i++) {
        const p = state.presentation
        if (p != null) {
          if (p.kind === 'throw') throws.push(`${p.thrower}>${p.receiver}`)
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
          const motion = state.motions.find(m => !m.complete && m.held !== true)
          if (motion == null) break
          state = scoringReducer(state, {
            type: 'MOTION_DONE',
            id: motion.id,
            generation: motion.generation
          })
        }
      }
      expect(throws).deep.equals(example.throws)
      expect(state.session.liveData.linescore.outs).equals(example.outs)
      const play = state.session.liveData.plays.allPlays.at(-1)!
      expect(
        play.runners.flatMap(r =>
          (r.credits ?? []).map(c => [
            r.details.runner.id,
            c.player.id,
            c.credit
          ])
        )
      ).deep.equals(example.credits)
      console.log(
        JSON.stringify({
          said: example.said,
          actions: turn.actions,
          throws,
          credits: example.credits
        })
      )
      expect(
        scoringReducer(state, { type: 'UNDO' }).session.liveData.linescore.outs
      ).equals(0)
    })
})
