import type { Kysely, Transaction } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database, TeamCreatedFrom } from '../db/database'
import { teamNameKey } from './teamNames'

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
 * The TeamStation team a schedule means by an opponent's name, found only by
 * the name itself (`teamNameKey`: trimmed, spaces collapsed, any case). In
 * order:
 *
 * 1. A team of the same season with that name.
 * 2. A team this run already found or made by it (`known`).
 * 3. The oldest external team, `kind = external`, with that name.
 * 4. Otherwise a new external team with the raw name.
 *
 * A name written another way — a trailing number, a bracket, a coach's
 * surname — is another team here; a client that knows better names the team
 * by its id. `known` is a cache of name key to id that a caller resolving
 * many fixtures passes in, so one run asks the database once per opponent.
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
  const wantedName = teamNameKey(rawName)
  const inSeason = seasonTeams.find(
    other => teamNameKey(other.name) === wantedName
  )
  if (inSeason != null) {
    return { id: inSeason.id, name: inSeason.name, found: 'season' }
  }

  const held = known?.get(wantedName)
  if (held != null) return { id: held, name: rawName, found: 'known' }

  // An external team already made by an earlier run, found by its name.
  // Two of one name resolve to the older, every time.
  const existing = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('kind', '=', 'external')
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const match = existing.find(row => teamNameKey(row.name) === wantedName)
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
