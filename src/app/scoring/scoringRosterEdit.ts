import type { MyRoles, RosterEntry } from '../../common/api'
import { rosterFullName } from '../../common/names'
import { keepsScore } from '../../common/roles'
import type { GameState, Side } from '../../common/scoring/state'
import { asGumboId } from '../../common/userId'
import { byJersey } from './rosterOrder'

/** Prefer the one team where the scorer holds an admin or staff role. */
export function rosterStaffSide(
  roles: Pick<MyRoles, 'teams'> | undefined,
  awayTeamId: string,
  homeTeamId: string
): Side | undefined {
  const away = (roles?.teams[awayTeamId]?.length ?? 0) > 0
  const home = (roles?.teams[homeTeamId]?.length ?? 0) > 0
  return away === home ? undefined : away ? 'away' : 'home'
}

/**
 * The one side this person keeps score for, when that is exactly one of the
 * two teams. A scorekeeper of both, or of neither, has no single side.
 */
export function scorekeeperSide(
  roles: Pick<MyRoles, 'teams'> | undefined,
  awayTeamId: string,
  homeTeamId: string
): Side | undefined {
  const away = keepsScore(roles, awayTeamId)
  const home = keepsScore(roles, homeTeamId)
  return away === home ? undefined : away ? 'away' : 'home'
}

/** What the roster row may do with a lineup QR code. */
export type LineupQrOffer = 'share' | 'scan' | 'both'

/**
 * A scorekeeper of one team shares that team's lineup and scans the
 * opponent's. Anyone who keeps score for both teams, or for neither, still
 * chooses share or scan for either side.
 */
export function lineupQrOffer(
  keeperSide: Side | undefined,
  side: Side
): LineupQrOffer {
  if (keeperSide == null) return 'both'
  return side === keeperSide ? 'share' : 'scan'
}

export interface EditRosterRow {
  key: string
  id: number
  userId?: string
  name: string
  /** Public name for the normal app's navigation frame. */
  navigationTitle: string
  sortName: string
  jersey: string
  bats: RosterEntry['bats']
  throws: RosterEntry['throws']
  positions: RosterEntry['positions']
}
function sortName(entry: RosterEntry): string {
  if (entry.nameDetails == null) return entry.shortName
  return rosterFullName({ id: entry.userId, ...entry.nameDetails })
}
/** Private names stay in presentation rows, never in the scoring snapshot. */
export function editRosterRows(
  entries: readonly RosterEntry[],
  draft: GameState,
  side: Side
): EditRosterRow[] {
  const rows: EditRosterRow[] = entries
    .filter(entry => entry.isPlayer)
    .map(entry => ({
      id: asGumboId(entry.gumboId),
      navigationTitle: entry.shortName,
      key: `player:${entry.userId}`,
      userId: entry.userId,
      name:
        entry.nameDetails == null
          ? entry.shortName
          : rosterFullName({ id: entry.userId, ...entry.nameDetails }),
      sortName: sortName(entry),
      jersey: entry.jersey?.trim() ?? '',
      bats: entry.bats,
      throws: entry.throws,
      positions: entry.positions
    }))
  for (const id of draft.liveData.boxscore.teams[side].players) {
    const player = draft.gameData.players[id]
    if (!player.local || rows.some(row => row.id === id)) continue
    rows.push({
      id,
      navigationTitle: player.fullName,
      key: `local:${id}`,
      name: player.fullName,
      sortName: player.fullName,
      jersey: player.jersey.trim(),
      bats: player.bats,
      throws: player.throws,
      positions: player.positions
    })
  }
  // Sort presentation rows without changing their persistent identities.
  rows.sort((a, b) => {
    const difference = a.id - b.id
    return difference !== 0
      ? difference
      : Number(a.userId == null) - Number(b.userId == null)
  })
  return byJersey(
    rows.map((_, index) => index),
    Object.fromEntries(
      rows.map((row, index) => [
        index,
        { jersey: row.jersey, fullName: row.sortName.toLocaleLowerCase() }
      ])
    )
  ).map(index => rows[index])
}
export const JERSEY_BADGE_SIZE = 56
export function rosterHand(value: RosterEntry['bats']): string {
  return value === 'left'
    ? 'L'
    : value === 'right'
      ? 'R'
      : value === 'switch'
        ? 'S'
        : '—'
}
export function editRosterLabel(row: EditRosterRow): string {
  return `${row.name}, ${row.jersey === '' ? 'no jersey number' : `jersey ${row.jersey}`}, bats ${row.bats ?? 'unknown'}, throws ${row.throws ?? 'unknown'}, ${row.positions.length === 0 ? '' : `positions ${row.positions.join(', ')}, `}${row.userId == null ? 'game-only player, ' : ''}edit settings`
}
