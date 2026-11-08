import { execFileSync } from 'node:child_process'

import type { TessFixture } from '../../src/test/tessFixture'
import { eventually } from '../core/readback'
import type { E2eContext } from '../core/spec'

/**
 * Tess in the phone or tablet app, on the same fixture as the browser's. The app's
 * address is fixed when its bundle is made, and names the stack's front server, which
 * sends the API on to the fixture once the scenario adopts it. The fixture binds where
 * the device reaches, so a remote load from rich HTML would reach its beacon. The
 * sign-in code comes from the fixture and is never printed.
 */

const APP_ID = 'app.teamstation.app'

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
  t: TessFixture
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

/** Starts the fixture, signs user 101 in through the app, runs the scenario. */
export async function withTessNative(
  ctx: E2eContext,
  options: TessNativeOptions,
  run: (native: TessNative) => Promise<void>
): Promise<void> {
  const { tessFixture } = await import('../../src/test/tessFixture')
  const { userIdOfGumbo } = await import('../../src/common/userId')
  const android = options.surface === 'android-app'
  const t = await tessFixture({
    bindHost: new URL(ctx.stack.origin).hostname,
    videos: false
  })
  try {
    await ctx.stack.adopt(t.f.h.origin)
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
          await t.f.h.db
            .selectFrom('games')
            .select('id')
            .where(eb =>
              eb.or([
                eb('home_team_id', '=', t.f.teamA),
                eb('away_team_id', '=', t.f.teamA)
              ])
            )
            .execute()
        ).length
    }

    if (options.landscape === true)
      await m.setOrientation({ orientation: 'LANDSCAPE' })
    await m.launchApp({
      appId: APP_ID,
      clearState: true,
      ...options.launch
    })
    await show('E-mail address', 30000)
    const { email } = await t.f.h.db
      .selectFrom('user_emails')
      .select('email')
      .where('user_id', '=', userIdOfGumbo(101))
      .executeTakeFirstOrThrow()
    // A phone's keyboard sometimes drops or swaps a key under the driver. The form
    // then waits for a code sent to another address; switching to a password and back
    // offers to send one again.
    let code: string | undefined
    for (let attempt = 1; code == null; attempt++) {
      if (attempt > 3) throw new Error('No sign-in code was sent')
      if (attempt > 1) {
        await tap('Use a password instead')
        await tap('Use a sign-in code')
      }
      await tap('E-mail address')
      await m.eraseText({ characters: 60 })
      await m.inputText({ text: email })
      await m.hideKeyboard()
      await native.tapIfShown('Send me a sign-in code', 2000)
      await show('.*six-digit code.*', 30000)
      for (let waited = 0; code == null && waited < 5000; waited += 1000) {
        code = t.f.h.mail.get(email)
        if (code == null) await wait(1000)
      }
    }
    await tap('Sign-in code')
    await m.eraseText({ characters: 12 })
    await m.inputText({ text: code })
    await m.hideKeyboard()
    await native.tapIfShown('Sign in', 2000)
    await show('Notifications', 60000)
    await run(native)
  } finally {
    await t.close()
  }
}
