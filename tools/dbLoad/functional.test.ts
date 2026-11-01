import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type { BrowserAccount, CredentialsFile } from './fixture'
import {
  ACTIONS,
  type Action,
  type Answer,
  BrowserDriver,
  type Context,
  type Driver,
  fillTemplate,
  outOfOrder,
  pitchMarks,
  type Playback,
  renderResult,
  runActions,
  runCommand,
  runFunctional,
  shellQuote,
  Skip,
  type Surface
} from './functional'

const STREAM_URL = 'rtmp://one.example.test:1936/live/secret-key'

const credentials: CredentialsFile = {
  runId: 'stub',
  accounts: [
    'person.admin',
    'person.coach',
    'person.guardian',
    'person.stranger',
    'browser.scorekeeper',
    'browser.coach',
    'browser.viewer',
    'browser.viewerAway',
    'browser.revoked',
    'browser.removed',
    'browser.videographer',
    'browser.chatKept',
    'browser.chatFriend'
  ].map(label => ({
    label,
    email: `${label}@example.test`,
    password: `generated-${label}`,
    userId: `usr_${label}`,
    teamId: null
  })),
  places: {
    liveGameId: 'gam_live',
    liveTeamId: 'tem_live',
    finishedGameId: 'gam_done',
    finishedTeamId: 'tem_done',
    largeGameId: 'gam_large',
    seasonId: 'sea_one',
    leagueId: 'lea_one',
    mergedPlayerId: 'usr_kept',
    mergedPlayerGames: 5,
    childId: 'usr_child',
    teamChatTeamId: 'tem_talk',
    mergedChatTeamId: 'tem_merged'
  }
}

/** The app as far as the actions can tell, with one wrong answer if asked. */
class StubApp {
  frames: unknown[] = []
  pitches = 0
  atBat = 0
  lacking = new Set<string>()
  answers = new Map<string, Answer>()
  streamState = 'publishing'
  playbackMs = 0
  calls: string[] = []

  answer(method: string, path: string): Answer {
    this.calls.push(`${method} ${path}`)
    const set = this.answers.get(`${method} ${path}`)
    if (set != null) return set
    if (path.includes('/live-streams/') && path.endsWith('/reveal'))
      return { status: 200, body: { url: STREAM_URL } }
    if (path.endsWith('/live-streams') && method === 'POST')
      return { status: 200, body: { id: 'stream' } }
    if (path.endsWith('/live-streams'))
      return {
        status: 200,
        body: { mine: [{ id: 'stream', state: this.streamState }] }
      }
    if (path.endsWith('/end')) {
      this.streamState = 'ended'
      return { status: 200, body: {} }
    }
    if (path === '/teams/tem_done/stats') return { status: 200, body: [{}] }
    if (path === '/players/usr_kept/stats')
      return { status: 200, body: { games: 5 } }
    if (path === '/games/gam_live/events')
      return { status: 200, body: { plays: [{}] } }
    if (path === '/chat/conversations') return { status: 200, body: [] }
    return { status: 200, body: { rows: [{}] } }
  }

  pitch(): void {
    this.pitches += 1
    this.frames.push({ type: 'change', gameId: 'gam_live', kind: 'lineups' })
    this.frames.push({
      type: 'change',
      gameId: 'gam_live',
      kind: 'plays',
      data: {
        currentPlay: {
          about: { atBatIndex: this.atBat },
          playEvents: Array.from({ length: this.pitches }, () => ({
            isPitch: true
          }))
        }
      }
    })
  }
}

class StubSurface implements Surface {
  constructor(
    private readonly app: StubApp,
    private readonly who: string
  ) {}

  async open(): Promise<void> {}
  async press(label: string): Promise<void> {
    if (this.app.lacking.has(label)) throw new Error(`No ${label} to press`)
    if (/^(Ball|Called Strike|Swing and Miss)$/.test(label)) this.app.pitch()
  }

  async fill(label: string): Promise<void> {
    if (this.app.lacking.has(label)) throw new Error(`No ${label} to fill`)
  }

