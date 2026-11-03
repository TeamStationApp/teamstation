import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { scratchDatabase } from '../../test/scoreboardKit'
import type { ValkeyCache } from '../cache/valkeyCache'
import type { Database } from '../db/database'
import { teamRosterCore } from '../teams/rosterCore'
import { main, renewRosterCacheEpoch } from './rosterCacheEpoch'

describe('roster-cache-epoch', function () {
  this.timeout(60_000)

  let db: Kysely<Database>
  let url = ''
  let drop: (() => Promise<void>) | undefined
  const TEAM = 'tem_rce_team'
  const kept = { gumboId: 8_300_001, userId: userIdOfGumbo(8_300_001) }
  const later = { gumboId: 8_300_002, userId: userIdOfGumbo(8_300_002) }

  before(async function () {
    ;({ db, url, drop } = await scratchDatabase('rostercacheepoch'))
    await insertFixtureUsers(db, [
      { id: kept.gumboId, display_name: 'Kept Member' },
      { id: later.gumboId, display_name: 'Later Member' }
    ])
    await db
      .insertInto('teams')
      .values({ id: TEAM, name: TEAM, kind: 'full' })
      .execute()
  })

  after(async function () {
    await drop?.()
  })

  /** Valkey as it stands while the database is restored: untouched. */
  const held = new Map<string, string>()
  const cache: ValkeyCache = {
    get: async key => held.get(key) ?? null,
    set: async (key, value) => {
      held.set(key, value)
    },
    close: async () => undefined
  }

  const membersRead = async (): Promise<string[]> =>
    (await teamRosterCore(db, TEAM, cache)).members.map(row => row.userId)

  const epochNow = async (): Promise<string> =>
    (
      await db
        .selectFrom('roster_cache_epoch')
        .select('epoch')
        .executeTakeFirstOrThrow()
    ).epoch

  it('keeps a restored database from reading the rosters Valkey held before', async function () {
    await db
      .insertInto('memberships')
      .values({ id: 'mem_rce_kept', team_id: TEAM, user_id: kept.userId })
      .execute()
    // The point the database is later restored to.
    const { last } = (
      await sql<{
        last: string
      }>`select last_value::text as last from team_roster_version_seq`.execute(
        db
      )
    ).rows[0]
    await db
      .insertInto('memberships')
      .values({ id: 'mem_rce_later', team_id: TEAM, user_id: later.userId })
      .execute()
    expect(await membersRead()).deep.equals([kept.userId, later.userId])
    expect(held.size).equals(1)

    // Restored: the later member's row, its bump and the sequence wound back,
    // and Valkey as it was.
    await db
      .deleteFrom('team_roster_bumps')
      .where('version', '>', Number(last))
      .execute()
    await sql`select setval('team_roster_version_seq', ${Number(last)})`.execute(
      db
    )
    await db
      .deleteFrom('memberships')
      .where('id', '=', 'mem_rce_later')
      .execute()
    // The delete's bump reissues the version the cached roster was stored
    // under, so the roster reads a member the database does not hold.
    expect(await membersRead()).deep.equals([kept.userId, later.userId])

    const before = await epochNow()
    const renewed = await renewRosterCacheEpoch(db)
    expect(renewed.previous).equals(before)
    expect(renewed.epoch).not.equals(before)
    expect(await epochNow()).equals(renewed.epoch)
    // Under the new epoch nothing held before is read.
    expect(await membersRead()).deep.equals([kept.userId])
    expect(held.size).equals(2)
  })

  it('prints the old epoch and the new one', async function () {
    const before = await epochNow()
    const printed: string[] = []
    const log = console.log
    console.log = (line: string) => printed.push(line)
    try {
      await main(url)
    } finally {
      console.log = log
    }
    expect(printed).deep.equals([
      `roster cache epoch: ${before} -> ${await epochNow()}`
    ])
  })

  it('writes an epoch where the database has none', async function () {
    await db.deleteFrom('roster_cache_epoch').execute()
    const renewed = await renewRosterCacheEpoch(db)
    expect(renewed.previous).equals(null)
    expect(await epochNow()).equals(renewed.epoch)
  })
})
