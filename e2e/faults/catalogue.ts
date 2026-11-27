/**
 * Every fault the suite proves it can catch. Each is applied from outside the app, so
 * production code gains no hooks.
 */
export type FaultLayer =
  'invariant' | 'expect' | 'read-back' | 'golden' | 'video'

export interface Fault {
  how: 'proxy' | 'style' | 'process' | 'stream'
  /** Any of these layers catching it counts as caught where it was meant to be. */
  caughtBy: FaultLayer[]
}

export const FAULTS: Record<string, Fault> = {
  'api-500': { how: 'proxy', caughtBy: ['invariant', 'expect'] },
  'api-hang': { how: 'proxy', caughtBy: ['invariant', 'expect'] },
  'api-garbage': { how: 'proxy', caughtBy: ['invariant', 'expect'] },
  'socket-drop': { how: 'proxy', caughtBy: ['invariant', 'expect'] },
  'wrong-data': { how: 'proxy', caughtBy: ['expect', 'read-back'] },
  'not-saved': { how: 'proxy', caughtBy: ['expect', 'read-back'] },
  'layout-shift': { how: 'style', caughtBy: ['golden'] },
  'hidden-element': { how: 'style', caughtBy: ['expect', 'golden'] },
  'missing-font': { how: 'style', caughtBy: ['golden'] },
  'blank-screen': { how: 'style', caughtBy: ['invariant'] },
  'app-crash': { how: 'process', caughtBy: ['invariant'] },
  'frozen-video': { how: 'stream', caughtBy: ['video'] },
  'no-audio': { how: 'stream', caughtBy: ['video'] }
}

/**
 * Per category, a fault that cannot reach it and why. Written when the category is
 * converted, never just to get through a milestone.
 */
export const EXCUSED: Record<string, Record<string, string>> = {
  // Tess's category, `assistant`.
  assistant: {
    'frozen-video':
      'Tess plays no stream of her own. The only video beside her is a generated clip whose element and clock she must leave alone, which those scenarios read directly; whether its picture moves belongs to the video category.',
    'no-audio':
      'Tess plays no sound: her clip has no audio track, and her only audio is the microphone going in, whose loss socket-drop and push-to-talk cover.'
  }
}

/** The problems with a converted category's faults, for `validate`. */
export function faultProblems(
  named: Record<string, string[]>,
  pending: string[],
  excused: Record<string, Record<string, string>> = EXCUSED
): string[] {
  const problems: string[] = []
  for (const [category, faults] of Object.entries(named)) {
    for (const fault of faults) {
      if (FAULTS[fault] == null) {
        problems.push(`${category}: unknown fault "${fault}"`)
      }
    }
    if (pending.includes(category)) continue
    for (const fault of Object.keys(FAULTS)) {
      if (!faults.includes(fault) && excused[category]?.[fault] == null) {
        problems.push(
          `${category}: no spec names "${fault}", and the catalogue excuses it nowhere`
        )
      }
    }
  }
  return problems
}