  async has(label: string): Promise<boolean> {
    if (label !== 'Score') return true
    return this.who === 'browser.scorekeeper'
  }

  async text(): Promise<string> {
    return ''
  }

  async waitForText(words: string): Promise<void> {
    if (this.app.lacking.has(words)) throw new Error(`No words ${words}`)
  }

  async waitForLabel(label: string): Promise<void> {
    if (this.app.lacking.has(label)) throw new Error(`No ${label}`)
  }

  async api(method: string, path: string): Promise<Answer> {
    const answer = this.app.answer(method, path)
    // Who the answer is for: what a stranger or a viewer may not read.
    if (
      answer.status === 200 &&
      ((this.who === 'person.stranger' && path.endsWith('/events')) ||
        (this.who === 'browser.viewer' && path.startsWith('/admin/')) ||
        (this.who === 'browser.revoked' && path.endsWith('/events')))
    )
      return { status: this.who === 'browser.revoked' ? 401 : 404, body: {} }
    return answer
  }

  frames(): unknown[] {
    return this.who === 'browser.viewerAway' ? this.app.frames : []
  }

  async videoPlayback(): Promise<Playback> {
    await new Promise(resolve => setTimeout(resolve, this.app.playbackMs))
    if (this.app.lacking.has('decoder')) return 'undecodable'
    return this.app.lacking.has('video') ? 'stalled' : 'plays'
  }

  async close(): Promise<void> {}
}

