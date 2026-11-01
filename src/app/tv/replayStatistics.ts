import type {
  GameDetail,
  GameLineupsResponse,
  Lineup,
  TeamStationClient
} from '../../common/api'
import {
  type ReplayBoxScore,
  replayBoxScore
} from '../../common/replay/replayBoxScore'
import { readReplaySource } from '../../common/replay/replaySource'
import type { BoardLine } from '../../common/scoring/boardLineTypes'
import {
  freshGame,
  newSetup,
  type RosterPlayer
} from '../../common/scoring/lineup'
import type { StoredGame } from '../../common/scoring/session'
import { teamsOf, withSideLineup } from '../../common/scoring/startingSetup'
import { setupOf } from '../../common/scoring/state'
import { type BoxStep, boxTimeline } from './playbackTimeline'

export interface ReplayStatistics {
  boxes: BoxStep[]
  message: string | null
}

/** Only a game without any plays can use a present-day lineup supplement. */
export function canSupplement(game: GameDetail, stored: StoredGame): boolean {
  return (
    (game.status === 'scheduled' || game.status === 'inProgress') &&
    stored.plays.length === 0 &&
    stored.currentPlay === null
  )
}

export function startingBox(
  game: GameDetail,
  lineups: GameLineupsResponse
): ReplayBoxScore | null {
  const chosen = {
    away: lineups.away.start ?? lineups.away.current,
    home: lineups.home.start ?? lineups.home.current
  }
  const roster = (lineup: Lineup | null): RosterPlayer[] => {
    const people = [
      ...(lineup?.batters ?? []),
      ...Object.values(lineup?.defense ?? {})
    ]
    return people.flatMap((person, index) =>
      person?.gumboId == null ||
      people.findIndex(other => other?.gumboId === person.gumboId) !== index
        ? []
        : [
            {
              gumboId: person.gumboId,
              shortName: person.name,
              jersey: person.jersey
            }
          ]
    )
  }
  const rosters = { away: roster(chosen.away), home: roster(chosen.home) }
  if (chosen.away === null && chosen.home === null) return null
  const teams = teamsOf(game)
  let state = freshGame(game.id, teams, newSetup(teams, rosters))
  for (const side of ['away', 'home'] as const) {
    const lineup = chosen[side]
    if (lineup !== null) state = withSideLineup(state, side, lineup)
  }
  const box = replayBoxScore(freshGame(game.id, teams, setupOf(state)))
  // Named, unregistered lineup slots are real starters too. These negative
  // keys identify display rows only; they never enter the scoring engine or API.
  for (const side of ['away', 'home'] as const) {
    const lineup = chosen[side]
    if (lineup === null) continue
    const known = box[side].batting
    box[side].batting = lineup.batters.map(
      (person, index) =>
        known.find(row => row.id === person.gumboId) ?? {
          id: -(index + 1),
          name: person.name,
          ab: 0,
          r: 0,
          h: 0,
          rbi: 0,
          bb: 0,
          k: 0,
          sub: false,
          current: false
        }
    )
    const pitcher = lineup.defense.P
    if (pitcher !== null && pitcher.gumboId === null)
      box[side].pitching = [
        {
          id: -1,
          name: pitcher.name,
          outs: 0,
          ip: '0.0',
          h: 0,
          r: 0,
          er: 0,
          bb: 0,
          k: 0,
          pc: 0,
          current: false
        }
      ]
  }
  return box
}

export async function readTvStatistics(
  client: TeamStationClient,
  gameId: string
): Promise<ReplayStatistics> {
  try {
    const { game, stored } = await readReplaySource(client, gameId)
    const boxes = boxTimeline(game, stored)
    if (boxes.length > 0) return { boxes, message: null }
    if (!canSupplement(game, stored))
      return {
        boxes: [],
        message: 'Replay statistics are not available for this game.'
      }
    const lineups = await client.gameLineups(gameId)
    if (
      lineups.generation !== undefined &&
      stored.generation !== undefined &&
      lineups.generation !== stored.generation
    )
      return { boxes: [], message: 'The game changed. Retry statistics.' }
    const box = startingBox(game, lineups)
    return box === null
      ? { boxes: [], message: 'Starting lineups are not available yet.' }
      : { boxes: [{ at: -Infinity, box }], message: null }
  } catch (error) {
    const status = (error as { status?: number }).status
    return {
      boxes: [],
      message:
        status === 401 || status === 403
          ? 'You do not have access to these statistics.'
          : 'Statistics could not load. Retry statistics.'
    }
  }
}

/** Both static and slide-up scores are projections of the very same replay box. */
export function lineOf(box: ReplayBoxScore): BoardLine {
  const side = (which: 'away' | 'home'): BoardLine['away'] => ({
    innings: box[which].innings,
    r: box[which].runs,
    h: box[which].hits,
    e: box[which].errors
  })
  return { away: side('away'), home: side('home') }
}
