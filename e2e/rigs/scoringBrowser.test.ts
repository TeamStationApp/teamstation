import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import type { TeamStationClient } from '../../src/common/api'
import type { ScoringAction } from '../../src/common/scoring/actions'
import type { GameState } from '../../src/common/scoring/state'
import type { FixtureManifest } from '../core/fixtures'
import type { E2eContext } from '../core/spec'
import {
  AUDIO_TAP,
  Browser,
  lineupWorld,
  pause,
  rosterSaves,
  ScoringStack,
  scoringStack
} from './scoringBrowser'

const ORIGIN = 'https://stack.example.test'

const MANIFEST: FixtureManifest = {
  world: 'lineup-game',
  nonce: 'n1',
  accounts: {
    scorekeeper: {
      role: 'scorekeeper',
      email: 'keeper@example.test',
      password: 'pw',
      userId: 'usr_keeper',
      displayName: 'Alex Cora'
    },
    headCoach: {
      role: 'headCoach',
      email: 'coach@example.test',
      password: 'pw',
      userId: 'usr_coach',
      displayName: 'Aaron Boone'
    },
    awayCoach: {
      role: 'awayCoach',
      email: 'away@example.test',
      password: 'pw',
      userId: 'usr_away',
      displayName: 'Dave Roberts'
    }
  },
  ids: {
    game: 'gam_1',
    season: 'sea_1',
    homeTeam: 'team_home',
    awayTeam: 'team_away',
    players: JSON.stringify({
      away: [{ userId: 'u1', gumboId: 1, name: 'Judge', jersey: '1' }],
      home: [{ userId: 'u2', gumboId: 2, name: 'Ohtani', jersey: '1' }]
    })
  }
}

interface Fake {
  ctx: E2eContext
  sql: Array<{ text: string; values: unknown[] }>
  dir: string
}

function fakeContext(
  rows: Array<Record<string, unknown>> = [{ home: 'Hosts' }],
  withControl = true
): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'scoring-browser-'))
  const sql: Fake['sql'] = []
  const ctx = {
    stack: {
      origin: ORIGIN,
      ...(withControl
        ? {
            control: {
              sql: async (text: string, values: unknown[] = []) => {
                sql.push({ text, values })
                return { rows, rowCount: rows.length }
              }
            }
          }
        : {})
    },
    artifact: (name: string) => join(dir, name),
    fixture: async () => MANIFEST,
    browser: async () => fakeSession().session
  } as unknown as E2eContext
  return { ctx, sql, dir }
}

/** A client that answers from `answers`, keeping what it was asked. */
function fakeClient(
  answers: Record<string, unknown>,
  asked: string[]
): TeamStationClient {
  return new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === 'then') return undefined
        return async (...args: unknown[]) => {
          asked.push(`${name} ${JSON.stringify(args)}`)
          const answer = answers[name]
          if (answer instanceof Error) throw answer
          return typeof answer === 'function'
            ? (answer as (...a: unknown[]) => unknown)(...args)
            : answer
        }
      }
    }
  ) as unknown as TeamStationClient
}

class TestStack extends ScoringStack {
  constructor(
    ctx: E2eContext,
    readonly client: TeamStationClient,
    readonly signIns: string[] = []
  ) {
    super(ctx, async (_api, account) => {
      this.signIns.push(account.email)
      return `tok-${account.email}`
    })
  }

  protected makeClient(): TeamStationClient {
    return this.client
  }
}

interface Session {
  session: any
  calls: Array<[string, unknown]>
  handlers: Record<string, (error: unknown) => void>
}

