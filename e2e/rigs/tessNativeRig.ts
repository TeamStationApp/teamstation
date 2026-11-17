import { execFileSync, spawnSync } from 'node:child_process'

import { Pool } from 'pg'

import { routePath } from '../../src/app/navigation/routes'
import { HEARD, tessScript } from '../../src/test/tessFixture'
import {
  faultControl,
  nodeDatabaseUrl,
  requireDropletHandle
} from '../core/dropletStack'
import { eventually } from '../core/readback'
import { BlockedError } from '../core/result'
import type { E2eContext } from '../core/spec'
import { SSH_OPTIONS } from '../core/streamingStack'
import { typeInto } from '../core/typeInto'
import { toWire } from '../faults/standIns'
import { setServer } from './app/setServer'

/**
 * Tess in the phone or tablet app, against a droplet stack: the `tess` world
 * seeded on it, her answers scripted on its fault server's model, dictation
 * heard by its recogniser. The device runs the branch's develop build, which
 * `setServer` points at the stack after a clean launch, and signs in with the
 * world's admin and password. Nothing listens on this machine.
 */

const APP_ID = 'app.teamstation.develop'

/** What the scenarios read of the world and of the stack's stand-ins. */
export interface TessWorld {
  games: { finals: string[]; may3: string; scheduled: string }
  links: { teamSettings: string; firstBaseAngle: string }
  players: { visible: string; hidden: string }
  /** Hits on the stack's beacon, which a remote load from rich HTML would make. */
  beaconHits: () => Promise<number>
  /** What the recogniser heard each utterance as, oldest first. */
  heard: () => Promise<string[]>
}

interface TreeNode {
  type?: string
  text?: string
  id?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: TreeNode[]
}

