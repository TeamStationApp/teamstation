import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  GAME_TITLE,
  parseArgs,
  runCli,
  runSoakFixture,
  seedSoakFixture,
  type SoakFixtureDeps,
  WORLD
} from './soakFixture'

const LIVE = JSON.parse('{"enabled": true}') as never

function fakeDb(): {
  db: never
  rows: Array<[string, unknown]>
  destroyed: () => boolean
} {
  const rows: Array<[string, unknown]> = []
  let destroyed = false
  const db = {
    insertInto: (table: string) => ({
      values: (values: unknown) => ({
        execute: async () => {
          rows.push([table, values])
        }
      })
    }),
    destroy: async () => {
      destroyed = true
    }
  }
  return { db: db as never, rows, destroyed: () => destroyed }
}

function fakeDeps(known?: string): {
  deps: SoakFixtureDeps
  calls: unknown[][]
} {
  const calls: unknown[][] = []
  let n = 0
  return {
    calls,
    deps: {
      makeNonce: () => 'n0n0',
      findUser: async (_db, email) => {
        calls.push(['find', email])
        return known
      },
      makeId: kind => `${kind}_${++n}`,
      createAccount: async (context, world, role, person) => {
        calls.push([
          'account',
          context.mailbox,
          context.nonce,
          world,
          role,
          person
        ])
        return {
          role,
          email: `qa+${world}-${role}-${context.nonce}@example.test`,
          password: 'p4ss-placeholder',
          userId: 'user_1',
          displayName: `${person.first} ${person.last}`
        }
      },
      createTeam: async (_db, body, creator) => {
        calls.push(['team', body.name, creator])
        return { id: 'team_home' }
      },
      createLiveStream: async (_db, options) => {
        calls.push([
          'stream',
          options.label,
          options.slot,
          options.gameId,
          options.source,
          options.videoTitle
        ])
        return {
          id: `stream_${options.slot}`,
          videoId: options.slot === 3 ? null : `video_${options.slot}`,
          key: `sk_${options.slot}`
        }
      }
    }
  }
}

