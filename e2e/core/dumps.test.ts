import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  accountsPath,
  DUMP_MAILBOX,
  dumpAccount,
  dumpArgs,
  dumpPath,
  dumpProblems,
  EXCLUDED_TABLES,
  isDumpWorld,
  makeDump,
  MAX_DUMP_BYTES,
  type PgTool,
  tablesWithData
} from './dumps'

const MIGRATIONS = Array.from(
  { length: 30 },
  (_, i) => `${String(i).padStart(3, '0')}m`
)

const LISTING = `;
; Archive created at 2026-11-26
3401; 1259 16390 TABLE public users teamstation
3402; 1259 16391 TABLE public audit_log teamstation
3403; 1259 16392 TABLE analytics events teamstation
3600; 0 16390 TABLE DATA public users teamstation
`

function account(userId: string): Record<string, unknown> {
  return {
    role: 'coach',
    email: 'dumps+coach@example.test',
    password: 'pw',
    userId,
    displayName: 'Aaron Boone',
    teams: [{ id: 't1', name: 'Hosts' }],
    games: [],
    people: []
  }
}

describe('dump worlds', function () {
  let root: string
  let n = 0
  before(function () {
    root = mkdtempSync(join(tmpdir(), 'dumps-test-'))
  })
  after(function () {
    rmSync(root, { recursive: true, force: true })
  })

  /** A root holding one dump world, and the files git would list. */
  function world(
    options: {
      bytes?: number
      migration?: string
      accounts?: Record<string, unknown> | null
    } = {}
  ): { at: string; files: string[] } {
    const at = join(root, `r${n++}`)
    mkdirSync(join(at, 'e2e', 'fixtures', 'dumps'), { recursive: true })
    writeFileSync(dumpPath(at, 'w-dump'), Buffer.alloc(options.bytes ?? 16))
    const files = ['e2e/fixtures/dumps/w-dump.dump']
    if (options.accounts !== null) {
      writeFileSync(
        accountsPath(at, 'w-dump'),
        JSON.stringify({
          world: 'w-dump',
          source: 'coach-game',
          migration: options.migration ?? MIGRATIONS[29],
          accounts: options.accounts ?? { coach: account('user-1') }
        })
      )
      files.push('e2e/fixtures/dumps/w-dump.accounts.json')
    }
    return { at, files }
  }

  const pg =
    (listing = LISTING, users = 'COPY public.users\nuser-1\t…\n'): PgTool =>
    (tool, args) => {
      expect(tool).equals('pg_restore')
      return args.includes('--list') ? listing : users
    }

  it('passes a world within every limit', function () {
    const { at, files } = world()
    expect(dumpProblems(at, files, MIGRATIONS, { pg: pg() })).deep.equals([])
    expect(isDumpWorld(at, 'w-dump')).equals(true)
    expect(isDumpWorld(at, 'coach-game')).equals(false)
  })

  it('is a problem for a dump past dumpMaxMigrationsBehind', function () {
    const { at, files } = world({ migration: MIGRATIONS[8] })
    expect(dumpProblems(at, files, MIGRATIONS, { pg: pg() })).deep.equals([
      'e2e/fixtures/dumps/w-dump.dump: 21 migrations behind the newest, more than 20: run e2e dump w-dump'
    ])
    expect(
      dumpProblems(at, files, MIGRATIONS, { pg: pg(), maxBehind: 21 })
    ).deep.equals([])
    const unknown = world({ migration: 'later' })
    expect(
      dumpProblems(unknown.at, unknown.files, MIGRATIONS, { pg: pg() })
    ).deep.equals([
      "e2e/fixtures/dumps/w-dump.dump: its migration later is not one of this checkout's"
    ])
  })

  it('is a problem for a dump over 10 MB', function () {
    const { at, files } = world({ bytes: MAX_DUMP_BYTES + 1 })
    expect(dumpProblems(at, files, MIGRATIONS, { pg: pg() })).deep.equals([
      `e2e/fixtures/dumps/w-dump.dump: ${MAX_DUMP_BYTES + 1} bytes is over the 10485760-byte cap on a dump world`
    ])
  })

  it('is a problem for rows of an excluded log table, and passes the same table with schema only', function () {
    const { at, files } = world()
    const carrying = `${LISTING}3601; 0 16391 TABLE DATA public audit_log teamstation\n3602; 0 16392 TABLE DATA analytics events teamstation\n`
    expect(
      dumpProblems(at, files, MIGRATIONS, { pg: pg(carrying) })
    ).deep.equals([
      'e2e/fixtures/dumps/w-dump.dump: carries rows of analytics.events, which a dump leaves out',
      'e2e/fixtures/dumps/w-dump.dump: carries rows of audit_log, which a dump leaves out'
    ])
    expect(tablesWithData(LISTING)).deep.equals(['public.users'])
  })

  it('is a problem for an accounts file naming a role the dump lacks', function () {
    const { at, files } = world({
      accounts: { coach: account('user-1'), umpire: account('user-9') }
    })
    expect(dumpProblems(at, files, MIGRATIONS, { pg: pg() })).deep.equals([
      'w-dump.accounts.json: role "umpire" has no account in the dump'
    ])
  })

  it('names a dump with no accounts file, one pg_restore cannot list, and an accounts file with no dump', function () {
    const bare = world({ accounts: null })
    expect(
      dumpProblems(bare.at, bare.files, MIGRATIONS, { pg: pg() })
    ).deep.equals([
      'e2e/fixtures/dumps/w-dump.dump: has no w-dump.accounts.json beside it'
    ])
    const broken = world()
    const failing: PgTool = () => {
      throw new Error('not an archive')
    }
    expect(
      dumpProblems(broken.at, broken.files, MIGRATIONS, { pg: failing })[0]
    ).contains('pg_restore cannot list it')
    const unreadable = world()
    writeFileSync(accountsPath(unreadable.at, 'w-dump'), '{')
    expect(
      dumpProblems(unreadable.at, unreadable.files, MIGRATIONS, { pg: pg() })[0]
    ).contains('its accounts file is unreadable')
    expect(
      dumpProblems(
        root,
        ['e2e/fixtures/dumps/lost.accounts.json'],
        MIGRATIONS,
        {
          pg: pg()
        }
      )
    ).deep.equals([
      'e2e/fixtures/dumps/lost.accounts.json: names a world with no dump'
    ])
  })

  it('e2e dump passes --exclude-table-data for every excluded table', function () {
    const args = dumpArgs('postgres://stack/db', '/out/w.dump')
    for (const table of EXCLUDED_TABLES) {
      expect(args).contains(`--exclude-table-data=${table}`)
    }
    expect(args).contains('--format=custom')
    expect(args).contains('--file=/out/w.dump')
    expect(args.at(-1)).equals('--dbname=postgres://stack/db')
  })

  it('reads a role from the accounts file, and throws for an unknown role', function () {
    const { at } = world()
    expect(dumpAccount(at, ['other', 'w-dump'], 'coach').teams).deep.equals([
      { id: 't1', name: 'Hosts' }
    ])
    expect(() => dumpAccount(at, ['w-dump'], 'umpire')).to.throw(
      'no account for role "umpire" in the dump worlds w-dump'
    )
    expect(() => dumpAccount(at, [], 'coach')).to.throw('(none)')
  })

  describe('e2e dump', function () {
    const manifest = {
      world: 'coach-game',
      nonce: 'n1',
      accounts: {
        coach: {
          role: 'coach',
          email: 'dumps+coach-game-coach-n1@example.test',
          password: 'pw',
          userId: 'u1',
          displayName: 'Aaron Boone'
        },
        scorekeeper: {
          role: 'scorekeeper',
          email: 'dumps+coach-game-scorekeeper-n1@example.test',
          password: 'pw2',
          userId: 'u3',
          displayName: 'Alex Cora'
        }
      },
      ids: { game: 'g1', homeTeam: 't1', awayTeam: 't2', homePlayer1: 'p1' }
    }

    function tools(
      users: string,
      applied: string[],
      ran: Array<[string, string[]]>,
      dumpBytes = 64
    ): PgTool {
      return (tool, args) => {
        ran.push([tool, args])
        if (tool === 'psql') {
          const sql = args.find(arg => arg.startsWith('--command='))
          return sql?.includes('count(*)') === true
            ? `${users}\n`
            : applied.join('\n')
        }
        const out = args.find(arg => arg.startsWith('--file='))?.slice(7)
        writeFileSync(String(out), Buffer.alloc(dumpBytes))
        return ''
      }
    }

    it('seeds the source on a fresh stack, dumps it with the tables left out, and writes both files', async function () {
      const at = join(root, `make-${n++}`)
      const scratch = join(root, `scratch-${n++}`)
      mkdirSync(scratch, { recursive: true })
      const ran: Array<[string, string[]]> = []
      const seeded: string[] = []
      const made = await makeDump({
        root: at,
        world: 'coach-season-dump',
        databaseUrl: 'postgres://stack/teamstation',
        seed: async (source, mailbox) => {
          seeded.push(`${source} ${mailbox}`)
          return manifest
        },
        migrations: MIGRATIONS,
        scratch,
        pg: tools('0', [MIGRATIONS[0], MIGRATIONS[27]], ran)
      })
      expect(seeded).deep.equals([`coach-game ${DUMP_MAILBOX}`])
      expect(made.bytes).equals(64)
      const dumped = ran.find(([tool]) => tool === 'pg_dump')
      expect(dumped?.[1]).deep.equals(
        dumpArgs(
          'postgres://stack/teamstation',
          join(scratch, 'coach-season-dump.dump')
        )
      )
      const accounts = JSON.parse(readFileSync(made.accounts, 'utf8'))
      expect(accounts.migration).equals(MIGRATIONS[27])
      expect(accounts.source).equals('coach-game')
      expect(accounts.accounts.coach.teams).deep.equals([
        { id: 't1', name: 'Hosts' }
      ])
      expect(accounts.accounts.coach.games).deep.equals([
        { id: 'g1', name: 'Visitors at Hosts' }
      ])
      expect(accounts.accounts.coach.people).deep.equals([
        { id: 'p1', name: 'homePlayer1' }
      ])
      expect(readFileSync(made.dump).length).equals(64)
    })

    it('refuses a stack that holds accounts, migrations it lacks, a dump over the cap and an unknown world', async function () {
      const attempt = async (
        pg: PgTool,
        world = 'coach-season-dump'
      ): Promise<string> => {
        const scratch = join(root, `scratch-${n++}`)
        mkdirSync(scratch, { recursive: true })
        try {
          await makeDump({
            root: join(root, `make-${n++}`),
            world,
            databaseUrl: 'postgres://stack/teamstation',
            seed: async () => manifest,
            migrations: MIGRATIONS,
            scratch,
            pg
          })
        } catch (error) {
          return (error as Error).message
        }
        return 'made'
      }
      expect(await attempt(tools('4', [], []))).contains(
        'already holds 4 accounts'
      )
      expect(await attempt(tools('0', ['999later'], []))).contains(
        'migrations this checkout lacks: 999later'
      )
      expect(await attempt(tools('0', [], []))).contains('ran no migrations')
      expect(
        await attempt(tools('0', [MIGRATIONS[29]], [], MAX_DUMP_BYTES + 1))
      ).contains('over the 10485760-byte cap')
      expect(await attempt(tools('0', [], []), 'nowhere')).contains(
        'no dump world "nowhere"'
      )
    })
  })
})
