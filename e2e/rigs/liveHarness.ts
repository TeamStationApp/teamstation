import { execFileSync, spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

/** Shared real-server helpers; importing this module starts no suite. */
export function createLiveHarness(options: {
  api: string
  app: string
  serverRoot?: string
  configDir?: string
  token: () => string
  live: { port: number; app: string }
  daemon: () => any
  onCamera?: (camera: {
    gameId: string
    streamId: string
    videoId: string
  }) => void
}): {
  dev: typeof dev
  ask: typeof ask
  camera: typeof camera
  broadcast: typeof broadcast
  browser: typeof browser
} {
  const root = resolve(options.serverRoot ?? '.')
  const stamp = Date.now().toString(36)
  function dev(script: string, ...args: string[]): string {
    return execFileSync(
      process.execPath,
      [
        '-r',
        join(root, 'node_modules/sucrase/register'),
        join(root, `src/server/dev/${script}.ts`),
        ...args
      ],
      { encoding: 'utf8', cwd: options.configDir ?? root }
    )
  }

  async function ask(
    path: string,
    init: RequestInit = {}
  ): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${options.api}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.token()}`,
        'content-type': 'application/json'
      }
    })
    const text = await response.text()
    return {
      status: response.status,
      json: text === '' ? null : JSON.parse(text)
    }
  }

  /** A camera for a game, with its key on this machine's ingest. */
  async function camera(
    gameId: string,
    label: string
  ): Promise<{ videoId: string; streamId: string; url: string }> {
    const made = await ask(`/games/${gameId}/live-streams`, {
      method: 'POST',
      body: JSON.stringify({ label })
    })
    const body = made.json as { id: string; videoId: string; url: string }
    if (made.status !== 201) throw new Error(`no camera: ${made.status}`)
    options.onCamera?.({ gameId, streamId: body.id, videoId: body.videoId })
    const key = new URL(body.url.replace(/^rtmp:/, 'http:')).pathname
      .split('/')
      .pop()!
    const live = options.live
    return {
      videoId: body.videoId,
      streamId: body.id,
      url: `rtmp://127.0.0.1:${live.port}/${live.app}/${key}`
    }
  }

  interface BroadcastEvent {
    at: number
    event: string
    t0?: number
    fromSec?: number
  }

  /** The fake broadcaster publishing into `url`, and what it says it did. */
  function broadcast(
    url: string,
    args: string[]
  ): { t0: Promise<number>; done: Promise<number>; events: BroadcastEvent[] } {
    const child = spawn(
      process.execPath,
      [
        join(root, 'scripts/e2e/liveOutage/fakeBroadcaster.mjs'),
        '--url',
        url,
        ...(process.env.TS_E2E_BROADCAST_LEAD_SEC == null
          ? []
          : ['--lead', process.env.TS_E2E_BROADCAST_LEAD_SEC]),
        ...args
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    )
    const events: BroadcastEvent[] = []
    let buffer = ''
    const t0 = new Promise<number>(resolve => {
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let at
        while ((at = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, at)) as BroadcastEvent
          buffer = buffer.slice(at + 1)
          events.push(event)
          if (event.event === 'planned') resolve(event.t0!)
        }
      })
    })
    const done = new Promise<number>(resolve =>
      child.on('exit', code => {
        resolve(code ?? 1)
      })
    )
    return { t0, done, events }
  }

  /** A browser signed in as the administrator. */
  async function browser(name: string): Promise<any> {
    const page = await options.daemon().attach({
      device: `liveOrigin-${name}-${stamp}`,
      platform: 'web',
      appId: options.app,
      stepDelay: 0,
      artifacts: 'on-failure',
      extra: {
        browser: process.env.E20_BROWSER ?? 'chrome',
        windowSize: '1280x720'
      }
    })
    await page.blockNetwork({
      patterns: ['*fonts.googleapis.com*', '*fonts.gstatic.com*']
    })
    await page.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: encodeURIComponent(options.token()),
          domain: new URL(options.api).hostname,
          path: '/'
        }
      ]
    })
    return page
  }

  return { dev, ask, camera, broadcast, browser }
}