class StubDriver implements Driver {
  closed = false
  constructor(private readonly app: StubApp) {}
  async signIn(account: BrowserAccount): Promise<Surface> {
    return new StubSurface(this.app, account.label)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function contextFor(app: StubApp, overrides: Partial<Context> = {}): Context {
  return {
    servers: ['http://one.example.test', 'http://two.example.test'],
    credentials,
    driver: new StubDriver(app),
    tabs: new Map(),
    publishCommand: 'publish {url} {duration}',
    restartCommand: 'restart',
    valkeyBlockCommand: 'block',
    // A publisher runs until it is stopped, as one the ingest accepted does.
    run: template => ({
      done: template.startsWith('publish')
        ? new Promise<number>(() => undefined)
        : Promise.resolve(0),
      stop: async () => undefined
    }),
    pollMs: 1,
    patienceMs: 30,
    pitches: 0,
    ...overrides
  }
}

async function runOne(
  name: string,
  context: Context
): Promise<{ status: string; detail: string }> {
  const action = ACTIONS.find(row => row.name === name)
  if (action == null) throw new Error(`no action ${name}`)
  const [result] = await runActions([action], context, () => undefined)
  return result
}

describe('the browser script', function () {
  this.timeout(60_000)

  it('reports every action by name, each passing on a healthy app', async function () {
    const app = new StubApp()
    const lines: string[] = []
    const results = await runActions(ACTIONS, contextFor(app), line =>
      lines.push(line)
    )
    expect(results.filter(row => row.status !== 'passed')).deep.equals([])
    expect(results.map(row => row.name)).include.members([
      'sign in by password',
      'create a team, season and game',
      'score a game with viewers on the other node',
      'edit a lineup mid-game',
      'box score and stats after the stats builder',
      "a merged player's stats",
      'send chat and see typing across nodes',
      'a chat holding a merged member',
      'revoke a viewer mid-game',
      'remove a member mid-game',
      'publish, watch live from both nodes, end it and play the recording',
      'view Analytics as admin',
      'open the schedule',
      'open a finished game, team and large box score',
      'let a chat audience reconcile',
      'restart an API node mid-game',
      'block Valkey for 20 s'
    ])
    expect(lines.length).equals(ACTIONS.length)
    expect(lines[0]).matches(/^PASSED sign in by password \(/)
  })

  it('never writes a stream URL or a password in what it reports', async function () {
    const lines: string[] = []
    await runActions(ACTIONS, contextFor(new StubApp()), line =>
      lines.push(line)
    )
    const report = lines.join('\n')
    expect(report).not.includes('secret-key')
    expect(report).not.includes('generated-')
  })

  it('fails a step on what the app did wrong, and goes on to the next', async function () {
    const app = new StubApp()
    app.lacking.add('Send')
    const results = await runActions(
      ACTIONS.filter(
        row =>
          row.name.startsWith('send chat') || row.name === 'open the schedule'
      ),
      contextFor(app),
      () => undefined
    )
    expect(results.map(row => row.status)).deep.equals(['failed', 'passed'])
    expect(results[0].detail).equals('No Send to press')
  })

  it('fails when a role reaches past what it holds', async function () {
    const name = 'each kind of account sees what its role allows'
    const wrong = new StubApp()
    wrong.lacking.add('Batting')
    expect((await runOne(name, contextFor(wrong))).detail).equals(
      'No words Batting'
    )
    const child = new StubApp()
    child.answers.set('GET /players/usr_child/stats', { status: 404, body: {} })
    expect((await runOne(name, contextFor(child))).detail).equals(
      'The guardian cannot read the child'
    )
    const stranger = new StubApp()
    stranger.answers.set('GET /games/gam_live/events', {
      status: 200,
      body: {}
    })
    class Open extends StubSurface {
      async api(method: string, path: string): Promise<Answer> {
        return stranger.answer(method, path)
      }

      async has(label: string): Promise<boolean> {
        return label === 'Score'
      }
    }
    const open = contextFor(stranger, {
      driver: {
        signIn: async account => new Open(stranger, account.label),
        close: async () => undefined
      }
    })
    expect((await runOne(name, open)).detail).matches(/should not have Score/)
  })

  it('reads pitches in the order the tab heard them', function () {
    const frame = (atBat: number, pitches: number, gameId = 'g'): unknown => ({
      type: 'change',
      gameId,
      kind: 'plays',
      data: {
        currentPlay: {
          about: { atBatIndex: atBat },
          playEvents: Array.from({ length: pitches }, () => ({ isPitch: true }))
        }
      }
    })
    const marks = pitchMarks(
      [
        frame(0, 1),
        frame(0, 2),
        frame(1, 1),
        frame(1, 1, 'another'),
        { type: 'subscribed' },
        { type: 'change', gameId: 'g', kind: 'plays', data: {} },
        { type: 'change', gameId: 'g', kind: 'game' }
      ],
      'g'
    )
    expect(marks).deep.equals([
      { atBat: 0, pitches: 1 },
      { atBat: 0, pitches: 2 },
      { atBat: 1, pitches: 1 }
    ])
    expect(outOfOrder(marks)).equals(undefined)
    expect(
      outOfOrder([
        { atBat: 1, pitches: 2 },
        { atBat: 1, pitches: 1 }
      ])
    ).matches(/frame 1/)
    expect(
      outOfOrder([
        { atBat: 2, pitches: 0 },
        { atBat: 1, pitches: 4 }
      ])
    ).matches(/at bat 1 pitch 4/)
  })

  it('fails on a pitch that never reaches the far node', async function () {
    class Silent extends StubSurface {
      frames(): unknown[] {
        return []
      }
    }
    const app = new StubApp()
    const context = contextFor(app, {
      driver: {
        signIn: async account => new Silent(app, account.label),
        close: async () => undefined
      }
    })
    const result = await runOne(
      'score a game with viewers on the other node',
      context
    )
    expect(result.status).equals('failed')
    expect(result.detail).equals(
      'Gave up waiting for pitch 1 to reach the far node'
    )
  })

  it('fails when pitches arrive out of order', async function () {
    const app = new StubApp()
    const context = contextFor(app)
    const original = app.pitch.bind(app)
    app.pitch = () => {
      original()
      app.atBat = app.pitches === 1 ? 3 : 0
    }
    const result = await runOne(
      'score a game with viewers on the other node',
      context
    )
    expect(result.status).equals('failed')
    expect(result.detail).matches(/^Pitches out of order/)
  })

  it('fails a lineup edit the far node did not hear of', async function () {
    const app = new StubApp()
    const original = app.pitch.bind(app)
    app.pitch = () => {
      original()
      app.frames = app.frames.filter(
        row => (row as { kind?: string }).kind !== 'lineups'
      )
    }
    const result = await runOne('edit a lineup mid-game', contextFor(app))
    expect(result.detail).match(
      /^The far node heard of no change of lineup, in \d+ frames/
    )
  })

  it('fails a merged player whose stats do not follow him', async function () {
    const app = new StubApp()
    app.answers.set('GET /players/usr_kept/stats', {
      status: 200,
      body: { games: 2 }
    })
    const result = await runOne("a merged player's stats", contextFor(app))
    expect(result.detail).equals('The kept row has 2 games, not his 5')
  })

  it('fails when a revoked or removed person still hears the game', async function () {
    class Hearing extends StubSurface {
      frames(): unknown[] {
        return app.frames
      }
    }
    const app = new StubApp()
    const context = (): Context =>
      contextFor(app, {
        driver: {
          signIn: async account => new Hearing(app, account.label),
          close: async () => undefined
        }
      })
    expect(
      (await runOne('revoke a viewer mid-game', context())).detail
    ).matches(/The revoked viewer heard 1 pitches/)
    expect(
      (await runOne('remove a member mid-game', context())).detail
    ).matches(/The removed member heard 1 pitches/)
  })

  it('fails when a revoked session still reads', async function () {
    class Reading extends StubSurface {
      async api(method: string, path: string): Promise<Answer> {
        return app.answer(method, path)
      }
    }
    const app = new StubApp()
    const result = await runOne(
      'revoke a viewer mid-game',
      contextFor(app, {
        driver: {
          signIn: async account => new Reading(app, account.label),
          close: async () => undefined
        }
      })
    )
    expect(result.detail).equals('A revoked session read the game: HTTP 200')
  })

  it('fails a video that does not play, and refuses a foreign stream host', async function () {
    const name =
      'publish, watch live from both nodes, end it and play the recording'
    const app = new StubApp()
    app.lacking.add('video')
    expect((await runOne(name, contextFor(app))).detail).equals(
      'The live video on http://one.example.test does not play'
    )
    const browserless = new StubApp()
    browserless.lacking.add('decoder')
    const told = await runOne(name, contextFor(browserless))
    expect(told.status).equals('skipped')
    expect(told.detail).matches(
      /published, shown live .*playback is not proved/
    )
    const foreign = new StubApp()
    foreign.answers.set('POST /games/gam_live/live-streams/stream/reveal', {
      status: 200,
      body: { url: 'rtmp://elsewhere.example.test/live/k' }
    })
    expect((await runOne(name, contextFor(foreign))).detail).matches(
      /Refusing to publish.*elsewhere\.example\.test/
    )
    const stuck = new StubApp()
    stuck.streamState = 'starting'
    expect((await runOne(name, contextFor(stuck))).detail).equals(
      'Gave up waiting for the stream to go live'
    )
  })

  it('ends a stream it could not watch, so a run can still take the next camera', async function () {
    const name =
      'publish, watch live from both nodes, end it and play the recording'
    const app = new StubApp()
    app.lacking.add('Live now')
    expect((await runOne(name, contextFor(app))).status).equals('failed')
    expect(app.calls).include('POST /games/gam_live/live-streams/stream/end')
  })

  it('fails a publisher that was refused or exited, rather than skipping it', async function () {
    const name =
      'publish, watch live from both nodes, end it and play the recording'
    const exiting =
      (delayMs: number): Context['run'] =>
      () => ({
        done: new Promise<number>(resolve => {
          setTimeout(() => {
            resolve(1)
          }, delayMs)
        }),
        stop: async () => undefined
      })

    // It never went live.
    const refused = new StubApp()
    refused.streamState = 'starting'
    const early = await runOne(
      name,
      contextFor(refused, { run: exiting(0), pollMs: 5 })
    )
    expect(early.status).equals('failed')
    expect(early.detail).equals(
      'The publisher was refused or exited, with code 1, before the stream went live'
    )
    expect(refused.calls).include(
      'POST /games/gam_live/live-streams/stream/end'
    )

    // The row said publishing for a moment, and this browser cannot decode:
    // that is no proof the stream was taken, so it must not read as a skip.
    const closed = new StubApp()
    closed.lacking.add('decoder')
    closed.playbackMs = 30
    const late = await runOne(name, contextFor(closed, { run: exiting(5) }))
    expect(late.status).equals('failed')
    expect(late.detail).equals(
      'The publisher was refused or exited, with code 1, while the stream was live'
    )
  })

  it('fills the publish template and starts the stream with it, then stops it', async function () {
    const name =
      'publish, watch live from both nodes, end it and play the recording'
    const started: Array<{ template: string; values: Record<string, string> }> =
      []
    let stopped = 0
    const app = new StubApp()
    const context = contextFor(app, {
      run: (template, values) => {
        started.push({ template, values })
        return {
          done: new Promise<number>(() => undefined),
          stop: async () => {
            stopped += 1
            app.streamState = 'ended'
          }
        }
      }
    })
    expect((await runOne(name, context)).status).equals('passed')
    expect(started).deep.equals([
      {
        template: 'publish {url} {duration}',
        values: { url: STREAM_URL, duration: '180' }
      }
    ])
    expect(stopped).equals(1)
  })

  it('says it skipped what it was given no command for', async function () {
    const context = contextFor(new StubApp(), {
      publishCommand: undefined,
      restartCommand: undefined,
      valkeyBlockCommand: undefined
    })
    const results = await runActions(
      ACTIONS.filter(row => /publish|restart|Valkey/.test(row.name)),
      context,
      () => undefined
    )
    expect(results.map(row => row.status)).deep.equals([
      'skipped',
      'skipped',
      'skipped'
    ])
    expect(results[1].detail).equals('No --restart-command was given')
  })

  it('fails a disruption command that fails', async function () {
    const context = contextFor(new StubApp(), {
      run: () => ({ done: Promise.resolve(3), stop: async () => undefined })
    })
    expect(
      (await runOne('restart an API node mid-game', context)).detail
    ).equals('--restart-command exited 3')
  })

  it('keeps pitching after a restart until the far node hears one', async function () {
    const app = new StubApp()
    let pitches = 0
    class Returning extends StubSurface {
      async press(label: string): Promise<void> {
        if (label === 'Ball' || label === 'Called Strike') pitches += 1
        // The first pitch is scored before the far node's socket is back.
        if (pitches !== 1) await super.press(label)
      }
    }
    const context = contextFor(app, {
      patienceMs: 200,
      driver: {
        signIn: async account => new Returning(app, account.label),
        close: async () => undefined
      }
    })
    const result = await runOne('restart an API node mid-game', context)
    expect(result.status).equals('passed')
    expect(pitches).equals(2)
  })

  it('fails when no pitch ever reaches the far node after a restart', async function () {
    class Silent extends StubSurface {
      frames(): unknown[] {
        return []
      }
    }
    const app = new StubApp()
    const result = await runOne(
      'restart an API node mid-game',
      contextFor(app, {
        driver: {
          signIn: async account => new Silent(app, account.label),
          close: async () => undefined
        }
      })
    )
    expect(result.status).equals('failed')
    expect(result.detail).equals(
      'Gave up waiting for a pitch to reach the far node'
    )
  })

  it('fails on an answer it cannot use', async function () {
    const app = new StubApp()
    app.answers.set('POST /admin/analytics/query', {
      status: 503,
      body: { message: 'no reader' }
    })
    expect(
      (await runOne('view Analytics as admin', contextFor(app))).detail
    ).equals('the analytics query: HTTP 503 {"message":"no reader"}')
    const open = new StubApp()
    class Open extends StubSurface {
      async api(method: string, path: string): Promise<Answer> {
        return open.answer(method, path)
      }
    }
    expect(
      (
        await runOne(
          'view Analytics as admin',
          contextFor(open, {
            driver: {
              signIn: async account => new Open(open, account.label),
              close: async () => undefined
            }
          })
        )
      ).detail
    ).equals('A viewer was answered an analytics query')
  })

  it('waits for a removed member to leave the chat', async function () {
    const app = new StubApp()
    app.answers.set('GET /chat/conversations', {
      status: 200,
      body: [{ scope: { id: 'tem_live' } }]
    })
    expect(
      (await runOne('let a chat audience reconcile', contextFor(app))).detail
    ).equals('Gave up waiting for the removed member to leave the chat')
  })

  it('names who is missing from the credentials', async function () {
    const context = contextFor(new StubApp(), {
      credentials: { ...credentials, accounts: [] }
    })
    expect((await runOne('open the schedule', context)).detail).equals(
      'credentials have no browser.viewer'
    )
  })

  it('renders a result on one line', function () {
    expect(
      renderResult({ name: 'a', status: 'skipped', ms: 1500, detail: 'why' })
    ).equals('SKIPPED a (1.5 s): why')
  })

  it('quotes template values for the shell, leaving unknown names alone', function () {
    expect(shellQuote("it's")).equals(`'it'\\''s'`)
    expect(fillTemplate('go {url} {other}', { url: 'a b' })).equals(
      "go 'a b' {other}"
    )
  })

  it('stops a command and whatever it started', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'dbload-command-'))
    try {
      const marker = join(dir, 'marker')
      const quick = runCommand('printf %s {word} > {path}', {
        word: 'made',
        path: marker
      })
      expect(await quick.done).equals(0)
      expect(readFileSync(marker, 'utf8')).equals('made')
      const long = runCommand('sleep 30', {})
      await long.stop()
      expect(await long.done).not.equals(0)
      await long.stop()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  describe('from its command line', function () {
    let dir: string
    let path: string
    before(function () {
      dir = mkdtempSync(join(tmpdir(), 'dbload-functional-'))
      path = join(dir, 'credentials.json')
      writeFileSync(path, JSON.stringify(credentials))
    })
    after(function () {
      rmSync(dir, { recursive: true })
    })

    const passing: Action = { name: 'passes', run: async () => 'fine' }
    const failing: Action = {
      name: 'fails',
      run: async () => {
        throw new Error('broken')
      }
    }
    const skipping: Action = {
      name: 'skips',
      run: async () => {
        throw new Skip('nothing to do')
      }
    }

    it('answers 1 on a failed step, with a report, and always closes', async function () {
      const lines: string[] = []
      const report = join(dir, 'functional.log')
      const driver = new StubDriver(new StubApp())
      const code = await runFunctional(
        [
          '--server',
          'http://one.example.test/',
          '--credentials',
          path,
          '--report',
          report
        ],
        { log: line => lines.push(line), driver },
        [passing, failing, skipping]
      )
      expect(code).equals(1)
      expect(driver.closed).equals(true)
      expect(lines[3]).equals('1 passed, 1 failed, 1 skipped')
      const written = readFileSync(report, 'utf8')
      expect(written).matches(/^PASSED passes/)
      expect(written).matches(/FAILED fails .*broken/)
      expect(written).matches(/SKIPPED skips .*nothing to do/)
    })

    it('answers 0 when nothing failed, running only what --only names', async function () {
      const lines: string[] = []
      const code = await runFunctional(
        [
          '--server',
          'http://one.example.test',
          '--credentials',
          path,
          '--only',
          'passes',
          '--patience-seconds',
          '1'
        ],
        {
          log: line => lines.push(line),
          driver: new StubDriver(new StubApp()),
          run: runCommand
        },
        [passing, failing]
      )
      expect(code).equals(0)
      expect(lines.length).equals(2)
    })

    it('refuses to run without a server or credentials', async function () {
      const io = { log: () => undefined }
      let message = ''
      await runFunctional([], io).catch((error: Error) => {
        message = error.message
      })
      expect(message).equals('--server is required')
      await runFunctional(['--server', 'http://a.example.test'], io).catch(
        (error: Error) => {
          message = error.message
        }
      )
      expect(message).equals('--credentials is required')
    })

    it('refuses a file that holds no accounts', async function () {
      const other = join(dir, 'other.json')
      writeFileSync(other, '{}')
      let message = ''
      await runFunctional(
        ['--server', 'http://a.example.test', '--credentials', other],
        { log: () => undefined }
      ).catch((error: Error) => {
        message = error.message
      })
      expect(message).matches(/is not a credentials file/)
    })
  })

  describe('in a real browser, against a stub server', function () {
    let server: Server
    let base: string
    const PAGE = `<!doctype html><title>stub</title><body>
      <div id="out">Sign in</div>
      <div role="button" id="use">Use a password instead</div>
      <input aria-label="E-mail address">
      <input aria-label="Password" hidden>
      <div role="button" aria-label="Off" aria-disabled="true"></div>
      <div role="button" aria-label="Go now">Go</div>
      <video></video>
      <script>
        document.getElementById('use').onclick = () => {
          document.querySelector('[aria-label=Password]').hidden = false
        }
        document.addEventListener('keydown', event => {
          if (event.key !== 'Enter') return
          const account = document.createElement('div')
          account.setAttribute('aria-label', 'Account, Stub')
          account.textContent = 'stub'
          document.body.append(account)
        })
        document.querySelector('[aria-label="Go now"]').onclick = () => {
          document.getElementById('out').textContent = 'Pressed'
        }
        const socket = new WebSocket(location.origin.replace('http', 'ws') + '/socket')
        void socket
      </script>`

    before(async function () {
      if (process.env.PUPPETEER_EXECUTABLE_PATH == null) this.skip()
      server = createServer((req, res) => {
        if (req.url === '/api/v1/teapot') {
          res.statusCode = 418
          res.end('not json')
          return
        }
        if (req.url?.startsWith('/api/v1/')) {
          let body = ''
          req.on('data', chunk => {
            body += String(chunk)
          })
          req.on('end', () => {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ method: req.method, body }))
          })
          return
        }
        res.setHeader('content-type', 'text/html')
        res.end(PAGE)
      })
      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', resolve)
      })
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    after(async function () {
      if (server == null) return
      server.closeAllConnections()
      await new Promise(resolve => {
        server.close(resolve)
      })
    })

    it('signs in, presses, fills, reads and asks as the tab', async function () {
      const driver = new BrowserDriver(3000)
      try {
        const tab = await driver.signIn(
          {
            label: 'stub',
            email: 'stub@example.test',
            password: 'generated',
            userId: 'usr',
            teamId: null
          },
          base
        )
        expect(await tab.has('Go now')).equals(true)
        expect(await tab.has('Off')).equals(true)
        expect(await tab.has('Nothing')).equals(false)
        await tab.press('Go*')
        await tab.waitForText('pressed')
        await tab.fill('E-mail address', 'again')
        await tab.waitForLabel('Account,*')
        expect(await tab.text()).includes('Pressed')
        expect(await tab.api('POST', '/thing', { a: 1 })).deep.equals({
          status: 200,
          body: { method: 'POST', body: '{"a":1}' }
        })
        expect((await tab.api('GET', '/teapot')).body).equals('not json')
        expect(tab.frames()).deep.equals([])
        expect(await tab.videoPlayback(600)).equals('stalled')
        let message = ''
        await tab.press('Off').catch((error: Error) => {
          message = error.message
        })
        expect(message).matches(/No Off to press at \/sign-in/)
        message = ''
        await tab.waitForText('absent', 200).catch((error: Error) => {
          message = error.message
        })
        expect(message).matches(/No the words "absent"/)
        message = ''
        await tab.fill('Absent', 'x').catch((error: Error) => {
          message = error.message
        })
        expect(message).matches(/No Absent to fill/)
        message = ''
        await tab.waitForLabel('Absent', 200).catch((error: Error) => {
          message = error.message
        })
        expect(message).matches(/No Absent at/)
        await tab.close()
      } finally {
        await driver.close()
      }
    })
  })
})
