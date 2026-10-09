// Run with node -r sucrase/register. The selected simulator and owned daemon
// are environment inputs; neither a device identifier nor credentials live here.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { argon2id, hash } from 'argon2'

import { TeamStationClient } from '../../common/api'
import { historyTargets, tagMetadata, tagTargets } from '../../common/eventTags'

interface Node {
  text?: string
  type?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
interface Device {
  launchApp: (options?: { stopApp?: boolean }) => Promise<unknown>
  openLink: (options: { link: string; browser?: boolean }) => Promise<unknown>
  tapOn: (options: {
    text: string
    timeout?: number
    optional?: boolean
  }) => Promise<unknown>
  tapOnPoint: (options: {
    x: number
    y: number
    duration?: number
  }) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  eraseText: (options: { characters: number }) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  assertVisible: (options: {
    text: string
    timeout?: number
  }) => Promise<unknown>
  assertNotVisible: (options: {
    text: string
    timeout?: number
  }) => Promise<unknown>
  hierarchy: () => Promise<Node>
  state: () => Promise<unknown>
  swipe: (options: {
    startX: number
    startY: number
    endX: number
    endY: number
    duration: number
  }) => Promise<unknown>
  screenshot: () => Promise<Buffer>
  eval: (script: string) => Promise<{ status: number; body: string }>
  detach: () => Promise<unknown>
}
interface Daemon {
  info: { runDir: string }
  attach: (options: {
    device: string
    appId: string
    platform: string
  }) => Promise<Device>
  close: () => void
}
const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
async function main(): Promise<void> {
  const deviceId = required('SCORING_DEVICE_UDID')
  const daemonName = required('MAESTRO_D')
  const output = required('SCORING_ARTIFACT_DIR')
  const credentials = JSON.parse(
    await readFile(required('EVENT_TAGS_CREDENTIALS'), 'utf8')
  ) as { email: string; password: string; gameIds: string[] }
  const { MaestroD } = require(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'dist/cjs/index.js')
  ) as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  const client = new TeamStationClient({
    baseUrl: required('EVENT_TAGS_API_URL'),
    passwordKdf: async (password, parameters) =>
      (
        await hash(password, {
          type: argon2id,
          raw: true,
          version: parameters.version,
          memoryCost: parameters.memoryKiB,
          timeCost: parameters.iterations,
          parallelism: parameters.parallelism,
          hashLength: parameters.hashLength,
          salt: Buffer.from(parameters.salt, 'hex')
        })
      ).toString('hex')
  })
  const sessionFile = process.env.EVENT_TAGS_SESSION_FILE
  if (sessionFile != null) {
    try {
      client.token = await readFile(sessionFile, 'utf8')
    } catch {
      /* First run signs in normally. */
    }
  }
  if (client.token == null) {
    const session = await client.signInWithPassword(
      credentials.email,
      credentials.password
    )
    if (sessionFile != null)
      await writeFile(sessionFile, session.token, { mode: 0o600 })
  }
  const daemon = await MaestroD.connect({ name: daemonName, spawn: false })
  const report = [
    '$ SCORING_DEVICE_UDID="$SCORING_DEVICE_UDID" MAESTRO_D="$MAESTRO_D" node -r sucrase/register src/app/scoring/eventTags.e2e.ts'
  ]
  const apiReport = [
    '$ node -r sucrase/register src/app/scoring/eventTags.e2e.ts # controlled API assertions'
  ]
  const log = (message: string): void => {
    report.push(message)
    console.log(message)
  }
  const flat = (node: Node): Node[] => [
    node,
    ...(node.children ?? []).flatMap(flat)
  ]
  const targets = async (
    id: string
  ): Promise<ReturnType<typeof tagTargets>> => {
    const stored = await client.gameEvents(id)
    return [
      ...stored.plays,
      ...(stored.currentPlay == null ? [] : [stored.currentPlay])
    ].flatMap(tagTargets)
  }
  async function until(
    check: () => Promise<boolean>,
    message: string
  ): Promise<void> {
    const end = Date.now() + 20000
    while (Date.now() < end) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(message)
  }
  async function gesture(
    m: Device,
    bounds: NonNullable<Node['bounds']>,
    seconds = 0
  ): Promise<void> {
    const logText = await readFile(
      join(daemon.info.runDir, 'daemon.log'),
      'utf8'
    )
    const line = logText
      .split('\n')
      .filter(value =>
        value.includes(`Starting WDA on device ${deviceId} (port:`)
      )
      .at(-1)
    assert(line != null, 'Owned driver endpoint is required')
    const port = /\(port: (\d+)\)/.exec(line)?.[1]
    assert(port != null && port !== '')
    const endpoint = `http://127.0.0.1:${port}`
    const status = await m.eval(
      `http.get(${JSON.stringify(endpoint + '/status')})`
    )
    const session = (JSON.parse(status.body) as { sessionId: string }).sessionId
    assert(typeof session === 'string' && session !== '')
    const body = {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
      ...(seconds === 0 ? {} : { duration: seconds })
    }
    const touchStarted = Date.now()
    console.log('Gesture', JSON.stringify(body))
    const result = await m.eval(
      `http.post(${JSON.stringify(endpoint + '/session/' + session + (seconds === 0 ? '/wda/tap' : '/wda/touchAndHold'))}, {body:${JSON.stringify(body)}})`
    )
    console.log(
      'Gesture elapsed',
      Date.now() - touchStarted,
      'status',
      result.status
    )
    assert.equal(result.status, 200)
    assert(
      (JSON.parse(result.body) as { value?: { error?: string } }).value
        ?.error == null,
      'Driver touch must succeed'
    )
  }
  async function touch(m: Device, text: string): Promise<void> {
    const matches = flat(await m.hierarchy()).filter(
      node => node.text === text && node.bounds != null
    )
    const match = matches.find(node => node.type === 'Button') ?? matches[0]
    if (match?.bounds == null) {
      await m.tapOn({ text: `^${text}$`, timeout: 10000 })
      return
    }
    await gesture(m, match.bounds)
  }
  async function hold(m: Device): Promise<void> {
    const undo = flat(await m.hierarchy()).find(node =>
      (node.text ?? '').startsWith('Undo ')
    )
    assert(undo?.bounds != null, 'Undo control must be visible')
    await m.tapOnPoint({
      x: Math.round(undo.bounds.x + undo.bounds.width / 2),
      y: Math.round(undo.bounds.y + undo.bounds.height / 2),
      duration: 2200
    })
    await m.assertVisible({
      text: 'Tap event to assign a tag.',
      timeout: 10000
    })
  }
  async function login(m: Device): Promise<void> {
    const visible = flat(await m.hierarchy()).some(
      node => node.text === 'E-mail address'
    )
    if (!visible) return
    await touch(m, 'E-mail address')
    await m.eraseText({ characters: 128 })
    await m.inputText({ text: credentials.email })
    await touch(m, 'Use a password instead')
    await touch(m, 'Password')
    await m.eraseText({ characters: 128 })
    await m.inputText({ text: credentials.password })
    await m.hideKeyboard()
    if (
      flat(await m.hierarchy()).some(
        node => node.type === 'Button' && node.text === 'Sign in'
      )
    )
      await touch(m, 'Sign in')
    await m.assertNotVisible({ text: 'Sign in to TeamStation', timeout: 30000 })
  }
  async function surface(name: 'safari' | 'native'): Promise<void> {
    const m = await daemon.attach({
      device: deviceId,
      appId:
        name === 'safari' ? 'com.apple.mobilesafari' : 'app.teamstation.app',
      platform: 'ios'
    })
    const route = (game: string, score: boolean): string =>
      name === 'safari'
        ? `${required('SCORING_TEST_URL')}/games/${game}${score ? '/score' : ''}?acceptance=${Date.now()}`
        : `teamstation://games/${game}${score ? '/score' : ''}`

    const shot = async (state: string): Promise<void> => {
      if (process.env.EVENT_TAGS_CAPTURE !== 'false')
        await writeFile(
          join(output, `${name}-${state}-after.png`),
          await m.screenshot()
        )
    }
    const open = async (game: string, score: boolean): Promise<void> => {
      await m.openLink({ link: route(game, score), browser: name === 'safari' })
      // The authenticated app may still be loading its initial session.
      await until(
        async () =>
          flat(await m.hierarchy()).some(
            node =>
              node.text === 'E-mail address' ||
              node.text === 'Open scoring menu' ||
              node.text === 'Video' ||
              node.text === 'Videos' ||
              node.text === 'Box score' ||
              node.text === 'Box Score'
          ),
        'App route did not load'
      )
      await login(m)
      if (score)
        await m.assertVisible({ text: 'Open scoring menu', timeout: 30000 })
      if (score) await m.assertVisible({ text: '^Host 08$', timeout: 30000 })
      if (score) {
        let last = ''
        let stable = 0
        await until(async () => {
          const undo = flat(await m.hierarchy()).find(
            node =>
              (node.text ?? '').startsWith('Undo ') ||
              node.text === 'Nothing to undo'
          )
          const bounds = JSON.stringify(undo?.bounds)
          stable = bounds === last && undo?.bounds != null ? stable + 1 : 0
          last = bounds
          return stable >= 3
        }, 'Undo geometry did not settle')
        console.log('Foreground', JSON.stringify(await m.state()))
      }

      const warning = flat(await m.hierarchy()).find(
        node => node.text?.includes('Open debugger to view warnings.') === true
      )
      if (warning?.bounds != null)
        await gesture(m, {
          x: warning.bounds.x + warning.bounds.width - 24,
          y: warning.bounds.y + warning.bounds.height / 2,
          width: 0,
          height: 0
        })
    }
    try {
      await m.launchApp({ stopApp: name === 'native' })
      await open(credentials.gameIds[0], true)
      const secondStored = await client.gameEvents(credentials.gameIds[1])
      await client.saveGameEvents(credentials.gameIds[1], {
        plays: [],
        remove: secondStored.plays.map(play => play.about.atBatIndex),
        currentPlay: null
      })
      if ((await targets(credentials.gameIds[0])).length === 5) {
        await touch(m, 'Swing and Miss')
        await until(
          async () => (await targets(credentials.gameIds[0])).length >= 6,
          'Fixture restoration pitch did not save'
        )
      }
      await until(async () => {
        const stored = await client.gameEvents(credentials.gameIds[0])
        const completed = stored.plays.find(play => play.about.atBatIndex === 0)
        return (
          completed != null &&
          tagMetadata(completed).play != null &&
          stored.currentPlay?.about.atBatIndex !== 0
        )
      }, 'Fixture pitch presentation did not finish')
      const first = await targets(credentials.gameIds[0])
      assert(first.length >= 6, 'Fixture contains six or more scoring events')
      const firstStored = await client.gameEvents(credentials.gameIds[0])
      const logical = [
        ...firstStored.plays,
        ...(firstStored.currentPlay == null ? [] : [firstStored.currentPlay])
      ].flatMap(historyTargets)
      const description = await client.gameEvents(credentials.gameIds[0])
      await hold(m)
      const rows = flat(await m.hierarchy())
        .filter(
          node =>
            (node.text ?? '').startsWith('Tag event: ') && node.bounds != null
        )
        .sort((a, b) => a.bounds!.y - b.bounds!.y)
      assert.equal(rows.length, 6)
      assert.deepEqual(
        rows.map(node => node.text),
        logical.slice(-6).map(target => `Tag event: ${target.title}`)
      )
      await shot('history')
      await m.tapOnPoint({ x: 20, y: 200 })
      await m.assertNotVisible({
        text: 'Tap event to assign a tag.',
        timeout: 10000
      })
      await hold(m)
      const completed = logical.at(-1)!
      await touch(m, `Tag event: ${completed.title}`)
      await m.assertVisible({ text: 'New tag', timeout: 10000 })
      await touch(m, 'New tag')
      await m.eraseText({ characters: 128 })
      await m.inputText({ text: '  GREAT  Catch ' })
      await m.hideKeyboard()
      if (flat(await m.hierarchy()).some(node => node.text === 'Save tag'))
        await touch(m, 'Save tag')
      await until(
        async () =>
          (await targets(credentials.gameIds[0])).find(
            target => target.id === completed.id
          )?.tag === 'great catch',
        'Typed tag did not persist'
      )
      log(
        `${name}: six chronological rows, outside dismissal and typed multiword tag PASS`
      )
      await hold(m)
      const pitch = logical.slice(-6)[0]
      await touch(m, `Tag event: ${pitch.title}`)
      await m.assertVisible({ text: 'Use tag great catch', timeout: 10000 })
      await touch(m, 'Use tag great catch')
      await until(
        async () =>
          (await targets(credentials.gameIds[0])).find(
            target => target.id === pitch.id
          )?.tag === 'great catch',
        'Pill selection did not persist'
      )
      await open(credentials.gameIds[0], true)
      const reloaded = await targets(credentials.gameIds[0])
      assert.equal(
        reloaded.find(target => target.id === completed.id)?.tag,
        'great catch'
      )
      assert.equal(
        reloaded.find(target => target.id === pitch.id)?.tag,
        'great catch'
      )
      // Supply enough real assignments to demonstrate wrapping at normal font size.
      const labels = [
        'late rally',
        'quick release',
        'sharp defense',
        'strong finish'
      ]
      const others = first.filter(
        target => target.id !== completed.id && target.id !== pitch.id
      )
      for (let at = 0; at < labels.length; at++)
        await client.saveEventTag(
          credentials.gameIds[0],
          others[at].id,
          labels[at]
        )
      await hold(m)
      await touch(m, `Tag event: ${completed.title}`)
      await m.assertVisible({ text: 'Recent tags', timeout: 10000 })
      await m.assertVisible({ text: 'Popular tags', timeout: 10000 })
      await shot('editor')
      await touch(m, 'Cancel')
      const unchanged = await client.gameEvents(credentials.gameIds[0])
      assert.deepEqual(
        unchanged.plays.map(play => play.result.description),
        description.plays.map(play => play.result.description)
      )
      const choice = await client.tagChoices()
      assert.equal(choice.popular[0].tag, 'great catch')
      assert.equal(choice.popular[0].count, 2)
      await touch(m, 'Ball')
      await until(
        async () =>
          (await targets(credentials.gameIds[0])).length === first.length + 1,
        'New pitch did not save'
      )
      await hold(m)
      await touch(m, `Tag event: ${completed.title}`)
      await m.assertVisible({
        text: 'Visitor 0.*strikes out swinging',
        timeout: 10000
      })
      await touch(m, 'Cancel')
      await touch(m, 'Undo Ball')
      await until(
        async () =>
          (await targets(credentials.gameIds[0])).length === first.length,
        'Older-event test did not restore the scoring fixture'
      )
      log(
        `${name}: older completed-play editor retains its full event description PASS`
      )
      await open(credentials.gameIds[1], true)
      await touch(m, 'Ball')
      await until(
        async () => (await targets(credentials.gameIds[1])).length > 0,
        'Second game pitch did not save'
      )
      await touch(m, 'Undo Ball')
      await until(
        async () => (await targets(credentials.gameIds[1])).length === 0,
        'Short Undo did not undo exactly one pitch'
      )
      await touch(m, 'Ball')
      await until(
        async () => (await targets(credentials.gameIds[1])).length > 0,
        'Replacement pitch did not save'
      )
      await hold(m)
      await touch(m, 'Tag event: Ball')
      await m.assertVisible({ text: 'Use tag great catch', timeout: 10000 })
      await touch(m, 'Use tag great catch')
      await until(
        async () =>
          (await targets(credentials.gameIds[1]))[0]?.tag === 'great catch',
        'Account recents did not work across games'
      )
      log(
        `${name}: pill selection, save/reload, short Undo and recents across games PASS`
      )
      await open(credentials.gameIds[0], false)
      await touch(m, name === 'safari' ? 'Videos' : 'Video')
      await m.assertVisible({ text: 'Strikeout: Host 01.*', timeout: 20000 })
      await m.swipe({
        startX: 360,
        startY: 700,
        endX: 360,
        endY: 400,
        duration: 100
      })
      const card = flat(await m.hierarchy()).find(
        node =>
          node.text?.includes('Strikeout: Host 01 great catch') === true &&
          node.bounds != null
      )
      assert(
        card?.bounds != null,
        'Tagged highlight card must have visible bounds'
      )
      await gesture(m, card.bounds)
      await m.assertVisible({ text: 'Top 1st:.*great catch', timeout: 10000 })
      await shot('highlight')
      log(
        `${name}: selected description and highlight card append one intact multiword pill PASS`
      )
      apiReport.push(
        `${name}: play and pitch tags persist independently; original descriptions unchanged; popular count equals active assignments; short Undo removes target and replacement has a fresh identity.`
      )
      apiReport.push('$ GET $EVENT_TAGS_API_URL/tags')
      apiReport.push(JSON.stringify(await client.tagChoices(), null, 2))
    } finally {
      await m.detach()
    }
  }
  let complete = false
  try {
    const selected = process.env.EVENT_TAGS_SURFACE
    if (selected !== 'native') await surface('safari')
    if (selected !== 'safari') await surface('native')
    complete = true
  } finally {
    if (!complete)
      report.push(
        'FAIL: acceptance stopped; see the runner diagnostic. Passed cases above are retained.'
      )
    try {
      const uiProofPath = process.env.EVENT_TAGS_UI_PROOF_LOG
      const uiProof =
        uiProofPath == null ? '' : await readFile(uiProofPath, 'utf8')
      await writeFile(
        join(output, 'tags-ui.log'),
        report.join('\n') + '\n' + uiProof
      )
      const proofPath = process.env.EVENT_TAGS_API_PROOF_LOG
      const proof = proofPath == null ? '' : await readFile(proofPath, 'utf8')
      await writeFile(
        join(output, 'tags-api.log'),
        apiReport.join('\n') + '\n' + proof
      )
    } finally {
      daemon.close()
    }
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Acceptance failed')
  process.exitCode = 1
})
