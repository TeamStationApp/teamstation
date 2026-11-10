import {
  asArray,
  asNumber,
  asObject,
  asOptional,
  asString,
  asUnknown
} from 'cleaners'

import { cleanAction, type ScoringAction } from '../../common/scoring/actions'
import { sameAction, type ScoringSession } from '../../common/scoring/session'
import type { PreferenceStorage } from './scoringPreferenceStore'

/**
 * A game's plays a build refused as too old to save (`updateRequired`) had
 * not saved, kept on this device until a newer build opens the game. On the
 * web the update is a reload, which would lose what only the page held; a
 * phone's queue keeps its own.
 */
const heldKey = (account: string, gameId: string): string =>
  `scoring.held.${account}.${gameId}`

const asHeld = asObject({
  /** The play generation and the sides the log was scored on. */
  generation: asOptional(asNumber),
  home: asString,
  away: asString,
  actions: asArray(asUnknown),
  times: asArray(asOptional(asString))
})

/** The teams a session's game names home and away. */
const sidesOf = (session: ScoringSession): { home: string; away: string } => ({
  home: session.state.gameData.teams.home.id,
  away: session.state.gameData.teams.away.id
})

/**
 * Keeps the game's whole log on this device for `account`, the person signed
 * in, with the generation and sides it was scored on, once a save of it is
 * refused as too old, and again after each change the scorer makes after
 * that, until the session is closed. Answers the function that stops it.
 */
export function holdWhenOutdated(
  session: ScoringSession,
  storage: PreferenceStorage,
  account: string
): () => void {
  let kept: string | undefined
  let stop = (): void => undefined
  const keep = (): void => {
    // A session closed for another read of the game holds nothing more: a
    // newer one may have kept the game's log since.
    if (session.isClosed) {
      stop()
      return
    }
    if (!session.outdated) return
    const log = JSON.stringify({
      ...(session.generation === undefined
        ? {}
        : { generation: session.generation }),
      ...sidesOf(session),
      actions: session.actions,
      times: session.actionStamps.map(time => time ?? null)
    })
    // An action replaced keeps the log's length: its whole text says.
    if (log === kept) return
    kept = log
    storage
      .setItem(heldKey(account, session.gameId), log)
      .catch(() => undefined)
  }
  keep()
  stop = session.subscribe(keep)
  return stop
}

/** Forgets the log kept of the game. */
async function forget(storage: PreferenceStorage, key: string): Promise<void> {
  // A storage that cannot remove a key keeps it empty instead.
  await (storage.removeItem?.(key) ?? storage.setItem(key, '')).catch(
    () => undefined
  )
}

/** Whether `actions` begin with `start`, action for action. */
function beginsWith(
  actions: readonly ScoringAction[],
  start: readonly ScoringAction[]
): boolean {
  return (
    start.length <= actions.length &&
    start.every((action, i) => sameAction(action, actions[i]))
  )
}

/**
 * Plays the actions this device kept of the game for `account` on top of
 * what the server holds, when what it holds is where the kept log began, on
 * the same generation of the game with the same sides, and saves them; the
 * kept log is forgotten once the session has saved all it holds, then or on a
 * later save. One the server holds whole
 * already is forgotten too. One the server has moved past, a game reset or
 * swapped since, or a log this build cannot read, is kept: it is the only
 * copy of those plays. Answers how many actions it played.
 */
export async function restoreHeld(
  session: ScoringSession,
  storage: PreferenceStorage,
  account: string
): Promise<number> {
  const key = heldKey(account, session.gameId)
  const raw = await storage.getItem(key).catch(() => null)
  if (raw == null || raw === '') return 0
  let held: ReturnType<typeof asHeld>
  try {
    held = asHeld(JSON.parse(raw))
  } catch {
    return 0
  }
  const actions: ScoringAction[] = []
  for (const action of held.actions) {
    const cleaned = cleanAction(action)
    if ('problem' in cleaned) return 0
    actions.push(cleaned.action)
  }
  // A copy: the session's own grows as the kept actions are played.
  // Scored on another generation of the game, or with its sides the other
  // way round: the server's plays are not where this log began.
  const sides = sidesOf(session)
  if (
    held.generation !== session.generation ||
    held.home !== sides.home ||
    held.away !== sides.away
  )
    return 0
  const saved = [...session.actions]
  if (beginsWith(saved, actions)) {
    await forget(storage, key)
    return 0
  }
  if (!beginsWith(actions, saved)) return 0
  let played = 0
  for (const [i, action] of actions.entries()) {
    if (i < saved.length) continue
    const time = held.times[i]
    const applied = session.apply(action, time == null ? {} : { time })
    if (applied.problems.length > 0) break
    played++
  }
  // Kept until the session has saved all it holds, at once or later: a
  // log left once its plays went on would play an undo of them back.
  if (played === actions.length - saved.length) {
    let stop = (): void => undefined
    let forgotten = false
    const whenSaved = async (): Promise<void> => {
      if (
        forgotten ||
        session.pending > 0 ||
        session.outdated ||
        session.problem != null
      )
        return
      forgotten = true
      stop()
      await forget(storage, key)
    }
    stop = session.subscribe(() => {
      whenSaved().catch(() => undefined)
    })
    await session.flush()
    await whenSaved()
  }
  return played
}
