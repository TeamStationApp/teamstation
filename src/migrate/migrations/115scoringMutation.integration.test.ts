import { expect } from 'chai'
import { sql } from 'kysely'
import { describe, it } from 'mocha'

import {
  addGame,
  addScorableTeams,
  scratchDatabase
} from '../../test/scoreboardKit'
import { migration115ScoringMutation } from './115scoringMutation'

describe('115 scoring mutation migration', function () {
  this.timeout(60000)
  it('keeps existing games unstamped and reverses without deleting scoring data', async () => {
    const { db, drop } = await scratchDatabase('mutation_migration')
    try {
      await sql.raw(migration115ScoringMutation.down).execute(db)
      const context = await addScorableTeams(db, {
        home: 'Hawks',
        away: 'Gulls'
      })
      const id = await addGame(db, {
        homeTeamId: context.teams.home.id,
        awayTeamId: context.teams.away.id,
        startAt: new Date()
      })
      await sql.raw(migration115ScoringMutation.up).execute(db)
      expect(
        (
          await db
            .selectFrom('games')
            .select('scoring_mutation')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).scoring_mutation
      ).equals(null)
      await db
        .updateTable('games')
        .set({
          scoring_mutation: { at: 1, id: 'test', revision: 0, frontier: 0 }
        })
        .where('id', '=', id)
        .execute()
      await sql`insert into schema_migrations (name) values ('113scoringMutation')`.execute(
        db
      )
      await sql.raw(migration115ScoringMutation.up).execute(db)
      expect(
        (
          await db
            .selectFrom('games')
            .select('scoring_mutation')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).scoring_mutation
      ).deep.equals({ at: 1, id: 'test', revision: 0, frontier: 0 })
      expect(
        (
          await sql`select name from schema_migrations where name = '113scoringMutation'`.execute(
            db
          )
        ).rows
      ).deep.equals([])
      await sql.raw(migration115ScoringMutation.down).execute(db)
      expect(
        (
          await db
            .selectFrom('games')
            .select('id')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).id
      ).equals(id)
      const columns = await sql<{
        column_name: string
      }>`select column_name from information_schema.columns where table_name='games' and column_name='scoring_mutation'`.execute(
        db
      )
      expect(columns.rows).deep.equals([])
    } finally {
      await drop()
    }
  })
})
