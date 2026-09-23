import type { FieldPlayer, GroundPoint } from '../field/fieldModel'
import { fieldPlayersFor } from './fieldAdapter'
import type { ScoringState } from './scoringTypes'
export type PitchKind = 'ball' | 'called' | 'swing' | 'foul'
export interface Point3 extends GroundPoint {
  y: number
}
export interface PresentationSequence {
  id: string
  generation: number
  stage: 'delivery'
  kind: 'pitch'
  pitch: PitchKind
  durationMs: number
  players: FieldPlayer[]
  pitcher: number
  catcher: number
  batter: number
  batSide: 'R' | 'L'
  throwSide: 'R' | 'L'
  from: Point3
  plate: Point3
  glove: Point3
}
export const PITCH_TIMING = {
  release: 300,
  plate: 700,
  catch: 860,
  finish: 1000,
  foulFinish: 1400
} as const
export function pitchPresentation(
  state: ScoringState,
  kind: PitchKind
): PresentationSequence {
  const session = state.session
  const play = session.liveData.plays.currentPlay!
  const players = fieldPlayersFor(session)
  const pitcher = play.matchup.pitcher.id
  const catcher = session.liveData.linescore.defense.C?.id ?? pitcher
  const throwSide =
    session.gameData.players[pitcher].throws === 'left' ? 'L' : 'R'
  const location = (id: number): GroundPoint =>
    players.find(player => player.playerId === id)!.position
  return {
    id: `${state.generation}:${session.meta.sequence + 1}:pitch`,
    generation: state.generation,
    stage: 'delivery',
    kind: 'pitch',
    pitch: kind,
    durationMs: kind === 'foul' ? PITCH_TIMING.foulFinish : PITCH_TIMING.finish,
    players,
    pitcher,
    catcher,
    batter: play.matchup.batter.id,
    batSide: play.matchup.batSide.code,
    throwSide,
    from: {
      ...location(pitcher),
      x: location(pitcher).x + (throwSide === 'R' ? 1.7 : -1.7),
      y: 7
    },
    plate: { x: 0, y: 5, z: 0 },
    glove: { ...location(catcher), y: 5.2 }
  }
}
export interface PresentationRuntime {
  elapsedMs: number
  fired: Set<string>
  complete: boolean
}
export function presentationRuntime(): PresentationRuntime {
  return { elapsedMs: 0, fired: new Set(), complete: false }
}
/** A single clock supplies visual sampling and exactly-once cue boundaries. */
export function stepPresentation(
  runtime: PresentationRuntime,
  sequence: PresentationSequence,
  deltaMs: number,
  paused: boolean
): { cues: Array<'swish' | 'pop' | 'bat'>; done: boolean } {
  if (paused || runtime.complete || !Number.isFinite(deltaMs) || deltaMs <= 0)
    return { cues: [], done: false }
  runtime.elapsedMs = Math.min(sequence.durationMs, runtime.elapsedMs + deltaMs)
  const cues: Array<'swish' | 'pop' | 'bat'> = []
  for (const [id, at, cue] of [
    ['release', PITCH_TIMING.release, 'swish'],
    [
      'impact',
      sequence.pitch === 'foul' ? PITCH_TIMING.plate : PITCH_TIMING.catch,
      'pop'
    ],
    [
      'contact',
      sequence.pitch === 'foul' ? PITCH_TIMING.plate : Infinity,
      'bat'
    ]
  ] as const) {
    if (runtime.elapsedMs >= at && !runtime.fired.has(id)) {
      runtime.fired.add(id)
      cues.push(cue)
    }
  }
  const done = runtime.elapsedMs >= sequence.durationMs
  runtime.complete = done
  return { cues, done }
}
