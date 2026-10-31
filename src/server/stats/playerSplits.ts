import type { Kysely } from 'kysely'

import {
  compareSplits,
  type StatSplit,
  type StatSplitBy
} from '../../common/playerStatSplits'
import { inningsPitched } from '../../common/statExtras'
import type { Database } from '../db/database'
import {
  type BattingLine,
  battingLines,
  type BattingRates,
  battingRates,
  type PitchingLine,
  pitchingLines,
  type PitchingRates,
  pitchingRates
} from '../stats'
import type { StatRowWithGame } from './rows'

export interface SplitBatting {
  split: StatSplit
  line: BattingLine & { rates: BattingRates }
}

export interface SplitPitching {
  split: StatSplit
  line: PitchingLine & { ip: string; rates: PitchingRates }
}

export interface PlayerSplits {
  by: StatSplitBy
  batting: SplitBatting[]
  pitching: SplitPitching[]
}

/**
 * A player's total, split into the rows it is the sum of: by team for a
 * career, by game for a season, a team or a year.
 *
 * Each row is the same arithmetic as the total, over its own lines, so a row
 * exists only where that kind of line exists — a team they only pitched for
 * has a pitching row and no batting row — and the rows are the split of the
 * total rather than a second population. `rows` are the reader's already:
 * whatever visibility left out of the total is left out of the rows.
 */
export async function playerSplits(
  db: Kysely<Database>,
  rows: readonly StatRowWithGame[],
  by: StatSplitBy
): Promise<PlayerSplits> {
  const groups = new Map<string, StatRowWithGame[]>()
  for (const row of rows) {
    // One game's lines for both sides, a pool player's, are a row each: a row
    // has one team and one opponent to be labelled by.
    const key =
      by === 'team'
        ? (row.teamId ?? '')
        : `${row.gameId}\u0000${row.teamId ?? ''}`
    const group = groups.get(key)
    if (group == null) groups.set(key, [row])
    else group.push(row)
  }

  // The stored lines know the player's team and not the other one, so a
  // game's opponent is read from the game, by which side the player was on.
  const games =
    by === 'game' && groups.size > 0
      ? new Map(
          (
            await db
              .selectFrom('games')
              .innerJoin('teams as home', 'home.id', 'games.home_team_id')
              .innerJoin('teams as away', 'away.id', 'games.away_team_id')
              .select([
                'games.id as id',
                'games.home_team_id as homeTeamId',
                'games.away_team_id as awayTeamId',
                'home.name as homeName',
                'away.name as awayName'
              ])
              .where('games.id', 'in', [
                ...new Set(rows.map(row => row.gameId))
              ])
              .execute()
          ).map(game => [game.id, game])
        )
      : undefined

  const batting: SplitBatting[] = []
  const pitching: SplitPitching[] = []
  for (const group of groups.values()) {
    const latest = group.reduce((a, b) => (startOf(b) > startOf(a) ? b : a))
    const first = group[0]
    const game = games?.get(first.gameId)
    const home =
      game == null || first.teamId == null
        ? null
        : first.teamId === game.homeTeamId
          ? true
          : first.teamId === game.awayTeamId
            ? false
            : null
    const split: StatSplit = {
      teamId: first.teamId,
      teamName: first.teamName,
      seasonName: latest.seasonName,
      gameId: by === 'game' ? first.gameId : null,
      startAt: isoOf(latest.startAt),
      opponentName:
        home == null || game == null
          ? null
          : home
            ? game.awayName
            : game.homeName,
      home
    }
    const [battingLine] = battingLines(group)
    if (battingLine != null) {
      batting.push({
        split,
        line: { ...battingLine, rates: battingRates(battingLine) }
      })
    }
    const [pitchingLine] = pitchingLines(group)
    if (pitchingLine != null) {
      pitching.push({
        split,
        line: {
          ...pitchingLine,
          ip: inningsPitched(pitchingLine.outs),
          rates: pitchingRates(pitchingLine)
        }
      })
    }
  }
  const order = (a: { split: StatSplit }, b: { split: StatSplit }): number =>
    compareSplits(a.split, b.split)
  return { by, batting: batting.sort(order), pitching: pitching.sort(order) }
}

function startOf(row: StatRowWithGame): number {
  return row.startAt == null ? -Infinity : new Date(row.startAt).getTime()
}

function isoOf(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString()
}
