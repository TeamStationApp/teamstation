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

import {
  type ChatConversation,
  type Session,
  TeamStationClient
} from '../../common/api'
import { passwordBytes } from '../../common/passwordProtocol'
import { nativeArgon } from '../../server/auth/passwords'
import { chatRowText, nativeRowInList } from '../../test/chatRows'

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
  enabled?: boolean
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
  pressKey: (options: { key: string }) => Promise<unknown>
  eraseText: (options?: object) => Promise<unknown>
  hideKeyboard: (options?: object) => Promise<unknown>
  pasteText: (options?: object) => Promise<unknown>
  copyTextFrom: (options: object) => Promise<{
    data?: unknown
    element?: { class?: string; visible?: boolean }
  }>
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
  actor: { userId: string; email: string; password: string }
  peers?: Array<{ userId: string }>
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
const legacyRows = process.env.CHAT_UI_NATIVE_LEGACY_ROWS === '1'

/**
 * The Chat tab row of a conversation: by its `chat-conversation-<id>` test
 * id, or, for a legacy build without row ids, by its title as `chatRows`
 * matches it (iOS names a row `title, preview, unread`). The fixture's own
 * conversation is known by id even when only its label is given.
 */
function chatRow(
  label: string,
  conversationId?: string
): { id: string } | { text: string } {
  const id =
    conversationId ??
    (label === fixture.conversationLabel ? fixture.conversationId : undefined)
  return id != null && !legacyRows
    ? { id: `chat-conversation-${id}` }
    : { text: chatRowText(label, platform === 'ios' ? 'ios' : 'android') }
}
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

let singleComposerReadVerified = false
const ambiguousComposerLabels = new Set([
  'Message',
  'Message Message',
  'Message draft'
])

async function rawComposerValue(device: Device): Promise<string> {
  const raw = await until(
    'Settled native composer accessibility element required',
    async () => {
      const raw = Buffer.from(await device.hierarchyRaw()).toString('utf8')
      return /<[^>]*(?:name|resource-id|identifier)="[^"]*chat-composer"[^>]*>/.test(
        raw
      )
        ? raw
        : undefined
    },
    15000
  )
  return composerValueFromRaw(raw)
}

async function composerValue(device: Device): Promise<string> {
  if (platform !== 'ios' || process.argv[2] !== 'fault-pending-send')
    return await rawComposerValue(device)
  const extracted = await device.copyTextFrom({
    id: 'chat-composer',
    timeout: 10000
  })
  assert.equal(
    extracted.element?.class,
    'XCUIElementTypeTextView',
    'Exact named native composer field required'
  )
  assert.equal(
    typeof extracted.data,
    'string',
    'Single native composer read must return text'
  )
  const text = extracted.data as string
  // An empty UITextView can expose its label twice. Compare ambiguous text
  // with the raw value, preserving a legitimate draft equal to that label.
  if (!singleComposerReadVerified || ambiguousComposerLabels.has(text)) {
    const raw = await rawComposerValue(device)
    if (raw !== text) {
      assert.equal(
        raw,
        '',
        'Nonempty native field extraction must equal its raw value'
      )
      ambiguousComposerLabels.add(text)
    }
    singleComposerReadVerified = true
    results.singleElementComposerReads = [
      ...((results.singleElementComposerReads as object[] | undefined) ?? []),
      {
        at: Date.now(),
        method: 'Maestro exact UITextView read compared with raw value',
        value: raw,
        ambiguousLabelChecked: true
      }
    ]
    return raw
  }
  results.singleElementComposerReads = [
    ...((results.singleElementComposerReads as object[] | undefined) ?? []),
    {
      at: Date.now(),
      method: 'Maestro copyTextFrom exact chat-composer UITextView',
      value: text,
      initialRawComparisonPassed: true
    }
  ]
  return text
}

