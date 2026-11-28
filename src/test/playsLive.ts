import type { PlayEditsData } from '../common/gameSocket'
import type { ScoringAction } from '../common/scoring/actions'
import type { StoredGame } from '../common/scoring/session'
import { inProgressGame, replayActions, scored } from './replayGameFixture'

/** What a held read of a live game was made from, as the tests name it. */
export const LIVE_READ = { generation: 1, namesDigest: 'n0' }

/**
 * The game in progress at three moments: as `inProgressGame` leaves it
 * (Muncy's at-bat with one pitch), after a called strike, and once Muncy has
 * singled and the next batter is up. Each carries the digest a read of it
 * would (`d0`, `d1`, `d2`), from one names book and generation.
 */
export async function liveGames(): Promise<{
  start: StoredGame
  pitched: StoredGame
  stored: StoredGame
}> {
  const start = await inProgressGame()
  const actions = replayActions()
  const shown = start.currentPlay?.about.atBatIndex
  if (shown == null) throw new Error('the game in progress has no at-bat')
  // Where `inProgressGame` cuts: Gil's first pitch to Muncy, after Stanton
  // moves to center. Muncy then singles; here a called strike comes first.
  const cut = actions.findIndex(
    (action, i) =>
      action.type === 'pitch' &&
      i > 0 &&
      actions[i - 1].type === 'lineup' &&
      (actions[i - 1] as { kind?: string }).kind === 'position'
  )
  const close = actions.findIndex(
    (action, i) =>
      i > cut && action.type === 'gameFlow' && action.kind === 'closePlay'
  )
  const strike: ScoringAction = { type: 'pitch', call: 'C' }
  const pitched = await scored([...actions.slice(0, cut + 1), strike])
  const stored = await scored([
    ...actions.slice(0, cut + 1),
    strike,
    ...actions.slice(cut + 1, close + 1)
  ])
  const next = stored.currentPlay?.about.atBatIndex
  if (next == null || next === shown)
    throw new Error('the next batter is not up once the at-bat is stored')
  return {
    start: { ...start, ...LIVE_READ, playsDigest: 'd0' },
    pitched: { ...pitched, ...LIVE_READ, playsDigest: 'd1' },
    stored: { ...stored, ...LIVE_READ, playsDigest: 'd2' }
  }
}

/**
 * The `playEdits` change a scorer's save from `from` to `to` sends: a put of
 * each play that is new or changed, a remove of each one gone, and the at-bat
 * in progress.
 */
export function editsBetween(from: StoredGame, to: StoredGame): PlayEditsData {
  const before = new Map(
    from.plays.map(play => [play.about.atBatIndex, JSON.stringify(play)])
  )
  const after = new Set(to.plays.map(play => play.about.atBatIndex))
  return {
    generation: to.generation ?? LIVE_READ.generation,
    fromDigest: from.playsDigest ?? null,
    digest: to.playsDigest ?? null,
    namesDigest: to.namesDigest ?? LIVE_READ.namesDigest,
    edits: [
      ...to.plays
        .filter(
          play => before.get(play.about.atBatIndex) !== JSON.stringify(play)
        )
        .map(play => ({
          op: 'put' as const,
          play: {
            id: `play_${play.about.atBatIndex}`,
            gameId: 'g1',
            gumbo: play
          }
        })),
      ...[...before.keys()]
        .filter(index => !after.has(index))
        .map(atBatIndex => ({ op: 'remove' as const, atBatIndex }))
    ],
    currentPlay: to.currentPlay
  }
}
