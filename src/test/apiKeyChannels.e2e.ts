import { readFileSync } from 'node:fs'

import WebSocket from 'ws'

/**
 * User API keys on the three channels that are not plain HTTP, against the
 * real server: the game socket, the scoreboard hub and dictation. Run it
 * against `npm start` on a database `apiServerSeed.ts` seeded, with dictation
 * configured (its upstream is never reached: only the upgrade is tried).
 *
 *   node -r sucrase/register src/test/apiKeyChannels.e2e.ts <seed.json> [origin]
 *
 * It prints each step and what the server answered, and exits non-zero when
 * an answer is not the one a key's permissions call for.
 */
interface Seed {
  tokens: Record<string, string>
  teamA: string
  seasonA: string
  games: string[]
}

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Seed
const origin = process.argv[3] ?? 'http://127.0.0.1:9100'
const api = `${origin}/api/v1`
const socketOrigin = origin.replace(/^http/, 'ws')
const admin = seed.tokens['101']
let failed = false

function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(got)}`)
}

async function keyWith(name: string, permissions: string[]): Promise<string> {
  const made = await fetch(`${api}/me/api-keys`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${admin}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ name, permissions })
  })
  if (made.status !== 201) throw new Error(`key: ${made.status}`)
  return ((await made.json()) as { secret: string }).secret
}

/** How an upgrade ended: refused with a status, or open. */
async function upgrade(
  url: string,
  token: string
): Promise<{ status: number } | { ws: WebSocket }> {
  return await new Promise(resolve => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` }
    })
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 })
      ws.terminate()
    })
    ws.on('open', () => {
      resolve({ ws })
    })
    ws.on('error', () => undefined)
  })
}

/** The close code a socket ends with, or `open` if it stays up 1.5 s. */
async function closeOf(ws: WebSocket): Promise<number | 'open'> {
  return await new Promise(resolve => {
    const timer = setTimeout(() => {
      resolve('open')
    }, 1500)
    ws.on('close', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function main(): Promise<void> {
  const elsewhere = await keyWith('Teams only', ['team:read'])
  const reader = await keyWith('Game reader', ['gameEvents:read'])
  const writer = await keyWith('Game writer', ['gameEvents:write'])
  const [game] = seed.games

  console.log('\n# The game socket, /socket')
  const refused = await upgrade(`${socketOrigin}/socket`, elsewhere)
  check('team read only: upgrade', refused, { status: 403 })
  const opened = await upgrade(`${socketOrigin}/socket`, reader)
  if (!('ws' in opened)) throw new Error('game events read was refused')
  const reply = await new Promise<unknown>(resolve => {
    opened.ws.once('message', data => {
      resolve(JSON.parse((data as Buffer).toString('utf8')))
    })
    opened.ws.send(
      JSON.stringify({ type: 'subscribe', gameId: game, id: 's1' })
    )
  })
  check('game events read: subscribe', reply, {
    type: 'subscribed',
    gameId: game,
    id: 's1'
  })
  opened.ws.close()

  console.log('\n# The scoreboard hub, /api/v1/scoreboard/:gameId')
  // A game starting now, so its scoreboard is open to a publisher.
  const scheduled = await fetch(`${api}/teams/${seed.teamA}/games`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${admin}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      games: [
        {
          opponent: { name: 'Demo Owls' },
          side: 'home',
          seasonId: seed.seasonA,
          startAt: new Date(Date.now() + 5 * 60_000).toISOString()
        }
      ]
    })
  })
  const live = (
    (await scheduled.json()) as { results: Array<{ gameId: string }> }
  ).results[0].gameId
  const board = `${socketOrigin}/api/v1/scoreboard/${live}`
  for (const [what, path, token, want] of [
    ['game events read: publisher', 'publish', reader, 4403],
    ['game events read: dashboard', 'dashboard', reader, 4403],
    ['team read only: timeline', 'socket?timeline=1', elsewhere, 4403],
    ['game events write: publisher', 'publish', writer, 'open'],
    ['game events read: timeline', 'socket?timeline=1', reader, 'open']
  ] as const) {
    const socket = await upgrade(`${board}/${path}`, token)
    if (!('ws' in socket)) {
      check(what, socket, want)
      continue
    }
    check(what, await closeOf(socket.ws), want)
    socket.ws.close()
  }

  console.log('\n# Dictation, /api/v1/dictation')
  check(
    'game events read: upgrade',
    await upgrade(`${socketOrigin}/api/v1/dictation`, reader),
    { status: 403 }
  )
  const dictating = await upgrade(`${socketOrigin}/api/v1/dictation`, writer)
  check(
    'game events write: upgrade',
    'ws' in dictating ? 'open' : dictating,
    'open'
  )
  if ('ws' in dictating) dictating.ws.close()
}

main().then(
  () => process.exit(failed ? 1 : 0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
