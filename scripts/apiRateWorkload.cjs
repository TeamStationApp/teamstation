// Run on a disposable test server with PostgreSQL 18 and Valkey.
// node -r sucrase/register scripts/apiRateWorkload.cjs <off|observe|enforce> <scoring|venue|schedule>
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { randomUUID } = require('node:crypto')
const { sql } = require('kysely')
const WebSocket = require('ws')
const root = process.cwd()
if (!process.env.TS_TEST_DATABASE_URL || !process.env.TS_TEST_REDIS_URL)
  throw new Error(
    'Set the disposable test database and Valkey endpoints before running the workload'
  )
const { groupFixture } = require(path.join(root, 'src/test/groupFixtures'))
const { testDatabaseUrl } = require(path.join(root, 'src/migrate/testDatabase'))
const { testRedisUrl } = require(path.join(root, 'src/test/scoreboardKit'))
const { insertFixtureUsers } = require(
  path.join(root, 'src/test/insertFixtureUsers')
)
const { createSession } = require(path.join(root, 'src/server/auth/sessions'))
const { userIdOfGumbo } = require(path.join(root, 'src/common/userId'))
const { CachingClient } = require(path.join(root, 'src/app/sync/cachingClient'))
const { openCacheStore } = require(path.join(root, 'src/app/sync/cacheStore'))
const { nodeSqliteExecutor } = require(
  path.join(root, 'src/test/nodeSqliteExecutor')
)
const { prepareOffline } = require(
  path.join(root, 'src/test/offlineSetTesting')
)
const [mode, scenario] = process.argv.slice(2)
assert(['off', 'observe', 'enforce'].includes(mode))
assert(['scoring', 'venue', 'schedule'].includes(scenario))
const say = result => console.log(JSON.stringify({ mode, scenario, ...result }))
const venue = '192.0.2.14'
async function seed(f) {
  const db = f.h.db
  const games = Array.from({ length: 3 }, (_, i) => 'gam_fixture_' + i)
  await db
    .insertInto('games')
    .values(
      games.map((id, i) => ({
        id,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date(Date.now() + (i + 1) * 3600000),
        status: 'scheduled'
      }))
    )
    .execute()
  await db
    .insertInto('season_teams')
    .values(
      [f.teamA, f.teamB].map(teamId => ({
        team_id: teamId,
        season_id: f.seasonA
      }))
    )
    .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
    .execute()
  await db
    .insertInto('system_settings')
    .values({ key: 'creation.hierarchyReady', value: true })
    .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
    .execute()
  const tokens = []
  for (const n of [101, 102, 103, 104]) {
    const userId = userIdOfGumbo(n)
    const roles = [f.teamA, f.teamB].map(scopeId => ({
      id: randomUUID(),
      user_id: userId,
      scope_id: scopeId,
      scope_type: 'team',
      role: 'admin'
    }))
    roles.push({
      id: randomUUID(),
      user_id: userId,
      scope_id: f.seasonA,
      scope_type: 'season',
      role: 'admin'
    })
    if (n === 101)
      roles.push({ ...roles[0], id: randomUUID(), role: 'scorekeeper' })
    await db
      .insertInto('scope_roles')
      .values(roles)
      .onConflict(oc =>
        oc.columns(['user_id', 'scope_type', 'scope_id', 'role']).doNothing()
      )
      .execute()
    tokens.push((await createSession(db, userId, undefined)).token)
  }
  const spectators = []
  for (const n of [107, 108]) {
    const id = userIdOfGumbo(n)
    await insertFixtureUsers(db, {
      id,
      legacyId: 'usr_viewer_' + n,
      login_enabled: true,
      display_name: 'Fixture viewer'
    })
    spectators.push((await createSession(db, id, undefined)).token)
  }
  return { games, tokens, spectators }
}
async function startServer(f, directory, samples) {
  const db = await sql`select current_database() as name`.execute(f.h.db)
  const address = testDatabaseUrl.replace(/\/[^/]*$/, '/' + db.rows[0].name)
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  fs.writeFileSync(
    path.join(directory, 'serverConfig.json'),
    JSON.stringify({
      databaseUrl: address,
      listenPort: port,
      listenHost: '127.0.0.1',
      clusterWorkers: 2,
      backgroundJobs: false,
      statsBuilder: false,
      logRequests: false,
      live: { enabled: false },
      redis: { url: testRedisUrl, prefix: 'workload:' + randomUUID() },
      apiRateLimitMode: mode,
      mediaDir: directory,
      workDir: directory
    }),
    { mode: 0o600 }
  )
  const child = spawn(
    process.execPath,
    [
      '-r',
      'sucrase/register',
      '-r',
      path.join(__dirname, 'apiRateMeasurements.cjs'),
      path.join(root, 'src/server/index.ts')
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        NODE_PATH: path.join(root, 'node_modules'),
        RATE_WORKLOAD_SAMPLES: samples,
        RATE_WORKLOAD_ROOT: root
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const exited = once(child, 'exit')
  try {
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for both API workers')),
        90000
      )
      const listen = buf => {
        output = (output + buf.toString()).slice(-32000)
        if ((output.match(/ listening on /g) ?? []).length >= 2) {
          clearTimeout(timer)
          resolve()
        }
      }
      child.stdout.on('data', listen)
      child.stderr.on('data', listen)
      exited.then(() => {
        clearTimeout(timer)
        reject(new Error('API process exited'))
      }, reject)
    })
  } catch (e) {
    child.kill('SIGTERM')
    await exited
    throw e
  }
  return {
    base: 'http://127.0.0.1:' + port + '/api/v1',
    close: async () => {
      child.kill('SIGTERM')
      await exited
    }
  }
}
function reader(base, token, ip, journey) {
  return async (route, body) => {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-forwarded-for': ip,
        'x-fixture-journey': journey,
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    return {
      status: response.status,
      wait: Number(response.headers.get('retry-after')),
      data: await response.json()
    }
  }
}
async function score(base, f, { games, tokens }, directory) {
  const call = reader(base, tokens[0], venue, 'launch')
  const launch = await Promise.all(
    [
      '/auth/me',
      '/me/home',
      '/me/groups',
      '/me/roles',
      '/me/notifications/summary'
    ].map(route => call(route))
  )
  assert(launch.every(x => x.status === 200))
  let journey = 'packages'
  let online = true
  const client = new CachingClient({
    baseUrl: base,
    token: tokens[0],
    fetch: async (url, init) => {
      if (!online) throw new TypeError('Offline fixture')
      const headers = new Headers(init?.headers)
      headers.set('x-forwarded-for', venue)
      headers.set('x-fixture-journey', journey)
      return await fetch(url, { ...init, headers })
    },
    openCache: async () =>
      await openCacheStore(
        nodeSqliteExecutor(path.join(directory, 'phone.sqlite'))
      )
  })
  client.openFor(userIdOfGumbo(101))
  try {
    const set = await prepareOffline(client)
    assert.equal(set.kept.length, 3)
    assert(set.kept.every(game => game.state === 'ready'))
    journey = 'reconnect'
    online = false
    for (const game of games.slice(0, 2)) {
      await client.saveGameEvents(game, {
        scoringBase: null,
        plays: [
          {
            about: {
              atBatIndex: 0,
              inning: 1,
              halfInning: 'top',
              isScoringPlay: false
            },
            count: { outs: 1 },
            matchup: { batter: { id: 101 } },
            result: {
              eventType: 'single',
              awayScore: 0,
              homeScore: 0,
              description: 'Single'
            },
            playEvents: [{ isPitch: true }]
          }
        ],
        remove: []
      })
    }
    const queued = (await client.outboxSummary()).count
    assert.equal(queued, 2)
    online = true
    client.wakeOutbox(true)
    await client.drainOutbox()
    assert.equal((await client.outboxSummary()).count, 0)
    for (const game of games.slice(0, 2)) {
      const actual = await reader(
        base,
        tokens[0],
        venue,
        'reconnect'
      )('/games/' + game + '/events')
      assert.equal(actual.status, 200)
      assert.equal(actual.data.plays.length, 1)
    }
    say({ readyPackages: 3, queuedOffline: queued, persistedAfterReconnect: 2 })
  } finally {
    await client.sessionRefused()
  }
}
async function spectators(base, f, { games, spectators: members }) {
  const routes = [
    '/games/' + games[0],
    '/games/' + games[0] + '/box-score?view=playback'
  ]
  for (const viewers of [4, 6, 8]) {
    const guest = reader(base, undefined, venue, 'guest' + viewers)
    const byStatus = {}
    const waits = []
    const start = Date.now()
    for (let tick = 0; tick < 18; tick++) {
      await sleep(Math.max(0, start + tick * 5000 - Date.now()))
      const requests = Array.from({ length: viewers }, () =>
        routes.map(p => guest(p))
      ).flat()
      const answers = await Promise.all(requests)
      for (const [index, answer] of answers.entries()) {
        byStatus[answer.status] = (byStatus[answer.status] ?? 0) + 1
        const normalStatus = index % 2 === 0 ? 200 : 401
        assert(
          [normalStatus, 429].includes(answer.status),
          'Unexpected guest response ' + answer.status
        )
        if (answer.status === 429) waits.push(answer.wait)
      }
      const signed = await Promise.all(
        members.map(token => reader(base, token, venue, 'member')(routes[0]))
      )
      assert(signed.every(x => x.status === 200))
    }
    if (viewers <= 6 || mode !== 'enforce') assert.equal(waits.length, 0)
    else assert(waits.length > 0)
    if (waits.length) {
      await sleep(Math.max(...waits) * 1000)
      assert.equal((await guest(routes[0])).status, 200)
    }
    say({
      viewers,
      seconds: 90,
      guestPerMinute: viewers * 24,
      signedInRequests: 36,
      byStatus,
      retrySeconds: [...new Set(waits)]
    })
    // Each phase starts from full guest buckets, on the same venue address.
    if (viewers !== 8) await sleep(20000)
  }
  for (let i = 0; i < 2; i++) {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/search', {
      headers: {
        'x-forwarded-for': venue,
        authorization: 'Bearer ' + members[0]
      }
    })
    await once(ws, 'open')
    ws.close()
    await once(ws, 'close')
  }
  say({ signedInSocketConnections: 2 })
}
async function schedule(base, f, { tokens }) {
  for (const [idx, count] of [1, 10, 50, 200].entries()) {
    const call = reader(base, tokens[idx], venue, 'schedule' + count)
    const rows = Array.from({ length: count }, (_, i) => ({
      opponent: { teamId: i % 2 === 0 ? f.teamB : 'tem_fixture_missing' },
      side: 'home',
      seasonId: f.seasonA,
      startAt: new Date(Date.UTC(2029, 1, count, i)).toISOString(),
      externalId: { system: 'fixture', id: 'schedule-' + count + '-' + i }
    }))
    const route = '/teams/' + f.teamA + '/games'
    const body = { games: rows }
    const r = await call(route, body)
    assert.equal(r.status, 200)
    assert.equal(r.data.counts.created, Math.ceil(count / 2))
    assert.equal(r.data.counts.error, Math.floor(count / 2))
    say({ submitted: count, counts: r.data.counts })
    if (count === 200) {
      const retry = reader(base, tokens[idx], venue, 'retry')
      const answer = await retry(route, body)
      if (mode === 'enforce') {
        assert.equal(answer.status, 429)
        assert(answer.wait > 0 && answer.wait <= 200)
        assert.equal(answer.wait, answer.data.details.retryAfterSec)
        await sleep(answer.wait * 1000)
        const recovered = await retry(route, body)
        assert.equal(recovered.status, 200)
        assert.equal(recovered.data.counts.unchanged, 100)
        assert.equal(recovered.data.counts.error, 100)
        say({
          immediateStatus: 429,
          retrySeconds: answer.wait,
          retryStatus: 200,
          counts: recovered.data.counts
        })
      } else {
        assert.equal(answer.status, 200)
        say({ immediateStatus: 200 })
      }
    }
  }
}
function summaries(samples) {
  const all = fs
    .readFileSync(samples, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  assert(all.length > 0, 'No workload measurements were collected')
  for (const sample of all) {
    if (mode === 'off') assert.equal(sample.gateMs.length, 0)
    else assert(sample.gateMs.length > 0, 'Expected the shared store')
    if (mode === 'enforce')
      assert.equal(sample.refusals, sample.status === 429 ? 1 : 0)
  }
  const refused = all.filter(sample => sample.refusals > 0)
  if (mode === 'off' || scenario === 'scoring') assert.equal(refused.length, 0)
  else {
    const journey = scenario === 'venue' ? 'guest8' : 'retry'
    assert(refused.length > 0, 'Expected over-budget traffic')
    assert(refused.every(sample => sample.journey === journey))
  }
  for (const journey of new Set(all.map(x => x.journey))) {
    for (const status of new Set(
      all.filter(x => x.journey === journey).map(x => x.status)
    )) {
      const group = all.filter(
        x => x.journey === journey && x.status === status
      )
      const gates = group.flatMap(x => x.gateMs).sort((a, b) => a - b)
      const stats = {
        sharedChecks: gates.length,
        sharedCheckP95Ms: gates.length
          ? +gates[Math.ceil(0.95 * gates.length) - 1].toFixed(2)
          : null,
        sharedCheckP99Ms: gates.length
          ? +gates[Math.ceil(0.99 * gates.length) - 1].toFixed(2)
          : null,
        firstRefusals: group.reduce((n, x) => n + x.refusals, 0)
      }
      for (const key of ['ms', 'sql', 'sqlMs', 'poolMs']) {
        const values = group.map(x => x[key]).sort((a, b) => a - b)
        stats[key] = { total: +values.reduce((a, b) => a + b, 0).toFixed(2) }
        for (const p of [50, 95, 99])
          stats[key]['p' + p] =
            +values[Math.ceil((p / 100) * values.length) - 1].toFixed(2)
      }
      say({ journey, status, n: group.length, stats })
    }
  }
}
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-workload-'))
  const samples = path.join(directory, 'measurements.jsonl')
  const f = await groupFixture(undefined, '127.0.0.1')
  try {
    const data = await seed(f)
    const server = await startServer(f, directory, samples)
    try {
      await { scoring: score, venue: spectators, schedule }[scenario](
        server.base,
        f,
        data,
        directory
      )
      summaries(samples)
    } finally {
      await server.close()
    }
  } finally {
    await f.h.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
