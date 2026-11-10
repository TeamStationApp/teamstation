import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../../migrate/migrations'
import { migrateUp } from '../../../migrate/runner'
import {
  dropScratchDatabase,
  testDatabaseUrl
} from '../../../migrate/testDatabase'
import { readPasswordRecord } from '../../auth/passwords'
import { type Database, makeDatabase } from '../../db/database'
import { accountMailEnabled } from '../../email/accountMail'
import { serverConfig } from '../../serverConfig'
import { createAccount, type FixtureManifest, makeNonce } from './accounts'
import { isTestAddress, splitMailbox, testAddress } from './address'
import { refuseRealAddresses, runBaseline } from './baseline'
import {
  parseFixtureArgs,
  refuseWithoutTestSettings,
  runCli,
  runFixture,
  WORLDS
} from './cli'
import { NODE_SETTINGS, UNSET_SETTINGS } from './nodeSettings'
import { runTeamWithRoster } from './teamWithRoster'

const MAILBOX = 'testmailbox@example.test'
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_fixtures_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

/** The message `run` rejects with, or fails when it resolves. */
async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a rejection')
}

describe('fixture addresses', function () {
  it('makes only + addresses on the mailbox, and knows one when it sees one', function () {
    expect(testAddress(MAILBOX, 'World-Role-1')).equals(
      'testmailbox+world-role-1@example.test'
    )
    expect(isTestAddress(MAILBOX, 'TestMailbox+a@example.test')).equals(true)
    expect(isTestAddress(MAILBOX, MAILBOX)).equals(false)
    expect(isTestAddress(MAILBOX, 'pat+a@example.test')).equals(false)
    expect(isTestAddress(MAILBOX, 'testmailbox+a@other.test')).equals(false)
  })

  it('refuses a mailbox that is not one', function () {
    for (const bad of [
      '',
      'nobody',
      '@example.test',
      'a@',
      'a+b@example.test'
    ]) {
      expect(() => splitMailbox(bad)).to.throw('not a plain mailbox')
    }
  })
})

describe('the fixtures script', function () {
  it('refuses unless testSettings is true, whatever NODE_ENV says', function () {
    const saved = process.env.NODE_ENV
    for (const env of ['production', 'test', undefined]) {
      process.env.NODE_ENV = env
      expect(() => {
        refuseWithoutTestSettings(false)
      }).to.throw('testSettings')
    }
    process.env.NODE_ENV = saved
    refuseWithoutTestSettings(true)
  })

  it('refuses to run without a mailbox or a known world', function () {
    expect(() => parseFixtureArgs(['baseline', '--json'])).to.throw('Usage')
    expect(() => parseFixtureArgs(['--mailbox', MAILBOX])).to.throw('Usage')
    expect(() => parseFixtureArgs(['nowhere', '--mailbox', MAILBOX])).to.throw(
      'No fixture world'
    )
    expect(() =>
      parseFixtureArgs(['baseline', '--mailbox', 'not-a-mailbox'])
    ).to.throw('not a plain mailbox')
    expect(
      parseFixtureArgs(['baseline', '--json', '--mailbox', MAILBOX])
    ).deep.equals({ world: 'baseline', mailbox: MAILBOX })
    expect(Object.keys(WORLDS)).includes('team-with-roster')
  })
})

