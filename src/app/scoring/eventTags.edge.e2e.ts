// Real-server edge acceptance. Fixture controls and credentials are external,
// private QA inputs; the application contains no fault injection hooks.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { TeamStationClient } from '../../common/api'
import { tagTargets } from '../../common/eventTags'

interface Node {
  text?: string
  type?: string
  enabled?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
type Device = Record<string, (...args: unknown[]) => Promise<unknown>>
interface Actor {
  email: string
  password: string
  userId?: number
  token?: string
}
interface Fixture {
  gameId: string
  primaryGameId: string
  primaryEmail: string
  primaryPassword: string
  admin: Actor
  readOnly: Actor
  controlUrl: string
  scoreUrl: string
  nativeLink: string
}
const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const flat = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flat)
]
const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const deviceId = required('SCORING_DEVICE_UDID')
  const output = required('SCORING_ARTIFACT_DIR')
  const cfg = JSON.parse(
    await readFile(required('EVENT_TAGS_EDGE_CONFIG'), 'utf8')
  ) as Fixture
  const primary: Actor = {
    email: cfg.primaryEmail,
    password: cfg.primaryPassword
  }
  const { MaestroD } = require(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'dist/cjs/index.js')
  ) as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<{
        info: { runDir: string }
        attach: (options: {
          device: string
          appId: string
          platform: string
        }) => Promise<Device>
        close: () => void
      }>
    }
  }
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const client = new TeamStationClient({
    baseUrl: required('EVENT_TAGS_API_URL'),
    token: await readFile(required('EVENT_TAGS_SESSION_FILE'), 'utf8')
  })
  const report = [
    '$ SCORING_DEVICE_UDID="$SCORING_DEVICE_UDID" MAESTRO_D="$MAESTRO_D" node -r sucrase/register src/app/scoring/eventTags.edge.e2e.ts'
  ]
  const log = (line: string): void => {
    report.push(line)
    console.log(line)
  }
  const control = async (path: string): Promise<void> => {
    const response = await fetch(`${cfg.controlUrl}/${path}`, {
      method: 'POST'
    })
    assert(response.ok, `Fixture control ${path} must succeed`)
  }
  const until = async (
    test: () => Promise<boolean>,
    message: string,
    timeout = 30000
  ): Promise<void> => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await test()) return
      await wait(100)
    }
    throw new Error(message)
  }
  async function surface(name: 'safari' | 'native'): Promise<void> {
    const m = await daemon.attach({
      device: deviceId,
      appId:
        name === 'safari' ? 'com.apple.mobilesafari' : 'app.teamstation.app',
      platform: 'ios'
    })
    const nodes = async (): Promise<Node[]> =>
      flat((await m.hierarchy()) as Node)
    const has = async (text: string): Promise<boolean> =>
      (await nodes()).some(node => node.text === text)
    const visible = async (text: string): Promise<void> => {
      await m.assertVisible({ text, timeout: 20000 })
    }
    const absent = async (text: string): Promise<void> => {
      await m.assertNotVisible({ text, timeout: 10000 })
    }
    const tap = async (text: string): Promise<void> => {
      const choices = (await nodes()).filter(
        node => node.text === text && node.bounds != null
      )
      const found = choices.find(node => node.type === 'Button') ?? choices[0]
      if (found?.bounds == null) {
        await m.tapOn({ text: `^${text}$`, timeout: 10000 })
        return
      }
      const b = found.bounds
      await m.tapOnPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    }
    const field = async (): Promise<void> => {
      await visible('Open scoring menu')
      await visible('^Host 08$')
      const warning = (await nodes()).find(
        node => node.text?.includes('Open debugger to view warnings.') === true
      )
      if (warning?.bounds != null)
        await m.tapOnPoint({
          x: warning.bounds.x + warning.bounds.width - 24,
          y: warning.bounds.y + warning.bounds.height / 2
        })
    }
    const route = (game: string, score: boolean): string =>
      name === 'safari'
        ? `${required('SCORING_TEST_URL')}/games/${game}${score ? '/score' : ''}?edge=${Date.now()}`
        : `teamstation://games/${game}${score ? '/score' : ''}`
    const openScore = async (game = cfg.gameId): Promise<void> => {
      await m.openLink({ link: route(game, true), browser: name === 'safari' })
      await field()
    }
    const hold = async (text?: string): Promise<void> => {
      const found = (await nodes()).find(node =>
        text == null
          ? node.text?.startsWith('Undo ') === true
          : node.text === text
      )
      assert(found?.bounds != null, 'History control must be visible')
      const b = found.bounds
      await m.tapOnPoint({
        x: b.x + b.width / 2,
        y: b.y + b.height / 2,
        duration: 2200
      })
    }
    const editor = async (): Promise<void> => {
      await hold()
      await visible('Tap event to assign a tag.')
      await tap('Tag event: Strikeout')
      await visible('New tag')
    }
    const type = async (value: string): Promise<void> => {
      await tap('New tag')
      await m.eraseText({ characters: 128 })
      await m.inputText({ text: value })
      await m.hideKeyboard()
    }
    const inputValue = async (): Promise<string | undefined> => {
      const lines = (
        await readFile(join(daemon.info.runDir, 'daemon.log'), 'utf8')
      ).split('\n')
      const line = lines
        .filter(value =>
          value.includes(`Starting WDA on device ${deviceId} (port:`)
        )
        .at(-1)
      const port = line == null ? undefined : /\(port: (\d+)\)/.exec(line)?.[1]
      assert(port != null, 'Owned driver endpoint must exist')
      const result = (await m.eval(
        `http.get(${JSON.stringify(`http://127.0.0.1:${port}/source`)})`
      )) as { body: string }
      const xml = (JSON.parse(result.body) as { value: string }).value
      const element = [...xml.matchAll(/<XCUIElementTypeTextField\b[^>]*>/g)]
        .map(match => match[0])
        .find(
          value =>
            value.includes('label="New tag"') ||
            value.includes('name="New tag"')
        )
      return element == null ? undefined : /value="([^"]*)"/.exec(element)?.[1]
    }
    const exit = async (): Promise<void> => {
      if (await has('Cancel')) await tap('Cancel')
      if (await has('Open scoring menu')) {
        await tap('Open scoring menu')
        await tap('Exit Current Game')
        await until(
          async () =>
            (await has('Discard and Exit')) ||
            (await nodes()).some(
              node => node.text?.startsWith('Account,') === true
            ),
          'Scoring exit did not finish'
        )
        if (await has('Discard and Exit')) await tap('Discard and Exit')
      }
    }
    const login = async (actor: Actor): Promise<void> => {
      await visible('Sign in to TeamStation')
      // Choose the mode before the keyboard can cover its button.
      if (await has('Use a password instead'))
        await tap('Use a password instead')
      // The upper email field stays above Safari's keyboard after focus.
      // Fill the lower secure field while its geometry is still unobscured.
      await tap('Password')
      await m.eraseText({ characters: 128 })
      await m.inputText({ text: actor.password })
      await tap('E-mail address')
      await m.eraseText({ characters: 128 })
      await m.inputText({ text: actor.email })
      await m.hideKeyboard()
      if (await has('Sign in')) await tap('Sign in')
      await absent('Sign in to TeamStation')
    }
    const switchUser = async (actor: Actor): Promise<void> => {
      await exit()
      const account = (await nodes()).find(
        node =>
          node.text?.startsWith('Account,') === true && node.bounds != null
      )
      assert(account?.text != null, 'Account navigation must be reachable')
      await tap(account.text)
      await m.scrollUntilVisible({
        element: { text: '^Sign out$' },
        direction: 'DOWN',
        maxScrolls: 8
      })
      await tap('Sign out')
      await login(actor)
    }
    const clearTags = async (): Promise<void> => {
      const stored = await client.gameEvents(cfg.gameId)
      for (const target of [
        ...stored.plays,
        ...(stored.currentPlay == null ? [] : [stored.currentPlay])
      ].flatMap(tagTargets))
        if (target.tag != null)
          await client.saveEventTag(cfg.gameId, target.id, null)
    }
    try {
      await m.openLink({
        link: route(cfg.primaryGameId, false),
        browser: name === 'safari'
      })
      await until(
        async () =>
          (await has('E-mail address')) ||
          (await nodes()).some(
            node => node.text?.startsWith('Account,') === true
          ),
        'Signed account did not load'
      )
      if (await has('E-mail address')) await login(primary)
      const account = (await nodes()).find(
        node => node.text?.startsWith('Account,') === true
      )
      if (
        account != null &&
        account.text?.endsWith(cfg.primaryEmail.split('@')[0]) !== true
      )
        await switchUser(primary)
      assert(
        cfg.admin.token != null,
        'A private fresh-account API session is required'
      )
      const otherClient = new TeamStationClient({
        baseUrl: required('EVENT_TAGS_API_URL'),
        token: cfg.admin.token
      })
      const accountHistory = (await otherClient.tagChoices()).recent
      log(`${name}: begin real failure/retry and stale-completion cases`)
      await openScore()
      await editor()
      await control('drop')
      await type('great catch')
      if (await has('Save tag')) await tap('Save tag')
      await visible('This scoring event no longer exists')
      assert.equal(
        await inputValue(),
        'great catch',
        'Failed save retains the exact input'
      )
      await control('restore')
      await tap('Save tag')
      await absent('New tag')
      log(
        `${name}: real target404 retains input; restored target retries successfully PASS`
      )

      await editor()
      const stored = await client.gameEvents(cfg.gameId)
      const target = stored.plays
        .flatMap(tagTargets)
        .find(value => value.completed === true)
      assert(target != null, 'The controlled completed event must exist')
      await control('lock')
      await type('quick release')
      if (await has('Save tag')) await tap('Save tag')
      await visible('Saving tag…')
      await tap('Cancel')
      await hold()
      await tap('Tag event: Called Strike')
      await visible('New tag')
      await control('release')
      await until(
        async () =>
          (await client.gameEvents(cfg.gameId)).plays
            .flatMap(tagTargets)
            .find(value => value.id === target.id)?.tag === 'quick release',
        'Old save did not complete'
      )
      await wait(1000)
      await visible('Called Strike')
      await visible('New tag')
      await tap('Cancel')
      log(
        `${name}: old queued save cannot close a newly selected event editor PASS`
      )

      await editor()
      await control('lock')
      await type('sharp defense')
      if (await has('Save tag')) await tap('Save tag')
      await visible('Saving tag…')
      await tap('Cancel')
      await switchUser(cfg.admin)
      await openScore(cfg.primaryGameId)
      await editor()
      if (accountHistory.length === 0) await absent('Recent tags')
      else await visible('Recent tags')
      await control('release')
      await until(
        async () =>
          (await client.gameEvents(cfg.gameId)).plays
            .flatMap(tagTargets)
            .find(value => value.id === target.id)?.tag === 'sharp defense',
        'Old-account save did not complete'
      )
      await wait(1000)
      await visible('New tag')
      assert.deepEqual(
        (await otherClient.tagChoices()).recent,
        accountHistory,
        'Old-account completion must not alter the new account history'
      )
      if (accountHistory.length === 0) await absent('Recent tags')
      await tap('Cancel')
      await openScore()
      await editor()
      await tap('Use tag great catch')
      await absent('New tag')
      await editor()
      await visible('Recent tags')
      await tap('Cancel')
      log(
        `${name}: game/account switch invalidates old selection; fresh account history remains isolated and reuse is recorded PASS`
      )

      await switchUser(cfg.readOnly)
      await openScore()
      await tap('Ball')
      await visible('Scoring is read-only')
      await visible('Nothing to undo')
      await hold('Nothing to undo')
      await absent('Tap event to assign a tag.')
      await absent('New tag')
      log(
        `${name}: actual member403 makes scoring read-only and blocks tag editing PASS`
      )
      await switchUser(primary)
      await clearTags()
    } finally {
      await control('release')
      await control('restore')
      try {
        await clearTags()
      } finally {
        await m.detach()
      }
    }
  }
  let complete = false
  try {
    const selected = process.env.EVENT_TAGS_SURFACE
    if (selected !== 'native') await surface('safari')
    if (selected !== 'safari') await surface('native')
    complete = true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Acceptance failed'
    const secrets = [
      deviceId,
      cfg.primaryPassword,
      cfg.admin.password,
      cfg.readOnly.password,
      cfg.admin.token,
      cfg.readOnly.token,
      client.token
    ].filter(
      (value): value is string => typeof value === 'string' && value !== ''
    )
    console.error(
      secrets.some(value => message.includes(value))
        ? 'Diagnostic contains private credentials and was withheld.'
        : message
    )
    throw error
  } finally {
    if (!complete)
      report.push(
        'FAIL: edge acceptance stopped; passed cases above are retained.'
      )
    await writeFile(join(output, 'tags-edge.log'), report.join('\n') + '\n')
    daemon.close()
  }
}
main().catch(() => {
  console.error('Edge acceptance stopped; see the private driver diagnostic.')
  process.exitCode = 1
})
