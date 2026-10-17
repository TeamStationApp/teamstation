import { sql } from 'kysely'

/** Current surviving plays/actions, not the game's sticky in-progress status. */
export const hasScoringEventsSql = sql<boolean>`(
  exists(select 1 from events where events."gameId" = games.id)
  or case when jsonb_typeof(games."currentPlay"->'teamStation'->'actions') = 'array'
    then jsonb_array_length(games."currentPlay"->'teamStation'->'actions') > 0
    else false end
)`