/** A browser session whose page answers `evaluate` and `waitForFunction` in turn. */
function fakeSession(
  evaluations: unknown[] = [],
  points: unknown[] = []
): Session {
  const calls: Array<[string, unknown]> = []
  const handlers: Session['handlers'] = {}
  const m = new Proxy(
    {},
    {
      get: (_target, name: string) => async (options: unknown) => {
        calls.push([name, options])
      }
    }
  )
  const page = {
    on: (event: string, handler: (error: unknown) => void) => {
      handlers[event] = handler
    },
    setDefaultTimeout: () => undefined,
    evaluate: async (script: unknown) => {
      calls.push(['evaluate', script])
      return evaluations.shift()
    },
    waitForFunction: async (script: unknown) => {
      calls.push(['waitForFunction', script])
      return { jsonValue: async () => points.shift() }
    },
    waitForSelector: async (selector: unknown) => {
      calls.push(['waitForSelector', selector])
    }
  }
  return {
    session: {
      m,
      page,
      close: async () => {
        calls.push(['close', undefined])
      }
    },
    calls,
    handlers
  }
}

describe('scoringBrowser', function () {
  it('reads a lineup-game world back', function () {
    const world = lineupWorld(MANIFEST)
    expect(world.gameId).equals('gam_1')
    expect(world.seasonId).equals('sea_1')
    expect(world.teams).deep.equals({ home: 'team_home', away: 'team_away' })
    expect(world.players.home[0].name).equals('Ohtani')
    expect(world.users.scorekeeper.email).equals('keeper@example.test')
  })

  it('seeds a world, logs it, and starts each log over once', async function () {
    const { ctx, dir } = fakeContext()
    const stack = new TestStack(ctx, fakeClient({}, []))
    expect(stack.api).equals(`${ORIGIN}/api/v1`)
    const world = await stack.lineupGame('a.log')
    expect(world.gameId).equals('gam_1')
    stack.note('a.log', 'second')
    stack.note(null, 'nowhere')
    expect(readFileSync(join(dir, 'a.log'), 'utf8')).equals(
      '$ # the lineup-game world: game gam_1, Hosts (home) vs Visitors (away)\n\nsecond\n'
    )
    await stack.lineupGame(null)
  })

  it('signs each person in once', async function () {
    const { ctx } = fakeContext()
    const client = fakeClient({}, [])
    const stack = new TestStack(ctx, client)
    const world = lineupWorld(MANIFEST)
    expect(await stack.tokenOf(world, 'scorekeeper')).equals(
      'tok-keeper@example.test'
    )
    await stack.tokenOf(world, 'scorekeeper')
    expect(await stack.clientOf(world, 'headCoach')).equals(client)
    expect(stack.signIns).deep.equals([
      'keeper@example.test',
      'coach@example.test'
    ])
  })

  it('runs statements on the stack, logged with their rows', async function () {
    const { ctx, sql, dir } = fakeContext([{ home: 'Visitors', away: 'Hosts' }])
    const stack = new TestStack(ctx, fakeClient({}, []))
    const rows = await stack.query('q.log', 'select   1', [1])
    expect(rows).deep.equals([{ home: 'Visitors', away: 'Hosts' }])
    await stack.query('q.log', 'select 2')
    expect(sql.map(row => row.values)).deep.equals([[1], []])
    const log = readFileSync(join(dir, 'q.log'), 'utf8')
    expect(log).includes('$ psql -c "select 1"  -- [1]')
    expect(log).includes('$ psql -c "select 2"\n')
    expect(await stack.sides(null, 'gam_1')).deep.equals({
      home: 'Visitors',
      away: 'Hosts'
    })
    expect(sql[2].values).deep.equals(['gam_1'])
  })

  it('refuses SQL on a stack without control routes', async function () {
    const { ctx } = fakeContext([], false)
    const stack = new TestStack(ctx, fakeClient({}, []))
    let error: unknown
    try {
      await stack.query(null, 'select 1')
    } catch (caught) {
      error = caught
    }
    expect(String(error)).includes('runs no setup SQL')
  })

  it('makes its own API client through the password route', async function () {
    const { ctx } = fakeContext()
    const stack = await scoringStack(ctx)
    const client = (
      stack as unknown as {
        makeClient: (token: string) => unknown
      }
    ).makeClient('tok')
    expect(client).to.have.property('game')
  })

  describe('scores through a session', function () {
    const game = {
      id: 'gam_1',
      awayTeamId: 'team_away',
      homeTeamId: 'team_home',
      awayTeamName: 'Visitors',
      homeTeamName: 'Hosts',
      fenceDistanceFt: null
    }
    const empty = {
      plays: [],
      currentPlay: null,
      scoringMutation: null,
      lineupsDigest: null,
      playsDigest: null,
      generation: 0
    }

    it('opens the game on its default lineups and saves nothing new', async function () {
      const { ctx } = fakeContext()
      const asked: string[] = []
      const client = fakeClient(
        {
          game,
          roster: new Error('no roster'),
          defaultLineup: { lineup: null },
          gameEvents: empty,
          saveGameEvents: {}
        },
        asked
      )
      const stack = new TestStack(ctx, client)
      const world = lineupWorld(MANIFEST)
      const session = await stack.score(world, [])
      expect(session).to.have.property('state')
      let opened: GameState | undefined
      await stack.score(world, state => {
        opened = state
        return []
      })
      const saves = rosterSaves(opened!)
      expect(saves.map(save => (save as { kind?: string }).kind)).deep.equals([
        'roster',
        'roster',
        'roster'
      ])
      expect(asked.filter(row => row.startsWith('roster'))).length(4)
    })

    it('fails on an action the session refuses', async function () {
      const { ctx } = fakeContext()
      const client = fakeClient(
        {
          game,
          roster: [],
          defaultLineup: new Error('none'),
          gameEvents: empty,
          saveGameEvents: {}
        },
        []
      )
      const stack = new TestStack(ctx, client)
      let error: unknown
      try {
        const refused = JSON.parse(
          '{ "type": "result", "eventType": "nonsense" }'
        ) as ScoringAction
        await stack.score(lineupWorld(MANIFEST), [refused])
      } catch (caught) {
        error = caught
      }
      expect(String(error)).includes('nonsense')
    })
  })

  describe('swaps', function () {
    const state = {
      game: { homeTeamId: 'team_home', awayTeamId: 'team_away' }
    }

    it('proposes through Game Settings and has the away coach accept', async function () {
      const { ctx, dir } = fakeContext()
      const asked: string[] = []
      const client = fakeClient(
        {
          gameScheduling: state,
          group: { group: { id: 'g' }, canManage: true },
          proposeGame: { id: 'req_1', status: 'pending' },
          decideGameRequest: { status: 'accepted' }
        },
        asked
      )
      const stack = new TestStack(ctx, client)
      const drafted: unknown[] = []
      const world = lineupWorld(MANIFEST)
      await stack.swapGame(world, 's.log', {
        loadedGameDraft: (...args: unknown[]) => {
          drafted.push(args)
          return { home: { id: 'h' }, away: { id: 'a' } }
        },
        swapSides: (draft: unknown) => draft,
        gameProposalFields: () => ({ homeTeamId: 'team_away' })
      })
      expect(drafted).length(1)
      expect(asked.some(row => row.startsWith('decideGameRequest'))).equals(
        true
      )
      const log = readFileSync(join(dir, 's.log'), 'utf8')
      expect(log).includes('/game-requests/req_1/accept')
    })

    it('stops at a swap accepted at once', async function () {
      const { ctx } = fakeContext()
      const asked: string[] = []
      const client = fakeClient(
        {
          gameScheduling: state,
          group: {
            group: { id: 'g' },
            canManage: false,
            canManagePeople: true
          },
          proposeGame: { id: 'req_2', status: 'accepted' }
        },
        asked
      )
      const stack = new TestStack(ctx, client)
      await stack.swapGame(lineupWorld(MANIFEST), 's.log', {
        loadedGameDraft: () => ({ home: {}, away: {} }),
        swapSides: (draft: unknown) => draft,
        gameProposalFields: () => ({})
      })
      expect(asked.some(row => row.startsWith('decideGameRequest'))).equals(
        false
      )
    })
  })

  it('taps the game audio before the app loads', function () {
    expect(AUDIO_TAP).includes('window.__gameAudio')
    expect(AUDIO_TAP).includes('peak(from, span)')
  })

  describe('Browser', function () {
    it('opens a window with the audio tap, and keeps page errors', async function () {
      const { ctx } = fakeContext()
      const fake = fakeSession()
      let emulation: any
      const browser = await Browser.open(
        {
          ...ctx,
          browser: async (_size: unknown, given: unknown) => {
            emulation = given
            return fake.session
          }
        },
        { width: 10, height: 10 },
        'probe()'
      )
      expect(emulation.beforeLoad).includes('probe()')
      expect(emulation.observeNetwork).equals(true)
      fake.handlers.pageerror(new Error('boom'))
      fake.handlers.pageerror('plain')
      expect(browser.errors[0]).includes('boom')
      expect(browser.errors[1]).equals('plain')
      expect(browser.page).equals(fake.session.page)
      await browser.close()
      expect(fake.calls.at(-1)?.[0]).equals('close')
    })

    it('goes to a path, signs in by cookie and captures', async function () {
      const { ctx, dir } = fakeContext()
      const fake = fakeSession()
      const browser = new Browser(ctx, fake.session)
      await browser.go('/games/g')
      await browser.as('a b')
      await browser.capture('shot.png')
      expect(fake.calls).deep.equals([
        ['openLink', { link: `${ORIGIN}/games/g` }],
        [
          'setCookies',
          {
            cookies: [
              {
                name: 'ts_session',
                value: 'a%20b',
                domain: 'stack.example.test',
                path: '/'
              }
            ]
          }
        ],
        ['waitForAnimationToEnd', undefined],
        ['takeScreenshot', { path: join(dir, 'shot.png') }]
      ])
    })

    it('taps a control once it holds still, scrolling it into the window', async function () {
      this.timeout(10000)
      const { ctx } = fakeContext()
      const fake = fakeSession(
        [],
        [
          { x: 5, y: 900, inside: false },
          { x: 5, y: 50, inside: true },
          { x: 5, y: 40, inside: true },
          { x: 5.2, y: 40.3, inside: true }
        ]
      )
      const browser = new Browser(ctx, fake.session)
      await browser.tap('Save')
      const names = fake.calls.map(call => call[0])
      expect(names.filter(name => name === 'evalBrowserScript')).length(1)
      expect(fake.calls.at(-1)).deep.equals(['tapOnPoint', { x: 5, y: 40 }])
    })

    it('reads the page', async function () {
      const { ctx } = fakeContext()
      const fake = fakeSession([
        'page text',
        ['Settings', 'End Game'],
        { value: 'Swap\nresets' },
        { none: true },
        { value: true },
        { value: false },
        { value: true },
        { value: true },
        { value: true }
      ])
      const browser = new Browser(ctx, fake.session)
      expect(await browser.text()).equals('page text')
      expect(await browser.menuOrder()).deep.equals(['Settings', 'End Game'])
      expect(await browser.labelText('Swap')).equals('Swap\nresets')
      expect(await browser.labelText('Gone')).equals('')
      expect(await browser.isDisabled('Swap')).equals(true)
      expect(await browser.has('Swap')).equals(false)
      expect(await browser.switchOn('Toggle')).equals(true)
      expect(await browser.uncovered('Speaker')).equals(true)
      expect(await browser.onScreen('End Game')).equals(true)
      await browser.waitText('Batter', 5)
      await browser.showButton('Save')
      expect(fake.calls.at(-1)?.[0]).equals('evalBrowserScript')
    })

    it('opens Game Settings to swap, and the scoring screen without its help', async function () {
      this.timeout(10000)
      const { ctx } = fakeContext()
      const still = { x: 1, y: 1, inside: true }
      const fake = fakeSession(
        [{ value: true }, { none: true }],
        Array.from({ length: 12 }, () => still)
      )
      const browser = new Browser(ctx, fake.session)
      await browser.swapInSettings('g')
      expect(fake.calls[0]).deep.equals([
        'openLink',
        { link: `${ORIGIN}/games/g/settings` }
      ])
      const taps = fake.calls.filter(call => call[0] === 'tapOnPoint')
      expect(taps).length(2)
      await browser.scoreGame('g')
      expect(fake.calls.filter(call => call[0] === 'tapOnPoint')).length(3)
    })
  })

  it('pauses', async function () {
    const started = Date.now()
    await pause(5)
    expect(Date.now() - started).at.least(4)
  })
})
