/** Native recovery assertions use public UI and a real returning browser holder. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { executablePath } from 'puppeteer'

import type { TeamStationClient } from '../../common/api'
import {
  maestroClient,
  type MaestroDevice
} from '../../test/chat117Maestro.e2e'
import {
  controlRecovery,
  type RecoveryControl
} from '../../test/chatRecoveryControl'

interface Node {
  id?: string
  type?: string
  text?: string
  label?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
interface NativeDevice {
  hierarchy: () => Promise<Node>
  hierarchyRaw: () => Promise<Uint8Array>
  screenshot: () => Promise<Uint8Array>
  tapOn: (options: object) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  assertVisible: (options: object) => Promise<unknown>
  addMedia: (options: { files: string[] }) => Promise<unknown>
}
interface Browser extends MaestroDevice {
  detach: () => Promise<void>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: unknown }>
}
interface HolderDaemon {
  attach: (options: object) => Promise<Browser>
  shutdown: () => Promise<void>
  close: () => Promise<void>
}
interface Input {
  synthetic: true
  source: string
  scenario: 'E5' | 'E7'
  platform: 'ios' | 'android'
  actorUserId: string
  conversationId: string
  origin: string
  holder: { profile: string; email: string; password: string }
  oldPosts: Array<{ id: string; body: string }>
  current: { id: string; body: string }
  anchor: { id: string; body: string }
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
async function until<T>(
  what: string,
  read: () => Promise<T | undefined>,
  ms = 30000
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value != null) return value
    assert(Date.now() < end, what)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

async function withHolder(
  input: Input,
  run: () => Promise<void>
): Promise<void> {
  assert(input.holder.email.endsWith('@chat.example.com'))
  const origin = new URL(input.origin)
  assert(
    origin.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(origin.hostname)
  )
  const daemon = (await maestroClient().MaestroD.connect({
    name: process.env.MAESTRO_D + '-history-holder',
    bin: process.env.MAESTRO_D_BIN
  })) as unknown as HolderDaemon
  let browser: Browser | undefined
  try {
    browser = await daemon.attach({
      device: 'returning-history-holder',
      platform: 'web',
      driver: 'cdp',
      url: input.origin,
      extra: {
        browser: await executablePath(),
        windowSize: '1280x900',
        userDataDir: input.holder.profile
      }
    })
    await browser.openLink({ link: input.origin })
    await browser.assertVisible({
      css: 'input[aria-label="E-mail address"], [aria-label^="Account,"]',
      timeout: 30000
    })
    const login = await browser.evalBrowserScript({
      script:
        'return !!document.querySelector(\'input[aria-label="E-mail address"]\')'
    })
    if (login.data === true || login.data === 'true') {
      await browser.tapOn({ css: 'input[aria-label="E-mail address"]' })
      await browser.inputText({ text: input.holder.email })
      await browser.tapOn({ text: 'Use a password instead' })
      await browser.tapOn({ css: 'input[aria-label="Password"]' })
      await browser.inputText({ text: input.holder.password })
      await browser.tapOn({ text: 'Sign in' })
      await browser.assertVisible({ text: 'Account,', timeout: 30000 })
    }
    await browser.openLink({
      link: input.origin + '/chat/' + input.conversationId
    })
    await browser.assertVisible({ text: input.current.body, timeout: 30000 })
    await run()
  } finally {
    await browser?.detach()
    await daemon.shutdown()
    await daemon.close()
  }
}

export async function nativeHistoryRecovery(options: {
  inputFile: string
  relayFile: string
  results: string
  platform: string
  actorUserId: string
  conversationId: string
  apiUrl: string
  api: TeamStationClient
  device: NativeDevice
  open: () => Promise<void>
  reveal: (id: string) => Promise<void>
  composerValue: () => Promise<string>
  stop: () => Promise<void>
  restart: () => Promise<void>
}): Promise<Record<string, unknown>> {
  const input = JSON.parse(readFileSync(options.inputFile, 'utf8')) as Input
  assert.equal(input.synthetic, true)
  assert.equal(input.platform, options.platform)
  assert.equal(input.actorUserId, options.actorUserId)
  assert.equal(input.conversationId, options.conversationId)
  assert(['E5', 'E7'].includes(input.scenario))
  assert(input.oldPosts.length > 0)
  assert(input.oldPosts.some(post => post.id === input.anchor.id))
  const relay = JSON.parse(readFileSync(options.relayFile, 'utf8')) as {
    disposable: true
    source: string
    upstream: string
    endpoint: string
    token: string
    audit: string
  }
  assert.equal(relay.disposable, true)
  assert.equal(relay.source, input.source)
  assert.equal(relay.upstream, options.apiUrl)
  const control: RecoveryControl = {
    disposable: true,
    endpoint: relay.endpoint,
    token: relay.token,
    actors: {
      recipient: {
        userId: input.actorUserId,
        conversationId: input.conversationId
      }
    }
  }
  const m = options.device
  const api = options.api
  const epochs = (await api.chatEpochs(input.conversationId)).epochs
  assert.deepEqual(
    epochs.map(epoch => epoch.chainBreak),
    [false, true]
  )
  const originalPosts = (await api.chatMessages(input.conversationId)).filter(
    post => post.kind === 'post'
  )
  const audit = (): Array<{
    gateId: string
    event?: string
    remaining: number
  }> =>
    readFileSync(relay.audit, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  const picture = async (name: string): Promise<void> => {
    writeFileSync(
      join(options.results, `${input.platform}-${name}.png`),
      await m.screenshot()
    )
  }
  async function readable(post: { id: string; body: string }): Promise<void> {
    await options.reveal(post.id)
    await m.assertVisible({ text: post.body, timeout: 30000 })
  }
  try {
    await options.open()
    await options.reveal(input.anchor.id)
    await m.assertVisible({ text: 'Locked message', timeout: 30000 })
    const beforeBoxes = await api.chatEpochs(input.conversationId, 0, {
      boxesAfter: '0'
    })
    assert(
      !beforeBoxes.boxes.some(box => box.epoch === 1),
      'Recipient must genuinely lack historical distribution'
    )
    if (input.scenario === 'E5') {
      const gate = 'native-draft-history'
      await controlRecovery(control, [
        'recipient',
        'history-delay',
        gate,
        '60000'
      ])
      const file = join(options.results, 'recovery-photo.png')
      writeFileSync(
        file,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgZGD4DwABCAEBfBRbtQAAAABJRU5ErkJggg==',
          'base64'
        )
      )
      await m.addMedia({ files: [file] })
      await m.tapOn({ text: 'Attach' })
      await m.tapOn({ text: 'Photo library' })
      const photo = await until(
        'Synthetic imported image must be selectable',
        async () =>
          flatten(await m.hierarchy())
            .flatMap(node => [node.text, node.label])
            .find(text => text != null && /^Photo(?: taken|,)/.test(text))
      )
      await m.tapOn({ text: photo })
      const attachment = await until(
        'Prepared attachment must be visible',
        async () =>
          flatten(await m.hierarchy())
            .flatMap(node => [node.text, node.label])
            .find(
              text =>
                text?.startsWith('Remove ') === true &&
                !text.includes('reaction')
            )
      )
      const draft = 'Keep this draft while older history is recovered'
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: draft })
      await options.reveal(input.anchor.id)
      let readerAnchor: Input['anchor'] | undefined
      async function snapshot(): Promise<{
        anchor: string
        y: number
        draft: string
        focused: boolean
        unread: number
        reads: unknown
      }> {
        const tree = await m.hierarchy()
        const nodes = flatten(tree)
        if (readerAnchor == null) {
          const header = nodes.find(
            node => node.id === 'chat-conversation-identity'
          )?.bounds
          const composer = nodes.find(
            node => node.id === 'chat-composer'
          )?.bounds
          assert(
            header != null && composer != null,
            'Actual reading band must be measurable'
          )
          const candidates = nodes
            .filter(
              node =>
                node.bounds != null &&
                node.bounds.y >= header.y + header.height &&
                node.bounds.y < composer.y &&
                input.oldPosts.some(
                  post => node.id === 'chat-message-' + post.id
                )
            )
            .sort((a, b) => a.bounds!.y - b.bounds!.y)
          readerAnchor = input.oldPosts.find(
            post => candidates[0]?.id === 'chat-message-' + post.id
          )
          assert(
            readerAnchor != null,
            'First fully visible historical reader row must exist'
          )
        }
        const row = nodes.find(
          node => node.id === 'chat-message-' + readerAnchor!.id
        )
        assert(
          row?.bounds != null && row.bounds.height > 0,
          'Reader anchor must be rendered'
        )
        await m.assertVisible({ text: attachment, timeout: 10000 })
        const raw = Buffer.from(await m.hierarchyRaw()).toString('utf8')
        const focused =
          input.platform === 'ios'
            ? raw.includes('XCUIElementTypeKeyboard')
            : /<[^>]*resource-id="[^"]*chat-composer"[^>]*focused="true"/.test(
                raw
              )
        const conversation = (await api.chatConversations()).find(
          row => row.id === input.conversationId
        )
        assert(conversation != null)
        return {
          anchor: readerAnchor.id,
          y: row.bounds.y,
          draft: await options.composerValue(),
          focused,
          unread: conversation.unread,
          reads: (await api.chatReads(input.conversationId)).filter(
            row => row.userId === input.actorUserId
          )
        }
      }
      const before = await snapshot()
      writeFileSync(
        join(options.results, 'draft-before-hierarchy.json'),
        JSON.stringify(await m.hierarchy(), null, 2)
      )
      assert.equal(before.draft, draft)
      assert(
        before.focused,
        'Draft must retain the actual keyboard focus before recovery'
      )
      await withHolder(input, async () => {
        await until('Real native history delivery must be held', async () => {
          const rows = audit().filter(row => row.gateId === gate)
          assert(
            !rows.some(row => row.event === 'delay-released'),
            'History hold expired before explicit release'
          )
          return rows.some(row => row.event == null && row.remaining === 0)
            ? true
            : undefined
        })
        await picture('draft-before-history')
        await controlRecovery(control, ['clear'])
        // Do not scroll after release: assert the existing reader location.
        await m.assertVisible({ text: readerAnchor!.body, timeout: 30000 })
        const after = await snapshot()
        writeFileSync(
          join(options.results, 'draft-history-measurements.json'),
          JSON.stringify({ before, after, attachment }, null, 2)
        )
        await picture('draft-after-history')
        assert.equal(after.draft, before.draft)
        assert(
          after.focused,
          'Historical recovery must not dismiss the keyboard'
        )
        assert(
          Math.abs(after.y - before.y) <= 2,
          'Historical row expansion must preserve the reader anchor'
        )
        assert.equal(after.unread, before.unread)
        assert.deepEqual(after.reads, before.reads)
      })
      assert.deepEqual(
        (await api.chatMessages(input.conversationId)).filter(
          post => post.kind === 'post'
        ),
        originalPosts
      )
    } else {
      const gate = 'native-history-outage'
      await controlRecovery(control, ['recipient', 'history-outage', gate])
      await options.stop()
      await options.restart()
      await options.open()
      await m.assertVisible({
        text: 'Older messages could not be recovered yet.',
        timeout: 30000
      })
      await until(
        'Real native history fetch must reach the outage',
        async () =>
          audit().some(row => row.gateId === gate && row.event == null)
            ? true
            : undefined
      )
      const body =
        'Current native message while historical fetch is unavailable'
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: body })
      await m.tapOn({ text: 'Send' })
      await m.assertVisible({ text: body, timeout: 30000 })
      await picture('history-error-current-send')
      await m.tapOn({ text: 'Try again' })
      await controlRecovery(control, ['clear'])
      await options.stop()
      await withHolder(input, async () => {
        await until(
          'Holder must distribute old keys while native recipient is stopped',
          async () =>
            (
              await api.chatEpochs(input.conversationId, 0, { boxesAfter: '0' })
            ).boxes.some(box => box.epoch === 1)
              ? true
              : undefined
        )
      })
      await options.restart()
      await options.open()
      for (const post of input.oldPosts) await readable(post)
      await readable(input.current)
      await m.assertVisible({ text: body, timeout: 30000 })
      const posts = (await api.chatMessages(input.conversationId)).filter(
        post => post.kind === 'post'
      )
      assert.equal(posts.length, originalPosts.length + 1)
      assert.equal(new Set(posts.map(post => post.id)).size, posts.length)
      await picture('retry-restarted-history')
    }
    assert.deepEqual(
      (await api.chatEpochs(input.conversationId)).epochs,
      epochs
    )
    return {
      scenario: input.scenario,
      platform: input.platform,
      source: input.source,
      realReturningHolder: true,
      historyIndependentOfSending: true,
      epochsUnchanged: true
    }
  } finally {
    await controlRecovery(control, ['clear'])
  }
}
