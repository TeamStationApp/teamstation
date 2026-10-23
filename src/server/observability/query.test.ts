import { expect } from 'chai'
import { describe, it } from 'mocha'

import { analyticsSql } from './query'

describe('analytics SQL positive grammar', () => {
  it('regenerates bounded selects, aggregates, dates, numeric properties and parameters', () => {
    for (const sql of [
      'select * from analytics.events',
      "select event_name,count(*) as n,date_trunc('day',occurred_at) as day from analytics.events where occurred_at >= $1 group by event_name,date_trunc('day',occurred_at) having count(*) > 0 order by n desc nulls last limit 10 offset 0",
      "select properties->>'vi',sum((properties->>'ms')::numeric) from analytics.events group by properties->>'vi'",
      "select distinct e.app from analytics.events e where e.user_id=$1 and event_name in ('a','b')",
      'select -1, +2, 1.5, true, null, coalesce(user_id, $1) from analytics.events where NOT user_id IS NULL',
      "select app from analytics.events where user_id IS NOT NULL and app NOT LIKE 'x' order by app asc nulls first",
      'select count(distinct app) from analytics.events'
    ]) {
      const result = analyticsSql(sql, ['2026-01-01'])
      expect(result.text).matches(/^SELECT \* FROM \(/)
      expect(result.text).matches(/LIMIT 1001$/)
      expect(result.values).deep.equals(['2026-01-01'])
    }
    expect(
      analyticsSql('select * from analytics.events', [null, true, 1]).values
    ).deep.equals([null, true, 1])
  })
  it('rejects every unapproved source, expression, modifier and oversized input', () => {
    const queries = [
      '',
      'select',
      'select * from users',
      'select * from events',
      'select * from pg_catalog.pg_roles',
      'select pg_sleep(10) from analytics.events',
      'select pg_catalog.count(*) from analytics.events',
      'select * into new_table from analytics.events',
      'select * from analytics.events for update',
      'delete from analytics.events',
      'select * from analytics.events; select 1',
      'with a as (delete from analytics.events returning *) select * from a',
      'select * from analytics.events union select * from analytics.events',
      'select * from analytics.events, users',
      'select * from analytics.events join users on true',
      'select (select password_hash from users) from analytics.events',
      'select current_user from analytics.events',
      'select random() from analytics.events',
      'select cast(event_id as regclass) from analytics.events',
      'select cast(event_id as text[]) from analytics.events',
      'select cast(event_id as pg_catalog.text) from analytics.events',
      'select cast(event_id as numeric(20,2)) from analytics.events',
      'select * from analytics.events limit $1',
      'select * from analytics.events limit -1',
      'select * from analytics.events offset 10001',
      'select secret from analytics.events',
      'select * from analytics.events as "Bad Alias"',
      'select app as "Bad Alias" from analytics.events',
      'select x.app from analytics.events',
      'select public.events.app from analytics.events',
      'select count(*) over () from analytics.events',
      'select distinct on (app) app from analytics.events',
      'select app COLLATE "C" from analytics.events',
      "select properties->>'chat' from analytics.events",
      "select properties->'vi' from analytics.events",
      "select app->>'vi' from analytics.events",
      'select app ~ $1 from analytics.events',
      'select $99 from analytics.events',
      'select $0 from analytics.events',
      'select ' +
        Array.from({ length: 21 }, () => 'app').join(',') +
        ' from analytics.events',
      'select coalesce(app,app,app,app,app) from analytics.events',
      'select * from analytics.events where app in (' +
        Array.from({ length: 51 }, () => "'a'").join(',') +
        ')',
      "select '" + 'x'.repeat(257) + "' from analytics.events",
      'select ' + 'NOT '.repeat(20) + 'true from analytics.events',
      'select ' +
        Array.from({ length: 200 }, () => '1').join('+') +
        ' from analytics.events',
      ' '.repeat(16385)
    ]
    for (const query of queries)
      expect(() => analyticsSql(query, ['a']), query).throws()
    for (const parameters of [
      {},
      ['x'.repeat(257)],
      Array(33).fill(0),
      [{}],
      [NaN],
      [Infinity]
    ])
      expect(() =>
        analyticsSql('select * from analytics.events', parameters)
      ).throws()
    expect(() => analyticsSql(null)).throws()
  })
})
