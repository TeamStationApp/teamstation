import WebSocket from 'ws'

import {
  type Log,
  parseArgs,
  printLog,
  readToken,
  required,
  serverBase
} from './cli'

/**
 * Records what reaches a game's scoreboard: the proof that a device
 * publishing to the event it was assigned really lands there.
 *
 *   node -r sucrase/register tools/eventControl/recorder.ts --server <url> \
 *     --token-file <file> --game <id> [--seconds <n>]
 *
 * Subscribes to `/api/v1/scoreboard/<game>/socket` with the token in
 * `--token-file`, and prints every board the server sends — on open and after
 * every change from any source — as a JSON line, until `--seconds` pass or it
 * is stopped.
 */

export interface Recording {
  /** Resolves when the socket has closed. */
  closed: Promise<number>
  stop: () => void
}

/** The viewer socket's URL for a game. */
export function scoreboardSocketUrl(server: string, gameId: string): string {
  return `${serverBase(server).replace(/^http/, 'ws')}/api/v1/scoreboard/${encodeURIComponent(gameId)}/socket`
}

export function record(options: {
  server: string
  token: string
  gameId: string
  log: Log
  seconds?: number
}): Recording {
  const { log, gameId } = options
  const url = scoreboardSocketUrl(options.server, gameId)
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${options.token}` }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    clearTimeout(timer)
    socket.close()
  }
  socket.on('open', () => {
    log({ event: 'subscribed', game: gameId })
    if (options.seconds != null) timer = setTimeout(stop, options.seconds * 1000)
  })
  socket.on('message', data => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    try {
      log({ event: 'scoreboard', game: gameId, state: JSON.parse(text) })
    } catch {
      log({ event: 'unreadable', game: gameId, text })
    }
  })
  socket.on('error', error => {
    log({ event: 'socketError', game: gameId, message: error.message })
  })
  const closed = new Promise<number>(resolve => {
    socket.on('close', code => {
      clearTimeout(timer)
      log({ event: 'closed', game: gameId, code })
      resolve(code)
    })
  })
  return { closed, stop }
}

export function main(argv: string[], log: Log = printLog): Recording {
  const args = parseArgs(argv, [])
  const seconds = args.get('seconds')
  return record({
    server: required(args, 'server'),
    token: readToken(required(args, 'token-file')),
    gameId: required(args, 'game'),
    log,
    seconds: typeof seconds === 'string' ? Number(seconds) : undefined
  })
}

if (require.main === module) {
  const recording = main(process.argv.slice(2))
  process.on('SIGINT', recording.stop)
  process.on('SIGTERM', recording.stop)
}