describe('the soak fixture', function () {
  it('seeds an account, a team, a season, the game and its synthetic camera', async function () {
    const { db, rows } = fakeDb()
    const { deps, calls } = fakeDeps()
    const now = new Date(Date.UTC(2026, 10, 12, 18))
    const manifest = await seedSoakFixture(
      {
        db,
        mailbox: 'qa@example.test',
        sessionSecret: 's',
        live: LIVE,
        now: () => now
      },
      deps
    )
    expect(manifest.world).equals(WORLD)
    expect(manifest.nonce).equals('n0n0')
    expect(manifest.accounts.owner.displayName).equals('Clayton Kershaw')
    expect(
      manifest.streams.map(stream => [stream.label, stream.key])
    ).deep.equals([['Synthetic', 'sk_3']])
    expect(manifest.streams[0].videoId).equals('')
    expect(manifest.ids).deep.include({
      team: 'team_home',
      game: manifest.gameId,
      'stream:Synthetic': 'stream_3'
    })
    expect(rows.map(row => row[0])).deep.equals([
      'teams',
      'seasons',
      'season_teams',
      'games'
    ])
    const game = rows[3][1] as Record<string, unknown>
    expect(game).deep.include({
      home_team_id: 'team_home',
      notes: GAME_TITLE,
      start_at: now,
      status: 'inProgress'
    })
    const season = rows[1][1] as Record<string, unknown>
    expect(season.starts_on).equals('2026-01-01')
    expect(
      calls.filter(call => call[0] === 'stream').map(call => call[4])
    ).deep.equals(['rtmp'])
    expect(calls.find(call => call[0] === 'team')).deep.equals([
      'team',
      'Soak Hosts n0n0',
      { userId: 'user_1', isAdmin: false }
    ])
  })

  it('runs against the database a URL names, and lets go of it after', async function () {
    const { db, destroyed } = fakeDb()
    const urls: string[] = []
    const manifest = await runSoakFixture({
      databaseUrl: 'postgres://soak@db.example.test/soak',
      mailbox: 'qa@example.test',
      sessionSecret: 'secret',
      live: LIVE,
      makeDatabase: url => {
        urls.push(url)
        return db
      },
      deps: fakeDeps().deps
    })
    expect(urls).deep.equals(['postgres://soak@db.example.test/soak'])
    expect(manifest.streams).length(1)
    expect(destroyed()).equals(true)
    const failing = fakeDb()
    const deps = fakeDeps().deps
    deps.createTeam = async () => {
      throw new Error('no team')
    }
    const error = await runSoakFixture({
      databaseUrl: 'x',
      mailbox: 'qa@example.test',
      sessionSecret: 's',
      live: LIVE,
      makeDatabase: () => failing.db,
      deps
    }).then(
      () => '',
      (e: unknown) => (e as Error).message
    )
    expect(error).equals('no team')
    expect(failing.destroyed()).equals(true)
    expect(
      await runSoakFixture({
        databaseUrl: 'x',
        mailbox: 'm@x',
        sessionSecret: '',
        live: LIVE,
        makeDatabase: () => failing.db
      }).then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).match(/session secret/)
  })

  it('runs as a command only where test settings are on, and prints the manifest', async function () {
    expect(parseArgs(['--json', '--mailbox', 'qa@example.test'])).deep.equals({
      mailbox: 'qa@example.test'
    })
    expect(() => parseArgs(['--json'])).throws(/Usage/)
    const said: string[] = []
    const out = {
      log: (line: string) => said.push(line),
      error: (line: string) => said.push(`error: ${line}`)
    }
    const config = {
      testSettings: false,
      databaseUrl: 'x',
      sessionSecret: 's',
      live: LIVE
    }
    expect(
      await runCli(
        ['--mailbox', 'qa@example.test'],
        () => ({ config, makeDatabase: () => fakeDb().db }),
        out
      )
    ).equals(1)
    expect(said.at(-1)).match(/testSettings/)
    // The real helpers cannot load in a unit test (they need the server's native addon),
    // so with test settings on the command reaches them and reports what stopped it.
    const code = await runCli(
      ['--mailbox', 'qa@example.test'],
      () => ({
        config: { ...config, testSettings: true },
        makeDatabase: () => fakeDb().db
      }),
      out
    )
    expect(code).equals(1)
    expect(
      await runCli([], () => ({ config, makeDatabase: () => fakeDb().db }), out)
    ).equals(1)
    expect(
      await runCli(
        ['--mailbox', 'q@x'],
        () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'raw'
        },
        out
      )
    ).equals(1)
    expect(said.at(-1)).equals('error: raw')
  })

  it('makes the stack its owner once, and every later run reuses it', async function () {
    const first = fakeDeps()
    const made = await seedSoakFixture(
      {
        db: fakeDb().db,
        mailbox: 'qa@example.test',
        sessionSecret: 's',
        live: LIVE
      },
      first.deps
    )
    expect(first.calls[0]).deep.equals([
      'find',
      'qa+streaming-soak-owner-stack@example.test'
    ])
    expect(first.calls[1].slice(0, 5)).deep.equals([
      'account',
      'qa@example.test',
      'stack',
      'streaming-soak',
      'owner'
    ])
    expect(made.accounts.owner.userId).equals('user_1')
    const again = fakeDeps('user_9')
    const reused = await seedSoakFixture(
      {
        db: fakeDb().db,
        mailbox: 'qa@example.test',
        sessionSecret: 's',
        live: LIVE
      },
      again.deps
    )
    expect(again.calls.some(call => call[0] === 'account')).equals(false)
    expect(reused.accounts.owner).deep.include({
      userId: 'user_9',
      email: 'qa+streaming-soak-owner-stack@example.test',
      displayName: 'Clayton Kershaw'
    })
    expect(again.calls.find(call => call[0] === 'team')![2]).deep.equals({
      userId: 'user_9',
      isAdmin: false
    })
  })
})
