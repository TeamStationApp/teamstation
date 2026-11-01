import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { onePerson } from '../../src/server/admin/people'
import { actorForToken } from '../../src/server/auth/sessions'
import { amountsFor, SCALES } from './amounts'
import {
  accountsForShard,
  cleanupRun,
  describeShapes,
  gameOfViewer,
  inTurn,
  interleaved,
  newRunId,
  parseShard,
  readCredentials,
  readTokens,
  type SeededAccount,
  seedFixture,
  systemOf,
  taggedIn,
  type TokensFile,
  verifyShapes,
  viewersByLabel,
  writeTokens
} from './fixture'
import { TEST_AMOUNTS } from './testAmounts'
import { openScratch, type Scratch } from './testSupport'

describe('the scale table', function () {
  it('has the amounts of the full-scale fixtures', function () {
    expect(SCALES.full).deep.include({
      accounts: 5000,
      leagues: 2,
      seasons: 6,
      teams: 100,
      liveGames: 50,
      finishedGames: 500,
      historyGames: 8000,
      dmShare: 0.1,
      mergedRows: 24,
      chainDepth: 10,
      guardianChildren: 8,
      guardianChildDepth: 5,
      roleTeams: 80,
      roleSeasons: 30,
      roleLeagues: 6,
      largeLeagueSeasons: 20,
      largeLeagueTeams: 300,
      duplicateTeams: 24,
      teamChainDepth: 4,
      longTeamGames: 600,
      longGameInnings: 24,
      crowdedViewers: 600,
      crowdedWorstCaseViewers: 20,
      largeChatMembers: 600,
      largeChatMessages: 10000,
      manyChats: 60,
      manySessions: 20,
      chatAddPeople: 50
    })
  })
})

