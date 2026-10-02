import type { Kysely, Transaction } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database, TeamCreatedFrom } from '../db/database'
import { coachSurname, normaliseTeamName } from './teamNames'

/** A team of the season a fixture is played in, by id and stored name. */
interface SeasonTeam {
  id: string
  name: string
}

export interface ResolvedOpponent {
  id: string
  name: string
  /**
   * `season`: a team of the same season. `known`: one this run already
   * resolved. `external`: an external team an earlier run made. `created`: a
   * new external team.
   */
  found: 'season' | 'known' | 'external' | 'created'
}

/**
 * The TeamStation team a schedule means by an opponent's name.
 *
 * A schedule names its opponent only by a name, and different teams write the
 * same club differently, so this rule lands every schedule's fixtures on the
 * same team. In order:
 *
 * 1. A team of the same season whose normalised name matches, or whose
 *    coach's surname matches — the Hawks' own schedule writes an opponent
 *    exactly as the organisation does, while other teams write `NP3 Mize`
 *    where the organisation says `Bay Stars (Mize)`.
 * 2. An external team, `kind = external`, whose normalised name matches.
 * 3. Otherwise a new external team with the raw name.
 *
 * `known` is a cache of normalised name to id that a caller resolving many
 * fixtures passes in, so one run asks the database once per opponent.
 */
export async function resolveOpponent(
  db: Kysely<Database> | Transaction<Database>,
  rawName: string,
  options: {
    seasonTeams: SeasonTeam[]
    known?: Map<string, string>
    /** Where a team this makes came from, recorded on it. */
    createdFrom: TeamCreatedFrom
    dryRun?: boolean
  }
): Promise<ResolvedOpponent> {
  const { seasonTeams, known } = options
  const wantedName = normaliseTeamName(rawName)
  const wantedCoach = coachSurname(rawName)
  const inSeason = seasonTeams.find(other => {
    if (normaliseTeamName(other.name) === wantedName) return true
    if (wantedCoach == null) return false
    return coachSurname(other.name) === wantedCoach
  })
  if (inSeason != null) {
    return { id: inSeason.id, name: inSeason.name, found: 'season' }
  }

  const held = known?.get(wantedName)
  if (held != null) return { id: held, name: rawName, found: 'known' }

  // An external team already made by an earlier run, found by its
  // normalised name rather than by an id no schedule gives.
  const existing = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('kind', '=', 'external')
    .execute()
  const match = existing.find(row => normaliseTeamName(row.name) === wantedName)
  if (match != null) {
    known?.set(wantedName, match.id)
    return { id: match.id, name: match.name, found: 'external' }
  }

  const id = makeId('team')
  known?.set(wantedName, id)
  if (options.dryRun !== true) {
    await db
      .insertInto('teams')
      .values({
        id,
        name: rawName,
        kind: 'external',
        created_from: options.createdFrom
      })
      .execute()
  }
  return { id, name: rawName, found: 'created' }
}