describe('fixture worlds', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  const the = (): Kysely<Database> => {
    if (db == null) throw new Error('no database')
    return db
  }

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
  })

  after(async function () {
    await db?.destroy()
    if (adminPool != null) {
      await dropScratchDatabase(adminPool, scratchName)
      await adminPool.end()
    }
  })

  it('baseline succeeds on an empty database, and a second run is idempotent', async function () {
    const first = await runBaseline(the(), MAILBOX)
    expect(Object.keys(first.accounts).sort()).deep.equals(['admin', 'member'])
    const users = async (): Promise<number> =>
      (await the().selectFrom('users').select('id').execute()).length
    const count = await users()
    const second = await runBaseline(the(), MAILBOX)
    expect(second.accounts).deep.equals({})
    expect(await users()).equals(count)
    expect(await accountMailEnabled(the())).equals(true)
    const rows = await the()
      .selectFrom('system_settings')
      .select(['key', 'value'])
      .execute()
    for (const [key, value] of Object.entries(NODE_SETTINGS)) {
      expect(rows.find(row => row.key === key)?.value, key).deep.equals(value)
    }
    const admin = first.accounts.admin
    expect(admin.role).equals('admin')
    const row = await the()
      .selectFrom('users')
      .select(['is_admin', 'password_hash', 'onboarding_step'])
      .where('id', '=', admin.userId as never)
      .executeTakeFirstOrThrow()
    expect(row.is_admin).equals(true)
    expect(row.onboarding_step).equals('complete')
    // F5: stored hashed, in no row in plain text.
    expect(row.password_hash).not.includes(admin.password)
    expect(readPasswordRecord(row.password_hash)).not.equals(null)
  })

  it('baseline refuses a database holding any other address', async function () {
    const other = 'otherbox@example.test'
    expect(
      await rejection(async () => await runBaseline(the(), other))
    ).includes('not test addresses')
    expect(
      await rejection(async () => {
        await refuseRealAddresses(the(), other)
      })
    ).includes('baseline refuses')
  })

  it('gives two worlds under different nonces no user or team in common', async function () {
    const run = async (): Promise<FixtureManifest> =>
      await runTeamWithRoster({
        db: the(),
        mailbox: MAILBOX,
        nonce: makeNonce()
      })
    const [a, b] = [await run(), await run()]
    expect(a.nonce).not.equals(b.nonce)
    expect(a.ids.team).not.equals(b.ids.team)
    const ids = (m: FixtureManifest): string[] =>
      Object.values(m.accounts).map(account => account.userId)
    expect(ids(a).filter(id => ids(b).includes(id))).deep.equals([])
    const emails = Object.values(a.accounts).map(account => account.email)
    expect(emails.every(email => isTestAddress(MAILBOX, email))).equals(true)
    const members = await the()
      .selectFrom('memberships')
      .select('user_id')
      .where('team_id', '=', a.ids.team)
      .execute()
    expect(members.length).greaterThanOrEqual(2)
    const team = await the()
      .selectFrom('teams')
      .select('name')
      .where('id', '=', a.ids.team)
      .executeTakeFirstOrThrow()
    expect(team.name).includes(a.nonce)
  })

  it('creates accounts with no role by default and distinct passwords', async function () {
    const context = { db: the(), mailbox: MAILBOX, nonce: makeNonce() }
    const person = { first: 'Pat', last: 'Neshek' }
    const one = await createAccount(context, 'w', 'one', person)
    const two = await createAccount(context, 'w', 'two', person)
    expect(one.password).not.equals(two.password)
    expect(one.email).not.equals(two.email)
    expect(one.displayName).equals('Pat Neshek')
  })

  it('prints the manifest on stdout, and only why it failed on stderr', async function () {
    const saved = serverConfig.testSettings
    const savedUrl = serverConfig.databaseUrl
    const printed: string[] = []
    const failed: string[] = []
    const out = {
      log: (line: string) => printed.push(line),
      error: (line: string) => failed.push(line)
    }
    try {
      serverConfig.testSettings = true
      serverConfig.databaseUrl = scratchUrl
      const argv = ['team-with-roster', '--json', '--mailbox', MAILBOX]
      expect(await runCli(argv, out)).equals(0)
      expect(JSON.parse(printed[0]).world).equals('team-with-roster')
      expect(failed).deep.equals([])
      expect(await runCli(['nowhere', '--mailbox', MAILBOX], out)).equals(1)
      expect(failed[0]).includes('No fixture world')
      expect(printed.length).equals(1)
    } finally {
      serverConfig.testSettings = saved
      serverConfig.databaseUrl = savedUrl
    }
  })

  it('runs through the script guard against the configured database', async function () {
    const saved = serverConfig.testSettings
    const savedUrl = serverConfig.databaseUrl
    serverConfig.testSettings = false
    try {
      expect(
        await rejection(
          async () => await runFixture({ world: 'baseline', mailbox: MAILBOX })
        )
      ).includes('testSettings')
      serverConfig.testSettings = true
      serverConfig.databaseUrl = scratchUrl
      const baseline = await runFixture({ world: 'baseline', mailbox: MAILBOX })
      expect(baseline.world).equals('baseline')
      const world = await runFixture({
        world: 'team-with-roster',
        mailbox: MAILBOX
      })
      expect(world.accounts.coach.role).equals('coach')
    } finally {
      serverConfig.testSettings = saved
      serverConfig.databaseUrl = savedUrl
    }
  })
})

/** Every `.ts` under a directory, tests aside. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

describe('settings a node holds outside migrations', function () {
  it('names every key the server reads, or says why it needs no row', function () {
    const keys = new Set<string>()
    for (const file of sources('src/server')) {
      if (file.includes('/dev/fixtures/')) continue
      const text = readFileSync(file, 'utf8')
      if (!text.includes('system_settings')) continue
      for (const match of text.matchAll(
        /\.where\('key', '(?:=|like)', '([^']+)'\)/g
      )) {
        keys.add(match[1].replace(/%$/, ''))
      }
      for (const match of text.matchAll(
        /(?:Key|KEY)\s*=\s*'([a-zA-Z]+\.[a-zA-Z.]+)'/g
      )) {
        keys.add(match[1])
      }
    }
    expect(keys.size).greaterThan(0)
    const known = (key: string): boolean =>
      NODE_SETTINGS[key] != null ||
      Object.keys(UNSET_SETTINGS).some(prefix => key.startsWith(prefix))
    expect([...keys].filter(key => !known(key))).deep.equals([])
    expect(keys.has('creation.hierarchyReady')).equals(true)
  })
})