describe('the fixture', function () {
  this.timeout(180_000)

  let scratch: Scratch
  let dir: string
  let tokensPath: string
  let tokens: TokensFile
  const amounts = amountsFor('small', TEST_AMOUNTS)

  before(async function () {
    scratch = await openScratch('fixture')
    dir = mkdtempSync(join(tmpdir(), 'dbload-fixture-'))
    tokensPath = join(dir, 'tokens.json')
    tokens = await seedFixture(scratch.db, {
      runId: 'first',
      scale: 'small',
      overrides: TEST_AMOUNTS,
      tokensPath
    })
  })
  after(async function () {
    rmSync(dir, { recursive: true })
    await scratch.drop()
  })

  const account = (label: string): SeededAccount => {
    const found = tokens.accounts.find(row => row.label === label)
    if (found == null) throw new Error(`no account ${label}`)
    return found
  }

  it('refuses a database without the mark, before writing anything', async function () {
    const unmarked = await openScratch('unmarked', false)
    try {
      let message = ''
      await seedFixture(unmarked.db, { runId: 'no', scale: 'small' }).catch(
        (error: Error) => {
          message = error.message
        }
      )
      expect(message).contains('not marked for load testing')
      const users = await unmarked.db.selectFrom('users').select('id').execute()
      expect(users).deep.equals([])
      message = ''
      await cleanupRun(unmarked.db, 'no').catch((error: Error) => {
        message = error.message
      })
      expect(message).contains('not marked for load testing')
    } finally {
      await unmarked.drop()
    }
  })

  it('reads every worst-case shape back as designed', async function () {
    const shapes = await describeShapes(scratch.db, 'first', tokens)
    verifyShapes(shapes, amounts)
    expect(shapes.mergedRows).equals(24)
    expect(shapes.chainDepth).equals(10)
    expect(shapes.guardianChildDepths).deep.equals(new Array(8).fill(5))
    expect(shapes.duplicateTeams).equals(24)
    expect(shapes.teamChainDepth).equals(4)
    expect(shapes.longGame.innings).equals(24)
    expect(shapes.longGame.plays).above(200)
    expect(shapes.longGame.recordVersions).deep.equals([1, 2, 3])
    expect(shapes.longGame.lineupChanges).above(0)
    expect(shapes.statsBuilt).equals(shapes.finishedGames)
    expect(shapes.kinds).include.members([
      'person.admin',
      'person.coach',
      'person.scorekeeper',
      'person.guardian',
      'person.teamMember',
      'person.seasonMember',
      'person.leagueMember',
      'person.seasonRole',
      'person.leagueRole',
      'person.merged',
      'person.disabled',
      'person.revokedSession',
      'person.expiredSession',
      'person.apiToken',
      'person.userKey'
    ])
    expect(shapes.copies).deep.equals({
      teamMerge: 3,
      personMerge: 3,
      signOut: 3,
      statsRebuild: 3,
      chatAdd: 3
    })
  })

  it('copies what the triggers wrote for a game with its copies', async function () {
    const count = async (table: string): Promise<number[]> => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from ${sql.table(table)} c
          join events e on e.id = c.${sql.ref(table === 'eventCredits' ? 'eventId' : 'event_id')}
          join external_ids t on t.entity_id = e."gameId"
        where t.system = 'dbloadfirst'
          and t.external_id in ('history.source', 'history.00000')
        group by e."gameId"
      `.execute(scratch.db)
      return rows.map(row => Number(row.n))
    }
    const players = await count('event_players')
    expect(players.length).equals(2)
    expect(players[0]).above(0)
    expect(players[0]).equals(players[1])
    const credits = await count('eventCredits')
    expect(credits.length).equals(2)
    expect(credits[0]).equals(credits[1])
    const { rows } = await sql<{ tgenabled: string }>`
      select tgenabled from pg_trigger
      where not tgisinternal and tgrelid = 'events'::regclass
    `.execute(scratch.db)
    expect(rows.every(row => row.tgenabled === 'O')).equals(true)
  })

  it('says which shape differs when one is short', async function () {
    const shapes = await describeShapes(scratch.db, 'first', tokens)
    expect(() => {
      verifyShapes({ ...shapes, chainDepth: 9 }, amounts)
    }).throws('chain depth: 9, wanted 10')
    expect(() => {
      verifyShapes({ ...shapes, crowdedViewers: 1 }, amounts)
    }).throws('crowded game: 1 viewers')
  })

  it('writes tokens that authenticate, at mode 0600, and dead ones that do not', async function () {
    expect(statSync(tokensPath).mode & 0o777).equals(0o600)
    const read = readTokens(tokensPath)
    expect(read.runId).equals('first')
    expect(read.accounts.length).equals(tokens.accounts.length)
    for (const row of [
      account('viewer00000'),
      account('person.admin'),
      account('person.apiToken'),
      account('person.userKey'),
      account('worst.chain')
    ]) {
      const actor = await actorForToken(scratch.db, row.token, {
        recordUse: false
      })
      expect(actor?.userId, row.label).equals(row.userId)
    }
    for (const label of [
      'person.revokedSession',
      'person.expiredSession',
      'person.disabled',
      'person.merged'
    ]) {
      const actor = await actorForToken(scratch.db, account(label).token, {
        recordUse: false
      })
      expect(actor, label).equals(undefined)
    }
  })

  it('makes a repeat seed the same shapes, and cleanup takes only its own rows', async function () {
    const second = await seedFixture(scratch.db, {
      runId: 'second',
      scale: 'small',
      overrides: TEST_AMOUNTS
    })
    const firstShapes = await describeShapes(scratch.db, 'first', tokens)
    const secondShapes = await describeShapes(scratch.db, 'second', second)
    expect(secondShapes).deep.equals(firstShapes)
    expect(second.accounts.map(row => row.label)).deep.equals(
      tokens.accounts.map(row => row.label)
    )

    const stranger = await scratch.db
      .insertInto('leagues')
      .values({ id: 'lea_notThisRun', name: 'Not this run', short_name: 'NO' })
      .returning('id')
      .executeTakeFirstOrThrow()

    const secondUsers = [
      ...(await taggedIn(scratch.db, 'second', 'user')).values()
    ]
    const { removed } = await cleanupRun(scratch.db, 'second')
    expect(removed.users).equals(secondUsers.length)
    const left = await scratch.db
      .selectFrom('users')
      .select('id')
      .where('id', 'in', secondUsers)
      .execute()
    expect(left).deep.equals([])
    expect(await taggedIn(scratch.db, 'second', 'user')).property('size', 0)

    // The first run reads exactly as it did, and the stranger is still there.
    expect(await describeShapes(scratch.db, 'first', tokens)).deep.equals(
      firstShapes
    )
    const kept = await scratch.db
      .selectFrom('leagues')
      .select('id')
      .where('id', '=', stranger.id)
      .execute()
    expect(kept.length).equals(1)
    await scratch.db
      .deleteFrom('leagues')
      .where('id', '=', stranger.id)
      .execute()
  })

  it('chooses viewers by label, whichever write finished first', async function () {
    const account = (label: string, kind: string): SeededAccount =>
      ({ label, kind }) as SeededAccount
    expect(
      viewersByLabel([
        account('viewer00002', 'viewer'),
        account('person.admin', 'person'),
        account('viewer00000', 'viewer'),
        account('viewer00001', 'viewer')
      ]).map(row => row.label)
    ).deep.equals(['viewer00000', 'viewer00001', 'viewer00002'])

    const users = await taggedIn(scratch.db, 'first', 'user')
    const teams = await taggedIn(scratch.db, 'first', 'team')
    const members = await scratch.db
      .selectFrom('memberships')
      .select('user_id')
      .where('team_id', '=', teams.get('chat.largeTeam') as string)
      .execute()
    const joined = new Set(members.map(row => row.user_id))
    expect(
      [...users]
        .filter(([label, id]) => label.startsWith('viewer') && joined.has(id))
        .map(([label]) => label)
        .sort()
    ).deep.equals(
      Array.from(
        { length: TEST_AMOUNTS.largeChatMembers },
        (_, i) => `viewer${String(i).padStart(5, '0')}`
      )
    )
  })

  it('deals shards that are disjoint and cover every account', function () {
    const all = accountsForShard(tokens, amounts.accounts)
    expect(all.length).equals(amounts.accounts)
    const a = accountsForShard(tokens, amounts.accounts, { index: 0, count: 2 })
    const b = accountsForShard(tokens, amounts.accounts, { index: 1, count: 2 })
    const labels = (rows: SeededAccount[]): string[] =>
      rows.map(row => row.label)
    expect(labels(a).filter(label => labels(b).includes(label))).deep.equals([])
    expect([...labels(a), ...labels(b)].sort()).deep.equals(labels(all).sort())
    expect(parseShard('1/2')).deep.equals({ index: 1, count: 2 })
    for (const bad of ['2/2', 'x', '0/0'])
      expect(() => parseShard(bad)).throws('--shard')
  })

  it('refuses more users than were seeded, saying so', function () {
    const connectable = tokens.accounts.filter(
      row => row.kind === 'viewer' || row.kind === 'worstCase'
    ).length
    expect(() => accountsForShard(tokens, connectable + 1)).throws(
      `--users ${connectable + 1} is above the ${connectable} accounts seeded for 5 game(s) of run first`
    )
  })

  it('connects only those who can see the games in the run', function () {
    const crowd = accountsForShard(tokens, 5, undefined, 1)
    expect(crowd.every(row => row.gameIndex === 0)).equals(true)
    expect(() => accountsForShard(tokens, 40, undefined, 1)).throws(
      'seeded for 1 game(s)'
    )
  })

  it('places worst-case people at one in twenty among the viewers', function () {
    const viewers = Array.from({ length: 40 }, (_, i) => ({
      label: `v${i}`,
      kind: 'viewer'
    })) as SeededAccount[]
    const worst = Array.from({ length: 3 }, (_, i) => ({
      label: `w${i}`,
      kind: 'worstCase'
    })) as SeededAccount[]
    const person = [{ label: 'p', kind: 'person' }] as SeededAccount[]
    const mixed = interleaved([...person, ...worst, ...viewers])
    expect(
      mixed.slice(0, 40).filter(row => row.kind === 'worstCase').length
    ).equals(2)
    expect(mixed[19].kind).equals('worstCase')
    expect(mixed[mixed.length - 1].label).equals('p')
    // More worst-case people than viewers still places them all.
    expect(interleaved(worst).map(row => row.label)).deep.equals([
      'w0',
      'w1',
      'w2'
    ])
  })

  it('crowds one game and thins the rest', function () {
    const games = Array.from({ length: 1000 }, (_, i) =>
      gameOfViewer(i, 1000, 100, 5)
    )
    const counts = [0, 1, 2, 3, 4].map(
      game => games.filter(row => row === game).length
    )
    expect(counts[0]).equals(100)
    expect(counts[1]).above(counts[2])
    expect(counts[2]).above(counts[4])
    expect(counts.reduce((sum, n) => sum + n, 0)).equals(1000)
    expect(gameOfViewer(5, 10, 0, 1)).equals(0)
  })

  it('knows its scales and run ids', function () {
    expect(() => amountsFor('enormous')).throws('Unknown --scale enormous')
    expect(amountsFor('small').accounts).equals(SCALES.small.accounts)
    const few = amountsFor('small', { accounts: 7 })
    expect(few.accounts).equals(7)
    expect(few.crowdedViewers).equals(7)
    expect(few.largeChatMembers).equals(7)
    expect(systemOf('abc')).equals('dbloadabc')
    expect(() => systemOf('not valid')).throws('A run id')
    expect(newRunId(35)).equals('z')
  })

  it('refuses a file that is not a tokens file', function () {
    const path = join(dir, 'other.json')
    writeTokens(path, { accounts: 'no' } as unknown as TokensFile)
    expect(() => readTokens(path)).throws('not a tokens file')
  })

  it('stops a seed that cannot fit its games, keeping the tokens made', async function () {
    const short = join(dir, 'short.json')
    let message = ''
    await seedFixture(scratch.db, {
      runId: 'short',
      scale: 'small',
      overrides: { teams: 2, liveGames: 2 },
      tokensPath: short
    }).catch((error: Error) => {
      message = error.message
    })
    expect(message).contains('2 teams cannot play 2 games')
    expect(readTokens(short).runId).equals('short')
    await cleanupRun(scratch.db, 'short')
  })

  it('runs a few at a time and answers in order', async function () {
    let running = 0
    let most = 0
    const answers = await inTurn([1, 2, 3, 4, 5], 2, async value => {
      running += 1
      most = Math.max(most, running)
      await new Promise(resolve => {
        setTimeout(resolve, 5)
      })
      running -= 1
      return value * 2
    })
    expect(answers).deep.equals([2, 4, 6, 8, 10])
    expect(most).equals(2)
  })
})

describe('a seed for a browser run', function () {
  this.timeout(180_000)

  let scratch: Scratch
  let dir: string
  let credentialsPath: string
  const amounts = amountsFor('small', TEST_AMOUNTS)

  before(async function () {
    scratch = await openScratch('browser')
    dir = mkdtempSync(join(tmpdir(), 'dbload-browser-'))
    credentialsPath = join(dir, 'credentials.json')
    await seedFixture(scratch.db, {
      runId: 'browser',
      scale: 'small',
      overrides: TEST_AMOUNTS,
      credentialsPath
    })
  })
  after(async function () {
    rmSync(dir, { recursive: true })
    await scratch.drop()
  })

  it('writes credentials at mode 0600, holding only generated accounts', async function () {
    expect(statSync(credentialsPath).mode & 0o777).equals(0o600)
    const read = readCredentials(credentialsPath)
    expect(read.runId).equals('browser')
    expect(read.accounts.length).above(10)
    for (const row of read.accounts) {
      expect(row.email).matches(/@example\.test$/)
      expect(row.password.length).at.least(20)
    }
    expect(new Set(read.accounts.map(row => row.password)).size).equals(
      read.accounts.length
    )
    const stored = await scratch.db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', read.accounts[0].userId)
      .executeTakeFirstOrThrow()
    expect(stored.password_hash).not.includes(read.accounts[0].password)
    expect(Object.values(read.places).every(value => value != null)).equals(
      true
    )
    expect(() => {
      writeFileSync(join(dir, 'other.json'), '{}')
      readCredentials(join(dir, 'other.json'))
    }).throws('is not a credentials file')
  })

  it('merges a played player into a row that played none of it', async function () {
    const { mergedPlayerId, mergedPlayerGames } =
      readCredentials(credentialsPath).places
    const kept = await onePerson(scratch.db, mergedPlayerId)
    expect(kept.userIds.length).equals(2)
    expect(mergedPlayerGames).equals(amounts.finishedGames)
  })

  it('ends with the organization set up, so people may create groups', async function () {
    const setting = await scratch.db
      .selectFrom('system_settings')
      .select('value')
      .where('key', '=', 'creation.hierarchyReady')
      .executeTakeFirstOrThrow()
    expect(setting.value).equals(true)
  })
})
