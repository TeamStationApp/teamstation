import { asArray, asNumber, asObject, asString } from 'cleaners'

import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { storedRecordOf } from './gumbo'
import { scoringFingerprintInput } from './scoringMutation'

/** Recent accepted changes, independent of the surviving scoring timeline. */
const storedUpdateFields = {
  id: asString,
  sequence: asNumber,
  userId: asString,
  lines: asArray(asString)
}
const asStoredScoringUpdates = asArray(asObject(storedUpdateFields))
export const asScoringUpdate = asObject({
  ...storedUpdateFields,
  name: asString
})
export type ScoringUpdate = ReturnType<typeof asScoringUpdate>
export const asScoringUpdates = asArray(asScoringUpdate)
export const SCORING_UPDATE_LIMIT = 100

const words = (text: string): string =>
  text.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
const capital = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1)

/** No player names are persisted in this public description stream. */
export function scoringActionLine(action: ScoringAction): string | undefined {
  switch (action.type) {
    case 'lineup':
      return undefined
    case 'pitch':
      return {
        B: 'Ball',
        C: 'Called strike',
        S: 'Swing and miss',
        F: 'Foul ball',
        T: 'Foul tip',
        L: 'Foul bunt'
      }[action.call]
    case 'ballInPlay':
      return (
        capital(words(action.trajectory ?? action.contact)) +
        (action.direction == null ? '' : ` to ${words(action.direction)}`)
      )
    case 'result':
      return (
        capital(words(action.eventType)) +
        (action.outBy == null ? '' : ` (${words(action.outBy)})`)
      )
    case 'runnerMovement':
      return (
        `Runner ${action.out === true ? 'out at' : 'to'} ${action.to}` +
        (action.reason == null ? '' : ` (${words(action.reason)})`)
      )
    case 'baseRunning':
      return (
        capital(words(action.kind)) +
        (action.to == null ? '' : ` at ${action.to}`)
      )
    case 'batteryEvent':
      return capital(words(action.kind))
    case 'fieldingPlay':
      return action.error == null ? 'Fielding play' : 'Fielding error'
    case 'gameFlow':
      return action.kind === 'closePlay'
        ? undefined
        : capital(words(action.kind))
  }
}

interface Step {
  key: string
  line: string
}
function steps(plays: ReadonlyArray<GumboPlay | CurrentPlay | null>): Step[] {
  // A reopened current at-bat overrides its retained completed event row.
  const byIndex = new Map<number, GumboPlay | CurrentPlay>()
  for (const play of plays)
    if (play != null) byIndex.set(play.about.atBatIndex, play)
  return [...byIndex]
    .sort(([a], [b]) => a - b)
    .flatMap(([index, play]) =>
      (storedRecordOf(play)?.actions ?? []).flatMap(action => {
        const line = scoringActionLine(action)
        return line == null
          ? []
          : [
              {
                key: `${index}:${scoringFingerprintInput(action)}`,
                line: `${play.about.halfInning === 'top' ? 'Top' : 'Bot'} ${play.about.inning}: ${line}`
              }
            ]
      })
    )
}

/** Compare canonical accepted histories, never a viewer's optimistic draft. */
export function scoringUpdateLines(
  before: ReadonlyArray<GumboPlay | CurrentPlay | null>,
  after: ReadonlyArray<GumboPlay | CurrentPlay | null>
): string[] {
  const old = steps(before)
  const next = steps(after)
  let shared = 0
  while (
    shared < old.length &&
    shared < next.length &&
    old[shared].key === next[shared].key
  )
    shared++
  const lines = [
    ...old
      .slice(shared)
      .reverse()
      .map(step => `Undo — ${step.line}`),
    ...next.slice(shared).map(step => step.line)
  ]
  // A reconnect can report a large deliberate rewrite without unbounded reads.
  return lines.length <= 100
    ? lines
    : [...lines.slice(0, 99), `${lines.length - 99} more scoring changes`]
}

/** Metadata is server-owned; never read this from an incoming scoring body. */
export function storedScoringUpdates(
  mutation: unknown
): Array<Omit<ScoringUpdate, 'name'>> {
  if (mutation == null || typeof mutation !== 'object') return []
  const updates = (mutation as { updates?: unknown }).updates
  return updates == null ? [] : asStoredScoringUpdates(updates)
}
