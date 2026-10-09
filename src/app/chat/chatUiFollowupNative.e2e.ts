/** Native follow-up proof uses explicit devices and private synthetic fixtures. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'

import { type ChatConversation, TeamStationClient } from '../../common/api'
import { passwordBytes } from '../../common/passwordProtocol'
import { nativeArgon } from '../../server/auth/passwords'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Hierarchy {
  type?: string
  text?: string
  label?: string
  value?: string
  hint?: string
  id?: string
  bounds?: Bounds
  children?: Hierarchy[]
}
interface Device {
  stopApp: (options: object) => Promise<unknown>
  launchApp: (options: object) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (options: object) => Promise<unknown>
  tapOnPoint: (options: object) => Promise<unknown>
  longPressOn: (options: object) => Promise<unknown>
  dragAndDrop: (options: object) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  eraseText: (options?: object) => Promise<unknown>
  hideKeyboard: (options?: object) => Promise<unknown>
  pasteText: (options?: object) => Promise<unknown>
  startRecording: (options: { path: string }) => Promise<unknown>
  stopRecording: (options: { path: string }) => Promise<unknown>
  addMedia: (options: { files: string[] }) => Promise<unknown>
  back: (options?: object) => Promise<unknown>
  swipe: (options: object) => Promise<unknown>
  scrollUntilVisible: (options: object) => Promise<unknown>
  setOrientation: (options: { orientation: string }) => Promise<unknown>
  assertVisible: (options: object) => Promise<unknown>
  assertNotVisible: (options: object) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  hierarchy: () => Promise<Hierarchy>
  hierarchyRaw: () => Promise<Uint8Array>
  platformInfo: () => Promise<unknown>
  detach: () => Promise<unknown>
}
interface Daemon {
  startDevice: (options: object) => Promise<unknown>
  attach: (options: object) => Promise<Device>
  shutdown: () => Promise<unknown>
  close: () => Promise<unknown>
}
interface Fixture {
  synthetic: true
  disposable?: boolean
  appId: string
  scheme: string
  apiUrl: string
  conversationId: string
  conversationLabel: string
  scopeName: string
  scopePill: string
  targetText: string
  replyText: string
  originalMessageIds: string[]
  draft: string
  probePost: string
  probeEdit: string
  nativeReplyText?: string
  nativeOwnPostText?: string
  photoPath?: string
  photoLabel?: string
  oversizePhotoPath?: string
  oversizeDocumentName?: string
  oversizeDocumentFolder?: string
  reader?: {
    conversationId: string
    conversationLabel: string
    messageId: string
    body: string
  }
  initialMessagePinned?: boolean
  initialPreferences?: { pinned: boolean; muted: boolean }
  orientationPolicy: 'portrait-only' | 'rotate'
  actor: { userId: number; email: string; password: string }
  peers?: Array<{ userId: number }>
}

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}

const fixture = JSON.parse(
  readFileSync(required('CHAT_UI_NATIVE_FIXTURE_FILE'), 'utf8')
) as Fixture
assert(fixture.synthetic, 'Only a synthetic fixture may be used')
assert(
  /@[^@]+\.example\.(?:com|test)$/.test(fixture.actor.email),
  'Synthetic fixture address required'
)
const platform = required('CHAT_PLATFORM')
assert(
  platform === 'ios' || platform === 'android',
  'Explicit native platform required'
)
const deviceId = required('CHAT_DEVICE')
const daemonName = required('MAESTRO_D')
const artifactDirectory = resolve(required('CHAT_UI_ARTIFACTS'))
const resultDirectory = resolve(required('CHAT_UI_NATIVE_RESULTS'))
const appFile = resolve(required('CHAT_UI_NATIVE_BUILD'))
const sourceStage = process.env.CHAT_UI_NATIVE_STAGE ?? 'M2'
assert(
  ['M2', 'M3', 'M4'].includes(sourceStage),
  'Supported source stage required'
)
const hidden = [
  fixture.actor.password,
  deviceId,
  fixture.apiUrl,
  appFile,
  fixture.conversationId,
  ...fixture.originalMessageIds
]
const results: Record<string, unknown> = {
  platform,
  stage: sourceStage,
  checks: []
}
let stage = 'setup'

function flatten(node: Hierarchy | Hierarchy[]): Hierarchy[] {
  if (Array.isArray(node)) return node.flatMap(flatten)
  return [node, ...(node.children ?? []).flatMap(flatten)]
}

function strings(nodes: Hierarchy[]): string[] {
  return nodes.flatMap(node =>
    [node.text, node.label, node.value, node.hint].filter(
      (value): value is string => typeof value === 'string' && value !== ''
    )
  )
}

function xmlText(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'"
  }
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_all, entity: string) => {
      if (entity.startsWith('#x'))
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
      if (entity.startsWith('#'))
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
      return named[entity.toLowerCase()]
    }
  )
}

async function composerValue(device: Device): Promise<string> {
  const raw = Buffer.from(await device.hierarchyRaw()).toString('utf8')
  const element =
    /<[^>]*(?:name|resource-id|identifier)="[^"]*chat-composer"[^>]*>/.exec(
      raw
    )?.[0]
  assert(element != null, 'Native composer element must be present')
  if (platform === 'android' && /\bshowing-hint="true"/.test(element)) return ''
  const value =
    /\bvalue="([^"]*)"/.exec(element)?.[1] ??
    /\btext="([^"]*)"/.exec(element)?.[1]
  // XCUITest omits value entirely for an empty UITextView.
  assert(
    value != null || platform === 'ios',
    'Native composer value must be readable'
  )
  return xmlText(value ?? '')
}

async function physicalMessageHold(
  device: Device,
  rowId: string,
  bodyText: string,
  duration: number
): Promise<void> {
  await device.scrollUntilVisible({
    element: { id: rowId },
    direction: 'UP',
    timeout: 30000
  })
  let previous: Bounds | undefined
  let parent: Bounds | undefined
  const bounds = await until(
    'Actual native message must settle before a physical hold',
    async () => {
      const row = flatten(await device.hierarchy()).find(
        node => node.id === rowId
      )
      parent = row?.bounds
      const body =
        row == null
          ? undefined
          : flatten(row).find(
              node =>
                (node.text === bodyText || node.label === bodyText) &&
                node.bounds != null
            )
      const current = body?.bounds
      assert(
        current != null && current.width > 0 && current.height > 0,
        'Actual identified message body bounds required'
      )
      const stable =
        previous != null &&
        Math.abs(previous.x - current.x) < 1 &&
        Math.abs(previous.y - current.y) < 1
      previous = current
      return stable ? current : undefined
    },
    15000
  )
  const x = Math.round(bounds.x + bounds.width / 2)
  const y = Math.round(bounds.y + bounds.height / 2)
  if (platform === 'android')
    await device.swipe({ startX: x, startY: y, endX: x, endY: y, duration })
  else {
    assert(
      parent != null && parent.width > 0 && parent.height > 0,
      'Actual native row bounds required'
    )
    const relativeX = ((x - parent.x) / parent.width) * 100
    const relativeY = ((y - parent.y) / parent.height) * 100
    assert(
      relativeX >= 0 && relativeX <= 100 && relativeY >= 0 && relativeY <= 100,
      'Body point must be inside selected native row'
    )
    await device.longPressOn({
      id: rowId,
      point: `${relativeX}%,${relativeY}%`,
      duration
    })
  }
}

async function tapVisibleControl(device: Device, label: string): Promise<void> {
  const node = await until(
    'Actual native control must be present',
    async () =>
      flatten(await device.hierarchy()).find(
        node =>
          (node.text === label || node.label === label) &&
          node.bounds != null &&
          node.bounds.width > 0 &&
          node.bounds.height > 0
      ),
    10000
  )
  const bounds = node.bounds!
  await device.tapOnPoint({
    point: `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
  })
}

async function tapStableControl(device: Device, label: string): Promise<void> {
  let prior: Bounds | undefined
  const bounds = await until(
    'Native picker control must finish layout before selection',
    async () => {
      const current = flatten(await device.hierarchy()).find(
        node =>
          (node.text === label || node.label === label) && node.bounds != null
      )?.bounds
      if (current == null) return undefined
      const stable =
        prior != null &&
        Math.abs(prior.x - current.x) < 1 &&
        Math.abs(prior.y - current.y) < 1
      prior = current
      return stable ? current : undefined
    },
    15000
  )
  await device.tapOnPoint({
    point: `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
  })
}

function pass(check: string): void {
  ;(results.checks as string[]).push(check)
  console.log(`PASS ${platform} ${check}`)
}

async function observer(): Promise<TeamStationClient> {
  const client = new TeamStationClient({
    baseUrl: fixture.apiUrl,
    passwordKdf: async (password, parameters) =>
      await nativeArgon(passwordBytes(password), parameters)
  })
  const session = await client.signInWithPassword(
    fixture.actor.email,
    fixture.actor.password
  )
  hidden.push(session.token)
  assert.equal(
    session.user.id,
    fixture.actor.userId,
    'Observer account must match the retained native account'
  )
  return client
}

async function until<T>(
  description: string,
  read: () => Promise<T | undefined>,
  timeout = 30000
): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value != null) return value
    assert(Date.now() < end, description)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

async function main(): Promise<void> {
  mkdirSync(artifactDirectory, { recursive: true })
  mkdirSync(resultDirectory, { recursive: true })
  const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
  const { MaestroD } = createRequire(join(resolve(clientRoot), 'package.json'))(
    'maestro-d'
  ) as { MaestroD: { connect: (options: object) => Promise<Daemon> } }
  const daemon = await MaestroD.connect({ name: daemonName, idleTimeout: 0 })
  let device: Device | undefined
  let recording = false
  try {
    if (platform === 'ios') {
      assert(
        process.env.CHAT_UI_BOOT_OWNED_SIMULATOR === '1',
        'Explicit owned simulator boot permission required'
      )
      await daemon.startDevice({ platform, name: deviceId, bootTimeout: 180 })
    }
    console.log(
      '$ attach explicit native device; install retained-data Release build; launch without clearState'
    )
    device = await daemon.attach({
      device: deviceId,
      platform,
      appId: fixture.appId,
      appFile,
      artifacts: 'none',
      driverStartTimeout: 180
    })
    await device.stopApp({ appId: fixture.appId }).catch(() => undefined)
    await device.launchApp({
      appId: fixture.appId,
      permissions: { all: 'unset' }
    })
    const m = device
    if (process.argv[2] === 'locked-link') {
      stage = 'normal-disposable-native-link'
      assert(
        fixture.disposable === true &&
          process.env.CHAT_UI_NATIVE_DISPOSABLE === '1',
        'Only explicitly new owned disposable devices may enroll a test actor'
      )
      const loginLabels = await until(
        'Owned disposable launch must settle its normal authentication route',
        async () => {
          const labels = strings(flatten(await m.hierarchy()))
          return labels.some(label => label.startsWith('Account, ')) ||
            labels.includes('Use a password instead') ||
            labels.includes('Sign in to TeamStation')
            ? labels
            : undefined
        },
        60000
      )
      if (!loginLabels.some(label => label.startsWith('Account, '))) {
        if (loginLabels.includes('Use a password instead'))
          await m.tapOn({ text: 'Use a password instead' })
        await m.assertVisible({ text: 'E-mail address', timeout: 60000 })
        await m.tapOn({ text: 'E-mail address' })
        await m.eraseText()
        await m.inputText({ text: fixture.actor.email })
        if (platform === 'android') await m.hideKeyboard()
        else await m.tapOn({ text: 'Sign in to TeamStation' })
        await m.tapOn({ text: 'Password' })
        await m.eraseText()
        await m.inputText({ text: fixture.actor.password })
        if (platform === 'android') await m.hideKeyboard()
        else {
          // Blur the secure field before tapping a button below the keyboard.
          await m.tapOn({ text: 'Sign in to TeamStation' })
        }
        const signInButton = flatten(await m.hierarchy())
          .filter(
            node =>
              (node.text === 'Sign in' || node.label === 'Sign in') &&
              node.bounds != null
          )
          .sort((a, b) => b.bounds!.y - a.bounds!.y)[0]
        assert(signInButton?.bounds != null, 'Sign-in action must be visible')
        await m.tapOnPoint({
          point: `${Math.round(signInButton.bounds.x + signInButton.bounds.width / 2)},${Math.round(signInButton.bounds.y + signInButton.bounds.height / 2)}`
        })
        await m.assertNotVisible({
          text: 'Sign in to TeamStation',
          timeout: 60000
        })
      }
      await until(
        'Normal sign-in must expose the actual account',
        async () =>
          strings(flatten(await m.hierarchy())).some(label =>
            label.startsWith('Account, ')
          )
            ? true
            : undefined,
        60000
      )
      // The system password dialog can arrive after the first account frame.
      for (let check = 0; check < 3; check++) {
        if (strings(flatten(await m.hierarchy())).includes('Not Now'))
          await tapVisibleControl(m, 'Not Now')
        await new Promise(resolve => setTimeout(resolve, 350))
      }
      await m.assertVisible({ text: 'Chat', timeout: 60000 })
      const tab = flatten(await m.hierarchy())
        .filter(
          node =>
            (node.text === 'Chat' || node.label === 'Chat') &&
            node.bounds != null
        )
        .sort((a, b) => b.bounds!.y - a.bounds!.y)[0]
      assert(tab?.bounds != null, 'Owned new app must expose Chat tab')
      await m.tapOnPoint({
        point: `${Math.round(tab.bounds.x + tab.bounds.width / 2)},${Math.round(tab.bounds.y + tab.bounds.height / 2)}`
      })
      await m.assertVisible({ text: 'Link this device', timeout: 60000 })
      const code = await until(
        'Normal new-device six-digit code must be visible',
        async () =>
          strings(flatten(await m.hierarchy()))
            .flatMap(label => {
              const accessible = /^Six-digit code (\d{6})$/.exec(label)?.[1]
              return (
                accessible ??
                (/^\d{3}\s\d{3}$/.test(label) ? label.replace(/\s/g, '') : [])
              )
            })
            .find(Boolean),
        30000
      )
      hidden.push(code)
      writeFileSync(
        required('CHAT_UI_NATIVE_LINK_REQUEST'),
        JSON.stringify(
          {
            code,
            nativeDeviceId: deviceId,
            platform,
            actorUserId: fixture.actor.userId,
            normalUiLinkRequest: true
          },
          null,
          2
        )
      )
      console.log(
        'READY owned new native normal link request saved privately; awaiting matched provider approval'
      )
      await until(
        'Normal matched provider identity-link approval required',
        async () =>
          strings(flatten(await m.hierarchy())).includes('Chats')
            ? true
            : undefined,
        180000
      )
      results.identityLinked = {
        actorUserId: fixture.actor.userId,
        nativeDeviceId: deviceId,
        normalUi: true,
        historyApproval: false
      }
      writeFileSync(
        join(resultDirectory, `${platform}-locked-linked.png`),
        await m.screenshot()
      )
      pass(
        'owned disposable native identity linked through normal provider approval'
      )
      return
    }
    await m.assertVisible({ text: 'Chat', timeout: 60000 })
    const chatTab = flatten(await m.hierarchy())
      .filter(
        node =>
          (node.text === 'Chat' || node.label === 'Chat') && node.bounds != null
      )
      .sort((a, b) => b.bounds!.y - a.bounds!.y)[0]
    assert(
      chatTab?.bounds != null,
      'Retained app must expose the native Chat tab'
    )
    await m.tapOnPoint({
      point: `${Math.round(chatTab.bounds.x + chatTab.bounds.width / 2)},${Math.round(chatTab.bounds.y + chatTab.bounds.height / 2)}`
    })
    if (process.argv[2] === 'inspect-unready') {
      const tree = await m.hierarchy()
      writeFileSync(
        join(resultDirectory, `${platform}-m2-unready-hierarchy.json`),
        JSON.stringify(tree, null, 2)
      )
      writeFileSync(
        join(resultDirectory, `${platform}-m2-unready.png`),
        await m.screenshot()
      )
      console.log(JSON.stringify({ platform, labels: strings(flatten(tree)) }))
      return
    }
    await m.assertVisible({ text: 'Chats', timeout: 60000 })
    await m.scrollUntilVisible({
      element: { text: fixture.conversationLabel },
      direction: 'DOWN',
      timeout: 30000
    })
    await m.assertVisible({ text: fixture.conversationLabel, timeout: 60000 })
    const tree = await m.hierarchy()
    writeFileSync(
      join(resultDirectory, `${platform}-m2-initial-hierarchy.json`),
      JSON.stringify(tree, null, 2)
    )
    writeFileSync(
      join(resultDirectory, `${platform}-m2-initial.png`),
      await m.screenshot()
    )
    results.deviceInfo = await m.platformInfo()
    results.appFile = appFile
    results.buildName = basename(appFile)
    if (platform === 'android')
      results.buildHash = createHash('sha256')
        .update(readFileSync(appFile))
        .digest('hex')
    else
      results.bundleHash = createHash('sha256')
        .update(readFileSync(join(appFile, 'main.jsbundle')))
        .digest('hex')
    pass('retained account opened the M2 list')
    if (process.argv[2] === 'inspect') {
      console.log(JSON.stringify({ platform, labels: strings(flatten(tree)) }))
      return
    }
    const api = await observer()
    const rows = await api.chatConversations()
    const target = rows.find(row => row.id === fixture.conversationId)
    assert(target != null, 'Supplied fixture conversation must be accessible')
    results.originalPreferences = target.preferences
    results.originalRows = rows.map(row => ({
      id: row.id,
      kind: row.kind,
      lastPostAt: row.lastPostAt,
      preferences: row.preferences
    }))
    async function current(): Promise<ChatConversation> {
      const value = (await api.chatConversations()).find(
        row => row.id === fixture.conversationId
      )
      assert(value != null, 'Fixture conversation must remain accessible')
      return value
    }
    async function list(): Promise<void> {
      if (platform === 'android') {
        const labels = await until(
          'Current native route must settle',
          async () => {
            const values = strings(flatten(await m.hierarchy()))
            return values.some(value =>
              value.startsWith('Conversation actions: ')
            ) || values.includes('Back')
              ? values
              : undefined
          },
          10000
        )
        if (
          !labels.some(value => value.startsWith('Conversation actions: ')) &&
          labels.includes('Back')
        )
          await tapVisibleControl(m, 'Back')
        for (let attempt = 0; attempt < 2; attempt++) {
          const next = strings(flatten(await m.hierarchy()))
          if (next.some(value => value.startsWith('Conversation actions: ')))
            break
          if (next.includes('Back')) await tapVisibleControl(m, 'Back')
        }
      } else await m.openLink({ link: `${fixture.scheme}://chat` })
      await until('Native conversation rows remain available', async () =>
        strings(flatten(await m.hierarchy())).some(value =>
          value.startsWith('Conversation actions: ')
        )
          ? true
          : undefined
      )
    }
    async function scopedOpen(
      id: string,
      uniquePreview: string
    ): Promise<void> {
      if (platform === 'ios') {
        await m.openLink({
          link: `${fixture.scheme}://chat/${encodeURIComponent(id)}`
        })
        // A newly installed app asks once before opening its URL scheme.
        for (let check = 0; check < 3; check++) {
          const labels = strings(flatten(await m.hierarchy()))
          if (labels.includes('Open in “TeamStation”?'))
            await tapVisibleControl(m, 'Open')
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        return
      }
      await list()
      const conversations = await api.chatConversations()
      const selected = conversations.find(row => row.id === id)
      assert(selected != null, 'Scope must be accessible to the current actor')
      const title = selected.title
      const titleUnique =
        title != null &&
        conversations.filter(row => row.title === title).length === 1
      const target = titleUnique ? title : uniquePreview
      await m
        .scrollUntilVisible({
          element: { text: target },
          direction: 'UP',
          timeout: 30000
        })
        .catch(
          async () =>
            await m.scrollUntilVisible({
              element: { text: target },
              direction: 'DOWN',
              timeout: 30000
            })
        )
      const selectedRow = await until(
        'Unique scope title or private preview must be selectable',
        async () =>
          flatten(await m.hierarchy()).find(
            node =>
              node.bounds != null &&
              (node.text === target ||
                node.label === target ||
                node.text?.startsWith(target) === true)
          )
      )
      const bounds = selectedRow.bounds!
      await m.tapOnPoint({
        point: `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
      })
    }
    async function open(): Promise<void> {
      await m
        .scrollUntilVisible({
          element: { text: fixture.conversationLabel },
          direction: 'DOWN',
          timeout: 20000
        })
        .catch(
          async () =>
            await m.scrollUntilVisible({
              element: { text: fixture.conversationLabel },
              direction: 'UP',
              timeout: 20000
            })
        )
      await m.tapOn({ text: fixture.conversationLabel })
      await m.scrollUntilVisible({
        element: { id: `chat-message-${fixture.originalMessageIds[0]}` },
        direction: 'UP',
        timeout: 30000
      })
      await m.assertVisible({ text: fixture.targetText, timeout: 60000 })
      await m
        .assertVisible({ text: fixture.replyText, timeout: 1000 })
        .catch(async () => {
          await m.scrollUntilVisible({
            element: { id: `chat-message-${fixture.originalMessageIds[1]}` },
            direction: 'DOWN',
            timeout: 30000
          })
          await m.assertVisible({ text: fixture.replyText, timeout: 10000 })
        })
    }
    async function menu(label = fixture.conversationLabel): Promise<void> {
      await m.scrollUntilVisible({
        element: { text: label },
        direction: 'DOWN',
        timeout: 10000
      })
      await hold(550, label)
      await m.assertVisible({ text: 'Mark unread', timeout: 10000 })
      const text = strings(flatten(await m.hierarchy()))
      assert(
        text.includes('Mark unread') &&
          (text.includes('Mute') || text.includes('Unmute')) &&
          (text.includes('Pin') || text.includes('Unpin')),
        'All three personal conversation actions required'
      )
    }
    async function photo(name: string): Promise<void> {
      writeFileSync(
        join(artifactDirectory, `${platform}-${name}.png`),
        await m.screenshot()
      )
    }
    async function noMenu(): Promise<void> {
      await m.assertNotVisible({ text: 'Mark unread', timeout: 3000 })
    }
    async function rowCenter(
      label = fixture.conversationLabel
    ): Promise<{ x: number; y: number }> {
      const row = flatten(await m.hierarchy()).find(
        node =>
          (node.text === label || node.label === label) && node.bounds != null
      )
      assert(
        row?.bounds != null,
        'The supplied conversation row must expose bounds'
      )
      return {
        x: Math.round(row.bounds.x + row.bounds.width / 2),
        y: Math.round(row.bounds.y + row.bounds.height / 2)
      }
    }
    async function hold(
      duration: number,
      label = fixture.conversationLabel
    ): Promise<void> {
      if (platform === 'android') {
        const point = await rowCenter(label)
        await m.swipe({
          startX: point.x,
          startY: point.y,
          endX: point.x,
          endY: point.y,
          duration
        })
      } else await m.longPressOn({ text: label, duration })
    }
    if (
      [
        'locked-phase1',
        'locked-phase2',
        'locked-unpin',
        'locked-sync'
      ].includes(process.argv[2])
    ) {
      stage = process.argv[2]
      assert(
        fixture.disposable === true &&
          process.env.CHAT_UI_NATIVE_DISPOSABLE === '1',
        'Locked proof requires a wholly owned disposable installation'
      )
      const locked = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_LOCKED_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        originalId: string
        originalBody: string
        selfReplyId: string
        selfReplyBody: string
        pinnedBeforeReset: boolean
      }
      assert(locked.pinnedBeforeReset, 'Normal pre-reset personal pin required')
      const originalId = `chat-message-${locked.originalId}`
      await scopedOpen(locked.conversationId, locked.originalBody)
      await m.assertVisible({ id: originalId, timeout: 60000 })
      const row = flatten(await m.hierarchy()).find(
        node => node.id === originalId
      )
      assert(row != null, 'Exact old original must remain in history')
      assert(
        strings(flatten(row)).includes('Locked message'),
        'Old original must remain locked'
      )
      assert(
        !strings(flatten(row)).some(label =>
          label.includes(locked.originalBody)
        ),
        'Old plaintext must not appear in locked row'
      )
      const pins = await api.chatPins(locked.conversationId)
      const hasOriginalPin = pins.some(
        pin => pin.messageId === locked.originalId
      )
      if (process.argv[2] === 'locked-sync') {
        assert(
          !hasOriginalPin,
          'Other device must observe removal of the same-user old pin'
        )
        assert(
          !strings(flatten(row)).includes('Pinned'),
          'Other device must remove the locked pin badge'
        )
        await photo('locked-pin-live-removal')
        pass('same-user locked pin removal appears on the other native client')
        return
      }
      assert(
        hasOriginalPin,
        'Keep the old personal pin through both locked phases'
      )
      if (process.argv[2] === 'locked-phase1') {
        await m.assertVisible({
          text: 'Waiting for history to unlock…',
          timeout: 30000
        })
        await m.assertVisible({
          text: 'History is locked — it unlocks when another member opens TeamStation',
          timeout: 30000
        })
        const raw = Buffer.from(await m.hierarchyRaw()).toString('utf8')
        writeFileSync(
          join(resultDirectory, `${platform}-locked-composer-raw.xml`),
          raw
        )
        await photo('locked-history-and-composer')
        pass(
          'actual native old history and composer remain locked after normal identity reset and link'
        )
      } else if (process.argv[2] === 'locked-phase2') {
        const currentReply = JSON.parse(
          readFileSync(required('CHAT_UI_NATIVE_LOCKED_REPLY'), 'utf8')
        ) as {
          replyId: string
          replyBody: string
        }
        const replyRowId = `chat-message-${currentReply.replyId}`
        await m.scrollUntilVisible({
          element: { id: replyRowId },
          direction: 'DOWN',
          timeout: 30000
        })
        const replyRow = flatten(await m.hierarchy()).find(
          node => node.id === replyRowId
        )
        assert(replyRow != null, 'Exact new-epoch reply must be readable')
        const replyLabels = strings(flatten(replyRow))
        assert(
          replyLabels.includes(currentReply.replyBody),
          'Current outer reply must decrypt'
        )
        assert(
          replyLabels.some(
            label =>
              label.startsWith('Jump to message from ') &&
              label.includes('Locked message')
          ),
          'Decoded current reply must quote a locked-original placeholder'
        )
        assert(
          !replyLabels.some(label => label.includes(locked.originalBody)),
          'Quote must not reuse the old plaintext snapshot'
        )
        await photo('readable-reply-locked-original-quote')
        await m.scrollUntilVisible({
          element: { id: originalId },
          direction: 'UP',
          timeout: 30000
        })
        pass(
          'new-epoch native reply decrypts while its old original quote suppresses inaccessible plaintext'
        )
      }
      await tapVisibleControl(m, `Pinned messages: ${pins.length}`)
      await m.assertVisible({ text: 'Pinned messages', timeout: 10000 })
      const listLabels = strings(flatten(await m.hierarchy()))
      assert(
        listLabels.includes('Locked message'),
        'Old personal pin list must show its safe locked placeholder'
      )
      assert(
        !listLabels.includes(locked.originalBody),
        'Pin list must suppress old plaintext'
      )
      await photo('locked-pinned-list')
      await m.tapOnPoint({ point: '5%,15%' })
      await physicalMessageHold(m, originalId, 'Locked message', 550)
      await m.assertVisible({ text: 'Unpin', timeout: 10000 })
      const menuLabels = strings(flatten(await m.hierarchy()))
      for (const action of [
        'Reply',
        'Copy',
        'Delete',
        'Edit',
        'More reactions',
        'React 👍'
      ])
        assert(
          !menuLabels.includes(action),
          'Locked original must offer only its existing personal Unpin action'
        )
      await photo('locked-unpin-only-menu')
      if (process.argv[2] === 'locked-unpin') {
        await tapVisibleControl(m, 'Unpin')
        await until(
          'Normal Unpin must remove only the old personal pin',
          async () =>
            !(await api.chatPins(locked.conversationId)).some(
              pin => pin.messageId === locked.originalId
            )
              ? true
              : undefined
        )
        pass('normal locked-message Unpin removes the old personal pin')
      } else {
        await m.tapOnPoint({ point: '5%,15%' })
        assert(
          (await api.chatPins(locked.conversationId)).some(
            pin => pin.messageId === locked.originalId
          ),
          'Availability proof must preserve the old personal pin'
        )
        pass(
          'actual native locked original and pin list expose only Unpin without removing it'
        )
      }
      return
    }
    if (process.argv[2] === 'jump-record') {
      stage = 'current-native-older-original-jump-recording'
      const deep = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_DEEP_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        originalId: string
        replyId: string
        replyBody: string
        navigationPreview?: string
      }
      await scopedOpen(
        deep.conversationId,
        deep.navigationPreview ?? deep.replyBody
      )
      await m.scrollUntilVisible({
        element: { id: `chat-message-${deep.replyId}` },
        direction: 'UP',
        timeout: 30000
      })
      await m.assertVisible({
        id: `chat-message-${deep.replyId}`,
        timeout: 10000
      })
      const nodes = flatten(await m.hierarchy())
      const row = nodes.find(node => node.id === `chat-message-${deep.replyId}`)
      assert(
        row != null &&
          !nodes.some(node => node.id === `chat-message-${deep.originalId}`),
        'Actual cold >100 original absence required'
      )
      const quote = strings(flatten(row)).find(label =>
        label.startsWith('Jump to message from ')
      )
      assert(quote != null)
      if (platform === 'android') {
        await m.startRecording({
          path: required('CHAT_UI_NATIVE_ANDROID_RECORD_REMOTE')
        })
        recording = true
        writeFileSync(
          required('CHAT_UI_NATIVE_RECORD_REQUEST'),
          JSON.stringify({
            deviceId,
            daemonName,
            pid: process.pid,
            remotePath: required('CHAT_UI_NATIVE_ANDROID_RECORD_REMOTE')
          })
        )
      } else {
        writeFileSync(
          required('CHAT_UI_NATIVE_RECORD_REQUEST'),
          JSON.stringify({ deviceId, daemonName, pid: process.pid })
        )
        await until('Own current jump recorder must be ready', async () =>
          existsSync(required('CHAT_UI_NATIVE_RECORD_READY')) ? true : undefined
        )
      }
      await photo('current-jump-before')
      await m.tapOn({ text: quote })
      await m.assertVisible({
        id: `chat-message-${deep.originalId}`,
        timeout: 60000
      })
      const current = flatten(await m.hierarchy())
      const original = current.find(
        node => node.id === `chat-message-${deep.originalId}`
      )?.bounds
      const composer = current.find(node => node.id === 'chat-composer')?.bounds
      assert(
        original != null &&
          composer != null &&
          original.y >= 0 &&
          original.y < composer.y,
        'Current measured native original must be inside viewport'
      )
      await photo('current-jump-after')
      await new Promise(resolve => setTimeout(resolve, 2000))
      if (recording) {
        await m.stopRecording({
          path: required('CHAT_UI_NATIVE_ANDROID_RECORD_REMOTE')
        })
        recording = false
      }
      writeFileSync(required('CHAT_UI_NATIVE_RECORD_STOP'), 'stop')
      if (process.env.CHAT_UI_NATIVE_RECORD_DONE != null)
        await until(
          'Capture must flush before shutting down the owned simulator',
          async () =>
            existsSync(process.env.CHAT_UI_NATIVE_RECORD_DONE!)
              ? true
              : undefined,
          30000
        )
      results.currentJump = {
        originalAbsentInitially: true,
        insideViewport: true,
        bounds: original
      }
      pass(
        'current native measured >100 older-original quote jump recorded on the fixed binary'
      )
      return
    }
    if (process.argv[2] === 'captures') {
      await photo('list-after')
      await open()
      await photo('conversation-after')
      await list()
      await menu()
      await photo('conversation-menu-after')
      await m.tapOnPoint({ point: '5%,15%' })
      pass(
        'final native list/conversation/menu frames captured with preserved original fixture'
      )
      return
    }
    if (process.argv[2] === 'fault-cancel') {
      stage = 'S7-native-paging-user-scroll-cancellation'
      const deep = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_DEEP_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        originalId: string
        replyId: string
        replyBody: string
        navigationPreview?: string
      }
      await scopedOpen(
        deep.conversationId,
        deep.navigationPreview ?? deep.replyBody
      )
      await m.scrollUntilVisible({
        element: { id: `chat-message-${deep.replyId}` },
        direction: 'UP',
        timeout: 30000
      })
      await m.assertVisible({
        id: `chat-message-${deep.replyId}`,
        timeout: 10000
      })
      const initial = flatten(await m.hierarchy())
      assert(
        !initial.some(node => node.id === `chat-message-${deep.originalId}`),
        'Cold old original must start outside loaded history'
      )
      const reply = initial.find(
        node => node.id === `chat-message-${deep.replyId}`
      )
      assert(reply?.bounds != null, 'Visible current reply required')
      const quote = strings(flatten(reply)).find(label =>
        label.startsWith('Jump to message from ')
      )
      assert(quote != null)
      const gateId = `native-${platform}-cancel-${Date.now()}`
      execFileSync(
        process.execPath,
        [
          required('CHAT_UI_NATIVE_FAULT_CONTROL'),
          platform,
          'delay',
          gateId,
          '15000'
        ],
        { stdio: 'pipe' }
      )
      await m.tapOn({ text: quote })
      const centerX = Math.round(reply.bounds.x + reply.bounds.width * 0.6)
      const centerY = Math.round(reply.bounds.y + reply.bounds.height * 0.5)
      await m.dragAndDrop({
        from: { point: `${centerX},${centerY}` },
        to: { point: `${centerX},${centerY + 120}` },
        holdDuration: 10,
        duration: 300
      })
      const dragDoneAt = Date.now()
      const afterScroll = flatten(await m.hierarchy())
      const composer = afterScroll.find(
        node => node.id === 'chat-composer'
      )?.bounds
      assert(composer != null, 'Same native composer state required')
      const anchor = afterScroll.find(
        node =>
          node.id?.startsWith('chat-message-msg_') === true &&
          node.bounds != null &&
          node.bounds.y > composer.y * 0.4 &&
          node.bounds.y + node.bounds.height < composer.y
      )
      assert(
        anchor?.bounds != null,
        'Actual visible user-scrolled anchor required'
      )
      const anchorAt = Date.now()
      results.pagingCancelRequest = {
        gateId,
        dragDoneAt,
        anchorAt,
        delayMs: 15000,
        anchorId: anchor.id,
        before: anchor.bounds
      }
      const untilResponse = Date.now() + 16000
      while (Date.now() < untilResponse)
        await new Promise(resolve => setTimeout(resolve, 250))
      const after = flatten(await m.hierarchy())
      const retained = after.find(node => node.id === anchor.id)?.bounds
      assert(retained != null, 'Delayed page must retain user-selected anchor')
      const audit = readFileSync(required('CHAT_UI_NATIVE_FAULT_AUDIT'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          line =>
            JSON.parse(line) as {
              gateId: string
              at: string
              remaining?: number
              event?: string
              mode?: string
            }
        )
        .filter(hit => hit.gateId === gateId)
      const consume = audit.filter(hit => hit.mode != null && hit.event == null)
      const release = audit.find(hit => hit.event === 'delay-released')
      assert.equal(consume.length, 1)
      assert.equal(consume[0].remaining, 0)
      assert(
        release != null,
        'Actual private delayed-page release must be audited'
      )
      const releasedAt = Date.parse(release.at)
      results.pagingCancelObservation = {
        gateId,
        dragDoneAt,
        anchorAt,
        afterAt: Date.now(),
        anchorId: anchor.id,
        before: anchor.bounds,
        after: retained,
        delta: retained.y - anchor.bounds.y,
        requestAt: consume[0].at,
        releasedAt: release.at,
        dragBeforeRelease: dragDoneAt < releasedAt,
        anchorBeforeRelease: anchorAt < releasedAt
      }
      assert(
        dragDoneAt < releasedAt && anchorAt < releasedAt,
        'Cancellation gesture and visible anchor must occur while the old page is still pending'
      )
      assert(
        Math.abs(retained.y - anchor.bounds.y) <
          Math.max(24, anchor.bounds.height * 0.25),
        'Late original page must not overwrite user scrolling'
      )
      const old = after.find(
        node => node.id === `chat-message-${deep.originalId}`
      )?.bounds
      assert(
        old == null || old.y + old.height < 0 || old.y >= composer.y,
        'Canceled jump must not display the old original in place of user position'
      )
      const hits = readFileSync(required('CHAT_UI_NATIVE_FAULT_AUDIT'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { gateId: string; remaining: number })
        .filter(
          hit =>
            hit.gateId === gateId && (hit as { event?: string }).event == null
        )
      assert.equal(hits.length, 1)
      assert.equal(hits[0].remaining, 0)
      results.pagingCancel = {
        gateId,
        hits: 1,
        remaining: 0,
        anchorId: anchor.id,
        before: anchor.bounds,
        after: retained,
        originalDidNotJump: true
      }
      await photo('paging-user-scroll-cancel')
      pass(
        'native user scrolling cancels delayed old-original jump and preserves the visible anchor'
      )
      return
    }
    if (process.argv[2] === 'fault-send') {
      stage = 'S4-S7-native-files-reply-retention-failed-send-retry'
      const deepPath = required('CHAT_UI_NATIVE_DEEP_FIXTURE')
      const deep = JSON.parse(readFileSync(deepPath, 'utf8')) as {
        conversationId: string
        replyId: string
        replyBody: string
        navigationPreview?: string
      }
      assert(fixture.photoPath != null, 'Owned small photo required')
      const freshPhoto = join(
        resultDirectory,
        `${platform}-retention-photo-${Date.now()}.png`
      )
      copyFileSync(fixture.photoPath, freshPhoto)
      utimesSync(freshPhoto, new Date(), new Date())
      await m.addMedia({ files: [freshPhoto] })
      await scopedOpen(
        deep.conversationId,
        deep.navigationPreview ?? deep.replyBody
      )
      await m.assertVisible({
        id: `chat-message-${deep.replyId}`,
        timeout: 60000
      })
      await physicalMessageHold(
        m,
        `chat-message-${deep.replyId}`,
        deep.replyBody,
        550
      )
      await m.assertVisible({ text: 'Reply', timeout: 10000 })
      await tapVisibleControl(m, 'Reply')
      await m.assertVisible({ text: 'Cancel reply', timeout: 10000 })
      const draft = `${fixture.draft}\nRetry ${platform} ${Date.now()}`
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: draft })
      await m.tapOn({ text: 'Attach' })
      await m.tapOn({ text: 'Photo library' })
      const photoLabel = await until(
        'Owned small imported photo must be selectable',
        async () =>
          strings(flatten(await m.hierarchy())).find(label =>
            /^Photo(?: taken|,)/.test(label)
          )
      )
      await tapStableControl(m, photoLabel)
      const fileLabel = await until(
        'Prepared file must remain in native draft',
        async () =>
          strings(flatten(await m.hierarchy())).find(
            label => label.startsWith('Remove ') && !label.includes('reaction')
          ),
        30000
      )
      await list()
      await scopedOpen(fixture.conversationId, fixture.targetText)
      await list()
      await scopedOpen(
        deep.conversationId,
        deep.navigationPreview ?? deep.replyBody
      )
      await m.assertVisible({ text: 'Cancel reply', timeout: 15000 })
      await m.assertVisible({ text: fileLabel, timeout: 15000 })
      assert.equal(
        await composerValue(m),
        draft,
        'Back/switch/reopen must retain multiline text, reply and prepared file'
      )
      await photo('draft-reply-file-retained')
      pass(
        'native Back/switch/reopen preserves multiline text, reply context and prepared file'
      )
      const before = (await api.chatConversations()).find(
        row => row.id === deep.conversationId
      )!
      const gateId = `native-${platform}-send-${Date.now()}`
      execFileSync(
        process.execPath,
        [required('CHAT_UI_NATIVE_FAULT_CONTROL'), platform, 'send', gateId],
        { stdio: 'pipe' }
      )
      await tapVisibleControl(m, 'Send')
      await m.assertVisible({
        text: 'That did not send. Try again.',
        timeout: 30000
      })
      assert.equal(
        await composerValue(m),
        draft,
        'Rejected native send must retain the draft'
      )
      await m.assertVisible({ text: 'Cancel reply' })
      await m.assertVisible({ text: fileLabel })
      assert.equal(
        (await api.chatConversations()).find(
          row => row.id === deep.conversationId
        )?.lastSeq,
        before.lastSeq,
        'Rejected post must not enter encrypted history'
      )
      const hits = readFileSync(required('CHAT_UI_NATIVE_FAULT_AUDIT'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { gateId: string; remaining: number })
        .filter(hit => hit.gateId === gateId)
      assert.equal(hits.length, 1)
      assert.equal(hits[0].remaining, 0)
      await photo('failed-send-retains-draft-reply-file')
      pass(
        'native controlled failed send retains the exact text, reply and file'
      )
      execFileSync(
        process.execPath,
        [required('CHAT_UI_NATIVE_FAULT_CONTROL'), 'clear'],
        { stdio: 'pipe' }
      )
      await tapVisibleControl(m, 'Send')
      const after = await until(
        'Retry must produce exactly one acknowledged encrypted post',
        async () => {
          const row = (await api.chatConversations()).find(
            row => row.id === deep.conversationId
          )
          return row?.lastSeq === before.lastSeq + 1 ? row : undefined
        },
        60000
      )
      await m.scrollUntilVisible({
        element: { id: `chat-message-${after.lastPostId}` },
        direction: 'DOWN',
        timeout: 30000
      })
      await m.assertVisible({ text: draft, timeout: 15000 })
      const message = (
        await api.chatMessages(deep.conversationId, {
          after: before.lastSeq,
          limit: 100
        })
      ).find(row => row.id === after.lastPostId)
      assert(
        message?.kind === 'post' &&
          message.senderUserId === fixture.actor.userId,
        'Successful retry must be one own post'
      )
      await until(
        'Successful native retry clears reply and file context',
        async () => {
          const labels = strings(flatten(await m.hierarchy()))
          return !labels.includes('Cancel reply') && !labels.includes(fileLabel)
            ? true
            : undefined
        }
      )
      assert.equal(
        await composerValue(m),
        '',
        'Successful retry clears submitted multiline draft'
      )
      assert(
        !JSON.stringify(await api.chatMessages(deep.conversationId)).includes(
          draft
        ),
        'Retry plaintext must remain absent from server envelopes'
      )
      writeFileSync(
        deepPath,
        JSON.stringify(
          {
            ...JSON.parse(readFileSync(deepPath, 'utf8')),
            navigationPreview: draft.split('\n')[0]
          },
          null,
          2
        )
      )
      results.nativeSendFailure = {
        gateId,
        retainedTextReplyFile: true,
        hits: 1,
        remaining: 0,
        retryPostId: after.lastPostId,
        lastSeqDelta: 1
      }
      pass(
        'native Back/switch/reopen preserves text/reply/file; failed send retains all; one encrypted retry clears all'
      )
      return
    }
    if (['fault-page', 'fault-empty'].includes(process.argv[2])) {
      const exhausted = process.argv[2] === 'fault-empty'
      stage = exhausted
        ? 'S7-native-paging-exhaustion'
        : 'S7-native-paging-failure-and-retry'
      const deep = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_DEEP_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        originalId: string
        replyId: string
        replyBody: string
        navigationPreview?: string
      }
      await scopedOpen(
        deep.conversationId,
        deep.navigationPreview ?? deep.replyBody
      )
      await m.assertVisible({
        id: `chat-message-${deep.replyId}`,
        timeout: 60000
      })
      const nodes = flatten(await m.hierarchy())
      assert(
        !nodes.some(node => node.id === `chat-message-${deep.originalId}`),
        'Cold native original must not be loaded before paging fault'
      )
      const row = nodes.find(node => node.id === `chat-message-${deep.replyId}`)
      assert(row != null, 'Current reply must remain available')
      const anchorBefore = row.bounds
      const composerBefore = await composerValue(m)
      const quote = strings(flatten(row)).find(label =>
        label.startsWith('Jump to message from ')
      )
      assert(quote != null, 'Reply must expose a normal quote action')
      const errorsBefore = nodes.filter(
        node =>
          node.text === 'Message unavailable' ||
          node.label === 'Message unavailable'
      ).length
      const gateId = `native-${platform}-page-${Date.now()}`
      execFileSync(
        process.execPath,
        [
          required('CHAT_UI_NATIVE_FAULT_CONTROL'),
          platform,
          exhausted ? 'empty' : 'page',
          gateId
        ],
        { stdio: 'pipe' }
      )
      await m.tapOn({ text: quote })
      await until(
        'Actual native rejected page must display a new unavailable error',
        async () => {
          const next = flatten(await m.hierarchy())
          return next.filter(
            node =>
              node.text === 'Message unavailable' ||
              node.label === 'Message unavailable'
          ).length > errorsBefore
            ? true
            : undefined
        },
        30000
      )
      const hits = readFileSync(required('CHAT_UI_NATIVE_FAULT_AUDIT'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          line =>
            JSON.parse(line) as {
              gateId: string
              remaining: number
              method: string
            }
        )
        .filter(hit => hit.gateId === gateId)
      const retainedAnchor = flatten(await m.hierarchy()).find(
        node => node.id === `chat-message-${deep.replyId}`
      )?.bounds
      assert(
        anchorBefore != null && retainedAnchor != null,
        'Failed page must retain its visible current reply anchor'
      )
      assert.equal(
        await composerValue(m),
        composerBefore,
        'Paging failure must not change native composer state'
      )
      results.pagingPosition = {
        before: anchorBefore,
        after: retainedAnchor,
        verticalDelta: retainedAnchor.y - anchorBefore.y,
        sameComposer: true
      }
      assert.equal(
        hits.length,
        1,
        'Exactly one controlled native page request must be rejected'
      )
      assert.equal(
        hits[0].remaining,
        0,
        'Native page gate must be consumed once'
      )
      await photo('paging-failure-unavailable')
      execFileSync(
        process.execPath,
        [required('CHAT_UI_NATIVE_FAULT_CONTROL'), 'clear'],
        { stdio: 'pipe' }
      )
      const retryRow = flatten(await m.hierarchy()).find(
        node => node.id === `chat-message-${deep.replyId}`
      )
      if (exhausted) {
        assert(
          !flatten(await m.hierarchy()).some(
            node => node.id === `chat-message-${deep.originalId}`
          ),
          'Exhausted native history must not pretend the original was found'
        )
        results.pagingExhaustion = {
          gateId,
          hits: 1,
          remaining: 0,
          unavailableFeedback: true,
          originalAbsent: true
        }
        pass(
          'native controlled empty history page leaves clear unavailable feedback without a false original jump'
        )
        return
      }
      assert(retryRow != null, 'Failed page must retain the current reply')
      const retryQuote = strings(flatten(retryRow)).find(label =>
        label.startsWith('Jump to message from ')
      )
      assert(
        retryQuote != null,
        'Failed quote remains available for normal retry'
      )
      await m.tapOn({ text: retryQuote })
      await m.assertVisible({
        id: `chat-message-${deep.originalId}`,
        timeout: 60000
      })
      const originalBounds = flatten(await m.hierarchy()).find(
        node => node.id === `chat-message-${deep.originalId}`
      )?.bounds
      const composerBounds = flatten(await m.hierarchy()).find(
        node => node.id === 'chat-composer'
      )?.bounds
      assert(
        originalBounds != null &&
          composerBounds != null &&
          originalBounds.y >= 0 &&
          originalBounds.y < composerBounds.y,
        'Retried original must be inside the actual native message viewport'
      )
      results.retryOriginalBounds = originalBounds
      await photo('paging-failure-normal-retry')
      results.pagingFailure = {
        gateId,
        hits: hits.length,
        remaining: 0,
        errorVisible: true,
        normalRetry: true
      }
      pass(
        'native controlled paging503 shows unavailable feedback and normal quote retry reaches its original'
      )
      return
    }
    if (process.argv[2] === 'attachment-short') {
      stage = 'S6-S8-native-attachment-pin-and-short-open'
      const deep = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_DEEP_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        originalId: string
        attachmentId: string
        replyId: string
        replyBody: string
        fileName: string
        fileBytes: string
      }
      await scopedOpen(deep.conversationId, deep.replyBody)
      await m.assertVisible({
        id: `chat-message-${deep.replyId}`,
        timeout: 60000
      })
      const reply = flatten(await m.hierarchy()).find(
        node => node.id === `chat-message-${deep.replyId}`
      )
      assert(
        reply != null,
        'Current reply must expose a normal route to older file history'
      )
      const quote = strings(flatten(reply)).find(label =>
        label.startsWith('Jump to message from ')
      )
      assert(quote != null, 'Normal quote jump must be available')
      await m.tapOn({ text: quote })
      await m.assertVisible({
        id: `chat-message-${deep.originalId}`,
        timeout: 60000
      })
      await m.scrollUntilVisible({
        element: { text: `Save ${deep.fileName}` },
        direction: 'DOWN',
        timeout: 30000
      })
      const fileId = `chat-message-${deep.attachmentId}`
      const initiallyPinned = (await api.chatPins(deep.conversationId)).some(
        pin => pin.messageId === deep.attachmentId
      )
      await physicalMessageHold(m, fileId, `Save ${deep.fileName}`, 550)
      await m.assertVisible({
        text: initiallyPinned ? 'Unpin' : 'Pin',
        timeout: 10000
      })
      if (!initiallyPinned) {
        await tapVisibleControl(m, 'Pin')
        await until('Normal attachment personal pin must persist', async () =>
          (await api.chatPins(deep.conversationId)).some(
            pin => pin.messageId === deep.attachmentId
          )
            ? true
            : undefined
        )
      } else await m.tapOnPoint({ point: '5%,15%' })
      await photo('attachment-personal-pin')
      const count = (await api.chatPins(deep.conversationId)).length
      await tapVisibleControl(m, `Pinned messages: ${count}`)
      await m.assertVisible({ text: `File: ${deep.fileName}`, timeout: 10000 })
      await photo('attachment-pinned-list')
      await tapVisibleControl(m, `File: ${deep.fileName}`)
      await m.assertVisible({ id: fileId, timeout: 15000 })
      if (!initiallyPinned) {
        await physicalMessageHold(m, fileId, `Save ${deep.fileName}`, 550)
        await m.assertVisible({ text: 'Unpin', timeout: 10000 })
        await tapVisibleControl(m, 'Unpin')
      }
      await tapVisibleControl(m, `Save ${deep.fileName}`)
      await until(
        'Ordinary file short tap must reach the native system opener',
        async () => {
          const labels = strings(flatten(await m.hierarchy()))
          if (platform === 'ios')
            return labels.includes('Text Document') ||
              labels.includes('Quick Look')
              ? labels
              : undefined
          return labels.some(
            label =>
              label.includes(deep.fileBytes.trim()) ||
              label === 'Open with' ||
              label === 'Chrome' ||
              label === 'HTML Viewer'
          )
            ? labels
            : undefined
        },
        30000
      )
      writeFileSync(
        join(
          resultDirectory,
          `${platform}-attachment-short-open-hierarchy.json`
        ),
        JSON.stringify(await m.hierarchy(), null, 2)
      )
      await photo('attachment-short-system-open')
      results.attachmentShort = {
        conversationId: deep.conversationId,
        attachmentId: deep.attachmentId,
        personalPinAndJump: true,
        shortSystemOpen: true
      }
      pass(
        'native attachment personal pin/list jump and ordinary short file-open survive nested hold handling'
      )
      return
    }
    if (
      ['deep', 'attachment-probe', 'quote-hold-probe'].includes(process.argv[2])
    ) {
      stage = 'S7-native-paged-quote'
      const deep = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_DEEP_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        originalId: string
        originalBody: string
        attachmentId: string
        attachmentReplyId: string
        attachmentReplyBody: string
        replyId: string
        replyBody: string
        fileName: string
        fillerCount: number
      }
      assert(
        deep.fillerCount > 100 && Array.from(deep.originalBody).length > 200,
        'Normal owned deep fixture must cross both paging and excerpt boundaries'
      )
      assert(
        (await api.chatConversations()).some(
          row => row.id === deep.conversationId
        ),
        'Normal native actor membership required for deep fixture'
      )
      await scopedOpen(deep.conversationId, deep.replyBody)
      const replyId = `chat-message-${deep.replyId}`
      await m.assertVisible({ id: replyId, timeout: 60000 })
      await m.assertVisible({ text: deep.replyBody, timeout: 60000 })
      const initialNodes = flatten(await m.hierarchy())
      const initialOriginal = initialNodes.find(
        node => node.id === `chat-message-${deep.originalId}`
      )
      results.deepInitialOriginalLoaded = initialOriginal != null
      assert(
        initialOriginal == null,
        'Original older than100 envelopes must be absent before claiming actual native paging'
      )
      const replyRow = initialNodes.find(node => node.id === replyId)
      assert(
        replyRow != null,
        'Deep quote must belong to the identified current reply row'
      )
      const quote = strings(flatten(replyRow)).find(label =>
        label.startsWith('Jump to message from ')
      )
      assert(
        quote != null,
        'Current deep reply exposes an accessible quote jump'
      )
      if (process.argv[2] === 'quote-hold-probe') {
        await physicalMessageHold(m, replyId, quote, 550)
        await until(
          'Nested quote hold must render its message actions',
          async () => {
            const labels = strings(flatten(await m.hierarchy()))
            return labels.includes('Reply') && labels.includes('Copy')
              ? true
              : undefined
          },
          10000
        )
        const quoteHoldTree = await m.hierarchy()
        const quoteHoldLabels = strings(flatten(quoteHoldTree))
        results.quoteHold = {
          menuOpened:
            quoteHoldLabels.includes('Reply') &&
            quoteHoldLabels.includes('Copy') &&
            (quoteHoldLabels.includes('Pin') ||
              quoteHoldLabels.includes('Unpin')),
          originalVisible: flatten(quoteHoldTree).some(
            node => node.id === `chat-message-${deep.originalId}`
          )
        }
        writeFileSync(
          join(resultDirectory, `${platform}-quoted-hold-hierarchy.json`),
          JSON.stringify(quoteHoldTree, null, 2)
        )
        await photo('quoted-hold-observed')
        assert(
          (results.quoteHold as { menuOpened: boolean }).menuOpened,
          'Physical hold on quoted inset must open message actions'
        )
        pass('physical native hold on nested quote opens its message menu')
        return
      }
      const initiallyPinned = (await api.chatPins(deep.conversationId)).some(
        row => row.messageId === deep.replyId
      )
      await physicalMessageHold(m, replyId, quote, 550)
      await until(
        'Physical quote hold must expose the current reply actions',
        async () => {
          const labels = strings(flatten(await m.hierarchy()))
          return labels.includes('Reply') && labels.includes('Copy')
            ? true
            : undefined
        },
        10000
      )
      await photo('quoted-message-actions')
      await m.tapOnPoint({ point: '5%,15%' })
      pass(
        'physical native quote hold opens actions and does not perform its short jump'
      )
      if (!initiallyPinned) {
        await physicalMessageHold(m, replyId, deep.replyBody, 550)
        await m.assertVisible({ text: 'Pin', timeout: 10000 })
        await tapVisibleControl(m, 'Pin')
        await until('Owned reply personal pin did not persist', async () =>
          (await api.chatPins(deep.conversationId)).some(
            row => row.messageId === deep.replyId
          )
            ? true
            : undefined
        )
      }
      await photo('deep-quote-before-jump')
      await m.tapOn({ text: quote })
      await m.assertVisible({
        id: `chat-message-${deep.originalId}`,
        timeout: 60000
      })
      await m.assertVisible({ text: deep.originalBody, timeout: 60000 })
      await photo('deep-original-after-jump')
      pass(
        'native quote pages over100 envelopes and scrolls to its own original'
      )
      await m.scrollUntilVisible({
        element: { id: `chat-message-${deep.attachmentId}` },
        direction: 'DOWN',
        timeout: 30000
      })
      await physicalMessageHold(
        m,
        `chat-message-${deep.attachmentId}`,
        `Save ${deep.fileName}`,
        550
      )
      const attachmentActions = await until(
        'Attachment-only physical hold must render its own message menu',
        async () => {
          const labels = strings(flatten(await m.hierarchy()))
          return labels.includes('Reply') && labels.includes('Pin')
            ? labels
            : undefined
        },
        10000
      )
      assert(
        attachmentActions.includes('Reply') &&
          !attachmentActions.includes('Copy'),
        'Attachment-only physical hold must open its posting menu without Copy'
      )
      await photo('attachment-message-actions')
      await m.tapOnPoint({ point: '5%,15%' })
      pass(
        'physical native hold on nested attachment label opens its message menu'
      )
      if (process.argv[2] === 'attachment-probe') return
      const count = (await api.chatPins(deep.conversationId)).length
      await m.tapOn({ text: `Pinned messages: ${count}` })
      await tapVisibleControl(m, deep.replyBody)
      await m.assertVisible({ id: replyId, timeout: 30000 })
      const currentReply = flatten(await m.hierarchy()).find(
        node => node.id === replyId
      )
      const excerpt = Array.from(deep.originalBody).slice(0, 200).join('') + '…'
      assert(
        currentReply != null,
        'Identified reply must be visible again after paging'
      )
      assert(
        strings(flatten(currentReply)).some(label => label.includes(excerpt)),
        'Accessible current long quote must clamp at200 code points with ellipsis'
      )
      pass(
        'identified native current long quote clamps at200 code points with ellipsis after actual paging'
      )
      if (!initiallyPinned) {
        await physicalMessageHold(m, replyId, deep.replyBody, 550)
        await tapVisibleControl(m, 'Unpin')
      }
      // Return near the attachment reply through the original's normal quote jump.
      const currentQuote = strings(flatten(currentReply)).find(label =>
        label.startsWith('Jump to message from ')
      )
      assert(
        currentQuote != null,
        'Loaded current quote must retain its jump action'
      )
      await m.tapOn({ text: currentQuote })
      await m.assertVisible({
        id: `chat-message-${deep.originalId}`,
        timeout: 30000
      })
      await m.scrollUntilVisible({
        element: { id: `chat-message-${deep.attachmentReplyId}` },
        direction: 'DOWN',
        timeout: 30000
      })
      const attachmentReply = flatten(await m.hierarchy()).find(
        node => node.id === `chat-message-${deep.attachmentReplyId}`
      )
      assert(
        attachmentReply != null,
        'Owned attachment reply must load with earlier history'
      )
      const attachmentQuote = strings(flatten(attachmentReply)).find(label =>
        label.startsWith('Jump to message from ')
      )
      assert(
        attachmentQuote?.includes(`File: ${deep.fileName}`) === true,
        'Native attachment quote uses the current safe attachment label'
      )
      await photo('deep-attachment-reply')
      await m.tapOn({ text: attachmentQuote })
      await m.assertVisible({
        id: `chat-message-${deep.attachmentId}`,
        timeout: 30000
      })
      await photo('deep-attachment-original')
      results.deep = {
        conversationId: deep.conversationId,
        originalId: deep.originalId,
        attachmentId: deep.attachmentId,
        replyId: deep.replyId,
        attachmentReplyId: deep.attachmentReplyId,
        fillerCount: deep.fillerCount,
        normalEncryptedHistory: true,
        originalJump: true,
        attachmentJump: true
      }
      pass('native long-current and attachment reply quote labels and jumps')
      return
    }
    if (process.argv[2] === 'owned-delete-live') {
      stage = 'S7-S8-native-owned-delete-live'
      assert(
        fixture.disposable === true,
        'Owned delete observer requires disposable fixture installation'
      )
      const owned = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_OWNED_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        originalId: string
        originalBody: string
        selfReplyId: string
        selfReplyBody: string
        pinnedBeforeDelete: boolean
      }
      assert(
        owned.pinnedBeforeDelete,
        'Normal personal pin must be prepared before deletion'
      )
      await scopedOpen(owned.conversationId, owned.selfReplyBody)
      await m.assertVisible({
        id: `chat-message-${owned.originalId}`,
        timeout: 60000
      })
      await m.assertVisible({ text: owned.originalBody, timeout: 30000 })
      await m.assertVisible({
        id: `chat-message-${owned.selfReplyId}`,
        timeout: 30000
      })
      const initialReply = flatten(await m.hierarchy()).find(
        node => node.id === `chat-message-${owned.selfReplyId}`
      )
      assert(initialReply != null, 'Exact owned self reply must be accessible')
      assert(
        strings(flatten(initialReply)).some(
          label =>
            label.startsWith('Jump to message from You:') &&
            label.includes(owned.originalBody)
        ),
        'Native readable self reply must expose You and the current original snippet'
      )
      const pinCount = (await api.chatPins(owned.conversationId)).length
      assert(
        (await api.chatPins(owned.conversationId)).some(
          pin => pin.messageId === owned.originalId
        ),
        'Same-user prepared pin must reach this installation'
      )
      await photo('owned-self-reply-readable')
      await tapVisibleControl(m, `Pinned messages: ${pinCount}`)
      await m.assertVisible({ text: 'Pinned messages', timeout: 10000 })
      await m.assertVisible({ text: owned.originalBody, timeout: 10000 })
      await photo('owned-pin-list-before-delete')
      writeFileSync(
        required('CHAT_UI_NATIVE_READY_SIGNAL'),
        JSON.stringify(
          {
            platform,
            conversationId: owned.conversationId,
            originalId: owned.originalId,
            selfReplyId: owned.selfReplyId,
            ready: true,
            pinListOpen: true,
            normalReadable: true
          },
          null,
          2
        )
      )
      console.log(
        'READY own native readable self reply and live pin list; awaiting normal author Delete'
      )
      await until(
        'Normal author Delete must purge the same-user personal pin',
        async () =>
          !(await api.chatPins(owned.conversationId)).some(
            pin => pin.messageId === owned.originalId
          )
            ? true
            : undefined,
        300000
      )
      await until(
        'Open native pin list must discard deleted original preview',
        async () => {
          const labels = strings(flatten(await m.hierarchy()))
          return labels.includes('No pinned messages.') &&
            !labels.includes(owned.originalBody)
            ? true
            : undefined
        },
        30000
      )
      await photo('owned-pin-live-purge')
      await m.tapOnPoint({ point: '5%,15%' })
      await m.assertVisible({
        id: `chat-message-${owned.selfReplyId}`,
        timeout: 15000
      })
      const afterReply = flatten(await m.hierarchy()).find(
        node => node.id === `chat-message-${owned.selfReplyId}`
      )
      assert(
        afterReply != null,
        'Decoded self reply must remain after original deletion'
      )
      const afterLabels = strings(flatten(afterReply))
      assert(
        afterLabels.includes(owned.selfReplyBody),
        'Current reply body must remain readable'
      )
      assert(
        afterLabels.some(
          label =>
            label.startsWith('Jump to message from ') &&
            label.includes('Message deleted')
        ),
        'Decoded quote must render the deleted-original placeholder'
      )
      assert(
        !afterLabels.some(label => label.includes(owned.originalBody)),
        'Decoded reply must suppress its obsolete original snapshot'
      )
      await photo('owned-deleted-original-quote')
      results.ownedDelete = {
        conversationId: owned.conversationId,
        originalId: owned.originalId,
        selfReplyId: owned.selfReplyId,
        pinLivePurged: true,
        decodedReplyRetained: true,
        snapshotSuppressed: true
      }
      pass(
        'normal author Delete purges live native pin preview and replaces decoded self quote without old snapshot content'
      )
      return
    }
    if (process.argv[2] === 'restricted') {
      stage = 'S8-restricted-native-actions'
      const scoped = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_SCOPED_FIXTURE'), 'utf8')
      ) as { conversationId: string; messageId: string; bodyStub: string }
      const expected = required('CHAT_UI_NATIVE_EXPECTED_COMPOSER')
      assert(
        expected === 'closed' || expected === 'readOnly',
        'A real closed or read-only fixture required'
      )
      const conversation = (await api.chatConversations()).find(
        row => row.id === scoped.conversationId
      )
      assert(
        conversation?.canPost === false &&
          conversation.closed === (expected === 'closed'),
        'Authenticated current scope must match the real restricted state'
      )
      await scopedOpen(scoped.conversationId, scoped.bodyStub)
      const rowId = `chat-message-${scoped.messageId}`
      await m.assertVisible({ id: rowId, timeout: 60000 })
      await m.assertVisible({ text: scoped.bodyStub, timeout: 60000 })
      await m.assertVisible({
        text:
          expected === 'closed'
            ? 'This chat is closed. You can read it, but not post.'
            : 'Only season staff post here. You can react.'
      })
      assert(
        !strings(flatten(await m.hierarchy())).includes('Send'),
        'Restricted native conversation must not offer sending'
      )
      async function restrictedMenu(): Promise<void> {
        await physicalMessageHold(m, rowId, scoped.bodyStub, 550)
        await m.assertVisible({ text: 'Copy', timeout: 10000 })
      }
      const initiallyPinned = (await api.chatPins(scoped.conversationId)).some(
        row => row.messageId === scoped.messageId
      )
      await restrictedMenu()
      const labels = strings(flatten(await m.hierarchy()))
      for (const blocked of ['Reply', 'Delete', 'Edit', 'Report'])
        assert(
          !labels.includes(blocked),
          'Restricted native message must exclude unavailable posting actions'
        )
      assert(
        labels.includes('Copy') &&
          labels.includes(initiallyPinned ? 'Unpin' : 'Pin'),
        'Readable restricted content must permit Copy and personal Pin'
      )
      if (expected === 'closed')
        assert(
          !labels.some(label => label.startsWith('React with ')) &&
            !labels.includes('More emoji'),
          'Closed native messages must not offer reaction posting'
        )
      else
        assert.deepEqual(
          [...new Set(labels.filter(label => label.startsWith('React with ')))],
          ['❤️', '👍', '👎', '😂', '😮', '😢'].map(
            emoji => `React with ${emoji}`
          ),
          'Announcements reader retains reaction controls'
        )
      await photo(`${expected}-message-actions`)
      if (expected === 'readOnly') {
        const beforeReaction = (await api.chatMessages(scoped.conversationId))
          .length
        await tapVisibleControl(m, 'React with 👍')
        await m.assertVisible({ text: '👍, 1', timeout: 15000 })
        await tapVisibleControl(m, '👍, 1')
        await until(
          'Reader reaction toggle must restore its visible state',
          async () =>
            !strings(flatten(await m.hierarchy())).includes('👍, 1')
              ? true
              : undefined
        )
        const afterReaction = await api.chatMessages(scoped.conversationId)
        assert.equal(
          afterReaction.length,
          beforeReaction + 2,
          'Reader add/remove reaction must reach encrypted history twice'
        )
        assert.equal(
          (await api.chatConversations()).find(
            row => row.id === scoped.conversationId
          )?.lastPostId,
          conversation.lastPostId,
          'Reader reactions must preserve post recency'
        )
        pass(
          'actual native Announcements reader toggles an encrypted reaction without posting a message'
        )
        await restrictedMenu()
      }
      await m.tapOn({ text: initiallyPinned ? 'Unpin' : 'Pin' })
      await until('Restricted native personal pin did not persist', async () =>
        (await api.chatPins(scoped.conversationId)).some(
          row => row.messageId === scoped.messageId
        ) !== initiallyPinned
          ? true
          : undefined
      )
      await restrictedMenu()
      await m.tapOn({ text: initiallyPinned ? 'Pin' : 'Unpin' })
      await until(
        'Restricted personal pin initial state was not restored',
        async () =>
          (await api.chatPins(scoped.conversationId)).some(
            row => row.messageId === scoped.messageId
          ) === initiallyPinned
            ? true
            : undefined
      )
      await restrictedMenu()
      await m.tapOn({ text: 'Copy' })
      await list()
      const defaultPaste = await current()
      if (defaultPaste.canPost && !defaultPaste.closed && !defaultPaste.locked)
        await open()
      else {
        const pasteScope = (await api.chatConversations()).find(
          row =>
            row.id !== scoped.conversationId &&
            row.canPost &&
            !row.closed &&
            !row.locked &&
            !row.noHolder
        )
        assert(
          pasteScope != null,
          'A normal writable scope is required to observe system Paste'
        )
        await scopedOpen(pasteScope.id, 'No messages yet')
        await m.assertVisible({ id: 'chat-composer', timeout: 15000 })
      }
      await m.tapOn({ id: 'chat-composer' })
      await m.longPressOn({ id: 'chat-composer', duration: 650 })
      const paste = await until(
        'System Paste must be visible',
        async () =>
          flatten(await m.hierarchy()).find(
            node =>
              (node.text === 'Paste' || node.label === 'Paste') &&
              node.bounds != null
          ),
        10000
      )
      const bounds = paste.bounds!
      await m.tapOnPoint({
        point: `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
      })
      if (strings(flatten(await m.hierarchy())).includes('Allow Paste'))
        await m.tapOn({ text: 'Allow Paste' })
      assert.equal(
        await composerValue(m),
        scoped.bodyStub,
        'Restricted Copy must paste only the actual readable body'
      )
      await m.eraseText({ characters: 2048 })
      results.restricted = {
        expected,
        conversationId: scoped.conversationId,
        messageId: scoped.messageId,
        bodyReadable: true,
        canPost: conversation.canPost,
        closed: conversation.closed,
        personalPinRestored: true,
        nativeCopyVerified: true
      }
      pass(
        `actual native ${expected} message action restrictions, personal pin and Copy`
      )
      return
    }
    if (process.argv[2] === 'read-fixture') {
      stage = 'native-scoped-fixture-read'
      const scoped = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_SCOPED_FIXTURE'), 'utf8')
      ) as { conversationId: string; messageId: string; bodyStub: string }
      assert(
        typeof scoped.conversationId === 'string' &&
          typeof scoped.messageId === 'string' &&
          typeof scoped.bodyStub === 'string',
        'Private normal-UI fixture metadata required'
      )
      const conversation = (await api.chatConversations()).find(
        row => row.id === scoped.conversationId
      )
      assert(
        conversation != null,
        'Scoped fixture must be a normal accessible conversation for this retained actor'
      )
      await scopedOpen(scoped.conversationId, scoped.bodyStub)
      await m.assertVisible({
        id: `chat-message-${scoped.messageId}`,
        timeout: 60000
      })
      await m.assertVisible({ text: scoped.bodyStub, timeout: 60000 })
      const messages = await api.chatMessages(scoped.conversationId)
      assert(
        messages.some(row => row.id === scoped.messageId),
        'Authenticated observer must see the same scoped post ID'
      )
      assert(
        !JSON.stringify(messages).includes(scoped.bodyStub),
        'Scoped plaintext must remain absent from authenticated encrypted envelopes'
      )
      results.scopedFixtureRead = {
        conversationId: scoped.conversationId,
        messageId: scoped.messageId,
        bodyReadable: true,
        canPost: conversation.canPost,
        closed: conversation.closed,
        memberIds: (await api.chatMembers(scoped.conversationId)).map(
          row => row.userId
        )
      }
      await photo('scoped-fixture-read')
      pass(
        'normal scoped fixture encrypted post is readable by retained native actor'
      )
      return
    }
    if (process.argv[2] === 'picker-document-large') {
      stage = 'S8-native-document-picker-size-rejection'
      assert(
        fixture.oversizeDocumentName != null &&
          fixture.oversizeDocumentFolder != null,
        'Private owned over-limit document metadata required'
      )
      await open()
      const before = (await api.chatMessages(fixture.conversationId))
        .filter(row => row.kind === 'post')
        .map(row => row.id)
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: 2048 })
      await m.inputText({ text: fixture.draft })
      await m.tapOn({ text: 'Attach' })
      await m.tapOn({ text: 'File' })
      await m.assertVisible({ text: 'Cancel', timeout: 15000 })
      writeFileSync(
        join(resultDirectory, `${platform}-document-picker-initial.json`),
        JSON.stringify(await m.hierarchy(), null, 2)
      )
      await photo('document-picker-initial')
      let fileLabels = strings(flatten(await m.hierarchy()))
      if (
        !fileLabels.includes(fixture.oversizeDocumentName) &&
        !fileLabels.includes(fixture.oversizeDocumentFolder)
      ) {
        if (fileLabels.includes('Browse')) {
          const browse = flatten(await m.hierarchy())
            .filter(
              node =>
                (node.text === 'Browse' || node.label === 'Browse') &&
                node.bounds != null
            )
            .sort((a, b) => b.bounds!.y - a.bounds!.y)[0]
          assert(
            browse?.bounds != null,
            'Native document browser must be reachable'
          )
          await m.tapOnPoint({
            point: `${Math.round(browse.bounds.x + browse.bounds.width / 2)},${Math.round(browse.bounds.y + browse.bounds.height / 2)}`
          })
        }
        await m.assertVisible({ text: 'On My iPhone', timeout: 15000 })
        await tapVisibleControl(m, 'On My iPhone')
      }
      fileLabels = strings(flatten(await m.hierarchy()))
      if (!fileLabels.includes(fixture.oversizeDocumentName))
        await tapVisibleControl(m, fixture.oversizeDocumentFolder)
      await m.assertVisible({
        text: fixture.oversizeDocumentName,
        timeout: 15000
      })
      await tapVisibleControl(m, fixture.oversizeDocumentName)
      if (strings(flatten(await m.hierarchy())).includes('Open'))
        await tapVisibleControl(m, 'Open')
      await until(
        'Native document metadata must reject the over-limit file before copying or reading',
        async () =>
          strings(flatten(await m.hierarchy())).find(label =>
            label.includes('is too large: files can be at most 100 MB.')
          ),
        30000
      )
      assert.equal(
        await composerValue(m),
        fixture.draft,
        'Document picker rejection preserves multiline draft'
      )
      assert.deepEqual(
        (await api.chatMessages(fixture.conversationId))
          .filter(row => row.kind === 'post')
          .map(row => row.id),
        before,
        'Native document size rejection must not send'
      )
      await photo('native-oversize-document-error')
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: 2048 })
      pass(
        'actual native document picker rejects over100 MB and preserves the unsent draft'
      )
      return
    }
    if (process.argv[2] === 'picker-large') {
      stage = 'S8-native-picker-size-rejection'
      assert(
        fixture.oversizePhotoPath != null,
        'Private over-limit owned photo required'
      )
      await m.addMedia({ files: [fixture.oversizePhotoPath] })
      await open()
      const before = (await api.chatMessages(fixture.conversationId))
        .filter(row => row.kind === 'post')
        .map(row => row.id)
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: 2048 })
      await m.inputText({ text: fixture.draft })
      await m.tapOn({ text: 'Attach' })
      await m.tapOn({ text: 'Photo library' })
      const largePhoto = await until(
        'Owned over-limit photo must appear in the native picker',
        async () =>
          strings(flatten(await m.hierarchy())).find(label =>
            /^Photo(?: taken|,)/.test(label)
          )
      )
      await tapVisibleControl(m, largePhoto)
      await until(
        'Native metadata size guard must reject the over-limit photo',
        async () =>
          strings(flatten(await m.hierarchy())).find(label =>
            label.includes('is too large: files can be at most 100 MB.')
          ),
        30000
      )
      assert.equal(
        await composerValue(m),
        fixture.draft,
        'Oversize picker rejection preserves multiline draft'
      )
      assert(
        !strings(flatten(await m.hierarchy())).some(
          label => label.startsWith('Remove ') && !label.includes('reaction')
        ),
        'Oversize selection must not produce an attachment chip'
      )
      assert.deepEqual(
        (await api.chatMessages(fixture.conversationId))
          .filter(row => row.kind === 'post')
          .map(row => row.id),
        before,
        'Native size rejection must not send'
      )
      await photo('native-oversize-photo-error')
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: 2048 })
      pass(
        'actual native picker rejects a photo over100 MB without sending or discarding the draft'
      )
      return
    }
    if (process.argv[2] === 'picker') {
      stage = 'S8-native-picker-and-keyboard'
      assert(fixture.photoPath != null, 'Private owned photo required')
      await m.addMedia({ files: [fixture.photoPath] })
      await open()
      const initialPosts = (await api.chatMessages(fixture.conversationId))
        .filter(row => row.kind === 'post')
        .map(row => row.id)
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: 2048 })
      await m.inputText({ text: fixture.draft })
      assert.equal(
        await composerValue(m),
        fixture.draft,
        'Native Enter must retain the multiline draft'
      )
      assert.deepEqual(
        (await api.chatMessages(fixture.conversationId))
          .filter(row => row.kind === 'post')
          .map(row => row.id),
        initialPosts,
        'Native newline must not send'
      )
      await m.tapOn({ text: 'Attach' })
      await m.tapOn({ text: 'File' })
      if (platform === 'android') await m.back()
      else {
        await m.assertVisible({ text: 'Cancel', timeout: 15000 })
        await tapVisibleControl(m, 'Cancel')
      }
      await m.assertVisible({ id: 'chat-composer', timeout: 15000 })
      assert.equal(
        await composerValue(m),
        fixture.draft,
        'File picker cancellation preserves the draft'
      )
      await m.tapOn({ text: 'Attach' })
      await m.tapOn({ text: 'Photo library' })
      await until('Photo picker must expose owned media cells', async () =>
        strings(flatten(await m.hierarchy())).some(label =>
          /^Photo(?: taken|,)/.test(label)
        )
          ? true
          : undefined
      )
      const cancelLabels = strings(flatten(await m.hierarchy()))
      const cancel = cancelLabels.includes('Cancel') ? 'Cancel' : 'Close'
      await tapVisibleControl(m, cancel)
      await m.assertVisible({ id: 'chat-composer', timeout: 15000 })
      assert.equal(
        await composerValue(m),
        fixture.draft,
        'Photo picker cancellation preserves the draft'
      )
      await m.tapOn({ text: 'Attach' })
      await m.tapOn({ text: 'Photo library' })
      const selectedPhoto = await until(
        'Owned imported photo must be selectable',
        async () =>
          strings(flatten(await m.hierarchy())).find(label =>
            /^Photo(?: taken|,)/.test(label)
          )
      )
      await tapVisibleControl(m, selectedPhoto)
      const removeLabel = await until(
        'Native picker must read the selected photo and expose a removable draft attachment',
        async () =>
          strings(flatten(await m.hierarchy())).find(
            label => label.startsWith('Remove ') && !label.includes('reaction')
          ),
        30000
      )
      assert.equal(
        await composerValue(m),
        fixture.draft,
        'Reading an attachment preserves native multiline draft'
      )
      await photo('native-photo-picked')
      await tapVisibleControl(m, removeLabel)
      await until(
        'Removing a picked photo must clear its draft chip',
        async () =>
          !strings(flatten(await m.hierarchy())).includes(removeLabel)
            ? true
            : undefined
      )
      assert.equal(
        await composerValue(m),
        fixture.draft,
        'Removing a picked attachment preserves the native draft'
      )
      assert.deepEqual(
        (await api.chatMessages(fixture.conversationId))
          .filter(row => row.kind === 'post')
          .map(row => row.id),
        initialPosts,
        'Picker and native newline must not send automatically'
      )
      await photo('native-picker-cancel-and-multiline')
      if (fixture.oversizePhotoPath != null) {
        await m.addMedia({ files: [fixture.oversizePhotoPath] })
        await m.tapOn({ text: 'Attach' })
        await m.tapOn({ text: 'Photo library' })
        const largePhoto = await until(
          'Owned over-limit photo must appear in the native picker',
          async () =>
            strings(flatten(await m.hierarchy())).find(label =>
              /^Photo(?: taken|,)/.test(label)
            )
        )
        await tapVisibleControl(m, largePhoto)
        await until(
          'Native metadata size guard must reject the over-limit photo',
          async () =>
            strings(flatten(await m.hierarchy())).find(label =>
              label.includes('is too large: files can be at most 100 MB.')
            ),
          30000
        )
        assert.equal(
          await composerValue(m),
          fixture.draft,
          'Oversize picker rejection preserves multiline draft'
        )
        assert(
          !strings(flatten(await m.hierarchy())).some(
            label => label.startsWith('Remove ') && !label.includes('reaction')
          ),
          'Oversize selection must not produce an attachment chip'
        )
        assert.deepEqual(
          (await api.chatMessages(fixture.conversationId))
            .filter(row => row.kind === 'post')
            .map(row => row.id),
          initialPosts,
          'Native size rejection must not send'
        )
        await photo('native-oversize-photo-error')
        pass(
          'actual native picker rejects a photo over100 MB without sending or discarding the draft'
        )
      }
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: 2048 })
      pass(
        'native multiline Enter, file/photo cancellation, actual photo read and remove preserve draft without sending'
      )
      return
    }
    if (process.argv[2] === 'picker-inspect') {
      stage = 'native-picker-inspection'
      assert(fixture.photoPath != null, 'Private synthetic photo path required')
      await m.addMedia({ files: [fixture.photoPath] })
      await open()
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: fixture.draft })
      await m.tapOn({ text: 'Attach' })
      await m.tapOn({ text: 'Photo library' })
      await m.assertVisible({ text: 'Photos', timeout: 30000 })
      writeFileSync(
        join(resultDirectory, `${platform}-native-picker-hierarchy.json`),
        JSON.stringify(await m.hierarchy(), null, 2)
      )
      writeFileSync(
        join(resultDirectory, `${platform}-native-picker.xml`),
        await m.hierarchyRaw()
      )
      writeFileSync(
        join(resultDirectory, `${platform}-native-picker.png`),
        await m.screenshot()
      )
      console.log(
        JSON.stringify({
          platform,
          pickerLabels: strings(flatten(await m.hierarchy()))
        })
      )
      return
    }
    if (process.argv[2] === 'reply-probe') {
      stage = 'S7-exact-row-reply'
      await open()
      const rowId = `chat-message-${fixture.originalMessageIds[0]}`
      await m.scrollUntilVisible({
        element: { id: rowId },
        direction: 'UP',
        timeout: 15000
      })
      await m.longPressOn({ id: rowId, duration: 550 })
      await m.assertVisible({ text: 'Reply', timeout: 10000 })
      const replyControl = flatten(await m.hierarchy()).find(
        node =>
          (node.text === 'Reply' || node.label === 'Reply') &&
          node.bounds != null
      )
      assert(
        replyControl?.bounds != null,
        'Current visible Reply control bounds required'
      )
      await m.tapOnPoint({
        point: `${Math.round(replyControl.bounds.x + replyControl.bounds.width / 2)},${Math.round(replyControl.bounds.y + replyControl.bounds.height / 2)}`
      })
      const context = await until(
        'Replying to the exact original message row must open composer context',
        async () =>
          strings(flatten(await m.hierarchy())).find(label =>
            label.startsWith('Replying to ')
          ),
        15000
      )
      writeFileSync(
        join(
          resultDirectory,
          `${platform}-${sourceStage.toLowerCase()}-reply-probe-hierarchy.json`
        ),
        JSON.stringify(await m.hierarchy(), null, 2)
      )
      await photo('reply-probe')
      assert(
        context != null,
        'Replying to the exact original message row must open composer context'
      )
      await m.tapOn({ text: 'Cancel reply' })
      pass('exact original native row Reply opens safe composer context')
      return
    }
    if (process.argv[2] === 'messages') {
      stage = 'S6-message-actions'
      console.log(
        '$ S6 native message holds, quick reactions, Copy and blur; S7 reply inset/jump; S8 personal pin result'
      )
      await open()
      const originalMessages = await api.chatMessages(fixture.conversationId)
      const original = originalMessages.find(
        row => row.id === fixture.originalMessageIds[0]
      )
      assert(
        original != null,
        'Original selected fixture post must remain present'
      )
      const originalId = original.id
      const sender =
        (await api.chatMembers(fixture.conversationId)).find(
          row => row.userId === original.senderUserId
        )?.shortName ?? 'Former member'
      const pinsBefore = await api.chatPins(fixture.conversationId)
      const wasPinned = pinsBefore.some(row => row.messageId === original.id)
      async function messageHold(duration: number): Promise<void> {
        const rowId = `chat-message-${originalId}`
        await m.scrollUntilVisible({
          element: { id: rowId },
          direction: 'UP',
          timeout: 10000
        })
        for (let adjustment = 0; adjustment < 5; adjustment++) {
          const tree = await m.hierarchy()
          let viewport: Bounds | undefined
          const walk = (node: Hierarchy): void => {
            if (
              node.type?.includes('ScrollView') === true &&
              node.bounds != null &&
              node.bounds.height > 0 &&
              flatten(node).some(child => child.id === rowId)
            )
              viewport = node.bounds
            for (const child of node.children ?? []) walk(child)
          }
          walk(tree)
          const row = flatten(tree).find(node => node.id === rowId)
          const body =
            row == null
              ? undefined
              : flatten(row).find(
                  node =>
                    (node.text === fixture.targetText ||
                      node.label === fixture.targetText) &&
                    node.bounds != null
                )?.bounds
          if (viewport == null || body == null) break
          const center = body.y + body.height / 2
          if (
            center > viewport.y + 12 &&
            center < viewport.y + viewport.height - 12
          )
            break
          const x = Math.round(viewport.x + viewport.width * 0.8)
          const y = Math.round(viewport.y + viewport.height * 0.5)
          const delta = Math.min(
            viewport.height * 0.3,
            Math.abs(center - (viewport.y + viewport.height * 0.5))
          )
          await m.swipe({
            startX: x,
            startY: y,
            endX: x,
            endY: Math.round(y + (center < viewport.y ? delta : -delta)),
            duration: 100
          })
        }
        let previous: Bounds | undefined
        let rowBounds: Bounds | undefined
        const bounds = await until(
          'Selected native message must settle before recognition',
          async () => {
            const row = flatten(await m.hierarchy()).find(
              node => node.id === rowId
            )
            rowBounds = row?.bounds
            const body =
              row == null
                ? undefined
                : flatten(row).find(
                    node =>
                      (node.text === fixture.targetText ||
                        node.label === fixture.targetText) &&
                      node.bounds != null
                  )
            const current = body?.bounds
            assert(
              current != null && current.width > 0 && current.height > 0,
              'Selected readable native message must have visible body bounds'
            )
            const stable =
              previous != null &&
              Math.abs(current.x - previous.x) < 1 &&
              Math.abs(current.y - previous.y) < 1
            previous = current
            return stable ? current : undefined
          },
          10000
        )
        const x = Math.round(bounds.x + bounds.width / 2)
        const y = Math.round(bounds.y + bounds.height / 2)
        if (platform === 'android')
          await m.swipe({ startX: x, startY: y, endX: x, endY: y, duration })
        else {
          assert(
            rowBounds != null && rowBounds.width > 0 && rowBounds.height > 0,
            'Exact native row bounds required'
          )
          const relativeX = ((x - rowBounds.x) / rowBounds.width) * 100
          const relativeY = ((y - rowBounds.y) / rowBounds.height) * 100
          assert(
            relativeX >= 0 &&
              relativeX <= 100 &&
              relativeY >= 0 &&
              relativeY <= 100,
            'Body point must lie in actual selected row'
          )
          await m.longPressOn({
            id: rowId,
            point: `${relativeX}%,${relativeY}%`,
            duration
          })
        }
      }
      async function messageMenu(): Promise<void> {
        await messageHold(550)
        await m.assertVisible({ text: 'Copy', timeout: 10000 })
      }
      try {
        await m.startRecording({
          path:
            platform === 'android'
              ? required('CHAT_UI_NATIVE_ANDROID_RECORD_REMOTE')
              : join(artifactDirectory, `${platform}-chat-actions.mp4`)
        })
        recording = true
      } catch (error) {
        assert(
          platform === 'ios' &&
            error instanceof Error &&
            error.message.includes('not supported'),
          'Recording failures must be an observed supported-platform limitation'
        )
        results.recording = {
          supported: false,
          reason: 'installed WDA driver rejects startRecording'
        }
        console.log(
          'INFO installed iOS WDA recording command unsupported; UI proof continues'
        )
      }
      const captureRequest = process.env.CHAT_UI_NATIVE_RECORD_REQUEST
      const captureReady = process.env.CHAT_UI_NATIVE_RECORD_READY
      if (platform === 'android' && recording && captureRequest != null)
        writeFileSync(
          captureRequest,
          JSON.stringify({
            deviceId,
            daemonName,
            pid: process.pid,
            remotePath: required('CHAT_UI_NATIVE_ANDROID_RECORD_REMOTE')
          })
        )
      if (
        platform === 'ios' &&
        captureRequest != null &&
        captureReady != null
      ) {
        writeFileSync(
          captureRequest,
          JSON.stringify({ deviceId, daemonName, pid: process.pid })
        )
        await until(
          'Approved private recording observer not ready',
          async () => (existsSync(captureReady) ? true : undefined)
        )
        results.recording = {
          supported: true,
          method: 'private TypeScript simctl observer',
          uiDriver: 'maestro-d TypeScript'
        }
      }
      await messageHold(250)
      assert(
        !strings(flatten(await m.hierarchy())).includes('Copy'),
        'Early native release must not recognize actions'
      )
      const movingBody = flatten(await m.hierarchy()).find(
        node => node.text === fixture.targetText && node.bounds != null
      )
      assert(
        movingBody?.bounds != null,
        'Actual visible message body required for scroll cancellation'
      )
      await m.dragAndDrop({
        from: {
          point: `${Math.round(movingBody.bounds.x + movingBody.bounds.width / 2)},${Math.round(movingBody.bounds.y + movingBody.bounds.height / 2)}`
        },
        to: {
          point: `${Math.round(movingBody.bounds.x + movingBody.bounds.width / 2)},${Math.round(movingBody.bounds.y + movingBody.bounds.height / 2 - 80)}`
        },
        holdDuration: 10,
        duration: 550
      })
      assert(
        !strings(flatten(await m.hierarchy())).includes('Copy'),
        'A moving native press must cancel message actions'
      )
      await m.assertNotVisible({ text: 'Copy', timeout: 1000 })
      await messageMenu()
      if (platform === 'android') {
        await m.back()
        await until(
          'Android Back must dismiss native message actions',
          async () =>
            !strings(flatten(await m.hierarchy())).includes('Copy')
              ? true
              : undefined
        )
        await messageMenu()
      }
      const quick = strings(flatten(await m.hierarchy())).filter(text =>
        text.startsWith('React with ')
      )
      assert.deepEqual(
        [...new Set(quick)],
        ['❤️', '👍', '👎', '😂', '😮', '😢'].map(
          emoji => `React with ${emoji}`
        ),
        'Exact six quick reactions in the approved order'
      )
      for (const label of [
        'Reply',
        'Copy',
        wasPinned ? 'Unpin' : 'Pin',
        'More emoji'
      ])
        await m.assertVisible({ text: label })
      for (const label of ['Edit', 'Report', 'Delete for everyone'])
        await m.assertNotVisible({ text: label, timeout: 1000 })
      if (!target.canModerate)
        await m.assertNotVisible({ text: 'Delete', timeout: 1000 })
      await photo('message-actions-after')
      await m.tapOnPoint({ point: '5%,15%' })
      await m.assertNotVisible({ text: 'Copy', timeout: 1000 })
      pass(
        'recognized native message menu, exact reactions and permission-filtered actions over blur'
      )
      stage = 'S6-copy'
      await messageMenu()
      await m.tapOn({ text: 'Copy' })
      await m.assertNotVisible({ text: 'Copy', timeout: 3000 })
      await m.tapOn({ id: 'chat-composer' })
      await m.longPressOn({ id: 'chat-composer', duration: 650 })
      const paste = await until(
        'Native Paste popup did not appear',
        async () =>
          flatten(await m.hierarchy()).find(
            node =>
              (node.text === 'Paste' || node.label === 'Paste') &&
              node.bounds != null
          ),
        10000
      )
      assert(
        paste?.bounds != null,
        'The actual native Paste control must expose visible bounds'
      )
      await m.tapOnPoint({
        point: `${Math.round(paste.bounds.x + paste.bounds.width / 2)},${Math.round(paste.bounds.y + paste.bounds.height / 2)}`
      })
      const pasteLabels = strings(flatten(await m.hierarchy()))
      if (pasteLabels.includes('Allow Paste'))
        await m.tapOn({ text: 'Allow Paste' })
      assert.equal(
        await composerValue(m),
        fixture.targetText,
        'Native Copy must paste only the readable body without quoted context or metadata'
      )
      await m.eraseText({ characters: 2048 })
      await m.tapOn({ text: 'Back' })
      await open()
      pass('native Copy round trip equals only the selected message body')
      stage = 'S8-pin-result'
      if (wasPinned) {
        await messageMenu()
        await m.tapOn({ text: 'Unpin' })
        await until('Native prior pin did not remove', async () =>
          !(await api.chatPins(fixture.conversationId)).some(
            row => row.messageId === originalId
          )
            ? true
            : undefined
        )
      }
      await messageMenu()
      await m.tapOn({ text: 'Pin' })
      await until('Personal native message pin did not persist', async () =>
        (await api.chatPins(fixture.conversationId)).some(
          row => row.messageId === original.id
        )
          ? true
          : undefined
      )
      await m.assertVisible({ text: 'Pinned message', timeout: 10000 })
      const count = (await api.chatPins(fixture.conversationId)).length
      await m.assertVisible({
        text: `Pinned messages: ${count}`,
        timeout: 10000
      })
      await photo('message-pins-after')
      await m.tapOn({ text: `Pinned messages: ${count}` })
      await m.assertVisible({ text: 'Pinned messages' })
      await m.assertVisible({ text: fixture.targetText })
      await photo('pinned-messages-after')
      await m.tapOn({ text: fixture.targetText })
      await m.assertVisible({ text: fixture.targetText })
      assert(
        !strings(flatten(await m.hierarchy())).includes('Pinned messages'),
        'Pinned-message modal must dismiss after activating its jump entry'
      )
      pass(
        'personal native pin badge/header/count and readable compact list jump'
      )
      stage = 'S7-original-reply'
      await m.assertVisible({ text: fixture.replyText })
      await photo('replies-after')
      const quote = strings(flatten(await m.hierarchy())).find(
        text =>
          text.startsWith('Jump to message from ') &&
          text.includes(fixture.targetText)
      )
      assert(
        quote != null,
        'Original reply quote must expose sender, excerpt and jump action'
      )
      await m.tapOn({ text: quote })
      await m.assertVisible({ text: fixture.targetText })
      pass('original encrypted reply inset and native quote jump')
      if (recording) {
        await m.stopRecording({
          path: join(artifactDirectory, `${platform}-chat-actions.mp4`)
        })
        recording = false
        if (platform === 'android')
          results.recording = {
            method:
              'maestro-d remote start/stop, private capture observer pulls MP4',
            remotePath: process.env.CHAT_UI_NATIVE_ANDROID_RECORD_REMOTE
          }
      }
      if (process.env.CHAT_UI_NATIVE_RECORD_STOP != null)
        writeFileSync(process.env.CHAT_UI_NATIVE_RECORD_STOP, 'stop')
      stage = 'S6-reaction-toggles'
      for (const emoji of ['❤️', '👍', '👎', '😂', '😮', '😢']) {
        const before = (await api.chatConversations()).find(
          row => row.id === fixture.conversationId
        )!
        await messageMenu()
        await m.tapOn({ text: `React with ${emoji}` })
        await m.assertVisible({ text: `${emoji}, 1`, timeout: 10000 })
        await m.tapOn({ text: `${emoji}, 1` })
        await until(
          'Native reaction toggle did not restore the visible state',
          async () =>
            !strings(flatten(await m.hierarchy())).includes(`${emoji}, 1`)
              ? true
              : undefined
        )
        const after = (await api.chatConversations()).find(
          row => row.id === fixture.conversationId
        )!
        assert.equal(
          after.lastPostId,
          before.lastPostId,
          'Reaction toggle must not replace post recency'
        )
        assert.equal(
          after.lastPostAt,
          before.lastPostAt,
          'Reaction toggle must not change post time'
        )
      }
      await messageMenu()
      await m.tapOn({ text: 'More emoji' })
      await m.assertVisible({ text: 'More emoji', timeout: 10000 })
      await m.tapOn({ text: 'Cancel' })
      pass('all six native quick reaction toggles and More emoji picker')
      stage = 'S7-reply-composer'
      await messageMenu()
      const replyControl = flatten(await m.hierarchy()).find(
        node =>
          (node.text === 'Reply' || node.label === 'Reply') &&
          node.bounds != null
      )
      assert(
        replyControl?.bounds != null,
        'Actual visible native Reply control bounds required'
      )
      await m.tapOnPoint({
        point: `${Math.round(replyControl.bounds.x + replyControl.bounds.width / 2)},${Math.round(replyControl.bounds.y + replyControl.bounds.height / 2)}`
      })
      await m.assertVisible({ text: `Replying to ${sender}` })
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: fixture.draft })
      await m.tapOn({ text: 'Cancel reply' })
      assert(
        (await composerValue(m)).includes(fixture.draft),
        'Cancel reply must preserve unsent typed text'
      )
      await m.eraseText({ characters: 2048 })
      assert(
        fixture.nativeReplyText != null,
        'Private synthetic outgoing reply text required'
      )
      await messageMenu()
      await tapVisibleControl(m, 'Reply')
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: fixture.nativeReplyText })
      const previous = (await current()).lastPostId
      const previousOwnPosts = new Set(
        (await api.chatMessages(fixture.conversationId))
          .filter(
            row =>
              row.kind === 'post' && row.senderUserId === fixture.actor.userId
          )
          .map(row => row.id)
      )
      await m.tapOn({ text: 'Send' })
      await m.assertVisible({ text: fixture.nativeReplyText, timeout: 60000 })
      await until('Native outgoing reply not observed', async () =>
        (await current()).lastPostId !== previous ? true : undefined
      )
      await m.assertNotVisible({ text: 'Cancel reply', timeout: 1000 })
      assert.equal(
        await composerValue(m),
        '',
        'Successful reply send clears the submitted text'
      )
      const envelopes = await api.chatMessages(fixture.conversationId)
      assert.equal(
        envelopes.filter(
          row =>
            row.kind === 'post' &&
            row.senderUserId === fixture.actor.userId &&
            !previousOwnPosts.has(row.id)
        ).length,
        1,
        'A native reply button press must create exactly one own encrypted post'
      )
      assert(
        fixture.originalMessageIds.every(id =>
          envelopes.some(row => row.id === id)
        ),
        'Original post and reply IDs preserved by native actions'
      )
      assert(
        !JSON.stringify(envelopes).includes(fixture.nativeReplyText),
        'Reply plaintext must be absent from authenticated API envelopes'
      )
      results.nativeReplyPostId = (await current()).lastPostId
      pass(
        'native reply Cancel keeps draft; successful encrypted reply send clears context exactly once'
      )
      if (!(fixture.initialMessagePinned ?? wasPinned)) {
        await messageMenu()
        await m.tapOn({ text: 'Unpin' })
        await until('Personal pin cleanup did not persist', async () =>
          !(await api.chatPins(fixture.conversationId)).some(
            row => row.messageId === original.id
          )
            ? true
            : undefined
        )
      }
      results.finalMessageIds = envelopes
        .filter(row => row.kind === 'post')
        .map(row => row.id)
      return
    }
    if (['retention', 'top-retention'].includes(process.argv[2])) {
      stage = 'S4-scroll-fixture'
      console.log(
        '$ S4 retain native message position and independent drafts across Back and conversation switch'
      )
      async function dismissKeyboard(): Promise<void> {
        if (platform === 'ios') {
          let raw = Buffer.from(await m.hierarchyRaw()).toString('utf8')
          if (raw.includes('<XCUIElementTypeKeyboard ')) {
            // WDA hideKeyboard inserts Return in multiline inputs. Normal
            // Back/reopen blurs the composer before measuring reading position.
            await m.tapOn({ text: 'Back' })
            await m.tapOn({ text: candidate!.shortName })
            await m.assertVisible({ id: 'chat-composer', timeout: 60000 })
            raw = Buffer.from(await m.hierarchyRaw()).toString('utf8')
          }
          assert(
            !raw.includes('<XCUIElementTypeKeyboard '),
            'Native keyboard must be hidden before comparing reading positions'
          )
        } else await m.hideKeyboard()
      }
      const peer = fixture.peers?.[0]
      assert(peer != null, 'A supplied synthetic DM peer is required')
      const candidate = (await api.dmCandidates()).find(
        row => row.userId === peer.userId
      )
      assert(
        candidate != null,
        'Supplied peer must remain a normal permitted candidate'
      )
      let dm: ChatConversation | undefined
      for (const row of await api.chatConversations()) {
        if (
          row.kind === 'dm' &&
          row.memberCount === 2 &&
          (await api.chatMembers(row.id)).some(
            member => member.userId === peer.userId
          )
        )
          dm = row
      }
      assert(
        dm != null,
        'The earlier normal UI-created DM must remain available'
      )
      await m.tapOn({ text: candidate.shortName })
      await m.assertVisible({ id: 'chat-composer', timeout: 60000 })
      const longPost = Array.from(
        { length: 24 },
        (_, index) => `${fixture.probePost} ${index + 1}`
      ).join('\n')
      const top = process.argv[2] === 'top-retention'
      const anchorText = top ? fixture.probeEdit : longPost
      if (!top) {
        const previousPostId = dm.lastPostId
        await m.tapOn({ id: 'chat-composer' })
        await m.inputText({ text: longPost })
        await m.tapOn({ text: 'Send' })
        await until(
          'Native scroll fixture post was not delivered',
          async () => {
            const row = (await api.chatConversations()).find(
              item => item.id === dm.id
            )
            return row?.lastPostId != null && row.lastPostId !== previousPostId
              ? row
              : undefined
          }
        )
      }
      await dismissKeyboard()
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: fixture.draft })
      await dismissKeyboard()
      if (top) {
        await m.scrollUntilVisible({
          element: { text: anchorText },
          direction: 'UP',
          timeout: 30000
        })
        for (let index = 0; index < 3; index += 1)
          await m.swipe({ direction: 'DOWN', duration: 600 })
      } else await m.swipe({ direction: 'DOWN', duration: 600 })
      const beforeNodes = flatten(await m.hierarchy())
      const anchor =
        beforeNodes.find(
          node => node.bounds != null && node.text === anchorText
        ) ??
        beforeNodes.find(
          node => node.bounds != null && node.label === anchorText
        )
      assert(
        anchor?.bounds != null,
        'Scroll fixture message must expose native bounds'
      )
      const beforeY = anchor.bounds.y
      results.messageOffsetAnchor = {
        beforeY,
        messageHeight: anchor.bounds.height
      }
      await photo(`${top ? 'top-' : ''}scroll-retention-before-switch`)
      await m.tapOn({ text: 'Back' })
      await m.tapOn({ text: fixture.conversationLabel })
      await m.assertVisible({ text: fixture.targetText, timeout: 60000 })
      assert(
        !(await composerValue(m)).includes(fixture.draft),
        'A different conversation must not inherit the DM draft'
      )
      await m.tapOn({ text: 'Back' })
      await m.tapOn({ text: candidate.shortName })
      await m.assertVisible({ id: 'chat-composer', timeout: 60000 })
      await dismissKeyboard()
      assert(
        (await composerValue(m)).includes(fixture.draft),
        'The DM must restore its own unsent draft after switching'
      )
      if (top) await m.assertVisible({ text: anchorText, timeout: 10000 })
      const afterNodes = flatten(await m.hierarchy())
      const afterAnchor = afterNodes.find(
        node =>
          node.bounds != null &&
          (node.text === anchorText || node.label === anchorText)
      )
      assert(
        afterAnchor?.bounds != null,
        'Restored scroll fixture anchor must remain available'
      )
      results.messageOffsetAnchor = {
        beforeY,
        afterY: afterAnchor.bounds.y,
        messageHeight: anchor.bounds.height
      }
      assert(
        Math.abs(afterAnchor.bounds.y - beforeY) <= 10,
        'Conversation switch must restore the same message position'
      )
      await photo(`${top ? 'top-' : ''}scroll-retention-after-switch`)
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: 2048 })
      await m.hideKeyboard().catch(() => undefined)
      pass(
        'native message position and independent draft restored after Back and conversation switch'
      )
      return
    }
    if (process.argv[2] === 'bands') {
      stage = 'S2-fixture-dms'
      console.log(
        '$ S2 create supplied synthetic adult DMs through UI; preserve original group messages'
      )
      assert(
        (fixture.peers?.length ?? 0) >= 2,
        'Two supplied synthetic adult peers required'
      )
      const candidates = await api.dmCandidates()
      const dms: Array<{ id: string; label: string }> = []
      for (const peer of fixture.peers!.slice(0, 2)) {
        const candidate = candidates.find(item => item.userId === peer.userId)
        assert(
          candidate != null,
          'Supplied peer must be an ordinary permitted DM candidate'
        )
        await list()
        await m.tapOn({ text: 'New message' })
        await m.tapOn({ text: 'Name' })
        await m.inputText({ text: candidate.shortName })
        await m.tapOn({ text: `Pick ${candidate.shortName}` })
        await m.tapOn({ text: 'Start conversation' })
        await m.assertVisible({ id: 'chat-composer', timeout: 60000 })
        let created: string | undefined
        for (const row of await api.chatConversations()) {
          if (row.kind !== 'dm' || row.memberCount !== 2) continue
          if (
            (await api.chatMembers(row.id)).some(
              member => member.userId === peer.userId
            )
          ) {
            created = row.id
            break
          }
        }
        assert(
          created != null,
          'Normal UI-created DM must be visible to its authenticated participant'
        )
        dms.push({ id: created, label: candidate.shortName })
      }
      dms.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const probe = dms[1]
      const empty = dms[0]
      await list()
      async function positions(
        entries: Array<{ id: string; label: string }>
      ): Promise<string[]> {
        const nodes = flatten(await m.hierarchy())
        const rows = entries.map(entry => {
          const found = nodes.find(
            node =>
              (node.text === entry.label || node.label === entry.label) &&
              node.bounds != null
          )
          assert(
            found?.bounds != null,
            'All supplied ordering rows must be visible together'
          )
          return { id: entry.id, y: found.bounds.y }
        })
        return rows.sort((a, b) => a.y - b.y).map(row => row.id)
      }
      const initialDms = await api.chatConversations()
      const dmRows = dms.map(entry =>
        initialDms.find(row => row.id === entry.id)!
      )
      const expectedInitial = [...dms].sort((a, b) => {
        const aTime = Date.parse(
          dmRows.find(row => row.id === a.id)!.lastPostAt ?? ''
        )
        const bTime = Date.parse(
          dmRows.find(row => row.id === b.id)!.lastPostAt ?? ''
        )
        const difference =
          (Number.isFinite(bTime) ? bTime : 0) -
          (Number.isFinite(aTime) ? aTime : 0)
        return difference !== 0
          ? difference
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0
      })
      assert.deepEqual(
        await positions(dms),
        expectedInitial.map(row => row.id),
        'Initial DM order must follow post time and stable identifiers'
      )
      results.emptyTieChecked = dmRows.every(row => row.lastPostAt == null)
      pass(
        results.emptyTieChecked === true
          ? 'empty DM stable identifier tie order'
          : 'existing DM post order'
      )
      stage = 'S2-post-recency'
      console.log(
        '$ S2 send encrypted probe in new DM; react and edit only that probe; observe post-only recency'
      )
      await m.tapOn({ text: probe.label })
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: fixture.probePost })
      await m.tapOn({ text: 'Send' })
      await m.assertVisible({ text: fixture.probePost, timeout: 60000 })
      const posted = (await api.chatConversations()).find(
        row => row.id === probe.id
      )!
      const postId = posted.lastPostId
      assert(
        postId != null && posted.lastPostAt != null,
        'New post must own post recency metadata'
      )
      await list()
      assert.deepEqual(
        await positions(dms),
        [probe.id, empty.id],
        'A new post must move its row inside the DM subgroup'
      )
      await m.tapOn({ text: probe.label })
      await m.longPressOn({ text: fixture.probePost, duration: 650 })
      await m.tapOn({ text: 'React with 👍' })
      let next = (await api.chatConversations()).find(
        row => row.id === probe.id
      )!
      assert.equal(
        next.lastPostId,
        postId,
        'Reaction must not become the latest post'
      )
      assert.equal(
        next.lastPostAt,
        posted.lastPostAt,
        'Reaction must not change post time'
      )
      await m.longPressOn({ text: fixture.probePost, duration: 650 })
      await m.tapOn({ text: 'Edit' })
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: fixture.probePost.length + 8 })
      await m.inputText({ text: fixture.probeEdit })
      await m.tapOn({ text: 'Send' })
      await m.assertVisible({ text: fixture.probeEdit, timeout: 60000 })
      next = (await api.chatConversations()).find(row => row.id === probe.id)!
      assert.equal(
        next.lastPostId,
        postId,
        'Edit must retain original post identity'
      )
      assert.equal(
        next.lastPostAt,
        posted.lastPostAt,
        'Edit must not change post time'
      )
      await list()
      assert.deepEqual(
        await positions(dms),
        [probe.id, empty.id],
        'Reaction and edit must leave ordering unchanged'
      )
      const otherGroup = (await api.chatConversations()).find(
        row => row.kind !== 'dm' && row.id !== fixture.conversationId
      )
      assert(
        otherGroup?.title != null,
        'A second scoped group required for the pinned-group band'
      )
      const changed = [
        { id: probe.id, label: probe.label, pinned: true },
        { id: otherGroup.id, label: otherGroup.title, pinned: true },
        {
          id: fixture.conversationId,
          label: fixture.conversationLabel,
          pinned: false
        }
      ]
      const before = await api.chatConversations()
      for (const row of changed) {
        const currentRow = before.find(item => item.id === row.id)!
        if (currentRow.preferences.pinned === row.pinned) continue
        await list()
        await menu(row.label)
        await m.tapOn({ text: row.pinned ? 'Pin' : 'Unpin' })
        await until('Synthetic band pin did not persist', async () =>
          (await api.chatConversations()).find(item => item.id === row.id)
            ?.preferences.pinned === row.pinned
            ? true
            : undefined
        )
      }
      await list()
      await menu()
      await m.tapOn({ text: 'Mark unread' })
      await until('Newer scoped group must remain marked unread', async () =>
        (await current()).preferences.manualUnread ? true : undefined
      )
      await list()
      const four = [
        probe,
        { id: otherGroup.id, label: otherGroup.title },
        empty,
        { id: fixture.conversationId, label: fixture.conversationLabel }
      ]
      assert.deepEqual(
        await positions(four),
        four.map(row => row.id),
        'Pinned DM, pinned group, unpinned DM, unpinned group must form four bands'
      )
      assert(
        (await current()).preferences.manualUnread,
        'Unread must not override the kind priority'
      )
      await photo('four-bands-after')
      pass('four ordering bands and post-only recency through actual native UI')
      for (const row of changed) {
        const old = before.find(item => item.id === row.id)!
        const now = (await api.chatConversations()).find(
          item => item.id === row.id
        )!
        if (old.preferences.pinned === now.preferences.pinned) continue
        await list()
        await menu(row.label)
        await m.tapOn({ text: old.preferences.pinned ? 'Pin' : 'Unpin' })
      }
      await list()
      await open()
      const originals = await api.chatMessages(fixture.conversationId)
      assert(
        fixture.originalMessageIds.every(id =>
          originals.some(row => row.id === id)
        ),
        'Original group message IDs must remain unchanged'
      )
      results.fixtureDmIds = dms.map(row => row.id)
      results.probePostId = postId
      return
    }
    stage = 'S2-list'
    console.log(
      '$ S2 verify personal headings, supplied row and local readable history'
    )
    assert(strings(flatten(tree)).includes('Chats'), 'Chats heading required')
    await photo('list-after')
    await open()
    const messages = await api.chatMessages(fixture.conversationId)
    assert(
      fixture.originalMessageIds.every(id =>
        messages.some(row => row.id === id)
      ),
      'Original message identifiers must be preserved'
    )
    await photo('conversation-after')
    pass('original messages and reply remain readable with preserved IDs')
    stage = 'S3-menu'
    await list()
    console.log(
      '$ S3 short hold, scrolling cancellation, recognized hold and outside/back dismissal'
    )
    stage = 'S3-short-hold'
    await hold(250)
    await noMenu()
    pass('short hold did not open the menu')
    await list()
    stage = 'S3-movement-cancel'
    const moving = await rowCenter()
    await m.dragAndDrop({
      from: { point: `${moving.x},${moving.y}` },
      to: { point: `${moving.x},${Math.max(100, moving.y - 150)}` },
      holdDuration: 200,
      duration: 500
    })
    await noMenu()
    pass('moving hold did not open the menu')
    await list()
    stage = 'S3-outside-dismiss'
    await menu()
    await photo('conversation-menu-after')
    await m.tapOnPoint({ point: '5%,15%' })
    await noMenu()
    pass('outside dismissal')
    stage = 'S3-back-dismiss'
    await menu()
    if (platform === 'android') await m.back()
    else await m.tapOnPoint({ point: '5%,15%' })
    await noMenu()
    pass('conversation menu gesture and dismissal')
    stage = 'S3-preferences'
    console.log(
      '$ S3 personal pin and mute persist in authenticated observation and retained-app reload'
    )
    await menu()
    await m.tapOn({ text: target.preferences.pinned ? 'Unpin' : 'Pin' })
    await until('Pin preference did not persist', async () => {
      const next = await current()
      return next.preferences.pinned !== target.preferences.pinned
        ? next
        : undefined
    })
    await menu()
    await m.tapOn({ text: target.preferences.muted ? 'Unmute' : 'Mute' })
    await until('Mute preference did not persist', async () => {
      const next = await current()
      return next.preferences.muted !== target.preferences.muted
        ? next
        : undefined
    })
    const reads = await api.chatReads(fixture.conversationId)
    await menu()
    await m.tapOn({ text: 'Mark unread' })
    const unread = await until('Manual unread did not persist', async () => {
      const next = await current()
      return next.preferences.manualUnread ? next : undefined
    })
    await new Promise(resolve => setTimeout(resolve, 3500))
    assert(
      (await current()).preferences.manualUnread,
      'Automatic list activity must preserve manual unread'
    )
    const laterReads = await api.chatReads(fixture.conversationId)
    assert(
      laterReads.every(
        row =>
          row.seq >=
          (reads.find(before => before.userId === row.userId)?.seq ?? 0)
      ),
      'Public read cursors must never decrease'
    )
    assert.equal(
      (await current()).lastPostAt,
      target.lastPostAt,
      'Preferences must not change post recency'
    )
    results.manualUnreadRevision = unread.preferences.manualUnreadRevision
    await photo('preferences-after')
    await m.launchApp({
      appId: fixture.appId,
      permissions: { all: 'unset' }
    })
    await list()
    assert(
      (await current()).preferences.manualUnread,
      'Reload must retain manual unread'
    )
    await open()
    await until('Deliberate open must acknowledge manual unread', async () =>
      !(await current()).preferences.manualUnread ? true : undefined
    )
    pass('personal preferences, unread and monotonic receipts')
    stage = 'S4-draft'
    console.log(
      '$ S4 unsent multiline draft survives back, reopen and safe orientation round trip'
    )
    await m.tapOn({ id: 'chat-composer' })
    await m.inputText({ text: fixture.draft })
    await m.hideKeyboard().catch(() => undefined)
    await m.tapOn({ text: 'Back' })
    await m.assertVisible({ text: fixture.conversationLabel, timeout: 30000 })
    await open()
    assert(
      (await composerValue(m)).includes(fixture.draft),
      'Unsent multiline draft must survive back/reopen'
    )
    stage = 'S4-orientation'
    if (fixture.orientationPolicy === 'rotate') {
      await m.setOrientation({ orientation: 'LANDSCAPE' })
      await m.setOrientation({ orientation: 'PORTRAIT' })
      assert(
        (await composerValue(m)).includes(fixture.draft),
        'Orientation must preserve the draft'
      )
      results.orientation = { applicable: true, draftRetained: true }
    } else {
      assert.equal(
        fixture.orientationPolicy,
        'portrait-only',
        'Private fixture must identify the supported build orientation'
      )
      results.orientation = {
        applicable: false,
        reason: 'existing portrait-only native build policy'
      }
      console.log(
        'INFO native rotation unavailable under existing portrait-only build policy'
      )
    }
    await photo('draft-after')
    assert(
      !JSON.stringify(await api.chatConversations()).includes(fixture.draft),
      'Unsent private draft must not enter server listing metadata'
    )
    await m.tapOn({ id: 'chat-composer' })
    await m.eraseText({ characters: 2048 })
    await m.hideKeyboard().catch(() => undefined)
    await list()
    await menu()
    await m.tapOn({ text: target.preferences.muted ? 'Mute' : 'Unmute' })
    await menu()
    await m.tapOn({ text: target.preferences.pinned ? 'Pin' : 'Unpin' })
    await until('Initial pin/mute preferences were not restored', async () => {
      const next = await current()
      return next.preferences.pinned === target.preferences.pinned &&
        next.preferences.muted === target.preferences.muted
        ? true
        : undefined
    })
    pass('draft retention and cleanup')
    results.finalMessageIds = (
      await api.chatMessages(fixture.conversationId)
    ).map(row => row.id)
  } catch (error) {
    const failurePrefix = `${platform}-${sourceStage.toLowerCase()}-${process.argv[2] ?? 'core'}-failure`
    if (device != null) {
      writeFileSync(
        join(resultDirectory, `${failurePrefix}-hierarchy.json`),
        JSON.stringify(await device.hierarchy(), null, 2)
      )
      writeFileSync(
        join(resultDirectory, `${failurePrefix}.xml`),
        await device.hierarchyRaw()
      )
      writeFileSync(
        join(resultDirectory, `${failurePrefix}.png`),
        await device.screenshot()
      )
    }
    results.failure = { stage, proofPrefix: failurePrefix }
    throw error
  } finally {
    if (
      process.argv[2]?.startsWith('fault-') &&
      process.env.CHAT_UI_NATIVE_FAULT_CONTROL != null
    )
      execFileSync(
        process.execPath,
        [process.env.CHAT_UI_NATIVE_FAULT_CONTROL, 'clear'],
        { stdio: 'pipe' }
      )
    if (recording)
      await device
        ?.stopRecording({
          path: join(artifactDirectory, `${platform}-chat-actions.mp4`)
        })
        .catch(() => undefined)
    writeFileSync(
      join(
        resultDirectory,
        `${platform}-${sourceStage.toLowerCase()}-${process.argv[2] ?? 'core'}-results.json`
      ),
      JSON.stringify(results, null, 2)
    )
    await device?.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
    await daemon.close()
  }
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : 'Native proof failed'
  for (const value of hidden)
    if (value !== '') message = message.split(value).join('[private input]')
  console.error(
    JSON.stringify({
      stage,
      name: error instanceof Error ? error.name : 'Error',
      message
    })
  )
  process.exitCode = 1
})