const flatten = (node: TreeNode): TreeNode[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export interface TessNative {
  t: TessWorld
  m: any
  nodes: () => Promise<TreeNode[]>
  find: (text: string) => Promise<TreeNode | undefined>
  /** The window's size: the root's bounds, since content scrolls past it. */
  screen: () => Promise<{ width: number; height: number }>
  show: (text: string, timeout?: number) => Promise<void>
  hidden: (text: string) => Promise<void>
  tap: (text: string) => Promise<void>
  /** Taps a system alert's button if it shows, as it does the first time only. */
  tapIfShown: (text: string, timeoutMs: number) => Promise<void>
  /**
   * The driver matches text by "contains", so `Close` also finds Tess's `Close Tess`
   * and `Team Settings` the chat's "Where are my team settings?". This waits for a
   * node whose text is exactly that.
   */
  exactly: (text: string, timeoutMs?: number) => Promise<TreeNode | undefined>
  showExactly: (text: string, timeoutMs?: number) => Promise<void>
  /** Types into Tess's field and waits until it holds the words. */
  typeIn: (words: string) => Promise<void>
  say: (words: string, answered: string) => Promise<void>
  /** Holds a point for `ms`, as a finger does, and lets go. */
  hold: (text: string, ms: number) => Promise<void>
  /** Each named header button that is drawn, left to right. */
  headerOrder: () => Promise<string[]>
  gamesOfTeam: () => Promise<number>
}

export interface TessNativeOptions {
  surface: 'ios-app' | 'android-app'
  /** A tablet lies on its side, and has its chat beside the app. */
  landscape?: boolean
  /** On the phone the keyboard stays up after a message: see `say`. */
  keepKeyboard?: boolean
  launch?: Record<string, unknown>
}

/** Seeds the world, scripts Tess, signs the admin in through the app, runs the scenario. */
export async function withTessNative(
  ctx: E2eContext,
  options: TessNativeOptions,
  run: (native: TessNative) => Promise<void>
): Promise<void> {
  const android = options.surface === 'android-app'
  if (ctx.stack.attached == null)
    throw new BlockedError('needs a droplet stack: --stack <id>')
  const handle = requireDropletHandle(ctx.stack.attached)
  if (handle.faults == null)
    throw new BlockedError(`stack "${handle.id}" has no fault server`)
  const control = faultControl(handle.faults)
  const world = await ctx.fixture('tess')
  const id = (name: string): string => world.ids[name]
  const games = {
    finals: id('finals').split(','),
    may3: id('may3'),
    scheduled: id('scheduled')
  }
  const firstBase = 'vid_tess_first'
  const links = {
    teamSettings: routePath({
      name: 'groupSettings',
      kind: 'team',
      id: id('teamA')
    }),
    firstBaseAngle: routePath({
      name: 'game',
      gameId: games.may3,
      tab: 'watch',
      videoId: firstBase,
      angles: [firstBase]
    })
  }
  const players = { visible: id('visiblePlayer'), hidden: id('hiddenPlayer') }
  await control.call(
    'PUT',
    'model/script',
    toWire(
      tessScript({
        teamA: id('teamA'),
        seasonA: id('season'),
        may3: games.may3,
        scheduled: games.scheduled,
        links,
        players,
        origin: () => ctx.stack.origin
      })
    )
  )
  await control.call('PUT', 'speech', { heard: HEARD })
  const t: TessWorld = {
    games,
    links,
    players,
    beaconHits: async () =>
      ((await control.call('GET', 'beacon')) as { hits: number }).hits,
    heard: async () =>
      ((await control.call('GET', 'speech')) as { said: string[] }).said
  }
  const database = new Pool({
    connectionString: nodeDatabaseUrl(handle.databaseUrl),
    max: 1
  })
  try {
    const m = await ctx.attach('user', {
      platform: android ? 'android' : 'ios',
      appId: APP_ID,
      commandTimeout: 30000,
      driverStartTimeout: 180
    })
    const nodes: TessNative['nodes'] = async () =>
      flatten((await m.hierarchy()) as TreeNode)
    const find: TessNative['find'] = async text =>
      (await nodes()).find(
        node => (node.text === text || node.id === text) && node.bounds != null
      )
    const show: TessNative['show'] = async (text, timeout = 20000) => {
      await m.assertVisible({ text, timeout })
    }
    const tap: TessNative['tap'] = async text => {
      await m.tapOn({ text, timeout: 20000 })
      await m.waitForAnimationToEnd()
    }
    const exactly: TessNative['exactly'] = async (text, timeoutMs = 20000) => {
      for (let waited = 0; ; waited += 500) {
        const node = await find(text)
        if (node != null || waited >= timeoutMs) return node
        await wait(500)
      }
    }
    const screen: TessNative['screen'] = async () => {
      const all = await nodes()
      const root = all.find(node => node.bounds != null)?.bounds
      if (root != null && root.width > 0 && root.height > 0)
        return { width: root.x + root.width, height: root.y + root.height }
      return {
        width: Math.max(
          ...all.map(node =>
            node.bounds == null ? 0 : node.bounds.x + node.bounds.width
          )
        ),
        height: Math.max(
          ...all.map(node =>
            node.bounds == null ? 0 : node.bounds.y + node.bounds.height
          )
        )
      }
    }
    /**
     * Whether Tess's field holds `words`. On iOS a node's text is its label, "Ask
     * Tess", and never what is typed, so there the driver's own tree is read for the
     * field's value.
     */
    const fieldHolds = async (words: string): Promise<boolean> => {
      if (android)
        return ((await find('Tess field'))?.text ?? '').includes(words)
      const raw = Buffer.from((await m.hierarchyRaw()) as Uint8Array).toString(
        'utf8'
      )
      let value = ''
      if (raw.trimStart().startsWith('{')) {
        const flat = JSON.parse(raw) as {
          nodes?: Array<{ identifier?: string; value?: string }>
        }
        value =
          flat.nodes?.find(node => node.identifier === 'Tess field')?.value ??
          ''
      } else {
        const element = /<[^>]*\bname="Tess field"[^>]*>/.exec(raw)?.[0] ?? ''
        value = (/\bvalue="([^"]*)"/.exec(element)?.[1] ?? '')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
      }
      return value.includes(words)
    }
    const typeIn: TessNative['typeIn'] = async words => {
      // By its test id: "Ask Tess" also begins the empty chat's hint.
      await m.tapOn({ id: 'Tess field', timeout: 20000 })
      if (android)
        // The emulator's driver types a long message slower than its own request
        // timeout; the shell's input types it at once.
        execFileSync('adb', [
          '-s',
          ctx.device('user'),
          'shell',
          `input text '${words.replace(/ /g, '%s')}'`
        ])
      else await m.inputText({ text: words })
      // The field takes the keys a while after they are typed; Send before then would
      // send half the words.
      await eventually(
        async () => {
          if (!(await fieldHolds(words)))
            throw new Error(`The field does not hold "${words}"`)
        },
        30000,
        1000
      )
    }
    const native: TessNative = {
      t,
      m,
      nodes,
      find,
      screen,
      show,
      hidden: async text => {
        await m.assertNotVisible({ text, timeout: 15000 })
      },
      tap,
      tapIfShown: async (text, timeoutMs) => {
        if ((await exactly(text, timeoutMs)) != null) await tap(text)
      },
      exactly,
      showExactly: async (text, timeoutMs = 20000) => {
        if ((await exactly(text, timeoutMs)) == null)
          throw new Error(`Nothing reads exactly ${text}`)
      },
      typeIn,
      say: async (words, answered) => {
        await typeIn(words)
        await tap('Send')
        await show(`.*${answered}.*`, 60000)
        // On iOS the driver hides a keyboard by typing a return, which in Tess's
        // multiline field is a new line: the field grows, and on the phone that pushes
        // the end of the conversation out of sight, so there the keyboard stays up.
        if (options.keepKeyboard !== true) await m.hideKeyboard()
      },
      hold: async (text, ms) => {
        const node = await find(text)
        if (node?.bounds == null) throw new Error(`Nothing labelled ${text}`)
        const size = await screen()
        const x = (100 * (node.bounds.x + node.bounds.width / 2)) / size.width
        const y = (100 * (node.bounds.y + node.bounds.height / 2)) / size.height
        await m.swipe({
          start: `${x}%,${y}%`,
          end: `${x}%,${y}%`,
          duration: ms
        })
      },
      headerOrder: async () =>
        (await nodes())
          .filter(
            node =>
              node.bounds != null &&
              node.bounds.y < 200 &&
              ['Tess', 'Notifications'].includes(node.text ?? '')
          )
          .sort((a, b) => a.bounds!.x - b.bounds!.x)
          .map(node => node.text!)
          .filter((text, index, all) => all.indexOf(text) === index),
      gamesOfTeam: async () =>
        (
          await database.query(
            'select count(*)::int as n from games where home_team_id = $1 or away_team_id = $1',
            [id('teamA')]
          )
        ).rows[0].n as number
    }

    if (options.landscape === true)
      await m.setOrientation({ orientation: 'LANDSCAPE' })
    // A clean launch forgets any server a link kept, so the stack is set after it.
    await m.launchApp({
      appId: APP_ID,
      clearState: true,
      ...options.launch
    })
    await setServer({
      platform: android ? 'android' : 'ios',
      udid: ctx.device('user'),
      appId: APP_ID,
      origin: ctx.stack.origin,
      device: m
    })
    await show('E-mail address', 30000)
    const admin = world.accounts.admin
    // By a sign-in code: an iPad's password field does not take the focus a tap
    // gives it, and its code field does. The stack sends no mail; its server
    // logs each code, read here over the observer's SSH and never printed.
    const codeFor = async (email: string): Promise<string> => {
      let refused = ''
      for (let waited = 0; waited < 30000; waited += 1000) {
        // A world's address is new each run, so its first logged code is this one.
        // A dropped SSH connection is retried like a code not logged yet.
        const read = spawnSync(
          'ssh',
          [
            ...SSH_OPTIONS,
            handle.ssh,
            `grep -F 'sign-in code for ${email}:' ${handle.serverLog} || true`
          ],
          { encoding: 'utf8', timeout: 15000 }
        )
        if (read.status === 0) {
          const line = read.stdout.trim().split('\n').at(-1)
          const code = /: (\d{6})$/.exec(line ?? '')?.[1]
          if (code != null) return code
        } else {
          const stderr = read.stderr.trim()
          refused = stderr !== '' ? stderr : String(read.error ?? read.status)
        }
        await wait(1000)
      }
      throw new Error(
        `The stack logged no sign-in code for ${email}${refused === '' ? '' : `: ${refused}`}`
      )
    }
    await typeInto(m, 'E-mail address', admin.email)
    await m.hideKeyboard()
    await native.tapIfShown('Send me a sign-in code', 2000)
    // The code field focuses and its keyboard covers the prompt on Android.
    if (android) await m.hideKeyboard()
    await show('.*six-digit code.*', 30000)
    await typeInto(m, 'Sign-in code', await codeFor(admin.email))
    await m.hideKeyboard()
    // On iOS dismissing the keyboard submits the form; the button is gone then.
    await m.tapOn({ text: 'Sign in', optional: true, timeout: 2000 })
    await show('TeamStation menu', 60000)
    await run(native)
  } finally {
    await database.end()
  }
}
