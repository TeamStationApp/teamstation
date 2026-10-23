import { readFileSync, writeFileSync } from 'node:fs'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import {
  actionFromTagSlots,
  type BallInPlayAction,
  type PitchAction,
  promptContext,
  type ScoringAction,
  toolSchema
} from '../../common/scoring/actions'
import { PITCH_TYPES } from '../../common/scoring/pitchType'
import {
  rosterPrompt,
  rosterToolSchema
} from '../../common/scoring/rosterCommands'
import { fieldInfoOf } from '../../common/scoring/state'
import { Interpretation, type Turn } from '../../server/dictation/interpreter'
import { placePhrases } from '../../test/dictationPlacePhrases'
import { scoringSession } from '../../test/scoringSession'
import { OUTFIELD_RADIUS } from '../field/stadiumBoundary'
import * as geometry from './dictatedGeometry'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'

/**
 * Where a ball or a pitch went, said to the real interpreter and scored
 * through the screen: the stored distance in feet at a 200 ft fence, the
 * foul's spot, and the pitch event Gumbo gets. Run explicitly:
 *
 *   TS_DICTATION_CONFIG=… mocha --exit -r sucrase/register \
 *     -r ./src/test/scoringDomSetup.cjs --extension ts --timeout 180000 \
 *     src/app/scoring/dictatedDistance.integration.ts
 *
 * TS_SAVE_INTERPRETED=<file> writes each sentence's actions there, for the
 * simulator acceptance. TS_DISTANCE_LOG_ONLY=1 logs what each sentence came
 * to without asserting, so the same run shows the game as it was before.
 * It reads new exports optionally for that reason.
 */
const logOnly = process.env.TS_DISTANCE_LOG_ONLY === '1'
/** How far from the plate a stored spot is, in whole feet at this fence. */
const distanceFeet = (
  point: { x: number; z: number },
  fenceFt: number
): number =>
  Math.round((Math.hypot(point.x, point.z) * fenceFt) / OUTFIELD_RADIUS)

function scoreable(turn: Turn): boolean {
  if (turn.kind !== 'actions') return false
  const balls = turn.actions.filter(action => action.type === 'ballInPlay')
  const results = turn.actions.filter(action => action.type === 'result')
  return balls.length <= 1 && (balls.length === 0 || results.length > 0)
}
const interpreted: Array<{ said: string; actions: ScoringAction[] }> = []

describe('where a dictated ball or pitch went, through the real interpreter', function () {
  this.timeout(180000)
  after(function () {
    const file = process.env.TS_SAVE_INTERPRETED
    if (file != null) writeFileSync(file, JSON.stringify(interpreted, null, 2))
  })

  for (const example of placePhrases)
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
      const before = initialScoringState(scoringSession(gameFixture), false)
      before.session.gameData.venue = { fieldInfo: fieldInfoOf(200) }
      const ask = async (): Promise<Turn> =>
        await new Interpretation(
          {
            apiKey: config.apiKey,
            baseUrl: config.baseUrl ?? 'https://api.anthropic.com/v1',
            model: 'claude-haiku-5-5',
            api: 'messages',
            tools: toolSchema().filter(tool => tool.name !== 'lineup'),
            rosterTools: rosterToolSchema()
          },
          `${promptContext(before.session)}\nROSTERS\n${rosterPrompt(before.session, ['away', 'home'])}`,
          example.said
        ).start()
      // As the prompt cases do: a reply that cannot be scored — a question,
      // or a ball in play with no result — is asked once more.
      const first = await ask()
      const turn = scoreable(first) ? first : await ask()
      if (turn.kind !== 'actions') {
        console.log(JSON.stringify({ said: example.said, turn }))
        if (!logOnly) expect(turn.kind, JSON.stringify(turn)).equals('actions')
        return
      }
      // The model names players by tag slot, as the server's route maps them.
      const actions = turn.actions.map(action =>
        actionFromTagSlots(action, before.session.meta.tagOrder)
      )
      interpreted.push({ said: example.said, actions })
      const state = scoringReducer(before, {
        type: 'DICTATED',
        transcript: example.said,
        actions
      })
      const play =
        state.session.liveData.plays.currentPlay?.playEvents.length === 0
          ? state.session.liveData.plays.allPlays.at(-1)
          : state.session.liveData.plays.currentPlay
      const ball = state.log.find(
        (action): action is BallInPlayAction => action.type === 'ballInPlay'
      )
      const pitch = state.log.find(
        (action): action is PitchAction => action.type === 'pitch'
      )
      const coordinates =
        play?.hitData?.coordinates ??
        state.session.liveData.plays.allPlays.at(-1)?.hitData?.coordinates
      const feet =
        coordinates == null ? undefined : distanceFeet(coordinates, 200)
      const foulPlace = (
        geometry as {
          foulPlace?: (
            game: unknown,
            pitch: PitchAction
          ) => { x: number; z: number } | undefined
        }
      ).foulPlace
      const spot =
        pitch == null || foulPlace == null
          ? undefined
          : foulPlace(state.session, pitch)
      const thrown = play?.playEvents.filter(event => event.isPitch).at(-1)
      console.log(
        JSON.stringify({
          said: example.said,
          actions,
          stored: {
            feet,
            depth: ball?.depth,
            foul:
              pitch?.call === 'F'
                ? { direction: pitch.direction, depth: pitch.depth, spot }
                : undefined,
            type: thrown?.details.type,
            pitchData: thrown?.pitchData
          }
        })
      )
      if (logOnly) return
      expect(state.dictation?.problem, JSON.stringify(state.dictation)).equals(
        undefined
      )
      if (example.kind === 'ball') {
        expect(feet, `${example.said} ${JSON.stringify(ball)}`).within(
          ...example.feet
        )
        return
      }
      if (example.kind === 'foul') {
        expect(pitch?.call).equals('F')
        expect(spot, JSON.stringify(pitch)).not.equals(undefined)
        expect(Math.sign(spot!.x)).equals(
          example.direction === 'right' ? 1 : -1
        )
        expect(Math.abs(spot!.x)).greaterThan(-spot!.z)
        // At the depth the words gave it.
        expect(Math.hypot(spot!.x, spot!.z), JSON.stringify(pitch)).closeTo(
          geometry.depthUnits(example.depth, 200),
          0.5
        )
        return
      }
      if (example.pitchType !== undefined)
        expect(thrown?.details.type?.code).equals(
          example.pitchType == null
            ? undefined
            : PITCH_TYPES[example.pitchType].code
        )
      if (example.location != null)
        expect(thrown?.pitchData?.location).deep.include(example.location)
    })
})