function composerValueFromRaw(raw: string): string {
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

async function clearNativeComposer(
  device: Device,
  text: string
): Promise<void> {
  if (platform === 'android') {
    // Real cursor/edit keys avoid accessibility Clear silently preserving a
    // controlled input. The known text length bounds both operations.
    let rightKeys = text.length
    while (rightKeys-- > 0) await device.pressKey({ key: 'DPAD_RIGHT' })
    let deleteKeys = text.length
    while (deleteKeys-- > 0) await device.pressKey({ key: 'BACKSPACE' })
  } else if (text.length > 0)
    await device.eraseText({ characters: text.length })
  assert.equal(
    await composerValue(device),
    '',
    'Normal native edit keys must clear the exact current draft'
  )
}

async function reveal(
  device: Device,
  element: { id?: string; text?: string },
  first: 'UP' | 'DOWN' = 'UP'
): Promise<void> {
  try {
    await device.assertVisible({ ...element, timeout: 500 })
    return
  } catch {
    // Native routes retain their prior offset, so either direction can be needed.
  }
  for (const direction of [first, first === 'UP' ? 'DOWN' : 'UP']) {
    try {
      await device.scrollUntilVisible({ element, direction, timeout: 20000 })
      await device.assertVisible({ ...element, timeout: 1000 })
      return
    } catch {
      // WDA has no scrollUntilVisible.from option; use its supported gestures.
    }
  }
  await device.assertVisible({ ...element, timeout: 1000 })
}

async function settleAndroidReplyContent(
  device: Device,
  rowId: string,
  bodyText: string
): Promise<void> {
  if (platform !== 'android') return
  await reveal(device, { text: bodyText })
  let previous: { body: Bounds; quote: Bounds } | undefined
  await until(
    'Exact reply body and quote must settle inside the current pane',
    async () => {
      const nodes = flatten(await device.hierarchy())
      const row = nodes.find(node => node.id === rowId)
      const viewport = nodes.find(
        node =>
          node.type?.includes('ScrollView') === true &&
          node.bounds != null &&
          flatten(node).some(child => child.id === rowId)
      )?.bounds
      const children = row == null ? [] : flatten(row)
      const body = children.find(
        node =>
          (node.text === bodyText || node.label === bodyText) &&
          node.bounds != null
      )?.bounds
      const quote = children.find(
        node =>
          (node.text?.startsWith('Jump to message from ') === true ||
            node.label?.startsWith('Jump to message from ') === true) &&
          node.bounds != null
      )?.bounds
      if (viewport == null) {
        previous = undefined
        return undefined
      }
      if (
        body == null ||
        quote == null ||
        body.y < viewport.y + 12 ||
        quote.y < viewport.y + 12
      ) {
        const x = Math.round(viewport.x + viewport.width * 0.5)
        await device.dragAndDrop({
          from: {
            point: `${x},${Math.round(viewport.y + viewport.height * 0.35)}`
          },
          to: {
            point: `${x},${Math.round(viewport.y + viewport.height * 0.55)}`
          },
          holdDuration: 10,
          duration: 400
        })
        previous = undefined
        return undefined
      }
      if (
        body.y + body.height > viewport.y + viewport.height - 12 ||
        quote.y + quote.height > viewport.y + viewport.height - 12
      ) {
        const x = Math.round(viewport.x + viewport.width * 0.5)
        await device.dragAndDrop({
          from: {
            point: `${x},${Math.round(viewport.y + viewport.height * 0.65)}`
          },
          to: {
            point: `${x},${Math.round(viewport.y + viewport.height * 0.45)}`
          },
          holdDuration: 10,
          duration: 400
        })
        previous = undefined
        return undefined
      }
      const stable =
        previous != null &&
        Math.abs(previous.body.y - body.y) < 1 &&
        Math.abs(previous.body.height - body.height) < 1 &&
        Math.abs(previous.quote.y - quote.y) < 1 &&
        Math.abs(previous.quote.height - quote.height) < 1
      previous = { body, quote }
      return stable ? true : undefined
    },
    15000
  )
}

async function physicalMessageHold(
  device: Device,
  rowId: string,
  bodyText: string,
  duration: number
): Promise<void> {
  await reveal(device, { id: rowId })
  let previous: Bounds | undefined
  let parent: Bounds | undefined
  let viewport: Bounds | undefined
  const bounds = await until(
    'Actual native message must settle before a physical hold',
    async () => {
      const tree = await device.hierarchy()
      const nodes = flatten(tree)
      const row = nodes.find(node => node.id === rowId)
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
      viewport = nodes.find(
        node =>
          node.type?.includes('ScrollView') === true &&
          node.bounds != null &&
          flatten(node).some(child => child.id === rowId)
      )?.bounds
      assert(
        viewport != null,
        'Actual message viewport required for physical hold'
      )
      results.physicalHoldPreparation = {
        rowId,
        row: parent,
        body: current,
        viewport,
        observedAt: Date.now()
      }
      if (
        current == null ||
        current.y + current.height <= viewport.y + 8 ||
        current.y >= viewport.y + viewport.height - 8
      ) {
        assert(
          parent != null,
          'Exact identified row required before body preparation'
        )
        const x = Math.round(viewport.x + viewport.width * 0.5)
        const down = (current ?? parent).y < viewport.y + 8
        const upper = Math.round(viewport.y + viewport.height * 0.3)
        const lower = Math.round(viewport.y + viewport.height * 0.7)
        await device.dragAndDrop({
          from: { point: `${x},${down ? upper : lower}` },
          to: { point: `${x},${down ? lower : upper}` },
          holdDuration: 10,
          duration: 400
        })
        previous = undefined
        return undefined
      }
      assert(
        current.width > 0 && current.height > 0,
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
  assert(viewport != null)
  const y = Math.round(
    (Math.max(bounds.y, viewport.y + 8) +
      Math.min(bounds.y + bounds.height, viewport.y + viewport.height - 8)) /
      2
  )
  results.physicalHoldReceipts = [
    ...((results.physicalHoldReceipts as object[] | undefined) ?? []),
    {
      rowId,
      body: bounds,
      row: parent,
      viewport,
      point: { x, y },
      requestedDurationMs: duration,
      stationary: true,
      issuedAt: Date.now()
    }
  ]
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
  const cachePath = process.env.CHAT_UI_NATIVE_OBSERVER_CACHE
  let session: Session | undefined
  if (cachePath != null && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Session
    hidden.push(cached.token)
    client.token = cached.token
    const actor = await client.whoAmI()
    if (actor?.id === fixture.actor.userId) session = cached
    else client.token = undefined
  }
  session ??= await client.signInWithPassword(
    fixture.actor.email,
    fixture.actor.password
  )
  hidden.push(session.token)
  assert.equal(
    session.user.id,
    fixture.actor.userId,
    'Observer account must match the retained native account'
  )
  if (cachePath != null)
    writeFileSync(cachePath, JSON.stringify(session), { mode: 0o600 })
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
  let restorePendingPreferences: (() => Promise<void>) | undefined
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
    const idleTimeout = process.env.CHAT_UI_NATIVE_IDLE_TIMEOUT
    const idleSettings =
      idleTimeout == null ? {} : { waitForIdleTimeout: Number(idleTimeout) }
    if (idleTimeout != null)
      assert(
        Number.isInteger(Number(idleTimeout)) &&
          Number(idleTimeout) >= 0 &&
          Number(idleTimeout) <= 10000,
        'Explicit native idle timeout must be supported milliseconds'
      )
    device = await daemon.attach({
      device: deviceId,
      platform,
      appId: fixture.appId,
      appFile,
      artifacts: 'none',
      driverStartTimeout: 180,
      ...idleSettings
    })
    results.driverSettings = idleSettings
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
    const initialRow = chatRow(fixture.conversationLabel)
    await reveal(m, initialRow, 'DOWN')
    await m.assertVisible({ ...initialRow, timeout: 60000 })
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
      const onList = (nodes: Hierarchy[]): boolean =>
        process.env.CHAT_UI_NATIVE_LEGACY_ROWS === '1'
          ? strings(nodes).some(value =>
              value.startsWith('Conversation actions: ')
            )
          : nodes.some(
              node => node.id?.startsWith('chat-conversation-') === true
            )
      if (onList(flatten(await m.hierarchy()))) return
      if (platform === 'android') {
        for (let attempt = 0; attempt < 3; attempt++) {
          const nodes = await until(
            'Current native route must settle',
            async () => {
              const nodes = flatten(await m.hierarchy())
              return onList(nodes) ||
                strings(nodes).includes('Back') ||
                strings(nodes).includes('Chat')
                ? nodes
                : undefined
            },
            10000
          )
          if (onList(nodes)) return
          if (!strings(nodes).includes('Back')) {
            const tab = nodes
              .filter(
                node =>
                  (node.text === 'Chat' || node.label === 'Chat') &&
                  node.bounds != null
              )
              .sort((a, b) => b.bounds!.y - a.bounds!.y)[0]?.bounds
            assert(
              tab != null,
              'Cold retained launch must expose its native Chat tab'
            )
            await m.tapOnPoint({
              point: `${Math.round(tab.x + tab.width / 2)},${Math.round(tab.y + tab.height / 2)}`
            })
            await until(
              'Cold retained Chat tab must reopen the list',
              async () =>
                onList(flatten(await m.hierarchy())) ? true : undefined,
              30000
            )
            return
          }
          await tapVisibleControl(m, 'Back')
          const arrived = await until(
            'Back must settle before another navigation action',
            async () =>
              onList(flatten(await m.hierarchy())) ? true : undefined,
            2000
          ).catch(() => undefined)
          if (arrived === true) return
        }
      } else await m.openLink({ link: `${fixture.scheme}://chat` })
      await until('Native conversation rows remain available', async () =>
        onList(flatten(await m.hierarchy())) ? true : undefined
      )
    }
    async function scopedOpen(
      id: string,
      uniquePreview: string
    ): Promise<void> {
      if (
        platform === 'ios' &&
        process.env.CHAT_UI_NATIVE_LEGACY_ROWS === '1'
      ) {
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
      const rowId = `chat-conversation-${id}`
      if (process.env.CHAT_UI_NATIVE_LEGACY_ROWS !== '1') {
        await reveal(m, { id: rowId })
        await m.tapOn({ id: rowId })
        await m.assertVisible({ id: 'chat-composer', timeout: 30000 })
        return
      }
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
      await scopedOpen(fixture.conversationId, fixture.targetText)
      await revealMessage(fixture.conversationId, fixture.originalMessageIds[0])
      await m.assertVisible({ text: fixture.targetText, timeout: 60000 })
      await m
        .assertVisible({ text: fixture.replyText, timeout: 1000 })
        .catch(async () => {
          await revealMessage(
            fixture.conversationId,
            fixture.originalMessageIds[1]
          )
          await m.assertVisible({ text: fixture.replyText, timeout: 10000 })
        })
    }
    async function revealMessage(
      conversationId: string,
      messageId: string
    ): Promise<void> {
      const conversation = (await api.chatConversations()).find(
        row => row.id === conversationId
      )
      assert(
        conversation != null,
        'Current message scope must remain accessible'
      )
      const pages = await Promise.all([
        api.chatMessages(conversationId, { after: 0, limit: 100 }),
        api.chatMessages(conversationId, {
          before: conversation.lastSeq + 1,
          limit: 100
        })
      ])
      const sequences = new Map(pages.flat().map(row => [row.id, row.seq]))
      const targetSeq = sequences.get(messageId)
      assert(
        targetSeq != null,
        'Supplied message must be present in normal authenticated history metadata'
      )
      let previous = ''
      await until(
        'Exact identified message must reach its real visible pane',
        async () => {
          const nodes = flatten(await m.hierarchy())
          const pane = nodes.find(
            node =>
              node.type?.includes('ScrollView') === true &&
              node.bounds != null &&
              flatten(node).some(
                child => child.id?.startsWith('chat-message-') === true
              )
          )?.bounds
          assert(
            pane != null,
            'Actual current message scroll viewport required'
          )
          const row = nodes.find(
            node => node.id === `chat-message-${messageId}`
          )?.bounds
          if (
            row != null &&
            Math.min(row.y + row.height, pane.y + pane.height) -
              Math.max(row.y, pane.y) >
              40
          )
            return true
          const visible = nodes.filter(
            node =>
              node.id?.startsWith('chat-message-') === true &&
              node.bounds != null &&
              node.bounds.y + node.bounds.height > pane.y &&
              node.bounds.y < pane.y + pane.height
          )
          const seen = visible
            .map(node => sequences.get(node.id!.slice('chat-message-'.length)))
            .filter((seq): seq is number => seq != null)
          assert(
            seen.length > 0,
            'At least one actual visible row must match history metadata'
          )
          const older =
            row != null && row.height > 0
              ? row.y < pane.y
              : targetSeq < Math.min(...seen)
          const key = visible
            .map(node => `${node.id}:${Math.round(node.bounds!.y)}`)
            .join(',')
          if (key === previous && older) {
            const earlier = nodes.find(
              node =>
                (node.text === 'Load earlier messages' ||
                  node.label === 'Load earlier messages') &&
                node.bounds != null
            )
            assert(
              earlier != null,
              'Older target requires a normal earlier-history control at this boundary'
            )
            await tapStableControl(m, 'Load earlier messages')
            previous = ''
            return undefined
          }
          previous = key
          const x = Math.round(pane.x + pane.width * 0.5)
          const from = {
            x,
            y: Math.round(pane.y + pane.height * (older ? 0.25 : 0.75))
          }
          const to = {
            x,
            y: Math.round(pane.y + pane.height * (older ? 0.75 : 0.25))
          }
          results.messageRevealReceipts = [
            ...((results.messageRevealReceipts as object[] | undefined) ?? []),
            {
              messageId,
              targetSeq,
              visibleSeqs: seen,
              pane,
              from,
              to,
              at: Date.now()
            }
          ]
          await m.dragAndDrop({
            from: { point: `${from.x},${from.y}` },
            to: { point: `${to.x},${to.y}` },
            holdDuration: 10,
            duration: 400
          })
          return undefined
        },
        90000
      )
    }
    async function menu(
      label = fixture.conversationLabel,
      conversationId?: string
    ): Promise<void> {
      if (conversationId != null)
        await reveal(m, chatRow(label, conversationId))
      else await reveal(m, chatRow(label), 'DOWN')
      await hold(550, label, conversationId)
      await m.assertVisible({ text: 'Mark unread', timeout: 10000 })
      const text = strings(flatten(await m.hierarchy()))
      assert(
        text.includes('Mark unread') &&
          (text.includes('Mute') || text.includes('Unmute')) &&
          (text.includes('Pin') || text.includes('Unpin')),
        'All three personal conversation actions required'
      )
    }
    async function currentMessageMore(messageId: string): Promise<void> {
      const rowId = `chat-message-${messageId}`
      await m.tapOn({
        text: 'More message actions',
        childOf: { id: rowId },
        timeout: 30000
      })
      results.currentMessageMoreReceipts = [
        ...((results.currentMessageMoreReceipts as object[] | undefined) ?? []),
        { messageId, childOf: rowId, namedNativeControl: true, at: Date.now() }
      ]
    }
    if (process.argv[2] === 'list-terminal') {
      stage = 'native-list-terminal-offsets'
      const input = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_LIST_TERMINAL_FIXTURE'), 'utf8')
      ) as {
        synthetic: true
        actorUserId: string
        zeroRows: [string, string]
        membersConversationId: string
        membersHeading: string
      }
      assert.equal(
        input.synthetic,
        true,
        'Private synthetic list fixture required'
      )
      assert.equal(
        input.actorUserId,
        fixture.actor.userId,
        'List fixture must belong to the retained actor'
      )
      assert.equal(
        input.zeroRows.length,
        2,
        'Exact first and following zero-position rows required'
      )
      assert.notEqual(
        input.zeroRows[0],
        input.zeroRows[1],
        'Two distinct zero-position rows required'
      )
      assert(
        rows.some(row => row.id === input.membersConversationId),
        'Members route must be accessible to the retained actor'
      )
      for (const id of input.zeroRows)
        assert(
          rows.some(row => row.id === id),
          'Each terminal anchor must be an accessible current conversation'
        )
      assert(
        input.membersHeading.length > 0,
        'Actual Members screen heading required'
      )
      interface ListSnapshot {
        at: number
        pane: Bounds
        rows: Array<{ id: string; bounds: Bounds }>
      }
      const contains = (outer: Bounds, inner: Bounds): boolean =>
        inner.width > 0 &&
        inner.height > 0 &&
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height
      async function listSnapshot(): Promise<ListSnapshot> {
        const nodes = flatten(await m.hierarchy())
        const pane = nodes.find(
          node => node.id === 'chat-conversation-list'
        )?.bounds
        assert(
          pane != null && pane.width > 0 && pane.height > 0,
          'Exact current conversation-list viewport required'
        )
        const held = nodes
          .filter(
            node =>
              node.id?.startsWith('chat-conversation-') === true &&
              node.id !== 'chat-conversation-list' &&
              node.bounds != null &&
              contains(pane, node.bounds)
          )
          .map(node => ({
            id: node.id!.slice('chat-conversation-'.length),
            bounds: node.bounds!
          }))
          .sort((a, b) => a.bounds.y - b.bounds.y)
        assert.equal(
          new Set(held.map(row => row.id)).size,
          held.length,
          'Full native conversation rows must have unique exact IDs'
        )
        assert(
          held.length >= 2,
          'Two complete unclipped native conversation rows required'
        )
        return { at: Date.now(), pane, rows: held }
      }
      const sameRectangle = (
        a: Bounds,
        b: Bounds,
        tolerance: number
      ): boolean =>
        (['x', 'y', 'width', 'height'] as const).every(
          key => Math.abs(a[key] - b[key]) <= tolerance
        )
      async function stableSnapshot(): Promise<ListSnapshot> {
        let previous: ListSnapshot | undefined
        return await until(
          'Two complete native list rows must settle',
          async () => {
            const next = await listSnapshot()
            const prior = previous
            const stable =
              prior != null &&
              sameRectangle(prior.pane, next.pane, 1) &&
              next.rows
                .slice(0, 2)
                .every(
                  (row, index) =>
                    prior.rows[index]?.id === row.id &&
                    sameRectangle(prior.rows[index].bounds, row.bounds, 1)
                )
            previous = next
            return stable ? next : undefined
          },
          15000
        )
      }
      async function physicalListMove(towardTop: boolean): Promise<void> {
        const before = await listSnapshot()
        const x = Math.round(before.pane.x + before.pane.width * 0.5)
        const upper = Math.round(before.pane.y + before.pane.height * 0.25)
        const lower = Math.round(before.pane.y + before.pane.height * 0.75)
        const startedAt = Date.now()
        await m.dragAndDrop({
          from: { point: `${x},${towardTop ? upper : lower}` },
          to: { point: `${x},${towardTop ? lower : upper}` },
          holdDuration: 10,
          duration: 400
        })
        const completedAt = Date.now()
        await new Promise(resolve => setTimeout(resolve, 800))
        const after = await stableSnapshot()
        results.listPhysicalMoves = [
          ...((results.listPhysicalMoves as object[] | undefined) ?? []),
          {
            towardTop,
            startedAt,
            completedAt,
            settleMs: 800,
            requestedDurationMs: 400,
            before,
            after
          }
        ]
      }
      async function physicalTop(): Promise<ListSnapshot> {
        let previous: ListSnapshot | undefined
        for (let attempt = 0; attempt < 20; attempt++) {
          await physicalListMove(true)
          const next = await stableSnapshot()
          const expected =
            next.rows[0].id === input.zeroRows[0] &&
            next.rows[1].id === input.zeroRows[1]
          const prior = previous
          const unchanged =
            prior != null &&
            expected &&
            input.zeroRows.every(id => {
              const a = prior.rows.find(row => row.id === id)?.bounds
              const b = next.rows.find(row => row.id === id)?.bounds
              return a != null && b != null && sameRectangle(a, b, 1)
            })
          previous = next
          if (unchanged) {
            await m.assertVisible({ text: 'New message', timeout: 3000 })
            return next
          }
        }
        assert.fail(
          'Physical top boundary must expose the exact complete first and following rows'
        )
      }
      async function physicalNonzero(top: ListSnapshot): Promise<ListSnapshot> {
        await physicalListMove(false)
        const moved = await stableSnapshot()
        const displacement = top.rows.flatMap(row => {
          const now = moved.rows.find(other => other.id === row.id)
          return now == null ? [] : [Math.abs(now.bounds.y - row.bounds.y)]
        })
        assert(
          displacement.some(value => value > 20) ||
            moved.rows[0].id !== top.rows[0].id,
          'Actual physical list movement away from zero is required'
        )
        return moved
      }
      const proofs: object[] = []
      async function appBack(headerLimit: number): Promise<void> {
        let prior: Bounds | undefined
        const bounds = await until(
          'Actual in-app header Back must settle',
          async () => {
            const matches = flatten(await m.hierarchy()).filter(
              node =>
                (node.text === 'Back' || node.label === 'Back') &&
                node.bounds != null &&
                node.bounds.width > 0 &&
                node.bounds.height > 0 &&
                node.bounds.y + node.bounds.height <= headerLimit
            )
            assert(
              matches.length <= 1,
              'In-app header Back must have one exact visible target'
            )
            const current = matches[0]?.bounds
            if (current == null) return undefined
            const stable = prior != null && sameRectangle(prior, current, 1)
            prior = current
            return stable ? current : undefined
          },
          15000
        )
        results.listAppBackTargets = [
          ...((results.listAppBackTargets as object[] | undefined) ?? []),
          { bounds, headerLimit, at: Date.now(), systemBackExcluded: true }
        ]
        await m.tapOnPoint({
          point: `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
        })
      }
      for (const position of ['zero', 'nonzero'] as const) {
        for (const route of ['new-message', 'members'] as const) {
          await list()
          const top = await physicalTop()
          await physicalNonzero(top)
          const before =
            position === 'zero' ? await physicalTop() : await stableSnapshot()
          const anchors = before.rows.slice(0, 2)
          const prefix = `${platform}-list-terminal-${position}-${route}`
          writeFileSync(
            join(resultDirectory, `${prefix}-before.json`),
            JSON.stringify(before, null, 2)
          )
          writeFileSync(
            join(resultDirectory, `${prefix}-before.png`),
            await m.screenshot()
          )
          const entryAt = Date.now()
          // Public route entry unmounts the workspace without scrolling to an
          // offscreen header button; final list motion remains physical.
          await m.openLink({
            link:
              route === 'new-message'
                ? `${fixture.scheme}://chat/new`
                : `${fixture.scheme}://chat/${encodeURIComponent(input.membersConversationId)}/members`
          })
          const opened = flatten(await m.hierarchy())
          if (strings(opened).includes('Open in “TeamStation”?'))
            await tapVisibleControl(m, 'Open')
          if (route === 'new-message') {
            await m.assertVisible({ text: 'Name', timeout: 30000 })
            await m.assertVisible({
              text: 'Start conversation',
              timeout: 10000
            })
          } else
            await m.assertVisible({
              text: input.membersHeading,
              timeout: 30000
            })
          await m.assertNotVisible({
            id: 'chat-conversation-list',
            timeout: 3000
          })
          await m.assertNotVisible({ id: 'chat-workspace', timeout: 3000 })
          const workspaceAbsentAt = Date.now()
          await appBack(before.pane.y)
          if (route === 'members') {
            await m.assertVisible({ text: 'Members', timeout: 30000 })
            await appBack(before.pane.y)
          }
          await m.assertVisible({
            id: 'chat-conversation-list',
            timeout: 30000
          })
          const returnedAt = Date.now()
          await new Promise(resolve => setTimeout(resolve, 800))
          const after = await listSnapshot()
          const proof = {
            position,
            route,
            navigation: 'normal public deep link and in-app Back',
            settleMs: 800,
            tolerance: 10,
            entryAt,
            workspaceAbsentAt,
            returnedAt,
            before,
            after,
            anchorIds: anchors.map(row => row.id)
          }
          proofs.push(proof)
          results.listTerminalProofs = proofs
          writeFileSync(
            join(resultDirectory, `${prefix}-after.json`),
            JSON.stringify(after, null, 2)
          )
          writeFileSync(
            join(resultDirectory, `${prefix}-after.png`),
            await m.screenshot()
          )
          assert(
            sameRectangle(before.pane, after.pane, 10),
            'List viewport must remain unchanged after workspace return'
          )
          for (const anchor of anchors) {
            const restored = after.rows.find(row => row.id === anchor.id)
            assert(
              restored != null,
              'Complete identified row and following row must remain unclipped after return'
            )
            assert(
              sameRectangle(anchor.bounds, restored.bounds, 10),
              'Complete identified native row must restore within ten pixels'
            )
          }
          pass(
            `physical final ${position} list offset survives ${route} workspace unmount and return`
          )
        }
      }
      return
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
      label = fixture.conversationLabel,
      conversationId?: string
    ): Promise<{ x: number; y: number }> {
      const selected = (await api.chatConversations()).find(row =>
        conversationId != null
          ? row.id === conversationId
          : label === fixture.conversationLabel
            ? row.id === fixture.conversationId
            : row.title === label
      )
      const rowId =
        selected == null ? undefined : `chat-conversation-${selected.id}`
      const titled = new RegExp(
        chatRowText(label, platform === 'ios' ? 'ios' : 'android')
      )
      if (rowId != null && process.env.CHAT_UI_NATIVE_LEGACY_ROWS !== '1')
        await reveal(m, { id: rowId })
      let prior: Bounds | undefined
      let visible: Bounds | undefined
      const row = await until(
        'Conversation row must finish scrolling before a measured hold',
        async () => {
          // The list is the one holding the matched row node, which a
          // legacy row without an id is found by too.
          const found = nativeRowInList(await m.hierarchy(), node =>
            rowId != null && process.env.CHAT_UI_NATIVE_LEGACY_ROWS !== '1'
              ? node.id === rowId
              : titled.test(node.text ?? '') || titled.test(node.label ?? '')
          )
          if (found == null) return undefined
          const { row, viewport } = found
          const bounds = row.bounds
          const left = Math.max(bounds.x, viewport.x) + 6
          const right =
            Math.min(bounds.x + bounds.width, viewport.x + viewport.width) - 6
          const upper = Math.max(bounds.y, viewport.y) + 6
          const lower =
            Math.min(bounds.y + bounds.height, viewport.y + viewport.height) - 6
          if (
            bounds.y < viewport.y + 6 ||
            bounds.y + bounds.height > viewport.y + viewport.height - 6
          ) {
            const x = Math.round(viewport.x + viewport.width * 0.5)
            const down = bounds.y < viewport.y + 6
            await m.dragAndDrop({
              from: {
                point: `${x},${Math.round(viewport.y + viewport.height * (down ? 0.3 : 0.65))}`
              },
              to: {
                point: `${x},${Math.round(viewport.y + viewport.height * (down ? 0.5 : 0.45))}`
              },
              holdDuration: 10,
              duration: 400
            })
            prior = undefined
            return undefined
          }
          assert(
            right > left && lower > upper,
            'Row hold must have a hittable intersection with its current list viewport'
          )
          visible = {
            x: left,
            y: upper,
            width: right - left,
            height: lower - upper
          }
          const stable =
            prior != null &&
            Math.abs(prior.x - bounds.x) < 1 &&
            Math.abs(prior.y - bounds.y) < 1
          prior = bounds
          return stable ? row : undefined
        },
        15000
      )
      assert(
        row?.bounds != null,
        'The supplied conversation row must expose bounds'
      )
      assert(visible != null, 'Actual visible row hold rectangle required')
      results.conversationHoldTarget = {
        rowId,
        row: row.bounds,
        visible,
        capturedAt: Date.now()
      }
      return {
        x: Math.round(visible.x + visible.width / 2),
        y: Math.round(visible.y + visible.height / 2)
      }
    }
    async function hold(
      duration: number,
      label = fixture.conversationLabel,
      conversationId?: string
    ): Promise<void> {
      const point = await rowCenter(label, conversationId)
      results.conversationHoldReceipts = [
        ...((results.conversationHoldReceipts as object[] | undefined) ?? []),
        {
          target: results.conversationHoldTarget,
          point,
          requestedDurationMs: duration,
          stationary: true,
          issuedAt: Date.now()
        }
      ]
      if (platform === 'android') {
        await m.swipe({
          startX: point.x,
          startY: point.y,
          endX: point.x,
          endY: point.y,
          duration
        })
      } else {
        await m.dragAndDrop({
          from: { point: `${point.x},${point.y}` },
          to: { point: `${point.x},${point.y}` },
          holdDuration: duration,
          duration: 10
        })
      }
    }
    if (process.argv[2] === 'hold-probe') {
      stage = 'stationary-native-message-hold'
      const probe = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_HOLD_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        messageId: string
        body: string
        holdCount: number
      }
      assert(
        Number.isInteger(probe.holdCount) &&
          probe.holdCount >= 1 &&
          probe.holdCount <= 6,
        'A bounded stationary hold trial count is required'
      )
      await scopedOpen(probe.conversationId, probe.body)
      const rowId = `chat-message-${probe.messageId}`
      await revealMessage(probe.conversationId, probe.messageId)
      await settleAndroidReplyContent(m, rowId, probe.body)
      for (let trial = 0; trial < probe.holdCount; trial++) {
        await photo(`hold-probe-${trial + 1}-before`)
        await physicalMessageHold(m, rowId, probe.body, 550)
        await until(
          'The exact message Reply action must open after the hold',
          async () =>
            flatten(await m.hierarchy()).some(
              node =>
                (node.text === 'Reply' || node.label === 'Reply') &&
                node.bounds != null
            )
              ? true
              : undefined,
          10000
        )
        await photo(`hold-probe-${trial + 1}-menu`)
        results.stationaryHoldTrials = trial + 1
        await m.tapOnPoint({ point: '5%,15%' })
        await until(
          'The exact message action menu must dismiss',
          async () =>
            flatten(await m.hierarchy()).some(
              node => node.text === 'Reply' || node.label === 'Reply'
            )
              ? undefined
              : true,
          3000
        )
      }
      pass(
        'bounded stationary 550 ms holds open message actions on the exact readable body'
      )
      return
    }
    if (process.argv[2] === 'fault-pending-send') {
      stage = 'native-pending-send-remount-and-newer-draft'
      const pending = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_PENDING_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        replyId: string
        replyBody: string
        submittedText: string
        newerText: string
      }
      assert.notEqual(pending.conversationId, fixture.conversationId)
      const pinnedBefore = (await api.chatConversations()).filter(row =>
        [pending.conversationId, fixture.conversationId].includes(row.id)
      )
      assert.equal(pinnedBefore.length, 2)
      restorePendingPreferences = async () => {
        for (const row of pinnedBefore)
          await api.updateChatPreferences(row.id, {
            pinned: row.preferences.pinned
          })
        results.pendingPreferenceCleanup = {
          normalAuthenticatedApi: true,
          exactPriorPinStatesRestored: true
        }
      }
      for (const row of pinnedBefore)
        if (!row.preferences.pinned)
          await api.updateChatPreferences(row.id, { pinned: true })
      results.pendingPreferencePreparation = {
        normalAuthenticatedApi: true,
        before: pinnedBefore.map(row => ({
          id: row.id,
          pinned: row.preferences.pinned
        })),
        physicalUiClaim: false
      }
      const auditFor = (
        gateId: string
      ): Array<{
        at: string
        gateId: string
        event?: string
        remaining?: number
      }> =>
        readFileSync(required('CHAT_UI_NATIVE_FAULT_AUDIT'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line))
          .filter(hit => hit.gateId === gateId)
      await scopedOpen(pending.conversationId, pending.replyBody)
      const startingText = await composerValue(m)
      const other = pinnedBefore.find(row => row.id === fixture.conversationId)!
      const expectedBTitle =
        other.kind === 'dm' || other.scope == null
          ? (other.title ??
            other.people
              .filter(person => person.userId !== fixture.actor.userId)
              .map(person => person.shortName)
              .join(', '))
          : (other.scopeName ?? other.title)
      assert(
        expectedBTitle != null && expectedBTitle !== '',
        'Actual B title must be derived from normal metadata'
      )
      const outcomes = (
        process.env.CHAT_UI_NATIVE_PENDING_OUTCOMES ?? 'success,failure'
      ).split(',')
      assert(
        outcomes.length > 0 &&
          outcomes.every(value => value === 'success' || value === 'failure') &&
          new Set(outcomes).size === outcomes.length,
        'Explicit unique pending outcomes required'
      )
      const pendingDelay = Number(
        process.env.CHAT_UI_NATIVE_PENDING_DELAY_MS ?? 15000
      )
      assert(
        pendingDelay === 15000 || pendingDelay === 30000,
        'Supported externally controlled native pending test delay required'
      )
      results.pendingTestMethod = {
        delayMs: pendingDelay,
        outcomes,
        physicalGestureAndGeometryThresholdsUnchanged: true
      }
      for (const outcome of outcomes) {
        await revealMessage(pending.conversationId, pending.replyId)
        await settleAndroidReplyContent(
          m,
          `chat-message-${pending.replyId}`,
          pending.replyBody
        )
        await physicalMessageHold(
          m,
          `chat-message-${pending.replyId}`,
          pending.replyBody,
          550
        )
        await tapStableControl(m, 'Reply')
        const submitted = `${pending.submittedText}\n${outcome} ${Date.now()}`
        const newer = `${pending.newerText}\n${outcome} ${Date.now()}`
        await m.tapOn({ id: 'chat-composer' })
        await clearNativeComposer(m, await composerValue(m))
        await m.inputText({ text: submitted })
        const center = (bounds: Bounds): { x: number; y: number } => ({
          x: Math.round(bounds.x + bounds.width / 2),
          y: Math.round(bounds.y + bounds.height / 2)
        })
        const backPoint = async (): Promise<{ x: number; y: number }> => {
          const node = flatten(await m.hierarchy())
            .filter(
              node =>
                (node.text === 'Back' || node.label === 'Back') &&
                node.bounds != null &&
                node.bounds.y <
                  (results.deviceInfo as { screenHeight: number })
                    .screenHeight *
                    0.25
            )
            .sort((a, b) => a.bounds!.y - b.bounds!.y)[0]
          assert(
            node?.bounds != null,
            'Actual native Back control required before timed navigation'
          )
          return center(node.bounds)
        }
        const backA = await backPoint()
        await list()
        const listNodes = flatten(await m.hierarchy())
        const listPane = listNodes.find(
          node =>
            node.type?.includes('ScrollView') === true &&
            node.bounds != null &&
            flatten(node).some(
              child =>
                child.id === `chat-conversation-${pending.conversationId}`
            )
        )?.bounds
        assert(
          listPane != null,
          'Both pinned navigation rows require their actual list pane'
        )
        const rowPoint = (id: string): { x: number; y: number } => {
          const row = listNodes.find(
            node => node.id === `chat-conversation-${id}`
          )?.bounds
          assert(
            row != null &&
              row.y >= listPane.y &&
              row.y + row.height <= listPane.y + listPane.height,
            'Timed navigation requires fully visible prevalidated A/B rows'
          )
          return center(row)
        }
        const pointA = rowPoint(pending.conversationId)
        const pointB = rowPoint(fixture.conversationId)
        const stableRows = flatten(await m.hierarchy())
        for (const [id, point] of [
          [pending.conversationId, pointA],
          [fixture.conversationId, pointB]
        ] as const) {
          const currentBounds = stableRows.find(
            node => node.id === `chat-conversation-${id}`
          )?.bounds
          assert(
            currentBounds != null,
            'Prepared navigation row must remain visible'
          )
          const currentPoint = center(currentBounds)
          assert(
            Math.abs(currentPoint.x - point.x) < 1 &&
              Math.abs(currentPoint.y - point.y) < 1,
            'Both prepared navigation rows must settle before the gate is armed'
          )
        }
        await m.tapOnPoint({ point: `${pointB.x},${pointB.y}` })
        await m.assertVisible({ id: 'chat-composer', timeout: 30000 })
        await revealMessage(
          fixture.conversationId,
          fixture.originalMessageIds[0]
        )
        const bPrepared = Buffer.from(await m.hierarchyRaw()).toString('utf8')
        assert(
          bPrepared.includes(expectedBTitle),
          'Actual B preparation must show its metadata title'
        )
        assert(
          bPrepared.includes(`chat-message-${fixture.originalMessageIds[0]}`),
          'Actual B preparation must contain its own unique message target'
        )
        const bComposerBefore = composerValueFromRaw(bPrepared)
        const backB = await backPoint()
        await m.tapOnPoint({ point: `${backB.x},${backB.y}` })
        await m.tapOnPoint({ point: `${pointA.x},${pointA.y}` })
        await m.assertVisible({ id: 'chat-composer', timeout: 30000 })
        const prepared = flatten(await m.hierarchy())
        const preparedSend = prepared.find(
          node =>
            (node.text === 'Send' || node.label === 'Send') &&
            node.bounds != null
        )
        assert(
          preparedSend?.bounds != null,
          'Prepared native Send control required'
        )
        const preparedRaw = Buffer.from(await m.hierarchyRaw()).toString('utf8')
        assert.equal(
          composerValueFromRaw(preparedRaw),
          submitted,
          'Before arming the gate, navigation must preserve the exact submitted draft'
        )
        const sendRaw =
          /<[^>]*(?:name|resource-id|identifier|text|content-desc|label)="Send"[^>]*>/.exec(
            preparedRaw
          )?.[0]
        assert(
          sendRaw != null && !/\benabled="false"/.test(sendRaw),
          'Prepared pending submission must be enabled'
        )
        const sendPoint = center(preparedSend.bounds)
        const preparedComposer = prepared.find(
          node => node.id === 'chat-composer'
        )?.bounds
        assert(
          preparedComposer != null,
          'Actual prepared composer rectangle required'
        )
        const composerPoint = center(preparedComposer)
        results.pendingNavigationPreparation = {
          pointA,
          pointB,
          backA,
          backB,
          sendPoint,
          composerPoint,
          composerBounds: preparedComposer,
          listPane,
          expectedBTitle,
          bMessageId: fixture.originalMessageIds[0],
          bComposerBefore,
          fullyVisibleRows: true,
          at: Date.now()
        }
        const before = (await api.chatConversations()).find(
          row => row.id === pending.conversationId
        )!
        const gateId = `native-${platform}-pending-${outcome}-${Date.now()}`
        execFileSync(
          process.execPath,
          [
            required('CHAT_UI_NATIVE_FAULT_CONTROL'),
            platform,
            `pending-${outcome}`,
            gateId,
            String(pendingDelay)
          ],
          { stdio: 'pipe' }
        )
        const milestones: Array<{ action: string; at: number }> = []
        results.pendingMilestones = milestones
        const outcomeMilestones = (results.pendingOutcomeMilestones ??
          {}) as Record<string, unknown>
        outcomeMilestones[outcome] = milestones
        results.pendingOutcomeMilestones = outcomeMilestones
        await m.tapOnPoint({ point: `${sendPoint.x},${sendPoint.y}` })
        milestones.push({ action: 'send returned', at: Date.now() })
        await until(
          'The normal encrypted post must consume the delayed gate',
          async () =>
            auditFor(gateId).some(hit => hit.event == null) ? true : undefined
        )
        assert(
          !auditFor(gateId).some(hit => hit.event === 'delay-released'),
          'The request must still be pending before timed navigation'
        )
        for (const [action, point] of [
          ['back from A', backA],
          ['open B', pointB],
          ['back from B', backB],
          ['return A', pointA]
        ] as const) {
          await m.tapOnPoint({ point: `${point.x},${point.y}` })
          milestones.push({ action, at: Date.now() })
          await new Promise(resolve => setTimeout(resolve, 150))
          if (action === 'open B') {
            const bRaw = Buffer.from(await m.hierarchyRaw()).toString('utf8')
            assert(
              bRaw.includes(expectedBTitle),
              'Timed navigation must actually open B title'
            )
            assert(
              bRaw.includes(`chat-message-${fixture.originalMessageIds[0]}`),
              'Timed B must contain its unique room message'
            )
            assert.equal(
              composerValueFromRaw(bRaw),
              bComposerBefore,
              'B must retain its separate composer state'
            )
            assert.notEqual(
              composerValueFromRaw(bRaw),
              submitted,
              'B must not show the submitted A draft'
            )
            milestones.push({
              action: 'actual B title/message/composer verified',
              at: Date.now()
            })
            await photo(`pending-${outcome}-B-navigation`)
            milestones.push({
              action: 'B navigation screenshot saved',
              at: Date.now()
            })
          }
        }
        milestones.push({
          action: 'returned composer inspection starts',
          at: Date.now()
        })
        const returnedRaw = Buffer.from(await m.hierarchyRaw()).toString('utf8')
        milestones.push({
          action: 'returned composer inspection completes',
          at: Date.now()
        })
        const pendingSendRaw =
          /<[^>]*(?:name|resource-id|identifier|text|content-desc|label)="Send"[^>]*>/.exec(
            returnedRaw
          )?.[0]
        assert(
          pendingSendRaw != null && /\benabled="false"/.test(pendingSendRaw),
          'Returning pending composer must block another submission'
        )
        assert.equal(
          composerValueFromRaw(returnedRaw),
          submitted,
          'Returned pending pane must retain the submitted draft'
        )
        milestones.push({ action: 'returned value verified', at: Date.now() })
        await m.tapOnPoint({
          point: `${sendPoint.x},${sendPoint.y}`
        })
        await m.tapOnPoint({ point: `${composerPoint.x},${composerPoint.y}` })
        await clearNativeComposer(m, submitted)
        await m.inputText({ text: newer })
        const newerDraftAt = Date.now()
        milestones.push({ action: 'newer draft typed', at: newerDraftAt })
        assert.equal(
          await composerValue(m),
          newer,
          'The exact newer draft must be present while the old request is still pending'
        )
        const newerVerifiedAt = Date.now()
        milestones.push({
          action: 'exact newer draft verified',
          at: newerVerifiedAt
        })
        await photo(`pending-${outcome}-remounted-newer-draft`)
        const release = await until(
          'Delayed send release must be audited',
          async () =>
            auditFor(gateId).find(hit => hit.event === 'delay-released')
        )
        assert(
          newerDraftAt < Date.parse(release.at) &&
            newerVerifiedAt < Date.parse(release.at),
          'Remount and newer draft must occur before the original request completes'
        )
        await until(
          'Pending completion must release the submission guard',
          async () => {
            const raw = Buffer.from(await m.hierarchyRaw()).toString('utf8')
            const node =
              /<[^>]*(?:name|resource-id|identifier|text|content-desc|label)="Send"[^>]*>/.exec(
                raw
              )?.[0]
            return node != null && !/\benabled="false"/.test(node)
              ? true
              : undefined
          }
        )
        assert.equal(
          await composerValue(m),
          newer,
          'Old completion must preserve the newer draft'
        )
        await list()
        await scopedOpen(fixture.conversationId, fixture.targetText)
        await list()
        await scopedOpen(pending.conversationId, pending.replyBody)
        assert.equal(
          await composerValue(m),
          newer,
          'Later navigation must preserve the newer draft'
        )
        const posts = (
          await api.chatMessages(pending.conversationId, {
            after: before.lastSeq,
            limit: 100
          })
        ).filter(row => row.kind === 'post')
        assert.equal(
          posts.length,
          outcome === 'success' ? 1 : 0,
          'A pending remount must not submit a duplicate encrypted post'
        )
        if (outcome === 'success')
          assert.equal(posts[0].senderUserId, fixture.actor.userId)
        const audit = auditFor(gateId)
        const consumption = audit.filter(hit => hit.event == null)
        assert.equal(consumption.length, 1)
        assert.equal(consumption[0].remaining, 0)
        results.pendingSendCases = [
          ...((results.pendingSendCases as object[] | undefined) ?? []),
          {
            outcome,
            delayMs: pendingDelay,
            gateId,
            consumedAt: consumption[0].at,
            releasedAt: release.at,
            newerDraftAt,
            newerVerifiedAt,
            newPosts: posts.length,
            duplicateBlockedOnRemount: true,
            newerDraftPreserved: true
          }
        ]
        writeFileSync(
          join(resultDirectory, `${platform}-pending-progress.json`),
          JSON.stringify(
            {
              cases: results.pendingSendCases,
              milestones: results.pendingMilestones
            },
            null,
            2
          ) + '\n'
        )
        writeFileSync(
          join(resultDirectory, `${platform}-pending-${outcome}-receipt.json`),
          JSON.stringify(
            {
              case: (results.pendingSendCases as object[]).at(-1),
              milestones,
              navigationPreparation: results.pendingNavigationPreparation
            },
            null,
            2
          ) + '\n'
        )
        pass(
          `native pending ${outcome} blocks a remount duplicate and preserves a newer draft`
        )
        execFileSync(
          process.execPath,
          [required('CHAT_UI_NATIVE_FAULT_CONTROL'), 'clear'],
          { stdio: 'pipe' }
        )
        if (strings(flatten(await m.hierarchy())).includes('Cancel reply'))
          await tapStableControl(m, 'Cancel reply')
      }
      await m.tapOn({ id: 'chat-composer' })
      await clearNativeComposer(m, await composerValue(m))
      if (startingText !== '') await m.inputText({ text: startingText })
      pass(
        `selected native delayed ${outcomes.join('/')} outcomes block remount duplicates and preserve a newer draft`
      )
      return
    }
    if (process.argv[2] === 'attachment-quote') {
      stage = 'current-native-attachment-quote-and-system-open'
      const deep = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_DEEP_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        attachmentReplyId: string
        attachmentReplyBody: string
        attachmentId: string
        fileName: string
      }
      await scopedOpen(deep.conversationId, deep.attachmentReplyBody)
      await revealMessage(deep.conversationId, deep.attachmentReplyId)
      const existing = (await api.chatPins(deep.conversationId)).some(
        pin => pin.messageId === deep.attachmentReplyId
      )
      if (!existing) {
        await currentMessageMore(deep.attachmentReplyId)
        await tapStableControl(m, 'Pin')
        await until(
          'Current attachment reply preparation pin must persist',
          async () =>
            (await api.chatPins(deep.conversationId)).some(
              pin => pin.messageId === deep.attachmentReplyId
            )
              ? true
              : undefined
        )
      }
      const quoteFor = async (): Promise<string> => {
        const row = flatten(await m.hierarchy()).find(
          node => node.id === `chat-message-${deep.attachmentReplyId}`
        )
        const quote = strings(row == null ? [] : flatten(row)).find(label =>
          label.startsWith('Jump to message from ')
        )
        assert(
          quote != null,
          'The identified current attachment reply must expose its own short-jump control'
        )
        return quote
      }
      await m.tapOn({ text: await quoteFor() })
      await m.assertVisible({
        id: `chat-message-${deep.attachmentId}`,
        timeout: 60000
      })
      await m.assertVisible({ text: `Save ${deep.fileName}`, timeout: 30000 })
      await photo('current-attachment-original-after-short-jump')
      const count = (await api.chatPins(deep.conversationId)).length
      await tapStableControl(m, `Pinned messages: ${count}`)
      await tapStableControl(m, deep.attachmentReplyBody)
      await m.assertVisible({
        id: `chat-message-${deep.attachmentReplyId}`,
        timeout: 30000
      })
      const currentQuote = await quoteFor()
      assert(
        currentQuote.includes(`File: ${deep.fileName}`),
        'Decoded current attachment quote must show its safe attachment label'
      )
      await photo('current-attachment-quote-label')
      await currentMessageMore(deep.attachmentReplyId)
      await tapStableControl(m, 'Unpin')
      await until(
        'Only the temporary current attachment reply pin must be removed',
        async () =>
          !(await api.chatPins(deep.conversationId)).some(
            pin => pin.messageId === deep.attachmentReplyId
          )
            ? true
            : undefined
      )
      await m.tapOn({ text: currentQuote })
      await m.assertVisible({ text: `Save ${deep.fileName}`, timeout: 30000 })
      await tapStableControl(m, `Save ${deep.fileName}`)
      const opened = await until(
        'Ordinary short file activation must open the native system viewer',
        async () => {
          const labels = strings(flatten(await m.hierarchy()))
          return labels.includes('Done') ||
            labels.includes('Copy') ||
            labels.includes('Share')
            ? labels
            : undefined
        },
        30000
      )
      await photo('current-attachment-system-open')
      results.currentAttachmentQuote = {
        normalCurrentReplyPinPreparation: true,
        existingTemporaryPin: existing,
        temporaryPinRemoved: true,
        exactCurrentQuoteLabel: currentQuote,
        attachmentJumpTarget: deep.attachmentId,
        systemViewerLabels: opened
      }
      pass(
        'current attachment quote uses its safe file label, short-jumps to its original and opens the native system viewer'
      )
      return
    }
    if (
      [
        'locked-setup',
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
      }
      assert(
        typeof locked.conversationId === 'string' &&
          typeof locked.originalId === 'string',
        'Exact retained synthetic locked post required'
      )
      const originalId = `chat-message-${locked.originalId}`
      await scopedOpen(locked.conversationId, locked.originalBody)
      await reveal(m, { id: originalId })
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
      if (process.argv[2] === 'locked-setup') {
        assert.equal(
          process.env.CHAT_UI_NATIVE_ALLOW_LOCKED_PIN_SETUP,
          '1',
          'Explicit synthetic personal metadata setup authorization required'
        )
        const envelope = (await api.chatMessages(locked.conversationId)).find(
          message => message.id === locked.originalId
        )
        assert(
          envelope != null && envelope.clearedAt == null,
          'Only an accessible retained undeleted locked post may be personally pinned'
        )
        await api.pinChatMessage(locked.conversationId, locked.originalId, true)
        results.lockedPinSetup = {
          conversationId: locked.conversationId,
          messageId: locked.originalId,
          normalAuthenticatedPersonalPinApi: true,
          ciphertextRolesKeysUnchanged: true
        }
      }
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
      await settleAndroidReplyContent(
        m,
        `chat-message-${deep.replyId}`,
        deep.replyBody
      )
      const nodes = flatten(await m.hierarchy())
      const row = nodes.find(node => node.id === `chat-message-${deep.replyId}`)
      assert(
        row != null &&
          !nodes.some(node => node.id === `chat-message-${deep.originalId}`),
        'Actual cold >100 original absence required'
      )
      const quote = strings(flatten(row)).find(
        label =>
          label.startsWith('Jump to message from ') ||
          label === 'Jump to the earlier message this replies to'
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
      await settleAndroidReplyContent(
        m,
        `chat-message-${deep.replyId}`,
        deep.replyBody
      )
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
      await reveal(m, { id: `chat-message-${deep.replyId}` })
      await settleAndroidReplyContent(
        m,
        `chat-message-${deep.replyId}`,
        deep.replyBody
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
      const quote = strings(flatten(row)).find(
        label =>
          label.startsWith('Jump to message from ') ||
          label === 'Jump to the earlier message this replies to'
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
    if (process.argv[2] === 'media-bounds') {
      stage = 'S8-native-image-and-file-containment'
      const inputs = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_MEDIA_BOUNDS_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        pagingReply?: {
          messageId: string
          body: string
          originalId: string
        }
        entries: Array<{
          messageId: string
          fileName?: string
          fileNamePrefix?: string
          contentType: string
          width?: number
          height?: number
        }>
      }
      assert(inputs.entries.length > 0, 'Readable owned media inputs required')
      const measured: Array<Record<string, unknown>> = []
      for (const entry of inputs.entries) {
        const image = entry.contentType.startsWith('image/')
        assert(
          !entry.contentType.startsWith('video/'),
          'Video containment requires its actual playback case'
        )
        assert(
          entry.fileName != null || (image && entry.fileNamePrefix != null),
          'Exact file name or saved image name prefix required'
        )
        const label = image ? entry.fileName : `Save ${entry.fileName}`
        const rowId = `chat-message-${entry.messageId}`
        await scopedOpen(
          inputs.conversationId,
          entry.fileName ?? entry.fileNamePrefix!
        )
        if (!image && inputs.pagingReply != null) {
          const reply = inputs.pagingReply
          const replyId = `chat-message-${reply.messageId}`
          await reveal(m, { text: reply.body })
          await settleAndroidReplyContent(m, replyId, reply.body)
          const identified = flatten(await m.hierarchy()).find(
            node => node.id === replyId
          )
          const quote =
            identified == null
              ? undefined
              : flatten(identified).find(
                  node =>
                    (node.text?.startsWith('Jump to message from ') === true ||
                      node.label?.startsWith('Jump to message from ') ===
                        true) &&
                    node.bounds != null
                )?.bounds
          assert(
            quote != null,
            'Identified current quote rectangle required for older file preparation'
          )
          await m.tapOnPoint({
            point: `${Math.round(quote.x + quote.width / 2)},${Math.round(quote.y + quote.height / 2)}`
          })
          await m.assertVisible({
            id: `chat-message-${reply.originalId}`,
            timeout: 60000
          })
          results.mediaHistoryPreparation = {
            normalShortQuote: true,
            replyId: reply.messageId,
            originalId: reply.originalId
          }
        }
        try {
          await reveal(m, { id: rowId })
        } catch {
          await reveal(m, { text: 'Load earlier messages' }, 'UP')
          await tapStableControl(m, 'Load earlier messages')
          await reveal(m, { id: rowId }, 'UP')
        }
        if (label != null) await reveal(m, { text: label })
        const actual = await until(
          'Exact rendered native media must be fully visible',
          async () => {
            const nodes = flatten(await m.hierarchy())
            const row = nodes.find(node => node.id === rowId)
            const children = row == null ? [] : flatten(row)
            const media = children.find(
              node =>
                ((label != null &&
                  (node.text === label || node.label === label)) ||
                  (entry.fileNamePrefix != null &&
                    (node.text?.startsWith(entry.fileNamePrefix) === true ||
                      node.label?.startsWith(entry.fileNamePrefix) ===
                        true))) &&
                node.bounds != null &&
                (!image ||
                  (node.type?.toLowerCase().includes('image') === true &&
                    node.bounds.width > 20 &&
                    node.bounds.height > 20))
            )
            const bubble = nodes.find(
              node => node.id === `chat-bubble-${entry.messageId}`
            )?.bounds
            const pane = nodes.find(
              node =>
                node.type?.includes('ScrollView') === true &&
                node.bounds != null &&
                flatten(node).some(child => child.id === rowId)
            )?.bounds
            if (media?.bounds == null || bubble == null || pane == null)
              return undefined
            if (
              media.bounds.y < pane.y + 4 ||
              media.bounds.y + media.bounds.height > pane.y + pane.height - 4
            ) {
              const downward = media.bounds.y < pane.y + 4
              const x = Math.round(pane.x + pane.width * 0.5)
              await m.dragAndDrop({
                from: {
                  point: `${x},${Math.round(pane.y + pane.height * (downward ? 0.35 : 0.65))}`
                },
                to: {
                  point: `${x},${Math.round(pane.y + pane.height * (downward ? 0.55 : 0.45))}`
                },
                holdDuration: 10,
                duration: 400
              })
              return undefined
            }
            return {
              media: media.bounds,
              type: media.type,
              actualFileName: media.label ?? media.text,
              bubble,
              pane
            }
          },
          30000
        )
        for (const [name, container] of [
          ['bubble', actual.bubble],
          ['pane', actual.pane]
        ] as const)
          assert(
            actual.media.x >= container.x - 2 &&
              actual.media.y >= container.y - 2 &&
              actual.media.x + actual.media.width <=
                container.x + container.width + 2 &&
              actual.media.y + actual.media.height <=
                container.y + container.height + 2,
            `Rendered native attachment must remain inside its own ${name}`
          )
        measured.push({ ...entry, ...actual, tolerance: 2 })
        results.mediaContainment = measured
        await photo(image ? 'image-bounds-after' : 'file-bounds-after')
      }
      results.mediaContainment = measured
      pass(
        'actual supplied readable attachment rectangles remain inside their message bubble and pane'
      )
      return
    }
    if (process.argv[2] === 'video-record') {
      stage = 'S6-S8-native-video-thumbnail-hold-and-play'
      const video = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_VIDEO_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        videoMessageId: string
        videoCaption: string
        fileName: string
        contentType: string
        normalAttachAndSend: boolean
        encryptedPost: boolean
      }
      assert(
        video.normalAttachAndSend &&
          video.encryptedPost &&
          video.contentType.startsWith('video/'),
        'Normal owned encrypted video fixture required'
      )
      await scopedOpen(video.conversationId, video.videoCaption)
      const rowId = `chat-message-${video.videoMessageId}`
      const openLabel = `Open ${video.fileName}`
      await revealMessage(video.conversationId, video.videoMessageId)
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
        await until('Owned video gesture recorder must be ready', async () =>
          existsSync(required('CHAT_UI_NATIVE_RECORD_READY')) ? true : undefined
        )
      }
      const recordingStartConfirmedAt = Date.now()
      const holdTarget = await prepareVideoThumbnail('hold')
      await photo('video-immediate-pre-hold')
      results.videoPreHoldTarget = {
        row: holdTarget.row,
        bubble: holdTarget.bubble,
        thumbnail: holdTarget.thumbnail,
        pane: holdTarget.pane,
        point: holdTarget.point,
        capturedAt: Date.now(),
        fullVisibleThumbnail: true
      }
      if (platform === 'android')
        await m.swipe({
          startX: holdTarget.point.x,
          startY: holdTarget.point.y,
          endX: holdTarget.point.x,
          endY: holdTarget.point.y,
          duration: 550
        })
      else
        await m.dragAndDrop({
          from: { point: `${holdTarget.point.x},${holdTarget.point.y}` },
          to: { point: `${holdTarget.point.x},${holdTarget.point.y}` },
          holdDuration: 550,
          duration: 10
        })
      const videoHoldMenu = await until(
        'The exact video message Reply action must open after a stationary hold',
        async () => {
          const tree = await m.hierarchy()
          return flatten(tree).some(
            node =>
              (node.text === 'Reply' || node.label === 'Reply') &&
              node.bounds != null
          )
            ? tree
            : undefined
        },
        10000
      )
      writeFileSync(
        join(resultDirectory, `${platform}-video-hold-menu-hierarchy.json`),
        JSON.stringify(videoHoldMenu, null, 2)
      )
      assert(
        !flatten(videoHoldMenu).some(
          node =>
            (node.text === video.fileName || node.label === video.fileName) &&
            node.bounds != null &&
            node.bounds.width > 60 &&
            node.bounds.height > 60
        ),
        'Holding the video thumbnail must not start its native player'
      )
      await photo('video-thumbnail-hold-menu')
      await new Promise(resolve => setTimeout(resolve, 1500))
      await m.tapOnPoint({ point: '5%,15%' })
      await m.assertVisible({ text: openLabel, timeout: 10000 })
      pass(
        'physical video thumbnail hold opens message actions without starting its player'
      )
      await photo('video-after-menu-dismissal')
      async function prepareVideoThumbnail(phase: 'hold' | 'short'): Promise<{
        hierarchy: Hierarchy
        thumbnail: Bounds
        row: Bounds
        bubble: Bounds
        pane: Bounds
        point: { x: number; y: number }
      }> {
        let previousThumbnail: Bounds | undefined
        return await until(
          'Exact video thumbnail must settle fully inside its own message pane',
          async () => {
            const hierarchy = await m.hierarchy()
            const nodes = flatten(hierarchy)
            const row = nodes.find(node => node.id === rowId)
            const bubble = nodes.find(
              node => node.id === `chat-bubble-${video.videoMessageId}`
            )?.bounds
            const pane = nodes.find(
              node =>
                node.type?.includes('ScrollView') === true &&
                node.bounds != null &&
                flatten(node).some(child => child.id === rowId)
            )?.bounds
            const thumbnail = (row == null ? [] : flatten(row)).find(
              node =>
                (node.text === openLabel || node.label === openLabel) &&
                node.bounds != null &&
                node.bounds.width > 60 &&
                node.bounds.height > 60
            )?.bounds
            results[
              phase === 'hold' ? 'videoPreHoldAttempt' : 'videoPreShortAttempt'
            ] = {
              row: row?.bounds,
              bubble,
              thumbnail,
              pane,
              observedAt: Date.now()
            }
            writeFileSync(
              join(
                resultDirectory,
                `${platform}-video-${phase === 'hold' ? 'pre-hold' : 'after-menu-dismissal'}-hierarchy.json`
              ),
              JSON.stringify(hierarchy, null, 2)
            )
            if (
              row?.bounds == null ||
              bubble == null ||
              pane == null ||
              thumbnail == null
            ) {
              if (row?.bounds != null && pane != null && thumbnail == null) {
                const down = row.bounds.y <= pane.y + 8
                const x = Math.round(pane.x + pane.width * 0.5)
                await m.dragAndDrop({
                  from: {
                    point: `${x},${Math.round(pane.y + pane.height * (down ? 0.35 : 0.65))}`
                  },
                  to: {
                    point: `${x},${Math.round(pane.y + pane.height * (down ? 0.55 : 0.45))}`
                  },
                  holdDuration: 10,
                  duration: 400
                })
              }
              previousThumbnail = undefined
              return undefined
            }
            if (
              thumbnail.y < pane.y + 6 ||
              thumbnail.y + thumbnail.height > pane.y + pane.height - 6
            ) {
              const down = thumbnail.y < pane.y + 6
              const x = Math.round(pane.x + pane.width * 0.5)
              await m.dragAndDrop({
                from: {
                  point: `${x},${Math.round(pane.y + pane.height * (down ? 0.35 : 0.65))}`
                },
                to: {
                  point: `${x},${Math.round(pane.y + pane.height * (down ? 0.55 : 0.45))}`
                },
                holdDuration: 10,
                duration: 400
              })
              previousThumbnail = undefined
              return undefined
            }
            assert(
              thumbnail.x >= pane.x - 2 &&
                thumbnail.x + thumbnail.width <= pane.x + pane.width + 2,
              'Gesture thumbnail must be fully inside the horizontal message viewport'
            )
            const left =
              Math.max(thumbnail.x, row.bounds.x, bubble.x, pane.x) + 6
            const right =
              Math.min(
                thumbnail.x + thumbnail.width,
                row.bounds.x + row.bounds.width,
                bubble.x + bubble.width,
                pane.x + pane.width
              ) - 6
            const upper =
              Math.max(thumbnail.y, row.bounds.y, bubble.y, pane.y) + 6
            const lower =
              Math.min(
                thumbnail.y + thumbnail.height,
                row.bounds.y + row.bounds.height,
                bubble.y + bubble.height,
                pane.y + pane.height
              ) - 6
            assert(
              right > left && lower > upper,
              'Video gesture requires a hittable rectangle shared by exact row, bubble, thumbnail and pane'
            )
            const stable =
              previousThumbnail != null &&
              (['x', 'y', 'width', 'height'] as const).every(
                dimension =>
                  Math.abs(
                    previousThumbnail![dimension] - thumbnail[dimension]
                  ) < 1
              )
            previousThumbnail = thumbnail
            return stable
              ? {
                  hierarchy,
                  thumbnail,
                  row: row.bounds,
                  bubble,
                  pane,
                  point: {
                    x: Math.round((left + right) / 2),
                    y: Math.round((upper + lower) / 2)
                  }
                }
              : undefined
          },
          30000
        )
      }
      const shortTarget = await prepareVideoThumbnail('short')
      const thumbnail = shortTarget.thumbnail
      const firstFrame = join(
        resultDirectory,
        `${platform}-video-playing-first.png`
      )
      const secondFrame = join(
        resultDirectory,
        `${platform}-video-playing-second.png`
      )
      const timing: Record<string, number> = {}
      results.videoTiming = timing
      const decodedFraction = (pixels: Buffer): number => {
        let decoded = 0
        for (let index = 0; index < pixels.length; index += 3) {
          const maximum = Math.max(
            pixels[index],
            pixels[index + 1],
            pixels[index + 2]
          )
          const minimum = Math.min(
            pixels[index],
            pixels[index + 1],
            pixels[index + 2]
          )
          if (maximum > 60 && maximum - minimum > 25) decoded++
        }
        return decoded / (pixels.length / 3)
      }
      const currentDecodedFraction = (file: string): number => {
        const dimension = JSON.parse(
          execFileSync(
            required('CHAT_FFPROBE'),
            [
              '-v',
              'error',
              '-show_entries',
              'stream=width',
              '-of',
              'json',
              file
            ],
            { encoding: 'utf8' }
          )
        ) as { streams: Array<{ width: number }> }
        const screenWidth = (results.deviceInfo as { screenWidth: number })
          .screenWidth
        const scale = dimension.streams[0].width / screenWidth
        const x = Math.round((thumbnail.x + thumbnail.width * 0.15) * scale)
        const y = Math.round((thumbnail.y + thumbnail.height * 0.15) * scale)
        const width = Math.round(thumbnail.width * 0.7 * scale)
        const height = Math.round(thumbnail.height * 0.45 * scale)
        return decodedFraction(
          execFileSync(
            required('CHAT_FFMPEG'),
            [
              '-v',
              'error',
              '-i',
              file,
              '-vf',
              `crop=${width}:${height}:${x}:${y},format=rgb24`,
              '-frames:v',
              '1',
              '-f',
              'rawvideo',
              'pipe:1'
            ],
            { maxBuffer: 8 * 1024 * 1024 }
          )
        )
      }
      writeFileSync(
        join(
          resultDirectory,
          `${platform}-video-immediate-pre-short-hierarchy.json`
        ),
        JSON.stringify(shortTarget.hierarchy, null, 2)
      )
      await photo('video-immediate-pre-short')
      results.videoPreShortTarget = {
        row: shortTarget.row,
        bubble: shortTarget.bubble,
        thumbnail,
        pane: shortTarget.pane,
        point: shortTarget.point,
        capturedAt: Date.now(),
        fullVisibleThumbnail: true
      }
      await m.tapOnPoint({
        point: `${shortTarget.point.x},${shortTarget.point.y}`
      })
      timing.shortActivationAt = Date.now()
      // Sample decoded playback directly before native source idle waits can
      // consume the short clip. These screenshots do not query the hierarchy.
      await new Promise(resolve => setTimeout(resolve, 500))
      await until(
        'First playback sample must contain decoded test-pattern pixels',
        async () => {
          writeFileSync(firstFrame, await m.screenshot())
          timing.firstFrameAt = Date.now()
          const fraction = currentDecodedFraction(firstFrame)
          results.videoFirstDecodedFraction = fraction
          return fraction > 0.05 ? true : undefined
        },
        5000
      )
      await new Promise(resolve => setTimeout(resolve, 1000))
      writeFileSync(secondFrame, await m.screenshot())
      timing.secondFrameAt = Date.now()
      results.videoSecondDecodedFraction = currentDecodedFraction(secondFrame)
      assert(
        (results.videoSecondDecodedFraction as number) > 0.05,
        'Second playback sample must contain decoded test-pattern pixels'
      )
      if (platform === 'android') {
        await m.tapOnPoint({
          point: `${Math.round(thumbnail.x + thumbnail.width / 2)},${Math.round(thumbnail.y + thumbnail.height / 2)}`
        })
        timing.pauseGestureAt = Date.now()
      }
      await until(
        'Short video thumbnail activation must open native player',
        async () =>
          flatten(await m.hierarchy()).find(
            node =>
              (node.text === video.fileName || node.label === video.fileName) &&
              node.bounds != null &&
              node.bounds.width > 60 &&
              node.bounds.height > 60
          ),
        30000
      )
      const playerNodes = flatten(await m.hierarchy())
      const bubble = playerNodes.find(
        node => node.id === `chat-bubble-${video.videoMessageId}`
      )?.bounds
      const pane = playerNodes.find(
        node =>
          node.type?.includes('ScrollView') === true &&
          node.bounds != null &&
          flatten(node).some(child => child.id === rowId)
      )?.bounds
      const actualPlayer = playerNodes.find(
        node =>
          (node.text === video.fileName || node.label === video.fileName) &&
          node.bounds != null &&
          node.bounds.width > 60 &&
          node.bounds.height > 60
      )?.bounds
      assert(
        bubble != null && pane != null && actualPlayer != null,
        'Exact native video bubble, pane and player rectangles required'
      )
      for (const dimension of ['x', 'y', 'width', 'height'] as const)
        assert(
          Math.abs(actualPlayer[dimension] - thumbnail[dimension]) <= 2,
          'Playback samples must use the same measured native media rectangle'
        )
      for (const [label, container] of [
        ['bubble', bubble],
        ['pane', pane]
      ] as const) {
        assert(
          actualPlayer.x >= container.x - 2 &&
            actualPlayer.y >= container.y - 2 &&
            actualPlayer.x + actualPlayer.width <=
              container.x + container.width + 2 &&
            actualPlayer.y + actualPlayer.height <=
              container.y + container.height + 2,
          `Opened native video must remain inside its own ${label}`
        )
      }
      results.videoContainment = {
        player: actualPlayer,
        bubble,
        pane,
        tolerance: 2
      }
      const dimension = JSON.parse(
        execFileSync(
          required('CHAT_FFPROBE'),
          [
            '-v',
            'error',
            '-show_entries',
            'stream=width,height',
            '-of',
            'json',
            firstFrame
          ],
          { encoding: 'utf8' }
        )
      ) as { streams: Array<{ width: number; height: number }> }
      const info = (await m.platformInfo()) as { screenWidth: number }
      const scale = dimension.streams[0].width / info.screenWidth
      const bounds = actualPlayer
      const crop = {
        x: Math.round((bounds.x + bounds.width * 0.15) * scale),
        y: Math.round((bounds.y + bounds.height * 0.15) * scale),
        width: Math.round(bounds.width * 0.7 * scale),
        height: Math.round(bounds.height * 0.45 * scale)
      }
      const pixels = (file: string): Buffer =>
        execFileSync(
          required('CHAT_FFMPEG'),
          [
            '-v',
            'error',
            '-i',
            file,
            '-vf',
            `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},format=rgb24`,
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            'pipe:1'
          ],
          { maxBuffer: 8 * 1024 * 1024 }
        )
      const a = pixels(firstFrame)
      const b = pixels(secondFrame)
      assert.equal(a.length, b.length)
      const decodedFractions = [decodedFraction(a), decodedFraction(b)]
      assert(
        decodedFractions.every(value => value > 0.05),
        'Both moving samples must contain decoded test-pattern content, not a loading transition'
      )
      let changed = 0
      for (let index = 0; index < a.length; index += 3)
        if (
          Math.abs(a[index] - b[index]) +
            Math.abs(a[index + 1] - b[index + 1]) +
            Math.abs(a[index + 2] - b[index + 2]) >
          45
        )
          changed++
      const changedFraction = changed / (a.length / 3)
      assert(
        changedFraction > 0.01,
        'Native video must show actual moving decoded content after short activation'
      )
      copyFileSync(
        secondFrame,
        join(artifactDirectory, `${platform}-video-short-native-playing.png`)
      )
      await photo(
        platform === 'android'
          ? 'video-player-bounds-paused'
          : 'video-player-bounds-after-sampling'
      )
      await new Promise(resolve => setTimeout(resolve, 3500))
      await new Promise(resolve =>
        setTimeout(
          resolve,
          Math.max(0, 17500 - (Date.now() - recordingStartConfirmedAt))
        )
      )
      results.recordingTiming = {
        startConfirmedAt: recordingStartConfirmedAt,
        stopRequestedAt: Date.now(),
        elapsedMs: Date.now() - recordingStartConfirmedAt,
        minimumElapsedMs: 17500
      }
      if (recording) {
        await m.stopRecording({
          path: required('CHAT_UI_NATIVE_ANDROID_RECORD_REMOTE')
        })
        recording = false
      }
      writeFileSync(required('CHAT_UI_NATIVE_RECORD_STOP'), 'stop')
      await until(
        'Owned video attachment movie must flush before release',
        async () =>
          existsSync(required('CHAT_UI_NATIVE_RECORD_DONE')) ? true : undefined,
        60000
      )
      results.videoAttachment = {
        messageId: video.videoMessageId,
        normalEncryptedVideo: true,
        holdWithoutPlay: true,
        shortNativePlayer: true,
        playerBounds: bounds,
        movingCrop: crop,
        changedFraction,
        decodedFractions,
        timing,
        firstFrame,
        secondFrame
      }
      pass(
        'ordinary short video activation opens native player and decoded moving video content'
      )
      return
    }
    if (process.argv[2] === 'nested-record') {
      stage = 'S6-S7-native-nested-hold-short-recording'
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
      const replyId = `chat-message-${deep.replyId}`
      await reveal(m, { id: replyId })
      const initial = flatten(await m.hierarchy())
      assert(
        !initial.some(node => node.id === `chat-message-${deep.originalId}`),
        'Recorded short quote must start with its older original unloaded'
      )
      const row = initial.find(node => node.id === replyId)
      const quote =
        row == null
          ? undefined
          : strings(flatten(row)).find(label =>
              label.startsWith('Jump to message from ')
            )
      assert(quote != null, 'Recorded exact reply must expose its quote')
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
        await until('Own nested recording observer must be ready', async () =>
          existsSync(required('CHAT_UI_NATIVE_RECORD_READY')) ? true : undefined
        )
      }
      await physicalMessageHold(m, replyId, quote, 550)
      await m.assertVisible({ text: 'Copy', timeout: 10000 })
      await photo('recorded-nested-quote-hold')
      await new Promise(resolve => setTimeout(resolve, 1500))
      await m.tapOnPoint({ point: '5%,15%' })
      assert(
        !flatten(await m.hierarchy()).some(
          node => node.id === `chat-message-${deep.originalId}`
        ),
        'Nested quote hold must not perform its ordinary short history jump'
      )
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
        'Recorded short quote must display its own original inside the viewport'
      )
      await photo('recorded-nested-quote-short-jump')
      await new Promise(resolve => setTimeout(resolve, 1500))
      const fileId = `chat-message-${deep.attachmentId}`
      await reveal(m, { id: fileId }, 'DOWN')
      await physicalMessageHold(m, fileId, `Save ${deep.fileName}`, 550)
      await m.assertVisible({ text: 'Reply', timeout: 10000 })
      await m.assertNotVisible({ text: 'Copy', timeout: 1000 })
      await photo('recorded-nested-file-hold')
      await new Promise(resolve => setTimeout(resolve, 1500))
      await m.tapOnPoint({ point: '5%,15%' })
      await tapVisibleControl(m, `Save ${deep.fileName}`)
      await until(
        'Recorded short file must reach its native system opener',
        async () => {
          const labels = strings(flatten(await m.hierarchy()))
          return platform === 'ios'
            ? labels.includes('Text Document') || labels.includes('Quick Look')
              ? true
              : undefined
            : labels.some(
                  label =>
                    label.includes(deep.fileBytes.trim()) ||
                    ['Open with', 'Chrome', 'HTML Viewer'].includes(label)
                )
              ? true
              : undefined
        }
      )
      await photo('recorded-nested-file-short-system-open')
      await new Promise(resolve => setTimeout(resolve, 2000))
      if (recording) {
        await m.stopRecording({
          path: required('CHAT_UI_NATIVE_ANDROID_RECORD_REMOTE')
        })
        recording = false
      }
      writeFileSync(required('CHAT_UI_NATIVE_RECORD_STOP'), 'stop')
      await until(
        'Own nested movie must flush before releasing this simulator',
        async () =>
          existsSync(required('CHAT_UI_NATIVE_RECORD_DONE')) ? true : undefined,
        60000
      )
      results.nestedRecording = {
        quoteHold: true,
        quoteShortJump: true,
        attachmentHold: true,
        attachmentShortSystemOpen: true,
        originalInitiallyUnloaded: true
      }
      pass(
        'recorded physical quote/file holds and preserved short quote jump/system file activation'
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
      await reveal(m, { id: `chat-message-${deep.replyId}` })
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
      await reveal(m, { id: replyId })
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
      const attachmentReplyInitiallyPinned = (
        await api.chatPins(deep.conversationId)
      ).some(row => row.messageId === deep.attachmentReplyId)
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
      // Keep a normal jump back to both current replies before paging far away.
      if (process.argv[2] === 'deep') {
        await revealMessage(deep.conversationId, deep.attachmentReplyId)
        if (!attachmentReplyInitiallyPinned) {
          await physicalMessageHold(
            m,
            `chat-message-${deep.attachmentReplyId}`,
            deep.attachmentReplyBody,
            550
          )
          await tapStableControl(m, 'Pin')
          await until(
            'Temporary current attachment reply pin must persist',
            async () =>
              (await api.chatPins(deep.conversationId)).some(
                row => row.messageId === deep.attachmentReplyId
              )
                ? true
                : undefined
          )
        }
        const currentCount = (await api.chatPins(deep.conversationId)).length
        await tapStableControl(m, `Pinned messages: ${currentCount}`)
        await tapStableControl(m, deep.replyBody)
        await m.assertVisible({ id: replyId, timeout: 30000 })
        results.deepCurrentReplyPinSetup = {
          normalUiOnly: true,
          olderOriginalPinned: false,
          longReplyInitiallyPinned: initiallyPinned,
          attachmentReplyInitiallyPinned,
          currentReplyIds: [deep.replyId, deep.attachmentReplyId]
        }
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
      const attachmentCount = (await api.chatPins(deep.conversationId)).length
      await tapStableControl(m, `Pinned messages: ${attachmentCount}`)
      await tapStableControl(m, deep.attachmentReplyBody)
      await m.assertVisible({
        id: `chat-message-${deep.attachmentReplyId}`,
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
      if (!attachmentReplyInitiallyPinned) {
        const remainingCount = (await api.chatPins(deep.conversationId)).length
        await tapStableControl(m, `Pinned messages: ${remainingCount}`)
        await tapStableControl(m, deep.attachmentReplyBody)
        await physicalMessageHold(
          m,
          `chat-message-${deep.attachmentReplyId}`,
          deep.attachmentReplyBody,
          550
        )
        await tapStableControl(m, 'Unpin')
        await until(
          'Temporary attachment reply pin must be restored',
          async () =>
            !(await api.chatPins(deep.conversationId)).some(
              row => row.messageId === deep.attachmentReplyId
            )
              ? true
              : undefined
        )
      }
      const restoredPins = await api.chatPins(deep.conversationId)
      assert.equal(
        restoredPins.some(pin => pin.messageId === deep.replyId),
        initiallyPinned,
        'Temporary current long reply pin must match its initial state'
      )
      assert.equal(
        restoredPins.some(pin => pin.messageId === deep.attachmentReplyId),
        attachmentReplyInitiallyPinned,
        'Temporary current attachment reply pin must match its initial state'
      )
      results.deepCurrentReplyPinCleanup = {
        normalUiOnly: true,
        longReplyRestored: true,
        attachmentReplyRestored: true,
        attachmentQuoteLabel: attachmentQuote,
        attachmentJumpTargetId: deep.attachmentId
      }
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
      const owned = JSON.parse(
        readFileSync(required('CHAT_UI_NATIVE_OWNED_FIXTURE'), 'utf8')
      ) as {
        conversationId: string
        originalId: string
        originalBody: string
        selfReplyId: string
        selfReplyBody: string
        pinnedBeforeDelete: boolean
        synthetic: boolean
        authorUserId: string
        preparePersonalPin?: boolean
      }
      assert(
        owned.synthetic &&
          !fixture.originalMessageIds.includes(owned.originalId),
        'Only a new synthetic disposable post may be used for author deletion'
      )
      const protectedDeep = JSON.parse(
        readFileSync(
          process.env.CHAT_UI_NATIVE_PROTECTED_HISTORY_FIXTURE ??
            required('CHAT_UI_NATIVE_DEEP_FIXTURE'),
          'utf8'
        )
      ) as {
        originalId: string
        attachmentId: string
        replyId: string
        attachmentReplyId: string
      }
      assert(
        ![
          protectedDeep.originalId,
          protectedDeep.attachmentId,
          protectedDeep.replyId,
          protectedDeep.attachmentReplyId
        ].includes(owned.originalId),
        'Protected deep original and attachment must never be deletion fixtures'
      )
      const listed = (await api.chatConversations()).find(
        item => item.id === owned.conversationId
      )
      assert(listed != null, 'New disposable post scope must be accessible')
      const originalEnvelope = (
        await api.chatMessages(owned.conversationId, {
          after: Math.max(0, listed.lastSeq - 100)
        })
      ).find(message => message.id === owned.originalId)
      assert(
        originalEnvelope?.kind === 'post' &&
          originalEnvelope.clearedAt == null &&
          originalEnvelope.senderUserId === owned.authorUserId,
        'New disposable original must remain an undeleted post of the supplied normal author'
      )
      await scopedOpen(owned.conversationId, owned.selfReplyBody)
      await reveal(m, { id: `chat-message-${owned.originalId}` })
      await m.assertVisible({ text: owned.originalBody, timeout: 30000 })
      await reveal(m, { id: `chat-message-${owned.selfReplyId}` }, 'DOWN')
      const initialReply = flatten(await m.hierarchy()).find(
        node => node.id === `chat-message-${owned.selfReplyId}`
      )
      assert(initialReply != null, 'Exact owned self reply must be accessible')
      assert(
        strings(flatten(initialReply)).some(
          label =>
            label.startsWith('Jump to message from ') &&
            label.includes(owned.originalBody)
        ),
        'Native readable reply must expose its current original snippet'
      )
      if (owned.preparePersonalPin === true) {
        await physicalMessageHold(
          m,
          `chat-message-${owned.originalId}`,
          owned.originalBody,
          550
        )
        const alreadyPinned = (await api.chatPins(owned.conversationId)).some(
          pin => pin.messageId === owned.originalId
        )
        if (alreadyPinned) await m.tapOnPoint({ point: '5%,15%' })
        else await tapVisibleControl(m, 'Pin')
        await until(
          'New received disposable post must be personally pinned through UI',
          async () =>
            (await api.chatPins(owned.conversationId)).some(
              pin => pin.messageId === owned.originalId
            )
              ? true
              : undefined
        )
      }
      const pinCount = (await api.chatPins(owned.conversationId)).length
      assert(
        (await api.chatPins(owned.conversationId)).some(
          pin => pin.messageId === owned.originalId
        ),
        'Same-user prepared pin must reach this installation'
      )
      await photo('owned-self-reply-readable')
      const presentation =
        process.env.CHAT_UI_NATIVE_DELETE_PRESENTATION ?? 'list'
      assert(
        ['list', 'menu'].includes(presentation),
        'Explicit pin list or message menu observation required'
      )
      if (presentation === 'list') {
        await tapVisibleControl(m, `Pinned messages: ${pinCount}`)
        await m.assertVisible({ text: 'Pinned messages', timeout: 10000 })
        await m.assertVisible({ text: owned.originalBody, timeout: 10000 })
        await photo('owned-pin-list-before-delete')
      } else {
        await physicalMessageHold(
          m,
          `chat-message-${owned.originalId}`,
          owned.originalBody,
          550
        )
        await m.assertVisible({ text: 'Unpin', timeout: 10000 })
        await photo('owned-pin-menu-before-delete')
      }
      writeFileSync(
        required('CHAT_UI_NATIVE_READY_SIGNAL'),
        JSON.stringify(
          {
            platform,
            conversationId: owned.conversationId,
            originalId: owned.originalId,
            selfReplyId: owned.selfReplyId,
            ready: true,
            presentation,
            pinListOpen: presentation === 'list',
            messageMenuOpen: presentation === 'menu',
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
        'Open native pin list/menu must discard deleted original preview',
        async () => {
          const labels = strings(flatten(await m.hierarchy()))
          return !labels.includes(owned.originalBody) &&
            (presentation === 'list' || !labels.includes('Copy'))
            ? true
            : undefined
        },
        30000
      )
      await photo(`owned-pin-${presentation}-live-purge`)
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
        snapshotSuppressed: true,
        presentation
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
      const initialSeq = (await current()).lastSeq
      const newPosts = async (): Promise<string[]> =>
        (
          await api.chatMessages(fixture.conversationId, {
            after: initialSeq,
            limit: 100
          })
        )
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
      assert.deepEqual(await newPosts(), [], 'Native newline must not send')
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
        await newPosts(),
        [],
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
          await newPosts(),
          [],
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
    if (['reply-probe', 'reply-capture'].includes(process.argv[2])) {
      stage = 'S7-exact-row-reply'
      await open()
      const draftBefore = await composerValue(m)
      const rowId = `chat-message-${fixture.originalMessageIds[0]}`
      await physicalMessageHold(m, rowId, fixture.targetText, 550)
      await m.assertVisible({ text: 'Reply', timeout: 10000 })
      await tapStableControl(m, 'Reply')
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
      await m.assertVisible({ text: 'Cancel reply', timeout: 10000 })
      await photo(
        process.argv[2] === 'reply-capture' ? 'replies-after' : 'reply-probe'
      )
      assert(
        context != null,
        'Replying to the exact original message row must open composer context'
      )
      await tapVisibleControl(m, 'Cancel reply')
      assert.equal(
        await composerValue(m),
        draftBefore,
        'Cancel must preserve the current draft exactly'
      )
      pass(
        'exact original native row Reply opens composer preview/Cancel and Cancel preserves the draft'
      )
      return
    }
    if (process.argv[2] === 'return-key') {
      stage = 'native-explicit-return-key'
      await scopedOpen(fixture.conversationId, fixture.targetText)
      const prior = await composerValue(m)
      const before = await current()
      assert(
        before.canPost && !before.locked && !before.closed,
        'Explicit Return test requires a normal writable retained conversation'
      )
      const marker = `Native key ${Date.now()}`
      await m.tapOn({ id: 'chat-composer' })
      if (prior.length > 0) await clearNativeComposer(m, prior)
      await m.inputText({ text: marker })
      const keyPressedAt = Date.now()
      await m.pressKey({ key: 'ENTER' })
      await m.inputText({ text: 'Next line' })
      const expected = marker + '\nNext line'
      assert.equal(
        await composerValue(m),
        expected,
        'A documented native Enter key must insert a newline without sending'
      )
      const posts = (
        await api.chatMessages(fixture.conversationId, {
          after: before.lastSeq,
          limit: 100
        })
      ).filter(row => row.kind === 'post')
      assert.equal(
        posts.length,
        0,
        'The native Enter key must create no encrypted post'
      )
      await photo('explicit-native-return-newline')
      if (platform === 'android') {
        // The optimized accessibility Clear command can leave a controlled
        // native input unchanged; real Delete keys retain normal edit events.
        let deleteKeys = expected.length
        while (deleteKeys-- > 0) await m.pressKey({ key: 'BACKSPACE' })
      } else await m.eraseText({ characters: expected.length })
      if (prior !== '') await m.inputText({ text: prior })
      assert.equal(
        await composerValue(m),
        prior,
        'Explicit Return test must restore its prior unsent draft'
      )
      results.explicitReturn = {
        documentedMaestroKey: 'ENTER',
        keyPressedAt,
        newlineInserted: true,
        newPostCount: 0,
        priorDraftRestored: true,
        conversationId: fixture.conversationId,
        actorUserId: fixture.actor.userId
      }
      pass(
        'documented native Enter inserts a newline, creates no encrypted post and restores the prior draft'
      )
      return
    }
    if (process.argv[2] === 'reply-send') {
      stage = 'native-current-reply-send-and-own-permissions'
      assert(fixture.nativeReplyText != null, 'Private reply text is required')
      await open()
      const originalId = fixture.originalMessageIds[0]
      await physicalMessageHold(
        m,
        `chat-message-${originalId}`,
        fixture.targetText,
        550
      )
      await tapStableControl(m, 'Reply')
      await m.assertVisible({ text: 'Cancel reply', timeout: 10000 })
      const body = `${fixture.nativeReplyText} ${Date.now()}`
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: 8192 })
      await m.inputText({ text: body })
      const before = await current()
      await tapStableControl(m, 'Send')
      await m.assertVisible({ text: body, timeout: 60000 })
      const acknowledged = await until(
        'The unique own native reply must be acknowledged',
        async () => {
          const next = await current()
          return next.lastPostId !== before.lastPostId &&
            next.lastSeq > before.lastSeq
            ? next
            : undefined
        }
      )
      const added = await api.chatMessages(fixture.conversationId, {
        after: before.lastSeq,
        limit: 100
      })
      const posts = added.filter(row => row.kind === 'post')
      assert.equal(
        posts.length,
        1,
        'One native reply press must create exactly one new encrypted post'
      )
      assert.equal(posts[0].senderUserId, fixture.actor.userId)
      assert.equal(posts[0].id, acknowledged.lastPostId)
      assert.equal(
        await composerValue(m),
        '',
        'Successful native reply must clear only its submitted text'
      )
      await m.assertNotVisible({ text: 'Cancel reply', timeout: 1000 })
      assert(
        !JSON.stringify(added).includes(body),
        'Native reply plaintext must be absent from authenticated envelopes'
      )
      await revealMessage(fixture.conversationId, posts[0].id)
      await physicalMessageHold(m, `chat-message-${posts[0].id}`, body, 550)
      for (const action of ['Reply', 'Copy', 'Delete'])
        await m.assertVisible({ text: action, timeout: 10000 })
      await m.assertNotVisible({ text: 'Edit', timeout: 1000 })
      await photo('own-message-actions-after')
      await m.tapOnPoint({ point: '5%,15%' })
      results.replySend = {
        beforeSeq: before.lastSeq,
        afterSeq: acknowledged.lastSeq,
        newPostId: posts[0].id,
        newPostCount: posts.length,
        senderMatches: true,
        submittedTextAndContextCleared: true,
        ownDeleteAvailable: true,
        editUnavailable: true,
        protectedPostsNotDeleted: true
      }
      pass(
        'one unique encrypted native reply clears its submitted draft and exposes the allowed own-message actions'
      )
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
        await revealMessage(fixture.conversationId, originalId)
        await physicalMessageHold(
          m,
          `chat-message-${originalId}`,
          fixture.targetText,
          duration
        )
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
      else await m.assertVisible({ text: 'Delete', timeout: 10000 })
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
      await reveal(
        m,
        { id: `chat-message-${fixture.originalMessageIds[1]}` },
        'DOWN'
      )
      await m.assertVisible({ text: fixture.replyText })
      await physicalMessageHold(
        m,
        `chat-message-${originalId}`,
        fixture.targetText,
        550
      )
      await tapVisibleControl(m, 'Reply')
      await m.assertVisible({ text: 'Cancel reply', timeout: 10000 })
      await photo('replies-after')
      await tapVisibleControl(m, 'Cancel reply')
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
        if (emoji === '❤️') {
          await physicalMessageHold(
            m,
            `chat-message-${originalId}`,
            `${emoji}, 1`,
            550
          )
          await until(
            'Nested reaction hold must select its message',
            async () => {
              const labels = strings(flatten(await m.hierarchy()))
              return labels.includes('Copy') && labels.includes('Reply')
                ? true
                : undefined
            },
            10000
          )
          await photo('reaction-chip-hold-actions')
          await m.tapOnPoint({ point: '5%,15%' })
          assert(
            strings(flatten(await m.hierarchy())).includes(`${emoji}, 1`),
            'Holding the reaction chip must not perform its short toggle'
          )
          pass(
            'physical nested reaction hold selects the message without toggling its reaction'
          )
        }
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
      const beforeReply = await current()
      const previous = beforeReply.lastPostId
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
      const envelopes = await api.chatMessages(fixture.conversationId, {
        after: beforeReply.lastSeq,
        limit: 100
      })
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
          originalMessages.some(row => row.id === id)
        ),
        'Original post and reply IDs preserved by native actions'
      )
      assert(
        !JSON.stringify(envelopes).includes(fixture.nativeReplyText),
        'Reply plaintext must be absent from authenticated API envelopes'
      )
      results.nativeReplyPostId = (await current()).lastPostId
      const ownReplyId = results.nativeReplyPostId as string
      await revealMessage(fixture.conversationId, ownReplyId)
      await physicalMessageHold(
        m,
        `chat-message-${ownReplyId}`,
        fixture.nativeReplyText,
        550
      )
      for (const action of ['Reply', 'Copy', 'Delete'])
        await m.assertVisible({ text: action, timeout: 10000 })
      await m.assertNotVisible({ text: 'Edit', timeout: 1000 })
      results.messagePermissionMatrix = {
        receivedDeleteAvailable: target.canModerate,
        ownDeleteAvailable: true,
        editUnavailable: true,
        protectedMessagesNotDeleted: true
      }
      await photo('own-message-actions-after')
      await m.tapOnPoint({ point: '5%,15%' })
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
      const readingPath = process.env.CHAT_UI_NATIVE_READING_FIXTURE
      const reading =
        readingPath == null
          ? undefined
          : (JSON.parse(readFileSync(readingPath, 'utf8')) as {
              conversationId: string
              firstMessageId: string
              firstBody: string
              followingMessageId: string
              followingBody: string
              expectedFirstRowHeight?: number
            })
      console.log(
        '$ S4 retain native message position and independent drafts across Back and conversation switch'
      )
      async function dismissKeyboard(): Promise<void> {
        if (platform === 'ios') {
          let raw = Buffer.from(await m.hierarchyRaw()).toString('utf8')
          if (raw.includes('<XCUIElementTypeKeyboard ')) {
            // WDA hideKeyboard inserts Return in multiline inputs. Normal
            // Back/reopen blurs the composer before measuring reading position.
            await tapVisibleControl(m, 'Back')
            await scopedOpen(dm!.id, candidate!.shortName)
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
          (reading == null || row.id === reading.conversationId) &&
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
      await scopedOpen(dm.id, candidate.shortName)
      await m.assertVisible({ id: 'chat-composer', timeout: 60000 })
      const longPost = `Native retention ${Date.now()}\n${Array.from(
        { length: 24 },
        (_, index) => `${fixture.probePost} ${index + 1}`
      ).join('\n')}`
      const top = process.argv[2] === 'top-retention'
      let anchorId: string
      let spacerId: string | undefined
      const spacerBody = `Reading spacer ${Date.now()}\n${Array.from({ length: 6 }, (_, index) => `Spacer line ${index + 1}`).join('\n')}`
      if (!top) {
        const previousPostId = dm.lastPostId
        await m.tapOn({ id: 'chat-composer' })
        await m.inputText({ text: longPost })
        await m.tapOn({ text: 'Send' })
        const acknowledged = await until(
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
        anchorId = acknowledged.lastPostId!
        await reveal(m, { id: `chat-message-${anchorId}` }, 'DOWN')
        await m.assertVisible({ text: longPost, timeout: 10000 })
      } else {
        let first = (await api.chatMessages(dm.id)).find(
          message => message.kind === 'post' && message.clearedAt == null
        )
        if (first == null) {
          const marker = `Zero reading marker ${Date.now()}`
          await m.tapOn({ id: 'chat-composer' })
          await m.inputText({ text: marker })
          await tapVisibleControl(m, 'Send')
          const posted = await until(
            'Normal owned zero marker must be delivered',
            async () => {
              const row = (await api.chatConversations()).find(
                item => item.id === dm.id
              )
              return row?.lastPostId != null ? row : undefined
            }
          )
          first = (await api.chatMessages(dm.id)).find(
            message => message.id === posted.lastPostId
          )
        }
        assert(
          first != null,
          'Existing readable first post required for explicit-zero proof'
        )
        anchorId = first.id
        if (reading != null)
          assert.equal(
            anchorId,
            reading.firstMessageId,
            'Exact existing first post required for zero-position reproduction'
          )
        await dismissKeyboard()
        const previousId = (await api.chatConversations()).find(
          item => item.id === dm.id
        )?.lastPostId
        if (
          reading == null ||
          process.env.CHAT_UI_NATIVE_READING_APPEND === '1'
        ) {
          const padding = `Zero reading padding ${Date.now()}\n${Array.from({ length: 36 }, (_, index) => `Owned padding line ${index + 1}`).join('\n')}`
          await m.tapOn({ id: 'chat-composer' })
          await m.inputText({ text: padding })
          await tapVisibleControl(m, 'Send')
          await until(
            'Normal zero fixture must have enough content to distinguish top from newest',
            async () => {
              const row = (await api.chatConversations()).find(
                item => item.id === dm.id
              )
              return row?.lastPostId != null && row.lastPostId !== previousId
                ? row
                : undefined
            }
          )
        }
      }
      await dismissKeyboard()
      if (!top && platform === 'android') {
        await m.tapOn({ id: 'chat-composer' })
        await m.inputText({ text: spacerBody })
        await tapVisibleControl(m, 'Send')
        const spacer = await until(
          'Normal owned spacer post must be acknowledged',
          async () => {
            const row = (await api.chatConversations()).find(
              item => item.id === dm.id
            )
            return row?.lastPostId != null && row.lastPostId !== anchorId
              ? row
              : undefined
          }
        )
        spacerId = spacer.lastPostId!
        await dismissKeyboard()
      }
      results.retentionFixture = {
        conversationId: dm.id,
        anchorId,
        spacerId,
        top
      }
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: fixture.draft })
      await dismissKeyboard()
      if (top) {
        if (reading != null) {
          await until(
            'Exact first body must reach explicit zero through the message pane',
            async () => {
              const nodes = flatten(await m.hierarchy())
              const pane = nodes.find(
                node =>
                  node.type?.includes('ScrollView') === true &&
                  node.bounds != null &&
                  flatten(node).some(
                    child => child.id?.startsWith('chat-message-') === true
                  )
              )?.bounds
              assert(
                pane != null,
                'Actual message pane required for explicit-zero preparation'
              )
              const row = nodes.find(
                node => node.id === `chat-message-${anchorId}`
              )
              const body =
                row == null
                  ? undefined
                  : flatten(row).find(
                      node =>
                        node.text === reading.firstBody ||
                        node.label === reading.firstBody
                    )?.bounds
              if (
                body != null &&
                body.height > 0 &&
                body.y >= pane.y &&
                row?.bounds != null &&
                row.bounds.y >= pane.y &&
                (reading.expectedFirstRowHeight == null ||
                  row.bounds.height >= reading.expectedFirstRowHeight - 2) &&
                row.bounds.y - pane.y < 40
              )
                return true
              const x = Math.round(pane.x + pane.width * 0.5)
              await m.dragAndDrop({
                from: {
                  point: `${x},${Math.round(pane.y + pane.height * 0.25)}`
                },
                to: { point: `${x},${Math.round(pane.y + pane.height * 0.8)}` },
                holdDuration: 10,
                duration: 400
              })
              return undefined
            },
            90000
          )
        } else {
          await reveal(m, { id: `chat-message-${anchorId}` })
          for (let index = 0; index < 3; index += 1)
            await m.swipe({ direction: 'DOWN', duration: 600 })
        }
      } else if (spacerId != null) {
        await reveal(m, { id: `chat-message-${spacerId}` }, 'DOWN')
        const nodes = flatten(await m.hierarchy())
        const viewport = nodes.find(
          node =>
            node.type?.includes('ScrollView') === true &&
            node.bounds != null &&
            flatten(node).some(child => child.id === `chat-message-${spacerId}`)
        )?.bounds
        assert(
          viewport != null,
          'Actual message pane required for spacer reading preparation'
        )
        const x = Math.round(viewport.x + viewport.width * 0.5)
        await m.dragAndDrop({
          from: {
            point: `${x},${Math.round(viewport.y + viewport.height * 0.3)}`
          },
          to: {
            point: `${x},${Math.round(viewport.y + viewport.height * 0.47)}`
          },
          holdDuration: 10,
          duration: 400
        })
      } else await m.swipe({ direction: 'DOWN', duration: 600 })
      if (top && reading != null) {
        const paneNow = async (): Promise<Bounds> =>
          await until(
            'Same actual message pane required',
            async () =>
              flatten(await m.hierarchy()).find(
                node =>
                  node.type?.includes('ScrollView') === true &&
                  node.bounds != null &&
                  flatten(node).some(
                    child => child.id?.startsWith('chat-message-') === true
                  )
              )?.bounds
          )
        const pullToBoundary = async (): Promise<void> => {
          const pane = await paneNow()
          const x = Math.round(pane.x + pane.width * 0.5)
          await m.dragAndDrop({
            from: { point: `${x},${Math.round(pane.y + pane.height * 0.25)}` },
            to: { point: `${x},${Math.round(pane.y + pane.height * 0.8)}` },
            holdDuration: 10,
            duration: 400
          })
        }
        await pullToBoundary()
        await pullToBoundary()
        if (process.env.CHAT_UI_NATIVE_READING_WARM === '1') {
          const pane = await paneNow()
          const x = Math.round(pane.x + pane.width * 0.5)
          const from = { x, y: Math.round(pane.y + pane.height * 0.65) }
          const to = { x, y: Math.round(pane.y + pane.height * 0.54) }
          await m.dragAndDrop({
            from: { point: `${from.x},${from.y}` },
            to: { point: `${to.x},${to.y}` },
            holdDuration: 10,
            duration: 400
          })
          await new Promise(resolve => setTimeout(resolve, 800))
          results.zeroWarmPreparation = {
            pane,
            from,
            to,
            at: Date.now(),
            rows: flatten(await m.hierarchy())
              .filter(
                node =>
                  node.id === `chat-message-${reading.firstMessageId}` ||
                  node.id === `chat-message-${reading.followingMessageId}`
              )
              .map(node => ({ id: node.id, bounds: node.bounds }))
          }
          await tapVisibleControl(m, 'Back')
          await scopedOpen(fixture.conversationId, fixture.targetText)
          await tapVisibleControl(m, 'Back')
          await scopedOpen(dm.id, candidate.shortName)
          await dismissKeyboard()
          for (let index = 0; index < 3; index++)
            await m.swipe({ direction: 'DOWN', duration: 600 })
        }
      }
      await new Promise(resolve => setTimeout(resolve, 800))
      const beforeNodes = flatten(await m.hierarchy())
      const anchorRow = beforeNodes.find(
        node => node.id === `chat-message-${anchorId}`
      )
      const anchor = top
        ? anchorRow
        : anchorRow == null
          ? undefined
          : flatten(anchorRow).find(
              node => node.text === longPost || node.label === longPost
            )
      assert(
        anchor?.bounds != null,
        'Scroll fixture message must expose native bounds'
      )
      const beforeY = anchor.bounds.y
      const firstBodyBefore =
        reading == null || anchorRow == null
          ? undefined
          : flatten(anchorRow).find(
              node =>
                node.text === reading.firstBody ||
                node.label === reading.firstBody
            )?.bounds
      const followingBefore =
        reading == null
          ? undefined
          : beforeNodes.find(
              node => node.id === `chat-message-${reading.followingMessageId}`
            )?.bounds
      const messageViewport = beforeNodes.find(
        node =>
          node.type?.includes('ScrollView') === true &&
          node.bounds != null &&
          flatten(node).some(child => child.id === `chat-message-${anchorId}`)
      )?.bounds
      assert(messageViewport != null, 'Actual native message viewport required')
      if (reading != null) {
        assert(
          firstBodyBefore != null && followingBefore != null,
          'Exact first body and following row must be visible before zero-position switch'
        )
        assert(
          firstBodyBefore.y >= messageViewport.y &&
            firstBodyBefore.y + firstBodyBefore.height <=
              messageViewport.y + messageViewport.height,
          'Zero-position proof requires the complete first body inside the pane'
        )
        results.zeroReadingGeometry = { firstBodyBefore, followingBefore }
      }
      const spacer =
        spacerId == null
          ? undefined
          : beforeNodes.find(node => node.id === `chat-message-${spacerId}`)
      const spacerText =
        spacer == null
          ? undefined
          : flatten(spacer).find(
              node => node.text === spacerBody || node.label === spacerBody
            )?.bounds
      assert(
        top
          ? beforeY >= messageViewport.y && beforeY - messageViewport.y < 40
          : spacerId != null
            ? beforeY <= messageViewport.y + 2 &&
              spacerText != null &&
              spacerText.y > messageViewport.y + 40 &&
              spacerText.y < messageViewport.y + messageViewport.height - 40
            : beforeY < messageViewport.y,
        top
          ? 'Explicit zero must show the first post at the top of its message viewport'
          : 'Positive reading proof must start partway through the unique long post'
      )
      results.messageOffsetAnchor = {
        messageId: anchorId,
        beforeY,
        messageHeight: anchor.bounds.height,
        beforeComposer: beforeNodes.find(node => node.id === 'chat-composer')
          ?.bounds,
        settledMs: 800,
        explicitZero: top,
        messageViewport,
        spacerId,
        spacerBefore: spacerText
      }
      await photo(`${top ? 'top-' : ''}scroll-retention-before-switch`)
      if (process.env.CHAT_UI_NATIVE_DIAGNOSTIC_CHECKPOINT === '1') {
        writeFileSync(
          join(resultDirectory, `${platform}-immediate-before-back.png`),
          await m.screenshot()
        )
        const snapshotStartedAt = Date.now()
        const nodes = flatten(await m.hierarchy())
        const row = nodes.find(node => node.id === `chat-message-${anchorId}`)
        const body = top
          ? row
          : row == null
            ? undefined
            : flatten(row).find(
                node => node.text === longPost || node.label === longPost
              )
        const back = nodes.find(
          node =>
            (node.text === 'Back' || node.label === 'Back') &&
            node.bounds != null
        )?.bounds
        assert(
          back != null && body?.bounds != null,
          'Immediate real Back/anchor bounds required for diagnostic'
        )
        results.immediateBeforeBack = {
          snapshotStartedAt,
          snapshotCompletedAt: Date.now(),
          messageId: anchorId,
          body: body.bounds,
          row: row?.bounds,
          composer: nodes.find(node => node.id === 'chat-composer')?.bounds,
          back
        }
        await m.tapOnPoint({
          point: `${Math.round(back.x + back.width / 2)},${Math.round(back.y + back.height / 2)}`
        })
        results.actualBackCompletedAt = Date.now()
      } else await tapVisibleControl(m, 'Back')
      await scopedOpen(fixture.conversationId, fixture.targetText)
      assert(
        !(await composerValue(m)).includes(fixture.draft),
        'A different conversation must not inherit the DM draft'
      )
      await tapVisibleControl(m, 'Back')
      await scopedOpen(dm.id, candidate.shortName)
      await m.assertVisible({ id: 'chat-composer', timeout: 60000 })
      await dismissKeyboard()
      assert(
        (await composerValue(m)).includes(fixture.draft),
        'The DM must restore its own unsent draft after switching'
      )
      await new Promise(resolve => setTimeout(resolve, 800))
      const afterNodes = flatten(await m.hierarchy())
      const afterRow = afterNodes.find(
        node => node.id === `chat-message-${anchorId}`
      )
      const afterAnchor = top
        ? afterRow
        : afterRow == null
          ? undefined
          : flatten(afterRow).find(
              node => node.text === longPost || node.label === longPost
            )
      assert(
        afterAnchor?.bounds != null,
        'Restored scroll fixture anchor must remain available'
      )
      results.messageOffsetAnchor = {
        ...(results.messageOffsetAnchor as object),
        afterY: afterAnchor.bounds.y,
        afterComposer: afterNodes.find(node => node.id === 'chat-composer')
          ?.bounds,
        delta: afterAnchor.bounds.y - beforeY
      }
      if (reading != null) {
        const firstBodyAfter =
          afterRow == null
            ? undefined
            : flatten(afterRow).find(
                node =>
                  node.text === reading.firstBody ||
                  node.label === reading.firstBody
              )?.bounds
        const followingAfter = afterNodes.find(
          node => node.id === `chat-message-${reading.followingMessageId}`
        )?.bounds
        results.zeroReadingGeometry = {
          ...(results.zeroReadingGeometry as object),
          firstBodyAfter,
          followingAfter
        }
        assert(
          firstBodyAfter != null &&
            followingAfter != null &&
            firstBodyBefore != null &&
            followingBefore != null,
          'The complete first body and same following row must remain after reopening zero position'
        )
        assert(
          Math.abs(firstBodyAfter.y - firstBodyBefore.y) <= 10 &&
            Math.abs(firstBodyAfter.height - firstBodyBefore.height) <= 2,
          'Zero restoration must preserve full first-body bounds rather than a clipped row anchor'
        )
        assert(
          Math.abs(followingAfter.y - followingBefore.y) <= 10,
          'Zero restoration must preserve the same following-bubble boundary'
        )
      }
      assert(
        Math.abs(afterAnchor.bounds.y - beforeY) <= 10,
        'Conversation switch must restore the same message position'
      )
      if (spacerId != null) {
        const afterSpacer = afterNodes.find(
          node => node.id === `chat-message-${spacerId}`
        )
        const afterSpacerText =
          afterSpacer == null
            ? undefined
            : flatten(afterSpacer).find(
                node => node.text === spacerBody || node.label === spacerBody
              )?.bounds
        assert(
          afterSpacerText != null && spacerText != null,
          'Same visible spacer must remain after restoring the unique clipped target'
        )
        results.messageOffsetAnchor = {
          ...(results.messageOffsetAnchor as object),
          afterHeight: afterAnchor.bounds.height,
          spacerAfter: afterSpacerText
        }
        assert(
          Math.abs(afterSpacerText.y - spacerText.y) <= 10 &&
            Math.abs(afterAnchor.bounds.height - anchor.bounds.height) <= 10,
          'Clipped native target and its visible spacer boundary must retain the exact reading position'
        )
      }
      await photo(`${top ? 'top-' : ''}scroll-retention-after-switch`)
      await m.tapOn({ id: 'chat-composer' })
      await m.eraseText({ characters: 2048 })
      await tapVisibleControl(m, 'Back')
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
        const existing = (await api.chatConversations()).filter(
          row => row.kind === 'dm'
        )
        await list()
        await reveal(m, { text: 'New message' })
        await m.tapOn({ text: 'New message' })
        await m.tapOn({ text: 'Name' })
        await m.inputText({ text: candidate.shortName })
        await m.tapOn({ text: `Pick ${candidate.shortName}` })
        await m.tapOn({ text: 'Start conversation' })
        await m.assertVisible({ id: 'chat-composer', timeout: 60000 })
        let created: string | undefined
        const afterCreate = await api.chatConversations()
        for (const row of [...afterCreate].sort(
          (a, b) =>
            Number(existing.some(item => item.id === a.id)) -
            Number(existing.some(item => item.id === b.id))
        )) {
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
        if (process.env.CHAT_UI_NATIVE_LEGACY_ROWS !== '1') {
          const visibleRows = async (): Promise<{
            ids: string[]
            viewport: Bounds
          }> => {
            const tree = await m.hierarchy()
            const nodes = flatten(tree)
            const viewport = nodes.find(
              node =>
                node.type?.includes('ScrollView') === true &&
                node.bounds != null &&
                flatten(node).some(
                  child => child.id?.startsWith('chat-conversation-') === true
                )
            )?.bounds
            assert(viewport != null, 'Native list scroll viewport required')
            const ids = nodes
              .filter(
                node =>
                  node.id?.startsWith('chat-conversation-') === true &&
                  node.bounds != null &&
                  node.bounds.y + node.bounds.height > viewport.y &&
                  node.bounds.y < viewport.y + viewport.height
              )
              .sort((a, b) => a.bounds!.y - b.bounds!.y)
              .map(node => node.id!.slice('chat-conversation-'.length))
            return { ids, viewport }
          }
          const move = async (
            viewport: Bounds,
            down: boolean
          ): Promise<void> => {
            const x = Math.round(viewport.x + viewport.width * 0.5)
            const upper = Math.round(viewport.y + viewport.height * 0.25)
            const lower = Math.round(viewport.y + viewport.height * 0.75)
            await m.dragAndDrop({
              from: { point: `${x},${down ? upper : lower}` },
              to: { point: `${x},${down ? lower : upper}` },
              holdDuration: 10,
              duration: 400
            })
          }
          let prior = ''
          for (let count = 0; count < 15; count++) {
            const snapshot = await visibleRows()
            const key = snapshot.ids.join(',')
            if (key === prior) break
            prior = key
            await move(snapshot.viewport, true)
          }
          const seen: string[] = []
          prior = ''
          for (let count = 0; count < 20; count++) {
            const snapshot = await visibleRows()
            for (const id of snapshot.ids) if (!seen.includes(id)) seen.push(id)
            if (entries.every(entry => seen.includes(entry.id))) break
            const key = snapshot.ids.join(',')
            assert(
              key !== prior,
              'Native list ended before every required ordering row was observed'
            )
            prior = key
            await move(snapshot.viewport, false)
          }
          assert(
            entries.every(entry => seen.includes(entry.id)),
            'Every required row must be observed in the native list'
          )
          const wanted = seen.filter(id =>
            entries.some(entry => entry.id === id)
          )
          results.orderingScans = [
            ...((results.orderingScans as object[] | undefined) ?? []),
            {
              entries: entries.map(entry => entry.id),
              actualOrder: wanted,
              visibleStream: seen
            }
          ]
          return wanted
        }
        const nodes = flatten(await m.hierarchy())
        const rows = entries.map(entry => {
          const found = nodes.find(
            node =>
              (node.id === `chat-conversation-${entry.id}` ||
                node.text === entry.label ||
                node.label === entry.label) &&
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
        '$ S2 send unique encrypted probe in new DM; react only to that probe; observe post-only recency'
      )
      await scopedOpen(probe.id, probe.label)
      const previousProbe = (await api.chatConversations()).find(
        row => row.id === probe.id
      )!
      const probeBody = `${fixture.probePost} ${Date.now()}`
      await m.tapOn({ id: 'chat-composer' })
      await m.inputText({ text: probeBody })
      await m.tapOn({ text: 'Send' })
      await m.assertVisible({ text: probeBody, timeout: 60000 })
      const posted = await until(
        'The new encrypted probe must be acknowledged as the latest post',
        async () => {
          const row = (await api.chatConversations()).find(
            row => row.id === probe.id
          )
          return row != null &&
            row.lastPostId !== previousProbe.lastPostId &&
            row.lastSeq > previousProbe.lastSeq
            ? row
            : undefined
        }
      )
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
      await scopedOpen(probe.id, probe.label)
      await physicalMessageHold(m, `chat-message-${postId}`, probeBody, 550)
      await m.tapOn({ text: 'React with 👍' })
      const next = (await api.chatConversations()).find(
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
      await m.tapOn({ text: '👍, 1' })
      await list()
      assert.deepEqual(
        await positions(dms),
        [probe.id, empty.id],
        'Reaction must leave ordering unchanged'
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
        await api.updateChatPreferences(row.id, { pinned: row.pinned })
        await until('Synthetic band pin did not persist', async () =>
          (await api.chatConversations()).find(item => item.id === row.id)
            ?.preferences.pinned === row.pinned
            ? true
            : undefined
        )
      }
      await api.updateChatPreferences(fixture.conversationId, {
        manualUnread: true
      })
      await until('Newer scoped group must remain marked unread', async () =>
        (await current()).preferences.manualUnread ? true : undefined
      )
      results.bandSetup = {
        normalAuthenticatedPersonalPreferences: true,
        physicalMenuCoveredSeparately: true,
        changed: changed.map(row => ({ id: row.id, pinned: row.pinned }))
      }
      await m.stopApp({ appId: fixture.appId })
      await m.launchApp({
        appId: fixture.appId,
        permissions: { all: 'unset' }
      })
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
      pass(
        'four ordering bands observed in native UI and normal post/reaction preserve post recency'
      )
      for (const row of changed) {
        const old = before.find(item => item.id === row.id)!
        const now = (await api.chatConversations()).find(
          item => item.id === row.id
        )!
        if (old.preferences.pinned === now.preferences.pinned) continue
        await api.updateChatPreferences(row.id, {
          pinned: old.preferences.pinned
        })
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
    await reveal(m, { text: 'Chats' })
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
    const listViewport = flatten(await m.hierarchy()).find(
      node =>
        node.type?.includes('ScrollView') === true &&
        node.bounds != null &&
        flatten(node).some(
          child => child.id === `chat-conversation-${fixture.conversationId}`
        )
    )?.bounds
    assert(
      listViewport != null,
      'Actual list viewport required for movement cancellation'
    )
    const endY =
      moving.y - 150 >= listViewport.y + 8 ? moving.y - 150 : moving.y + 150
    assert(
      endY > listViewport.y + 8 &&
        endY < listViewport.y + listViewport.height - 8,
      'The full physical cancellation movement must remain inside the list pane'
    )
    results.conversationMovementGesture = {
      from: moving,
      to: { x: moving.x, y: endY },
      viewport: listViewport,
      requestedHoldMs: 200,
      requestedMovementMs: 500,
      physicalDistance: Math.abs(endY - moving.y),
      issuedAt: Date.now()
    }
    await m.dragAndDrop({
      from: { point: `${moving.x},${moving.y}` },
      to: { point: `${moving.x},${endY}` },
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
    await m.stopApp({ appId: fixture.appId })
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
    await reveal(m, chatRow(fixture.conversationLabel))
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
    results.failure = { stage, proofPrefix: failurePrefix }
    if (device != null) {
      let hierarchyAvailable = false
      const inspectionFailures: string[] = []
      try {
        writeFileSync(
          join(resultDirectory, `${failurePrefix}-hierarchy.json`),
          JSON.stringify(await device.hierarchy(), null, 2)
        )
        hierarchyAvailable = true
      } catch {
        inspectionFailures.push('native hierarchy unavailable')
      }
      if (hierarchyAvailable) {
        try {
          writeFileSync(
            join(resultDirectory, `${failurePrefix}.xml`),
            await device.hierarchyRaw()
          )
        } catch {
          inspectionFailures.push('raw native hierarchy unavailable')
        }
      }
      try {
        writeFileSync(
          join(resultDirectory, `${failurePrefix}.png`),
          await device.screenshot()
        )
      } catch {
        inspectionFailures.push('native screenshot unavailable')
      }
      results.failureInspection = { hierarchyAvailable, inspectionFailures }
    }
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
    if (restorePendingPreferences != null) await restorePendingPreferences()
    if (recording)
      await device
        ?.stopRecording({
          path:
            process.env.CHAT_UI_NATIVE_ANDROID_RECORD_REMOTE ??
            join(artifactDirectory, `${platform}-chat-actions.mp4`)
        })
        .catch(() => undefined)
    if (
      process.env.CHAT_UI_NATIVE_RECORD_REQUEST != null &&
      existsSync(process.env.CHAT_UI_NATIVE_RECORD_REQUEST) &&
      process.env.CHAT_UI_NATIVE_RECORD_STOP != null
    ) {
      writeFileSync(process.env.CHAT_UI_NATIVE_RECORD_STOP, 'stop')
      const done = process.env.CHAT_UI_NATIVE_RECORD_DONE
      if (done != null) {
        const flushed = await until(
          'Owned recording observer must flush before native device release',
          async () => (existsSync(done) ? true : undefined),
          30000
        ).catch(() => false)
        results.captureCleanup = {
          stopRequested: true,
          observerFlushedBeforeDeviceRelease: flushed,
          boundedWaitMs: 30000
        }
      }
    }
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
