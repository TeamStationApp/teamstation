import { expect } from 'chai'
import { it } from 'mocha'
import type { Pool } from 'pg'

import { migrations } from './migrations'
import { migrateDown, migrateUp } from './runner'

it('applies only the two coach migrations to a deployed history and rolls them back in reverse order', async () => {
  const start = migrations.findIndex(step => step.name === '103TeamHeadCoach')
  expect(start).greaterThan(0)
  const deployed = migrations.slice(0, start).map(step => step.name)
  const expected = ['103TeamHeadCoach', '104ManagerScheduling']
  const history = [...deployed]
  const ddl: string[] = []
  const pool = {
    query: async (sql: string) => {
      if (sql === 'show server_version_num')
        return { rows: [{ server_version_num: '180000' }] }
      if (sql.includes('to_regclass'))
        return { rows: [{ name: 'schema_migrations' }] }
      if (sql.includes('order by name desc'))
        return {
          rows: history
            .slice(-2)
            .reverse()
            .map(name => ({ name }))
        }
      return { rows: history.map(name => ({ name })) }
    },
    connect: async () => ({
      release: () => undefined,
      query: async (sql: string, values: string[]) => {
        if (sql.startsWith('insert into schema_migrations'))
          history.push(values[0])
        if (sql.startsWith('delete from schema_migrations'))
          expect(history.pop()).equals(values[0])
        if (sql.includes('alter table')) ddl.push(sql)
      }
    })
  } as unknown as Pool
  const catalog = migrations.slice(0, start + 2)
  expect((await migrateUp(pool, catalog)).applied).deep.equals(expected)
  expect((await migrateUp(pool, catalog)).applied).deep.equals([])
  expect(await migrateDown(pool, catalog, 2)).deep.equals(
    [...expected].reverse()
  )
  expect(history).deep.equals(deployed)
  expect(ddl[0]).includes('create unique index team_one_head_coach')
  expect(ddl[1]).includes('default true')
  expect(ddl[2]).includes('drop column avoid_head_coach_conflicts')
  expect(ddl[3]).includes('drop column is_head_coach')
})
