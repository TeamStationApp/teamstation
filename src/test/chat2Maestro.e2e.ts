/** Public-UI actions, private evidence and one explicitly owned Maestro lease. */
import assert from 'node:assert/strict'
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync
} from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'

import { JSDOM } from 'jsdom'
import puppeteer, { type Browser, type CDPSession } from 'puppeteer'

import {
  Chat2Blocked,
  type Chat2Fixture,
  type Chat2Surface,
  digest,
  fixtureControl,
  need,
  outsideCheckout,
  privateJson,
  redact,
  sourceBinding
} from './chat2Fixture.e2e'

type Args = Record<string, unknown>
export interface Chat2Device {
  pasteText: () => Promise<unknown>
  setClipboard: (args: Args) => Promise<unknown>
  setDarkMode: (args: Args) => Promise<unknown>
  stopApp: (args: Args) => Promise<unknown>
  launchApp: (args: Args) => Promise<unknown>
  openLink: (args: Args) => Promise<unknown>
  tapOn: (args: Args) => Promise<unknown>
  tapOnPoint: (args: Args) => Promise<unknown>
  longPressOn: (args: Args) => Promise<unknown>
  swipe: (args: Args) => Promise<unknown>
  dragAndDrop: (args: Args) => Promise<unknown>
  inputText: (args: Args) => Promise<unknown>
  copyTextFrom: (
    args: Args
  ) => Promise<{ data?: unknown; element?: { bounds?: Bounds } }>
  eraseText: (args?: Args) => Promise<unknown>
  pressKey: (args: Args) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  back: () => Promise<unknown>
  assertVisible: (args: Args) => Promise<unknown>
  assertNotVisible: (args: Args) => Promise<unknown>
  scrollUntilVisible: (args: Args) => Promise<unknown>
  uploadFile: (args: Args) => Promise<unknown>
  addMedia: (args: Args) => Promise<unknown>
  startRecording: (args: Args) => Promise<unknown>
  stopRecording: () => Promise<unknown>
  mockNetwork: (args: Args) => Promise<unknown>
  clearNetworkMocks: () => Promise<unknown>
  setNetworkConditions: (args: Args) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  hierarchy: () => Promise<unknown>
  platformInfo: () => Promise<Args>
  evalBrowserScript: (args: Args) => Promise<{ data?: unknown }>
}
interface Daemon {
  started: boolean
  info?: { pid: number; reportsDir?: string }
  attach: (args: Args) => Promise<Chat2Device>
  startDevice: (args: Args) => Promise<{ id: string }>
  stopDevice: (id: string, args?: Args) => Promise<unknown>
  detach: (id: string) => Promise<unknown>
  shutdown: (args?: Args) => Promise<unknown>
  status: () => Promise<Args>
  close: () => void
}
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface CaptureViewport {
  width: number
  height: number
  dpr: number
  coarse: boolean
  scale: number
  scrollX: number
  scrollY: number
}

export interface PublicNode {
  id?: string
  type?: string
  text?: string
  bounds?: Bounds
  focused?: boolean
  enabled?: boolean
}

interface IosReadNode extends PublicNode {
  index: number
  parentIndex?: number
  value?: string
  placeholderValue?: string
  label?: string
}

/** Read native metadata without copying text or changing the clipboard. */
export function iosPublicRead(
  raw: Uint8Array,
  selected: Args,
  expectedType?: string
): { nodes: IosReadNode[]; element?: IosReadNode } {
  const tree = object(JSON.parse(Buffer.from(raw).toString('utf8')))
  assert(Array.isArray(tree.nodes), 'Actual raw native node array required')
  const nodes = tree.nodes.map((entry: unknown): IosReadNode => {
    const n = object(entry)
    assert(Number.isInteger(n.index), 'Native public node index required')
    return {
      index: n.index as number,
      parentIndex:
        typeof n.parentIndex === 'number' ? n.parentIndex : undefined,
      id: typeof n.identifier === 'string' ? n.identifier : undefined,
      type: typeof n.type === 'string' ? n.type : undefined,
      label: typeof n.label === 'string' ? n.label : undefined,
      value: typeof n.value === 'string' ? n.value : undefined,
      placeholderValue:
        typeof n.placeholderValue === 'string' ? n.placeholderValue : undefined,
      text:
        typeof n.value === 'string'
          ? n.value
          : typeof n.label === 'string'
            ? n.label
            : undefined,
      bounds: bounds(n.rect),
      enabled: typeof n.enabled === 'boolean' ? n.enabled : undefined
    }
  })
  const byIndex = new Map<number, IosReadNode>()
  for (const node of nodes) {
    assert(!byIndex.has(node.index), 'Unique native public indices required')
    byIndex.set(node.index, node)
  }
  const chain = (node: IosReadNode): IosReadNode[] => {
    const parents: IosReadNode[] = []
    const seen = new Set<number>([node.index])
    let index = node.parentIndex
    while (index != null) {
      assert(!seen.has(index), 'Acyclic actual native ancestry required')
      seen.add(index)
      const parent = need(
        byIndex.get(index),
        'Complete actual native ancestry required'
      )
      parents.push(parent)
      index = parent.parentIndex
    }
    return parents
  }
  const valid = (node: IosReadNode): Bounds => {
    const b = need(node.bounds, 'Observed native public bounds required')
    assert(
      [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
        b.width > 0 &&
        b.height > 0,
      'Positive finite native public bounds required'
    )
    return b
  }
  const inside = (child: Bounds, parent: Bounds): boolean =>
    child.x >= parent.x - 1 &&
    child.y >= parent.y - 1 &&
    child.x + child.width <= parent.x + parent.width + 1 &&
    child.y + child.height <= parent.y + parent.height + 1
  const scopeId = object(selected.childOf).id
  assert(
    selected.childOf == null || typeof scopeId === 'string',
    'Exact public scope identifier required'
  )
  let scope: IosReadNode | undefined
  if (typeof scopeId === 'string') {
    const scopes = nodes.filter(node => node.id === scopeId)
    assert(scopes.length === 1, 'Unique observed native scope required')
    scope = scopes[0]
    valid(scope)
  }
  const id = typeof selected.id === 'string' ? selected.id : undefined
  const pattern =
    typeof selected.text === 'string'
      ? new RegExp(selected.text, 'i')
      : undefined
  assert(
    id != null || pattern != null || expectedType != null,
    'Exact public identifier, text or native type required'
  )
  const matches = nodes.filter(node => {
    if (id != null && node.id !== id) return false
    if (
      pattern != null &&
      ![node.label, node.value, node.placeholderValue].some(
        value => value != null && pattern.test(value)
      )
    )
      return false
    if (expectedType != null && node.type !== expectedType) return false
    if (scope != null) {
      if (!inside(valid(node), valid(scope))) return false
      const owners = chain(node)
      const ancestor = owners.some(parent => parent.index === scope.index)
      // Native accessibility can flatten a section and its visible Card to siblings.
      const sameParent =
        node.parentIndex != null && node.parentIndex === scope.parentIndex
      const scroll = owners.find(parent => parent.type === 'ScrollView')
      const scopeScroll = chain(scope).find(
        parent => parent.type === 'ScrollView'
      )
      const sameScroll = scroll != null && scopeScroll?.index === scroll.index
      if (!ancestor && !sameParent && !sameScroll) return false
    }
    return true
  })
  assert(matches.length <= 1, 'Unique exact native public element required')
  if (matches[0] != null) valid(matches[0])
  return { nodes, element: matches[0] }
}

/** iOS exposes no focus flag: require the actual composer above an observed IME. */
export async function readIosComposerKeyboard(
  ui: Pick<Chat2UI, 'device'>,
  signal: AbortSignal
): Promise<{
  nodes: PublicNode[]
  geometry: Record<'composer' | 'band' | 'history' | 'keyboard', Bounds>
  focusSignal: 'unavailable-on-ios'
}> {
  const api = ui.device as unknown as {
    hierarchy: (options: { signal: AbortSignal }) => Promise<unknown>
    assertVisible: (
      args: Args,
      options: { signal: AbortSignal }
    ) => Promise<unknown>
  }
  const positive = (b: Bounds): boolean =>
    [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
    b.width > 0 &&
    b.height > 0
  const inside = (child: Bounds, parent: Bounds): boolean =>
    child.x >= parent.x - 1 &&
    child.y >= parent.y - 1 &&
    child.x + child.width <= parent.x + parent.width + 1 &&
    child.y + child.height <= parent.y + parent.height + 1
  for (;;) {
    signal.throwIfAborted()
    const nodes = flattenPublicHierarchy(await api.hierarchy({ signal }))
    const keyboards = nodes.filter(n => /^Keyboard$/i.test(n.type ?? ''))
    assert(keyboards.length <= 1, 'Unique observed iOS Keyboard required')
    if (keyboards.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 50))
      continue
    }
    const keyboard = need(
      keyboards[0].bounds,
      'Observed iOS Keyboard bounds required'
    )
    assert(positive(keyboard), 'Positive finite iOS Keyboard bounds required')
    const measure = async (id: string): Promise<Bounds> => {
      const observed = nodes.filter(n => n.id === id)
      assert(
        observed.length <= 1,
        'Unique exact public element required: ' + id
      )
      if (observed[0]?.bounds != null) {
        if (id === 'chat-composer')
          assert(observed[0].enabled === true, 'Enabled iOS composer required')
        assert(
          positive(observed[0].bounds),
          'Finite positive public bounds required: ' + id
        )
        return observed[0].bounds
      }
      const element = object(
        object(await api.assertVisible({ id, timeout: 120 }, { signal }))
          .element
      )
      assert(element.id === id, 'Exact positive public element required: ' + id)
      if (id === 'chat-composer')
        assert(element.enabled === true, 'Enabled iOS composer required')
      const measured = need(
        bounds(element.bounds),
        'Positive public bounds required: ' + id
      )
      assert(
        positive(measured),
        'Finite positive public bounds required: ' + id
      )
      return measured
    }
    const history = await measure('chat-message-history')
    const band = await measure('chat-composer-band')
    const composer = await measure('chat-composer')
    assert(
      inside(band, history) &&
        inside(composer, band) &&
        inside(keyboard, history),
      'Contained iOS composer and Keyboard geometry required'
    )
    assert(
      band.y + band.height <= keyboard.y + 1,
      'iOS composer must be above the observed software keyboard'
    )
    signal.throwIfAborted()
    return {
      nodes,
      geometry: { history, band, composer, keyboard },
      focusSignal: 'unavailable-on-ios'
    }
  }
}

/** A history gutter stays outside measured chrome and composer controls. */
export function iosKeyboardDismissPoint(input: {
  history: Bounds
  identity: Bounds
  composer: Bounds
  keyboard: Bounds
  pins?: Bounds
  excluded: Bounds[]
}): { x: number; y: number } {
  const { history, identity, composer, keyboard, pins, excluded } = input
  const valid = (b: Bounds): boolean =>
    [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
    b.width > 0 &&
    b.height > 0
  assert(
    [
      history,
      identity,
      composer,
      keyboard,
      ...excluded,
      ...(pins != null ? [pins] : [])
    ].every(valid),
    'Finite positive observed keyboard-dismissal bounds required'
  )
  const top = Math.max(
    history.y,
    identity.y + identity.height,
    pins != null ? pins.y + pins.height : history.y
  )
  const bottom = Math.min(history.y + history.height, composer.y, keyboard.y)
  const left = composer.x - history.x
  const right = history.x + history.width - composer.x - composer.width
  assert(left >= 0 && right >= 0, 'Whole composer band must lie inside history')
  // Rounding must leave the point strictly inside the observed gutter/band.
  assert(
    bottom - top > 2 && Math.max(left, right) > 2,
    'No safe measured history gutter for keyboard dismissal'
  )
  const x = Math.round(
    left >= right
      ? history.x + left / 2
      : composer.x + composer.width + right / 2
  )
  const y = Math.round((top + bottom) / 2)
  const contains = (b: Bounds): boolean =>
    x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
  assert(
    x > history.x &&
      x < history.x + history.width &&
      y > top &&
      y < bottom &&
      ![
        identity,
        composer,
        keyboard,
        ...excluded,
        ...(pins != null ? [pins] : [])
      ].some(contains),
    'Measured keyboard-dismissal point intersects public chrome or controls'
  )
  return { x, y }
}

/** Dismiss through one observed gutter, with one observed OS-menu transition. */
export async function dismissIosChatKeyboard(
  ui: Pick<Chat2UI, 'device' | 'steps' | 'runDir'>,
  timeout = 90000
): Promise<void> {
  const end = Date.now() + timeout
  const remaining = (): number => {
    const ms = end - Date.now()
    assert(ms > 0, 'Timed out verifying iOS keyboard dismissal')
    return ms
  }
  const options = (): { signal: AbortSignal } => ({
    signal: AbortSignal.timeout(remaining())
  })
  const api = ui.device as unknown as {
    hierarchy: (options: { signal: AbortSignal }) => Promise<unknown>
    assertVisible: (
      args: Args,
      options: { signal: AbortSignal }
    ) => Promise<unknown>
    tapOn: (args: Args, options: { signal: AbortSignal }) => Promise<unknown>
    screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
    tapOnPoint: (
      args: Args,
      options: { signal: AbortSignal }
    ) => Promise<unknown>
  }
  const row: Args = {
    name: 'Measured iOS keyboard dismissal',
    method:
      'Positive keyboard and moved composer, accessibility and stable raw native pixels; actual image review required',
    startedAt: new Date().toISOString(),
    samples: []
  }
  ui.steps.push(row)
  const read = async (): Promise<PublicNode[]> =>
    flattenPublicHierarchy(await api.hierarchy(options()))
  const keyboardOf = (nodes: PublicNode[]): PublicNode | undefined => {
    const matches = nodes.filter(n => /keyboard$/i.test(n.type ?? ''))
    assert(matches.length <= 1, 'Unique observed iOS keyboard required')
    return matches[0]
  }
  const measured = async (nodes: PublicNode[], id: string): Promise<Bounds> => {
    const matches = nodes.filter(n => n.id === id)
    assert(
      matches.length <= 1,
      'Unique public keyboard element required: ' + id
    )
    if (matches[0]?.bounds != null) return matches[0].bounds
    const found = object(
      object(
        await api.assertVisible(
          { id, timeout: Math.min(120, remaining()) },
          options()
        )
      ).element
    )
    assert(found.id === id, 'Exact positive public element required: ' + id)
    return need(bounds(found.bounds), 'Measured public bounds required: ' + id)
  }
  const geometry = async (
    nodes: PublicNode[]
  ): Promise<{ history: Bounds; composer: Bounds }> => {
    const history = await measured(nodes, 'chat-message-history')
    const composer = await measured(nodes, 'chat-composer-band')
    assert(
      [history, composer].every(
        b =>
          [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
          b.width > 0 &&
          b.height > 0
      ) &&
        composer.x >= history.x &&
        composer.x + composer.width <= history.x + history.width &&
        composer.y >= history.y &&
        composer.y + composer.height <= history.y + history.height,
      'Positive contained history and whole composer geometry required'
    )
    return { history, composer }
  }
  const same = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a) === JSON.stringify(b)
  let captures = 0
  let raster: string | undefined
  const image = async (): Promise<Args> => {
    assert(
      ++captures <= 8,
      'Bounded native keyboard evidence captures exhausted'
    )
    remaining()
    const proof = saveCapture(
      await api.screenshot(options()),
      join(
        ui.runDir,
        'keyboard-dismissal-' + Date.now() + '-' + captures + '.png'
      )
    )
    remaining()
    assert(
      typeof proof.rawPath === 'string' &&
        typeof proof.rawSha256 === 'string' &&
        digest(proof.rawPath) === proof.rawSha256 &&
        Number.isFinite(proof.width) &&
        Number(proof.width) > 0 &&
        Number.isFinite(proof.height) &&
        Number(proof.height) > 0,
      'Retained actual native screenshot bytes and dimensions required'
    )
    const bytes = readFileSync(proof.rawPath)
    assert(
      bytes.subarray(0, 8).equals(PNG) &&
        bytes.toString('ascii', 12, 16) === 'IHDR',
      'Actual native PNG required'
    )
    assert(
      bytes.readUInt32BE(16) === proof.width &&
        bytes.readUInt32BE(20) === proof.height,
      'Native raw raster dimensions differ from receipt'
    )
    const size = JSON.stringify([proof.width, proof.height])
    assert(
      raster == null || size === raster,
      'Native screenshot dimensions changed during dismissal'
    )
    raster = size
    return {
      rawPath: proof.rawPath,
      rawSha256: proof.rawSha256,
      width: proof.width,
      height: proof.height
    }
  }
  const stable = async (
    nodes: PublicNode[],
    expected: { history: Bounds; composer: Bounds },
    kind: 'closed' | 'menu'
  ): Promise<Args> => {
    let reference: string | undefined
    let since = Date.now()
    const expectedKeyboard = keyboardOf(nodes)?.bounds
    const eligible = (sample: PublicNode[]): boolean =>
      kind === 'closed'
        ? keyboardOf(sample) == null
        : same(keyboardOf(sample)?.bounds, expectedKeyboard) &&
          expectedKeyboard != null &&
          !sample.some(n => /MenuItem$/i.test(n.type ?? ''))
    for (;;) {
      assert(
        eligible(nodes),
        'Public keyboard/menu state changed during pixel observation'
      )
      const before = await geometry(nodes)
      assert(
        same(before, expected),
        'Native keyboard geometry changed during pixel observation'
      )
      const frame = await image()
      nodes = await read()
      assert(
        eligible(nodes),
        'Public keyboard/menu state changed across screenshot'
      )
      const after = await geometry(nodes)
      assert(
        same(before, after),
        'Native keyboard geometry moved across screenshot'
      )
      const signature = JSON.stringify({
        geometry: after,
        rawSha256: frame.rawSha256
      })
      if (reference !== signature) {
        reference = signature
        since = Date.now()
      }
      const sample = { ...after, image: frame, stableForMs: Date.now() - since }
      row.samples = [...(row.samples as Args[]).slice(-15), sample]
      if (Date.now() - since >= 200) return { nodes, image: frame }
      // The measured window schedules another observation; waiting alone never passes.
      await new Promise(resolve =>
        setTimeout(
          resolve,
          Math.min(Math.max(1, 200 - (Date.now() - since)), remaining())
        )
      )
    }
  }
  const tap = async (
    nodes: PublicNode[],
    keyboard: PublicNode
  ): Promise<{ history: Bounds; composer: Bounds; keyboard: Bounds }> => {
    const current = await geometry(nodes)
    const identity = await measured(nodes, 'chat-conversation-identity')
    const pinNodes = nodes.filter(n => n.id === 'chat-pinned-band')
    assert(pinNodes.length <= 1, 'Unique observed pinned band required')
    const pins =
      pinNodes.length === 1
        ? await measured(nodes, 'chat-pinned-band')
        : undefined
    const excluded = nodes
      .filter(n => /Button$|MenuItem$/i.test(n.type ?? '') && n.bounds != null)
      .map(n => n.bounds!)
    // Only observed optional controls are used; a failed query is never an absence proof.
    for (const id of [
      'chat-jump-latest',
      'chat-attention-count',
      'chat-attention-retry'
    ])
      if (nodes.some(n => n.id === id)) excluded.push(await measured(nodes, id))
    let ime = need(keyboard.bounds, 'Observed iOS keyboard bounds required')
    for (const n of nodes) {
      const b = n.bounds
      if (
        /Toolbar$/i.test(n.type ?? '') &&
        b != null &&
        b.y <= ime.y &&
        b.y + b.height >= ime.y &&
        b.x < ime.x + ime.width &&
        b.x + b.width > ime.x
      )
        ime = { ...ime, height: ime.y + ime.height - b.y, y: b.y }
    }
    const point = iosKeyboardDismissPoint({
      ...current,
      identity,
      keyboard: ime,
      pins,
      excluded
    })
    row.samples = [
      ...(row.samples as Args[]).slice(-15),
      { ...current, keyboard: ime, pins, point }
    ]
    await api.tapOnPoint({ point: `${point.x},${point.y}` }, options())
    return { ...current, keyboard: ime }
  }
  try {
    let nodes = await read()
    let keyboard = keyboardOf(nodes)
    if (keyboard == null) {
      await measured(nodes, 'chat-composer')
      await api.tapOn({ id: 'chat-composer' }, options())
      row.initialSetup =
        'Ordinary composer focus only; no text or clipboard operation'
      do {
        nodes = await read()
        keyboard = keyboardOf(nodes)
        if (keyboard == null)
          await new Promise(resolve =>
            setTimeout(resolve, Math.min(50, remaining()))
          )
      } while (keyboard == null)
    }
    const menus = nodes.filter(
      n => /MenuItem$/i.test(n.type ?? '') && n.bounds != null
    )
    const beforeImage = menus.length > 0 ? await image() : undefined
    let opened = await tap(nodes, keyboard)
    let menuTransitionUsed = false
    for (;;) {
      nodes = await read()
      const current = keyboardOf(nodes)
      const actual = await geometry(nodes)
      const bottom = actual.composer.y + actual.composer.height
      const openBottom = opened.composer.y + opened.composer.height
      const penetration =
        Math.min(opened.composer.height, opened.keyboard.height) / 2
      const movedIntoFormerKeyboard =
        same(actual.history, opened.history) &&
        bottom > openBottom &&
        bottom > opened.keyboard.y + penetration &&
        bottom <=
          Math.min(
            opened.keyboard.y + opened.keyboard.height,
            actual.history.y + actual.history.height
          )
      if (current == null && movedIntoFormerKeyboard) {
        const settled = await stable(nodes, actual, 'closed')
        assert(
          keyboardOf(settled.nodes as PublicNode[]) == null,
          'Keyboard reappeared during closure proof'
        )
        row.outcome = 'passed'
        row.closure =
          'Positive moved-composer layout certificate with AX and stable actual pixels; ROOT image review required'
        return
      }
      if (
        current != null &&
        menus.length > 0 &&
        !menuTransitionUsed &&
        !nodes.some(n => /MenuItem$/i.test(n.type ?? '')) &&
        same(actual, { history: opened.history, composer: opened.composer })
      ) {
        const settled = await stable(nodes, actual, 'menu')
        const settledNodes = settled.nodes as PublicNode[]
        const stillKeyboard = keyboardOf(settledNodes)
        assert(
          stillKeyboard != null &&
            !settledNodes.some(n => /MenuItem$/i.test(n.type ?? '')) &&
            object(settled.image).rawSha256 !== beforeImage?.rawSha256,
          'Actual changed stable menu-transition pixels and positive keyboard required'
        )
        menuTransitionUsed = true
        row.observedMenuDismissed =
          'AX omission plus changed stable raw pixels; conservative evidence, ROOT review required'
        opened = await tap(settledNodes, stillKeyboard)
      }
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(50, remaining()))
      )
    }
  } catch (error) {
    row.outcome = 'failed'
    row.error = String(error)
    throw error
  } finally {
    row.finishedAt = new Date().toISOString()
  }
}

function object(value: unknown): Args {
  return value != null && typeof value === 'object' ? (value as Args) : {}
}
function bounds(raw: unknown): Bounds | undefined {
  if (typeof raw === 'string') {
    const numbers = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number)
    if (numbers?.length === 4)
      return {
        x: numbers[0],
        y: numbers[1],
        width: numbers[2] - numbers[0],
        height: numbers[3] - numbers[1]
      }
  }
  const b = object(raw)
  if (['x', 'y', 'width', 'height'].every(k => typeof b[k] === 'number'))
    return b as unknown as Bounds
}

/** Read public DOM geometry; keep serialized code free of module-scoped helpers. */
export function publicWebNodes(parentId?: string): PublicNode[] {
  const root =
    parentId == null
      ? document.body
      : document.querySelector<HTMLElement>(
          '[data-testid=' + JSON.stringify(parentId) + ']'
        )
  if (root == null) throw new Error('Observed public parent element required')
  return [root, ...root.querySelectorAll<HTMLElement>('*')].flatMap(node => {
    if (node.closest('script,style,[hidden],[aria-hidden="true"]') != null)
      return []
    for (
      let ancestor: Element | null = node;
      ancestor != null;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number.parseFloat(style.opacity) === 0
      )
        return []
    }
    const rect = node.getBoundingClientRect()
    if (
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      return []
    let id: string | undefined
    const identifier = node.getAttribute('data-testid')
    if (identifier !== null && identifier !== '') id = identifier
    let role: string | undefined
    const namedRole = node.getAttribute('role')
    if (namedRole !== null && namedRole !== '') role = namedRole
    let labelIds = ''
    const labelledBy = node.getAttribute('aria-labelledby')
    if (labelledBy !== null) labelIds = labelledBy
    const labelled = labelIds
      .split(/\s+/)
      .filter(Boolean)
      .map(id => {
        const label = document.getElementById(id)
        if (label == null) return ''
        const content = label.textContent
        if (content == null) return ''
        return content.trim()
      })
      .filter(Boolean)
      .join(' ')
    let text: string | undefined
    const label = node.getAttribute('aria-label')
    if (label !== null) text = label
    else if (labelled !== '') text = labelled
    else if (
      node.childElementCount === 0 ||
      role != null ||
      node.tagName === 'BUTTON'
    ) {
      const content = node.textContent
      if (content !== null) text = content.trim()
    }
    let type = node.tagName.toLowerCase()
    if (role !== undefined) type = role
    if (id == null && role == null && (text == null || text === '')) return []
    return [
      {
        id,
        type,
        text,
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        },
        focused: node === document.activeElement,
        enabled:
          !node.hasAttribute('disabled') &&
          node.getAttribute('aria-disabled') !== 'true'
      }
    ]
  })
}

/** Supports documented normalized nodes and the supported native backends. */
export function flattenPublicHierarchy(raw: unknown): PublicNode[] {
  if (Array.isArray(raw)) return raw.flatMap(flattenPublicHierarchy)
  if (typeof raw === 'string') {
    if (raw.trim().startsWith('<')) {
      const dom = new JSDOM(raw, { contentType: 'text/xml' })
      try {
        return Array.from(dom.window.document.querySelectorAll('*')).map(n => ({
          id:
            n.getAttribute('resource-id') ??
            n.getAttribute('identifier') ??
            undefined,
          type: n.getAttribute('class') ?? n.getAttribute('type') ?? undefined,
          text:
            n.getAttribute('text') ??
            n.getAttribute('content-desc') ??
            n.getAttribute('label') ??
            undefined,
          bounds: bounds(n.getAttribute('bounds'))
        }))
      } finally {
        dom.window.close()
      }
    }
    try {
      return flattenPublicHierarchy(JSON.parse(raw))
    } catch {
      return []
    }
  }
  const n = object(raw)
  if (Array.isArray(n.nodes)) return n.nodes.flatMap(flattenPublicHierarchy)
  if (Object.keys(n).length === 0) return []
  const text = n.text ?? n.label ?? n.value ?? n.name
  return [
    {
      id:
        typeof (n.id ?? n.identifier) === 'string'
          ? String(n.id ?? n.identifier)
          : undefined,
      type:
        typeof (n.type ?? n.className) === 'string'
          ? String(n.type ?? n.className)
          : undefined,
      text: typeof text === 'string' ? text : undefined,
      bounds: bounds(n.bounds ?? n.rect),
      focused: n.focused === true,
      enabled: typeof n.enabled === 'boolean' ? n.enabled : undefined
    },
    ...(Array.isArray(n.children)
      ? n.children.flatMap(flattenPublicHierarchy)
      : [])
  ]
}

/** Verify an observed native value against one exact public raw-node identity. */
export function observedNativeValue(
  raw: Uint8Array,
  expected: { identifier: string; type: string; label: string; value: string }
): { identifier: string; type: string; label: string; value: string } {
  assert(
    expected != null && typeof expected === 'object',
    'Observed raw value predicate required'
  )
  for (const field of ['identifier', 'type', 'label', 'value'] as const)
    assert(
      typeof expected[field] === 'string',
      'Exact observed raw strings required'
    )
  assert(
    expected.type !== '' &&
      (expected.identifier !== '' || expected.label !== ''),
    'Named observed native identity required'
  )
  const tree = JSON.parse(Buffer.from(raw).toString('utf8')) as {
    nodes?: unknown
  }
  assert(Array.isArray(tree.nodes), 'Actual raw native node array required')
  const matches = tree.nodes.filter((entry: unknown) => {
    if (entry == null || typeof entry !== 'object') return false
    const n = entry as Record<string, unknown>
    const identifier = n.identifier ?? ''
    const label = n.label ?? ''
    return (
      identifier === expected.identifier &&
      n.type === expected.type &&
      label === expected.label
    )
  }) as Array<Record<string, unknown>>
  assert(
    matches.length === 1,
    'Unique exact observed native raw identity required'
  )
  assert(
    typeof matches[0].value === 'string' && matches[0].value === expected.value,
    'Actual native raw value differs from observed predicate'
  )
  return { ...expected }
}

export function exactText(text: string): string {
  return '^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
}
export async function until<T>(
  read: () => Promise<T | undefined>,
  label: string,
  timeout = 15000
): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value != null) return value
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

function code(error: unknown): string | undefined {
  const value = object(error).code
  return typeof value === 'string' ? value : undefined
}
function lockTree(path: string): void {
  if (!existsSync(path)) return
  if (statSync(path).isDirectory()) {
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) lockTree(join(path, name))
  } else chmodSync(path, 0o600)
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** The Android RPC backend can return JPEG even when its API promises PNG. */
export function saveCapture(bytes: Uint8Array, destination: string): Args {
  const raw = Buffer.from(bytes)
  const rawPath =
    destination + (raw.subarray(0, 8).equals(PNG) ? '.raw.png' : '.raw.jpg')
  writeFileSync(rawPath, raw, { mode: 0o600, flag: 'wx' })
  let conversion: Args | undefined
  if (raw.subarray(0, 8).equals(PNG)) {
    writeFileSync(destination, raw, { mode: 0o600, flag: 'wx' })
  } else {
    assert(
      raw[0] === 255 && raw[1] === 216 && raw[2] === 255,
      'Unknown screenshot codec; do not mislabel it PNG'
    )
    const python = process.env.CHAT2_PYTHON ?? 'python3'
    const script = [
      'import sys,json,hashlib',
      'from PIL import Image',
      'im=Image.open(sys.argv[1]); im.load(); before=im.tobytes(); mode=im.mode; size=im.size',
      'im.save(sys.argv[2],format="PNG")',
      'out=Image.open(sys.argv[2]); out.load()',
      'assert out.mode==mode and out.size==size and out.tobytes()==before',
      'print(json.dumps({"decodedPixelsEqual":True,"decodedPixelSha256":hashlib.sha256(before).hexdigest()}))'
    ].join('\n')
    const result = spawnSync(python, ['-c', script, rawPath, destination], {
      encoding: 'utf8',
      timeout: 10000
    })
    if (result.status !== 0)
      throw new Chat2Blocked(
        'JPEG driver capture requires CHAT2_PYTHON with Pillow; raw bytes retained'
      )
    chmodSync(destination, 0o600)
    conversion = JSON.parse(result.stdout) as Args
  }
  const png = readFileSync(destination)
  assert(
    png.subarray(0, 8).equals(PNG) && png.toString('ascii', 12, 16) === 'IHDR',
    'Final screenshot must be actual PNG'
  )
  return {
    rawPath,
    rawSha256: digest(rawPath),
    sha256: digest(destination),
    format: 'PNG',
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    conversion
  }
}

export class Chat2UI {
  readonly native: boolean
  readonly steps: Args[] = []
  readonly captures: Args[] = []
  readonly runDir: string
  readonly binding: ReturnType<typeof sourceBinding>
  readonly deadline = AbortSignal.timeout(900000)
  device!: Chat2Device
  daemon?: Daemon
  browser?: Browser
  cdp?: CDPSession
  environment?: Args
  deviceId = ''
  cleanup: Args = {}
  private readonly root: string
  private readonly artifactRoot: string
  private readonly daemonName: string
  private webFrame?: {
    width: number
    height: number
    dpr: number
    coarse: boolean
  }

  private webZoom?: CaptureViewport
  private reportsDir?: string
  private connectCleanup?: () => Promise<Daemon>

  constructor(
    readonly fixture: Chat2Fixture,
    readonly surface: Chat2Surface,
    readonly scenario: string
  ) {
    this.root = process.cwd()
    this.native = surface === 'ios' || surface === 'android'
    this.artifactRoot = resolve(
      need(process.env.CHAT2_ARTIFACTS, 'CHAT2_ARTIFACTS required')
    )
    outsideCheckout(this.root, this.artifactRoot)
    this.binding = sourceBinding(this.root, fixture, surface)
    this.daemonName = need(
      process.env.MAESTRO_D,
      'Each run requires its own explicit MAESTRO_D name'
    )
    assert(
      this.daemonName.startsWith(fixture.ownershipId + '-') &&
        /^[\w-]+$/.test(this.daemonName),
      'Daemon name must bind this disposable ownership ID'
    )
    this.runDir = join(
      this.artifactRoot,
      'runs',
      this.binding.source.slice(0, 12) +
        '-' +
        surface +
        '-' +
        scenario +
        '-' +
        Date.now()
    )
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 })
  }

  async start(): Promise<void> {
    const bin = process.env.MAESTRO_D_BIN ?? 'maestro-d'
    const inventory = execFileSync(bin, ['ps'], {
      encoding: 'utf8',
      timeout: 8000
    })
    writeFileSync(join(this.runDir, 'daemon-inventory.txt'), inventory, {
      mode: 0o600
    })
    const clientRoot = need(
      process.env.MAESTRO_D_CLIENT_ROOT,
      'MAESTRO_D_CLIENT_ROOT must identify the installed/built client'
    )
    const { MaestroD } = createRequire(
      join(resolve(clientRoot), 'package.json')
    )('maestro-d') as { MaestroD: { connect: (args: Args) => Promise<Daemon> } }
    this.connectCleanup = async () =>
      await MaestroD.connect({ name: this.daemonName, bin, spawn: false })
    this.daemon = await MaestroD.connect({
      name: this.daemonName,
      bin,
      idleTimeout: 0,
      signal: this.deadline
    })
    if (!this.daemon.started) {
      this.daemon.close()
      this.daemon = undefined
      throw new Error(
        'Daemon name already exists; do not reuse another run lease'
      )
    }
    this.reportsDir = this.daemon.info?.reportsDir
    if (this.native) await this.startNative()
    else await this.startWeb()
    this.environment = this.native
      ? await this.device.platformInfo()
      : await this.dom(
          'return {width:innerWidth,height:innerHeight,coarse:matchMedia("(pointer:coarse)").matches,fine:matchMedia("(pointer:fine)").matches,dpr:devicePixelRatio,userAgent:navigator.userAgent}'
        )
  }

  private async startNative(): Promise<void> {
    const platform = this.surface === 'ios' ? 'ios' : 'android'
    const configured = this.fixture.devices[platform]
    const requestedDevice = need(
      process.env[
        platform === 'ios' ? 'CHAT_IOS_DEVICE' : 'CHAT_ANDROID_DEVICE'
      ],
      'Explicit task-owned native ID required'
    )
    assert(
      requestedDevice === configured.id && configured.owned,
      'Device does not match the owned descriptor'
    )
    this.deviceId = requestedDevice
    if (platform === 'android') {
      const sims = JSON.parse(
        execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
          encoding: 'utf8'
        })
      ) as { devices: Record<string, Array<{ udid: string; state: string }>> }
      assert(
        !Object.values(sims.devices)
          .flat()
          .some(
            d => d.udid === this.fixture.devices.ios.id && d.state === 'Booted'
          ),
        'Own iOS target must stop before Android starts'
      )
    } else {
      const adb = spawnSync(process.env.CHAT2_ADB ?? 'adb', ['devices'], {
        encoding: 'utf8',
        timeout: 5000
      })
      assert(
        adb.status === 0 &&
          !adb.stdout
            .split('\n')
            .some(line =>
              line.startsWith(this.fixture.devices.android.id + '\t')
            ),
        'Own Android target must stop before iOS starts'
      )
    }
    if (process.env.CHAT2_NATIVE_PREBOOTED !== '1') {
      const started = await need(this.daemon, 'Daemon required').startDevice({
        platform,
        name: configured.name,
        bootTimeout: 180
      })
      assert(started.id === this.deviceId, 'Boot returned a different device')
    } else if (platform === 'android') {
      const name = execFileSync(
        process.env.CHAT2_ADB ?? 'adb',
        ['-s', this.deviceId, 'emu', 'avd', 'name'],
        { encoding: 'utf8', timeout: 5000 }
      )
        .split('\n')[0]
        .trim()
      assert(
        name === configured.name,
        'Prebooted serial belongs to another AVD'
      )
    } else {
      const sims = JSON.parse(
        execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
          encoding: 'utf8'
        })
      ) as {
        devices: Record<
          string,
          Array<{ udid: string; name: string; state: string }>
        >
      }
      assert(
        Object.values(sims.devices)
          .flat()
          .some(
            d =>
              d.udid === this.deviceId &&
              d.name === configured.name &&
              d.state === 'Booted'
          ),
        'Exact owned prebooted simulator required'
      )
    }
    this.device = await need(this.daemon, 'Daemon required').attach({
      device: this.deviceId,
      platform,
      driver: configured.driver,
      appId: this.fixture.appId,
      ...(process.env.CHAT2_UPDATE_OWN_APP === '1'
        ? {
            appFile:
              platform === 'ios'
                ? dirname(this.binding.binding.artifact)
                : this.binding.binding.artifact
          }
        : { noAppInstall: true }),
      artifacts: 'none',
      driverStartTimeout: 180,
      commandTimeout: 30000
    })
    await this.device.launchApp({ appId: this.fixture.appId })
    if (platform === 'ios') {
      const installed = execFileSync(
        'xcrun',
        [
          'simctl',
          'get_app_container',
          this.deviceId,
          this.fixture.appId,
          'app'
        ],
        { encoding: 'utf8' }
      ).trim()
      assert(
        digest(join(installed, basename(this.binding.binding.artifact))) ===
          this.binding.binding.sha256,
        'Installed iOS executable differs from final bound build'
      )
      if (this.binding.binding.bundle != null)
        assert(
          digest(
            join(installed, basename(this.binding.binding.bundle.path))
          ) === this.binding.binding.bundle.sha256,
          'Installed iOS JS differs from final source'
        )
      this.steps.push({
        name: 'Installed iOS build/source binding',
        outcome: 'passed',
        installedArtifactSha256: this.binding.binding.sha256
      })
    } else {
      const apkPath = execFileSync(
        process.env.CHAT2_ADB ?? 'adb',
        ['-s', this.deviceId, 'shell', 'pm', 'path', this.fixture.appId],
        { encoding: 'utf8', timeout: 5000 }
      )
        .trim()
        .split('\n')[0]
        .replace(/^package:/, '')
      assert(
        /^\/data\/app\/[A-Za-z0-9_./+~=-]+\.apk$/.test(apkPath),
        'Expected explicit installed application APK path'
      )
      const pulled = join(this.runDir, 'installed.apk')
      execFileSync(
        process.env.CHAT2_ADB ?? 'adb',
        ['-s', this.deviceId, 'pull', apkPath, pulled],
        { stdio: 'pipe', timeout: 20000 }
      )
      assert(
        digest(pulled) === this.binding.binding.sha256,
        'Installed Android APK differs from final source build'
      )
      this.steps.push({
        name: 'Installed Android build/source binding',
        outcome: 'passed',
        installedArtifactSha256: digest(pulled)
      })
    }
  }

  private async startWeb(): Promise<void> {
    const requestedDevice = need(
      process.env.CHAT_WEB_DEVICE,
      'Explicit task-owned CHAT_WEB_DEVICE required'
    )
    assert(
      requestedDevice.startsWith(this.fixture.ownershipId + '-'),
      'Browser ID must bind this fixture ownership'
    )
    this.deviceId = requestedDevice
    const browser = need(
      this.fixture.browser,
      'Owned browser/profile descriptor required'
    )
    outsideCheckout(this.root, browser.profileRoot)
    const served = await fetch(
      this.fixture.webUrl.replace(/\/$/, '') +
        '/' +
        basename(this.binding.binding.artifact)
    )
    assert(served.ok, 'Actual served web bundle unavailable')
    const bytes = Buffer.from(await served.arrayBuffer())
    const expected = readFileSync(this.binding.binding.artifact)
    assert(
      bytes.equals(expected),
      'Actual served web JS differs from final bound build'
    )
    this.steps.push({
      name: 'Served final-source JS bytes',
      outcome: 'passed',
      sha256: this.binding.binding.sha256
    })
    const metrics = this.metrics()
    const profile = join(browser.profileRoot, this.surface)
    this.device = await need(this.daemon, 'Daemon required').attach({
      device: this.deviceId,
      platform: 'web',
      driver: 'cdp',
      appId: this.fixture.webUrl,
      url: this.fixture.webUrl,
      artifacts: 'none',
      extra: {
        browser: browser.executable,
        userDataDir: profile,
        windowSize: metrics.width + 'x' + metrics.height
      }
    })
    const port = readFileSync(
      join(profile, 'DevToolsActivePort'),
      'utf8'
    ).split('\n')[0]
    this.browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:' + port,
      defaultViewport: null
    })
    await this.device.openLink({ link: this.fixture.webUrl })
    this.cdp = await this.currentWebTarget()
    await this.cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: metrics.dpr,
      mobile: metrics.coarse
    })
    await this.cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: metrics.coarse,
      maxTouchPoints: 1
    })
    const actual = await this.dom(
      'return {width:innerWidth,height:innerHeight,coarse:matchMedia("(pointer:coarse)").matches,dpr:devicePixelRatio}'
    )
    const matches =
      actual.width === metrics.width &&
      actual.height === metrics.height &&
      actual.coarse === metrics.coarse &&
      actual.dpr === metrics.dpr
    this.steps.push({
      name: 'Viewport and pointer measurements',
      outcome: matches ? 'passed' : 'failed',
      expected: metrics,
      actual: {
        width: actual.width,
        height: actual.height,
        coarse: actual.coarse,
        dpr: actual.dpr
      }
    })
    assert(
      matches,
      'Actual viewport/pointer/pixel scale differs from requested surface'
    )
    this.webFrame = { ...metrics }
  }

  /** Bind the observer to Maestro's current public document, including restored tabs. */
  private async currentWebTarget(): Promise<CDPSession> {
    const browser = need(this.browser, 'Passive browser observer required')
    const origin = new URL(this.fixture.webUrl).origin
    const attribute = 'data-observer-' + randomUUID().replace(/-/g, '')
    const marker = randomUUID()
    const name = JSON.stringify(attribute)
    const value = JSON.stringify(marker)
    const sessions: CDPSession[] = []
    let retained: CDPSession | undefined
    let marked = false
    let ownedPageCount = 0
    let targetId: string | undefined
    try {
      let selected: CDPSession | undefined
      try {
        const result = await this.dom(
          'const node=document.documentElement; const name=' +
            name +
            '; if(node.hasAttribute(name)) throw Error("Observer marker collision");' +
            ' node.setAttribute(name,' +
            value +
            '); return {marked:node.getAttribute(name)===' +
            value +
            ',origin:location.origin}'
        )
        marked = result.marked === true
        assert(
          marked && result.origin === origin,
          'Owned Maestro page marker required'
        )
        const matches: CDPSession[] = []
        for (const page of await browser.pages()) {
          let pageOrigin: string
          try {
            pageOrigin = new URL(page.url()).origin
          } catch {
            continue
          }
          if (pageOrigin !== origin) continue
          ownedPageCount++
          try {
            const session = await page.createCDPSession()
            sessions.push(session)
            const probe = await session.send('Runtime.evaluate', {
              expression:
                '({marker:document.documentElement.getAttribute(' +
                name +
                ')===' +
                value +
                ',origin:location.origin})',
              returnByValue: true
            })
            assert(probe.exceptionDetails == null, 'Public DOM probe failed')
            const observed = object(probe.result.value)
            if (observed.marker === true && observed.origin === origin)
              matches.push(session)
          } catch {
            throw new Error('Owned browser target read probe failed')
          }
        }
        assert(
          matches.length === 1,
          'Exactly one Maestro-marked owned browser target required'
        )
        selected = matches[0]
        const info = await selected.send('Target.getTargetInfo')
        assert(
          info.targetInfo.type === 'page' &&
            new URL(info.targetInfo.url).origin === origin &&
            info.targetInfo.targetId !== '',
          'Marked browser page target identity required'
        )
        targetId = info.targetInfo.targetId
      } finally {
        const cleanup = await this.dom(
          'const node=document.documentElement; const name=' +
            name +
            '; const matched=node.getAttribute(name)===' +
            value +
            '; if(matched) node.removeAttribute(name);' +
            ' return {matched,absent:!node.hasAttribute(name)}'
        )
        assert(
          cleanup.absent === true && (!marked || cleanup.matched === true),
          'Owned Maestro page marker cleanup required'
        )
      }
      retained = need(selected, 'Unique marked browser observer required')
      this.steps.push({
        name: 'Exact Maestro browser target identity',
        outcome: 'passed',
        ownedOrigin: origin,
        ownedPageCount,
        matchCount: 1,
        targetId,
        markerSha256: createHash('sha256').update(marker).digest('hex'),
        markerRemoved: true
      })
      return retained
    } finally {
      for (const session of sessions)
        if (session !== retained) await session.detach()
    }
  }

  metrics(): { width: number; height: number; coarse: boolean; dpr: number } {
    return {
      width:
        this.surface === 'web-wide'
          ? 1440
          : this.surface === 'web-320'
            ? 320
            : 390,
      height:
        this.surface === 'web-wide'
          ? 1000
          : this.surface === 'web-320'
            ? 700
            : 844,
      coarse: this.surface === 'web-touch' || this.surface === 'web-320',
      dpr: 2
    }
  }

  /** Starts a real new app workspace, preserving ordinary device keys and login. */
  async coldOpen(path: string, beforeLaunch?: () => void): Promise<void> {
    const at = new Date().toISOString()
    if (this.native) {
      await this.device.stopApp({ appId: this.fixture.appId })
      beforeLaunch?.()
      await this.device.launchApp({ appId: this.fixture.appId })
      await this.open(path)
    } else {
      // Full navigation through Maestro destroys the previous JS workspace.
      await this.device.openLink({ link: 'about:blank' })
      beforeLaunch?.()
      await this.device.openLink({
        link: this.fixture.webUrl.replace(/\/$/, '') + path
      })
    }
    this.steps.push({
      name: 'Real cold workspace lifecycle',
      at,
      platform: this.surface,
      path,
      keysReset: false
    })
  }

  /** Disable only the browser capability before app scripts, never app state. */
  async withoutWasm(check: () => Promise<void>): Promise<void> {
    assert(
      !this.native && this.cdp != null,
      'No-WASM is a browser capability case'
    )
    const script = await this.cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: 'delete globalThis.WebAssembly;' }
    )
    try {
      await this.coldOpen('/chat')
      await check()
    } finally {
      await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: script.identifier
      })
      await this.coldOpen('/chat')
    }
  }

  async renderedEffects(): Promise<Args> {
    if (this.native)
      return {
        method:
          'Native actual composition is captured; OS Settings and source-bound visual review required',
        publicNodes: (await this.nodes()).filter(n =>
          [
            'chat-message-spotlight',
            'chat-message-spotlight-controls',
            'chat-pinned-band',
            'chat-composer-band'
          ].includes(n.id ?? '')
        )
      }
    return await this.dom(
      'const ids=["chat-message-spotlight","chat-message-spotlight-controls","chat-pinned-band","chat-composer-band"];return {styles:ids.flatMap(id=>{const n=document.querySelector("[data-testid="+JSON.stringify(id)+"]");return n?[n,...n.querySelectorAll("*")].slice(0,60).map(el=>{const s=getComputedStyle(el);return {id:el.getAttribute("data-testid"),background:s.backgroundColor,backdrop:s.backdropFilter,filter:s.filter,transition:s.transitionDuration,animation:s.animationDuration,opacity:s.opacity}}):[]})}'
    )
  }

  async photoMarker(conversationId: string): Promise<Args> {
    return await this.renderedPhoto({
      id: 'chat-avatar',
      childOf: { id: 'chat-conversation-' + conversationId }
    })
  }

  async renderedPhoto(selected: Args): Promise<Args> {
    const box = await this.observedBounds(selected)
    const path = join(this.runDir, 'photo-avatar-' + Date.now() + '.png')
    const capture = await this.captureImage(path)
    const screen: Args = this.native
      ? await this.device.platformInfo()
      : object(object(capture.captureObserver).before)
    const width = Number(screen.screenWidth ?? screen.width)
    const height = Number(screen.screenHeight ?? screen.height)
    assert(
      width > 0 && height > 0,
      'Actual screenshot coordinate space required'
    )
    const result = spawnSync(
      process.env.CHAT2_PYTHON ?? 'python3',
      [
        '-c',
        [
          'import sys,json',
          'from PIL import Image',
          'im=Image.open(sys.argv[1]).convert("RGB"); b=json.loads(sys.argv[2]); sw=float(sys.argv[3]); sh=float(sys.argv[4])',
          'x=round(b["x"]*im.width/sw); y=round(b["y"]*im.height/sh); w=round(b["width"]*im.width/sw); h=round(b["height"]*im.height/sh)',
          'pixels=list(im.crop((x,y,x+w,y+h)).getdata()); assert len(pixels)>20',
          'magenta=sum(r>170 and g<110 and blue>140 for r,g,blue in pixels)/len(pixels)',
          'green=sum(g>170 and r<110 and blue<130 for r,g,blue in pixels)/len(pixels)',
          'print(json.dumps({"magentaFraction":magenta,"greenFraction":green,"actualRenderedSyntheticMarker":magenta>0.08 and green>0.08}))'
        ].join('\n'),
        path,
        JSON.stringify(box),
        String(width),
        String(height)
      ],
      { encoding: 'utf8', timeout: 10000 }
    )
    assert.equal(
      result.status,
      0,
      'Synthetic rendered photo pixel observation failed'
    )
    const proof = JSON.parse(result.stdout) as Args
    assert(
      proof.actualRenderedSyntheticMarker === true,
      'Actual avatar must show both synthetic photo marker colors'
    )
    return { box, capture, path, ...proof }
  }

  async iosRaw(signal = AbortSignal.timeout(30000)): Promise<Uint8Array> {
    const api = this.device as unknown as {
      hierarchyRaw: (options: { signal: AbortSignal }) => Promise<Uint8Array>
    }
    return await api.hierarchyRaw({ signal })
  }

  /** These are fresh observed OS elements, never fabricated clipboard contents. */
  async iosMenuAction(label: string): Promise<void> {
    const read = iosPublicRead(
      await this.iosRaw(),
      { text: exactText(label) },
      'MenuItem'
    )
    const node = need(
      read.element,
      'Observed exact OS menu item required: ' + label
    )
    assert(node.enabled === true, 'Enabled observed OS menu item required')
    await this.tapObserved(node)
  }

  async clipboardSentinel(text: string): Promise<void> {
    if (this.surface !== 'ios') {
      await this.device.setClipboard({ text })
      return
    }
    await this.replaceDraft(text)
    await this.device.longPressOn({ id: 'chat-composer', duration: 600 })
    await this.iosMenuAction('Select All')
    await this.iosMenuAction('Copy')
    await this.replaceDraft('')
    // Paste once to prove that the ordinary OS Copy actually installed the sentinel.
    await this.pasteClipboard()
    assert.equal(
      await this.draft(),
      text,
      'Observed OS sentinel Copy/Paste required'
    )
    await this.replaceDraft('')
  }

  async pasteClipboard(): Promise<void> {
    if (this.surface !== 'ios') {
      await this.device.pasteText()
      return
    }
    await this.device.longPressOn({ id: 'chat-composer', duration: 600 })
    await this.iosMenuAction('Paste')
  }

  /** Browser CDP swipe ignores absolute endpoints; its drag supports real mouse movement. */
  async measuredSwipe(input: {
    startX: number
    startY: number
    endX: number
    endY: number
    duration: number
  }): Promise<void> {
    assert(
      Object.values(input).every(Number.isFinite) &&
        input.duration > 0 &&
        [input.startX, input.startY, input.endX, input.endY].every(
          value => value >= 0
        ),
      'Actual finite measured gesture coordinates required'
    )
    const screen = this.native
      ? await this.device.platformInfo()
      : this.metrics()
    const width = Number(
      'screenWidth' in screen ? screen.screenWidth : screen.width
    )
    const height = Number(
      'screenHeight' in screen ? screen.screenHeight : screen.height
    )
    assert(
      [width, height].every(value => Number.isFinite(value) && value > 0),
      'Actual measured gesture viewport required'
    )
    assert(
      [input.startX, input.endX].every(value => value > 0 && value < width) &&
        [input.startY, input.endY].every(value => value > 0 && value < height),
      'Measured gesture endpoints must stay strictly inside the actual viewport'
    )
    if (this.native) await this.device.swipe(input)
    else
      await this.device.dragAndDrop({
        from: { point: `${input.startX},${input.startY}` },
        to: { point: `${input.endX},${input.endY}` },
        holdDuration: 1,
        duration: input.duration
      })
  }

  async deleteBackward(): Promise<void> {
    if (this.surface !== 'ios') {
      await this.device.pressKey({ key: 'BACKSPACE' })
      return
    }
    const raw = await this.iosRaw()
    const read = iosPublicRead(raw, { text: '^delete$' }, 'Key')
    const key =
      read.element ?? (await this.iosRead({ text: exactText('delete') }, 'Key'))
    const keyboard = iosPublicRead(raw, {}, 'Keyboard')
    assert(
      keyboard.element != null && key.enabled === true,
      'Observed enabled Delete key and Keyboard required'
    )
    const k = need(key.bounds, 'Delete key bounds required')
    const b = need(keyboard.element.bounds, 'Keyboard bounds required')
    assert(
      k.x >= b.x &&
        k.y >= b.y &&
        k.x + k.width <= b.x + b.width &&
        k.y + k.height <= b.y + b.height,
      'Delete key must belong to the actual Keyboard band'
    )
    await this.tapObserved(key)
  }

  async assertEmptyDraft(): Promise<void> {
    if (this.surface !== 'ios') {
      assert.equal(await this.draft(), '')
      return
    }
    const signal = AbortSignal.timeout(90000)
    const inspect = async (): Promise<Args> => {
      const raw = await this.iosRaw(signal)
      const rawPath = join(
        this.runDir,
        'ios-empty-raw-' + Date.now() + '-' + randomUUID() + '.json'
      )
      writeFileSync(rawPath, raw, { mode: 0o600, flag: 'wx' })
      const input = iosPublicRead(raw, { id: 'chat-composer' }, 'TextView')
      assert(
        input.nodes.length < 300,
        'Empty-state tree reached the pinned native snapshot cap; completeness is unavailable'
      )
      const node = need(
        input.element,
        'Fresh raw iOS editable composer required for empty UI'
      )
      assert(
        node.enabled === true &&
          typeof node.placeholderValue === 'string' &&
          node.placeholderValue !== '',
        'Actual enabled composer and observed placeholder required'
      )
      assert(
        node.value == null || node.value === node.placeholderValue,
        'Composer still exposes a nonempty value'
      )
      const send = need(
        iosPublicRead(raw, { text: exactText('Send') }, 'Button').element,
        'Fresh actual Send Button required'
      )
      assert(
        send.enabled === false,
        'Actual Send Button must be positively disabled'
      )
      assert(
        !input.nodes.some(
          n => n.id === 'chat-attachment-chip' || n.label === 'Cancel reply'
        ),
        'Empty UI cannot retain reply or attachment chips'
      )
      const band = need(
        iosPublicRead(raw, { id: 'chat-composer-band' }).element?.bounds,
        'Fresh whole composer band required'
      )
      const box = need(node.bounds, 'Fresh editable bounds required')
      assert(
        box.x >= band.x &&
          box.y >= band.y &&
          box.x + box.width <= band.x + band.width &&
          box.y + box.height <= band.y + band.height,
        'Actual empty composer must fit its whole band'
      )
      return {
        composer: box,
        band,
        send: send.bounds,
        placeholder: node.placeholderValue,
        rawPath,
        rawSha256: createHash('sha256').update(raw).digest('hex')
      }
    }
    const before = await inspect()
    const path = join(this.runDir, 'ios-empty-composer-' + Date.now() + '.png')
    const api = this.device as unknown as {
      screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
    }
    const image = saveCapture(await api.screenshot({ signal }), path)
    const after = await inspect()
    for (const key of ['composer', 'band', 'send'])
      assert.deepEqual(
        before[key],
        after[key],
        'Empty UI geometry changed during capture'
      )
    this.steps.push({
      name: 'Actual native empty composer UI',
      before,
      after,
      image,
      whitespaceFidelity:
        'Native AX trims values; no exact whitespace-string claim',
      actualImageReviewRequired: true
    })
  }

  async recordTransition(
    path: string,
    work: () => Promise<void>,
    recorder: (command: string, args: string[]) => ChildProcess = (
      command,
      args
    ) => spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }),
    inspect: (path: string) => Args = path => {
      const result = spawnSync(
        process.env.CHAT2_FFPROBE ?? 'ffprobe',
        [
          '-v',
          'error',
          '-threads',
          '2',
          '-read_intervals',
          '%+1',
          '-count_frames',
          '-show_entries',
          'stream=codec_type,width,height,nb_read_frames:format=duration',
          '-of',
          'json',
          path
        ],
        { encoding: 'utf8', timeout: 15000 }
      )
      assert(
        result.status === 0,
        'Actual native movie must be readable by ffprobe'
      )
      const actual = object(JSON.parse(result.stdout))
      const streams = Array.isArray(actual.streams)
        ? actual.streams.map(object)
        : []
      assert(
        streams.some(
          stream =>
            stream.codec_type === 'video' &&
            Number(stream.width) > 0 &&
            Number(stream.height) > 0 &&
            Number(stream.nb_read_frames) > 0
        ),
        'Actual decoded video frames required'
      )
      assert(
        Number(object(actual.format).duration) > 0,
        'Actual positive video duration required'
      )
      return {
        ...actual,
        validation:
          'At most the first second decoded with two threads; complete original retained for transition review'
      }
    }
  ): Promise<void> {
    if (this.surface !== 'ios') {
      await this.device.startRecording({ path })
      try {
        await work()
      } finally {
        await this.device.stopRecording()
      }
      return
    }
    assert(
      resolve(dirname(path)) === resolve(this.runDir) &&
        !existsSync(path) &&
        path.endsWith('.mp4'),
      'New owned recording artifact required'
    )
    assert(
      this.deviceId === this.fixture.devices?.ios?.id,
      'Exact owned simulator binding required'
    )
    const args = [
      'simctl',
      'io',
      this.deviceId,
      'recordVideo',
      '--codec',
      'h264',
      path
    ]
    const child = recorder('/usr/bin/xcrun', args)
    const observation: Args = {
      name: 'Read-only owned iOS simulator recording observer',
      path,
      pid: child.pid,
      argv: ['/usr/bin/xcrun', ...args],
      startedAt: new Date().toISOString(),
      uiActions: 'Maestro TypeScript only',
      outcome: 'failed'
    }
    this.steps.push(observation)
    let workCompleted = false
    let stopRequested = false
    let exited = false
    let started = false
    let failure: Error | undefined
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let startResolve: () => void, startReject: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      startResolve = resolve
      startReject = reject
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096)
      if (!started && stderr.includes('Recording started')) {
        started = true
        startResolve()
      }
    })
    child.once('error', error => {
      failure = error
      startReject(error)
    })
    const closed = new Promise<void>(resolve =>
      child.once('close', (code, signal) => {
        exited = true
        exitCode = code
        exitSignal = signal
        if (started && !stopRequested)
          failure = new Error(
            'Recorder exited before the requested transition completed'
          )
        if (!started)
          startReject(
            new Error('Recorder exited before its first-frame acknowledgment')
          )
        resolve()
      })
    )
    const startLimit = setTimeout(() => {
      startReject(
        new Error('No first-frame recording acknowledgment within 10 seconds')
      )
    }, 10000)
    const limit = setTimeout(() => {
      failure = new Error('Owned recording exceeded 120 seconds')
      child.kill('SIGINT')
    }, 120000)
    try {
      await ready
      clearTimeout(startLimit)
      assert(
        !exited && failure == null,
        'Acknowledged recorder must still be running'
      )
      await work()
      workCompleted = true
    } catch (error) {
      observation.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      clearTimeout(startLimit)
      clearTimeout(limit)
      stopRequested = true
      if (!exited) child.kill('SIGINT')
      const wait = async (milliseconds: number): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const result = await Promise.race([
          closed.then(() => true),
          new Promise<boolean>(resolve => {
            timer = setTimeout(() => {
              resolve(false)
            }, milliseconds)
          })
        ])
        clearTimeout(timer)
        return result
      }
      if (!(await wait(15000))) {
        failure = new Error(
          'Owned recording did not finalize within 15 seconds'
        )
        child.kill('SIGKILL')
        assert(
          await wait(2000),
          'Owned recorder did not exit after bounded forced cleanup'
        )
      }
      observation.completedAt = new Date().toISOString()
      observation.exitCode = exitCode
      observation.exitSignal = exitSignal
      observation.stderrSha256 = createHash('sha256')
        .update(stderr)
        .digest('hex')
      assert(failure == null, failure?.message)
      assert(
        exited && exitCode === 0 && exitSignal == null,
        'Native recorder must finalize with a successful exit'
      )
      assert(
        existsSync(path) && statSync(path).size > 32,
        'Actual finalized native recording required'
      )
      observation.stream = inspect(path)
      observation.sha256 = digest(path)
      observation.outcome = workCompleted ? 'passed' : 'failed'
    }
  }

  async iosRead(
    selected: Args,
    expectedType?: string,
    signal = AbortSignal.timeout(30000)
  ): Promise<IosReadNode> {
    assert(
      this.surface === 'ios',
      'iOS read adapter requires its owned iOS session'
    )
    const api = this.device as unknown as {
      hierarchyRaw: (options: { signal: AbortSignal }) => Promise<Uint8Array>
      assertVisible: (
        args: Args,
        options: { signal: AbortSignal }
      ) => Promise<unknown>
    }
    const raw = await api.hierarchyRaw({ signal })
    const path = join(
      this.runDir,
      'ios-public-read-' + Date.now() + '-' + randomUUID() + '.json'
    )
    writeFileSync(path, raw, { mode: 0o600, flag: 'wx' })
    const read = iosPublicRead(raw, selected, expectedType)
    this.steps.push({
      name: 'Passive iOS public element read',
      rawHierarchy: path,
      sha256: createHash('sha256').update(raw).digest('hex'),
      selector: selected,
      expectedType,
      foundInSnapshot: read.element != null
    })
    if (read.element != null) return read.element
    let query: Args
    let literal: string | undefined
    if (typeof selected.id === 'string' && selected.text == null)
      query = { id: selected.id }
    else {
      assert(
        typeof selected.text === 'string' &&
          selected.text.startsWith('^') &&
          selected.text.endsWith('$'),
        'Exact literal native text required for positive fallback'
      )
      literal = selected.text.slice(1, -1)
      assert(
        exactText(literal) === selected.text &&
          /^[\p{L}\p{N} ,_-]+$/u.test(literal),
        'Only actual plain exact text can use the supported deep query'
      )
      query = { text: literal }
    }
    assert(
      selected.childOf == null,
      'Missing scoped native element cannot use an unscoped fallback'
    )
    const element = object(
      object(await api.assertVisible({ ...query, timeout: 120 }, { signal }))
        .element
    )
    if (typeof selected.id === 'string')
      assert(
        element.id === selected.id,
        'Exact returned native public identifier required'
      )
    else
      assert(
        element.accessibilityLabel === literal,
        'Exact returned native public label required'
      )
    if (expectedType != null)
      assert(
        element.class === expectedType,
        'Expected actual native element type required'
      )
    const b = need(
      bounds(element.bounds),
      'Actual returned native public bounds required'
    )
    assert(
      [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
        b.width > 0 &&
        b.height > 0,
      'Positive finite returned public bounds required'
    )
    return {
      index: -1,
      id: element.id as string,
      type: typeof element.class === 'string' ? element.class : undefined,
      text: typeof element.text === 'string' ? element.text : undefined,
      label:
        typeof element.accessibilityLabel === 'string'
          ? element.accessibilityLabel
          : undefined,
      bounds: b,
      enabled:
        typeof element.enabled === 'boolean' ? element.enabled : undefined
    }
  }

  async observedBounds(selected: Args, expectedType?: string): Promise<Bounds> {
    if (this.surface === 'ios')
      return need(
        (await this.iosRead(selected, expectedType)).bounds,
        'Observed iOS public bounds required'
      )
    const id = typeof selected.id === 'string' ? selected.id : undefined
    const child = object(selected.childOf)
    if (!this.native) {
      const text = typeof selected.text === 'string' ? selected.text : undefined
      assert(
        id != null || text != null,
        'Public identifier or text selector required'
      )
      assert(
        selected.childOf == null || typeof child.id === 'string',
        'Public parent identifier required'
      )
      const pattern = text == null ? undefined : new RegExp(text)
      const nodes = await this.nodes(
        typeof child.id === 'string' ? child.id : undefined
      )
      return need(
        nodes.find(node =>
          id != null ? node.id === id : pattern!.test(node.text ?? '')
        )?.bounds,
        'Measured public DOM element bounds required'
      )
    }
    const found =
      id != null && selected.childOf == null
        ? (await this.nodes()).find(
            node => node.id === id && node.bounds != null
          )?.bounds
        : undefined
    return (
      found ??
      need(
        (await this.device.copyTextFrom(selected)).element?.bounds,
        'Measured public element bounds required'
      )
    )
  }

  async publicBounds(id: string): Promise<Bounds> {
    return await this.observedBounds({ id })
  }

  async publicText(id: string): Promise<string> {
    if (!this.native) {
      const result = await this.dom(
        'const n=document.querySelector(' +
          JSON.stringify('[data-testid="' + id + '"]') +
          ');return {text:n?.textContent ?? n?.getAttribute("aria-label")}'
      )
      assert(typeof result.text === 'string', 'Public text required: ' + id)
      return result.text
    }
    if (this.surface === 'ios') {
      const text = (await this.iosRead({ id })).text
      assert(
        typeof text === 'string' && text !== '',
        'Positive observed iOS public text required'
      )
      return text
    }
    const result = await this.device.copyTextFrom({ id })
    assert(
      typeof result.data === 'string',
      'Native public text required: ' + id
    )
    return result.data
  }

  async resize(width: number, height: number): Promise<void> {
    assert(
      !this.native && this.cdp != null,
      'Only owned browser environment may resize'
    )
    const expected = { ...this.metrics(), width, height }
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: expected.dpr,
      mobile: expected.coarse
    })
    const actual = await this.dom(
      'return {width:innerWidth,height:innerHeight,coarse:matchMedia("(pointer:coarse)").matches,dpr:devicePixelRatio}'
    )
    const matches =
      actual.width === width &&
      actual.height === height &&
      actual.coarse === expected.coarse &&
      actual.dpr === expected.dpr
    this.steps.push({
      name: 'Resized viewport and pointer measurements',
      outcome: matches ? 'passed' : 'failed',
      expected,
      actual: {
        width: actual.width,
        height: actual.height,
        coarse: actual.coarse,
        dpr: actual.dpr
      }
    })
    assert(matches, 'Actual resized viewport/pointer/pixel scale differs')
    this.webFrame = expected
    this.webZoom = undefined
  }

  /** OS Settings UI is an explicit observed private recipe, driven only by Maestro. */
  private async settingsActions(
    actions: NonNullable<Chat2Fixture['variants']>[string]['set']
  ): Promise<void> {
    for (const action of actions) {
      assert(
        [
          'launchApp',
          'tapOn',
          'scrollUntilVisible',
          'back',
          'pressKey',
          'setDarkMode'
        ].includes(action.command),
        'Unsupported Settings recipe command'
      )
      if (action.command === 'launchApp')
        assert(
          [
            this.fixture.appId,
            'com.apple.Preferences',
            'com.android.settings'
          ].includes(String(action.args.appId)),
          'Settings recipe may launch only own app or OS Settings'
        )
      const command = this.device[action.command as keyof Chat2Device]
      await command.call(this.device, action.args)
    }
  }

  /** Raw-value predicates observe state; they do not use selector fallbacks. */
  private async settingsVerify(
    checks: NonNullable<Chat2Fixture['variants']>[string]['verify']
  ): Promise<void> {
    for (const check of checks) {
      if (check.rawValue == null) {
        assert(
          this.surface !== 'ios' || check.checked == null,
          'iOS checked-only state proof is unsupported'
        )
        await this.device.assertVisible({ ...check, timeout: 5000 })
        continue
      }
      assert(this.surface === 'ios', 'Observed raw-value contract is iOS-only')
      assert(
        check.id == null &&
          check.text == null &&
          check.checked == null &&
          check.selected == null,
        'Raw state predicate cannot mix selector state claims'
      )
      const device = this.device as unknown as {
        hierarchyRaw: (options: { signal: AbortSignal }) => Promise<Uint8Array>
        screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
      }
      const raw = await device.hierarchyRaw({
        signal: AbortSignal.timeout(10000)
      })
      const file = join(
        this.runDir,
        'native-setting-' + randomUUID() + '.raw-hierarchy.json'
      )
      writeFileSync(file, raw, { flag: 'wx', mode: 0o600 })
      const evidence: Args = {
        name: 'Observed native raw value',
        source: this.binding.source,
        deviceId: this.deviceId,
        daemonName: this.daemonName,
        rawPath: file,
        rawSha256: digest(file),
        expected: check.rawValue,
        observedAt: new Date().toISOString(),
        outcome: 'failed'
      }
      this.steps.push(evidence)
      // Retain actual hierarchy even if parsing or equality fails. No error is inverted.
      evidence.actual = observedNativeValue(raw, check.rawValue)
      evidence.image = saveCapture(
        await device.screenshot({ signal: AbortSignal.timeout(10000) }),
        file + '.png'
      )
      evidence.outcome = 'passed'
    }
  }

  async variant(name: string, sweep: () => Promise<void>): Promise<void> {
    assert(
      [
        'light',
        'dark',
        'large-text',
        'reduced-motion',
        'reduced-transparency'
      ].includes(name),
      'Unknown accessibility variant'
    )
    const row: Args = {
      name,
      startedAt: new Date().toISOString(),
      platform: this.surface
    }
    const recipe = this.fixture.variants?.[this.surface + ':' + name]
    let browserZoomAttempted = false
    const nativeTextBefore = this.native
      ? await this.publicBounds('chat-composer')
      : undefined
    const before = this.native
      ? undefined
      : await this.dom(
          'const n=document.querySelector(\'[data-testid="chat-composer"]\');return {font:n?parseFloat(getComputedStyle(n).fontSize):0,height:n?.getBoundingClientRect().height,scale:visualViewport?.scale??1,dpr:devicePixelRatio,viewportWidth:visualViewport?.width??innerWidth}'
        )
    try {
      if (this.native) {
        if (this.surface === 'android' && name === 'reduced-transparency') {
          assert(
            recipe?.applicability === 'not-applicable' &&
              (recipe.reason?.length ?? 0) > 20,
            'Explicit Android platform-applicability rationale required'
          )
          row.applicability = 'not-applicable'
          row.reason = recipe.reason
          row.environment =
            'No Android OS reduced-transparency preference; inspect actual native fallback composition'
        } else if (name === 'light' || name === 'dark') {
          assert(
            recipe?.applicability === 'applicable' &&
              recipe.restore.length > 0 &&
              recipe.verify.length > 0 &&
              recipe.restoreVerify.length > 0,
            'Native appearance requires observed restoration recipe'
          )
          await this.device.setDarkMode({ enabled: name === 'dark' })
          await this.settingsActions(recipe.set)
          await this.settingsVerify(recipe.verify)
          await this.device.launchApp({ appId: this.fixture.appId })
          row.environment = {
            method: 'Maestro setDarkMode',
            requested: name,
            observed: await this.device.platformInfo()
          }
        } else {
          const actual = need(
            recipe,
            'Observed native OS Settings recipe required for ' + name
          )
          assert(
            actual.applicability === 'applicable' &&
              actual.verify.length > 0 &&
              actual.restoreVerify.length > 0,
            'Native variant requires applied and restored setting observations'
          )
          await this.settingsActions(actual.set)
          await this.settingsVerify(actual.verify)
          row.environment = {
            method: 'Observed OS Settings via Maestro',
            selectors: actual.verify
          }
          await this.device.launchApp({ appId: this.fixture.appId })
        }
      } else {
        const features = [
          {
            name: 'prefers-color-scheme',
            value: name === 'dark' ? 'dark' : 'light'
          },
          {
            name: 'prefers-reduced-motion',
            value: name === 'reduced-motion' ? 'reduce' : 'no-preference'
          },
          {
            name: 'prefers-reduced-transparency',
            value: name === 'reduced-transparency' ? 'reduce' : 'no-preference'
          }
        ]
        await need(this.cdp, 'Owned CDP environment required').send(
          'Emulation.setEmulatedMedia',
          { features }
        )
        await need(this.cdp, 'Owned CDP environment required').send(
          'Emulation.setEmulatedOSTextScale',
          { scale: name === 'large-text' ? 1.5 : 1 }
        )
        const observe = async (): Promise<Args> =>
          await this.dom(
            'const n=document.querySelector(\'[data-testid="chat-composer"]\');return {dark:matchMedia("(prefers-color-scheme:dark)").matches,motion:matchMedia("(prefers-reduced-motion:reduce)").matches,transparency:matchMedia("(prefers-reduced-transparency:reduce)").matches,font:n?parseFloat(getComputedStyle(n).fontSize):0,height:n?.getBoundingClientRect().height,scale:visualViewport?.scale??1,dpr:devicePixelRatio,viewportWidth:visualViewport?.width??innerWidth}'
          )
        let actual = await observe()
        assert(
          actual.dark === (name === 'dark') &&
            actual.motion === (name === 'reduced-motion') &&
            actual.transparency === (name === 'reduced-transparency'),
          'Actual browser media preferences differ'
        )
        if (name === 'large-text') {
          if (!(
            Number(actual.font) > Number(before?.font) ||
            Number(actual.height) > Number(before?.height)
          )) {
            browserZoomAttempted = true
            await this.device.pressKey({ key: 'Cmd+=' })
            await this.device.pressKey({ key: 'Cmd+=' })
            actual = await observe()
            const pixelFont = (value: Args | undefined): number =>
              Number(value?.font) * Number(value?.scale) * Number(value?.dpr)
            if (pixelFont(actual) <= pixelFont(before)) {
              await this.cdp?.send('Emulation.setPageScaleFactor', {
                pageScaleFactor: 1.5
              })
              actual = await observe()
              row.textScaleMethod =
                'Actual browser viewport zoom; OS text scale alone had no app effect'
            } else
              row.textScaleMethod =
                'Observed ordinary browser zoom through Maestro keyboard'
          } else
            row.textScaleMethod =
              'Observed OS text-scale glyph or line-box growth'
          assert(
            Number(actual.font) > Number(before?.font) ||
              Number(actual.height) > Number(before?.height) ||
              Number(actual.font) * Number(actual.scale) * Number(actual.dpr) >
                Number(before?.font) *
                  Number(before?.scale) *
                  Number(before?.dpr),
            'Browser accessibility setting must enlarge actual glyph/line-box or observed viewport pixel scale'
          )
          row.textGrowth = { before, after: actual }
          this.webZoom = await this.captureViewport()
          row.captureGeometry = this.webZoom
        }
        row.environment = actual
      }
      if (this.native && name === 'large-text') {
        const after = await this.publicBounds('chat-composer')
        assert(
          after.height > Number(nativeTextBefore?.height),
          'Native OS large text must enlarge actual composer line-box'
        )
        row.textGrowth = { before: nativeTextBefore, after }
      }
      if (name === 'dark') {
        row.applicability = 'not-applicable'
        row.reason =
          'App has no public dark-theme selector; default ThemeProvider uses tsBallpark. OS-dark is applied and its actual light fallback is reviewed. Mounted tsDark component coverage is separate.'
        row.osPreferenceApplied = true
      }
      await sweep()
      row.outcome = 'passed'
    } finally {
      if (this.native) {
        if (recipe?.applicability === 'applicable') {
          await this.settingsActions(recipe.restore)
          await this.settingsVerify(recipe.restoreVerify)
          await this.device.launchApp({ appId: this.fixture.appId })
        }
      } else {
        if (browserZoomAttempted) await this.device.pressKey({ key: 'Cmd+0' })
        await this.cdp?.send('Emulation.setPageScaleFactor', {
          pageScaleFactor: 1
        })
        await this.cdp?.send('Emulation.setEmulatedMedia', { features: [] })
        await this.cdp?.send('Emulation.setEmulatedOSTextScale', { scale: 1 })
        this.webZoom = undefined
      }
      row.restoredAt = new Date().toISOString()
      this.steps.push({ ...row, variant: name, name: 'Accessibility variant' })
    }
  }

  async step(name: string, run: () => Promise<void>): Promise<void> {
    const row: Args = { name, startedAt: new Date().toISOString() }
    this.steps.push(row)
    try {
      await run()
      row.outcome = 'passed'
    } catch (error) {
      row.outcome = error instanceof Chat2Blocked ? 'blocked' : 'failed'
      row.error = redact(this.fixture, String(error))
      throw error
    } finally {
      row.finishedAt = new Date().toISOString()
    }
  }

  async nodes(parentId?: string): Promise<PublicNode[]> {
    if (this.native)
      return flattenPublicHierarchy(await this.device.hierarchy())
    const result = await this.dom(
      'return {nodes:(' +
        publicWebNodes.toString() +
        ')(' +
        JSON.stringify(parentId) +
        ')}'
    )
    assert(Array.isArray(result.nodes), 'Observed public DOM nodes required')
    return result.nodes as PublicNode[]
  }

  async dom(script: string): Promise<Args> {
    assert(
      !this.native,
      'Browser DOM inspection cannot inspect native/private app state'
    )
    const result = await this.device.evalBrowserScript({
      script: 'return JSON.stringify((()=>{' + script + '})())'
    })
    return typeof result.data === 'string'
      ? object(JSON.parse(result.data))
      : object(result.data)
  }

  async visible(selector: Args, timeout = 1000): Promise<boolean> {
    try {
      await this.device.assertVisible({ ...selector, timeout })
      return true
    } catch (error) {
      if (code(error) !== 'COMMAND_FAILED') throw error
      return false
    }
  }

  async text(text: string): Promise<void> {
    await this.device.tapOn({ text: exactText(text) })
  }

  async id(id: string): Promise<void> {
    await this.device.tapOn({ id })
  }

  async present(id: string): Promise<void> {
    await this.device.assertVisible({ id, timeout: 15000 })
  }

  async absent(id: string): Promise<void> {
    await this.device.assertNotVisible({ id, timeout: 3000 })
  }

  async open(path: string): Promise<void> {
    assert(path.startsWith('/chat'), 'Only fixture chat routes may be opened')
    if (!this.native) {
      await this.dom(
        'history.pushState(null,"",' +
          JSON.stringify(path) +
          ');dispatchEvent(new PopStateEvent("popstate"));return {publicHistoryNavigation:true,path:location.pathname}'
      )
      return
    }
    await this.device.openLink({
      link: this.native
        ? this.fixture.scheme + ':/' + path
        : this.fixture.webUrl.replace(/\/$/, '') + path
    })
    if (this.surface === 'ios') {
      for (let i = 0; i < 10; i++) {
        const nodes = await this.nodes()
        if (nodes.some(n => /Open in .TeamStation/.test(n.text ?? ''))) {
          await this.tapObserved(
            need(
              nodes.find(n => n.text === 'Open' && n.bounds != null),
              'Observed native Open alert button required'
            )
          )
          break
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
  }

  async tapObserved(node: PublicNode): Promise<void> {
    const b = need(node.bounds, 'Observed public element bounds required')
    await this.device.tapOnPoint({
      point: `${Math.round(b.x + b.width / 2)},${Math.round(b.y + b.height / 2)}`
    })
  }

  async hideKeyboard(): Promise<void> {
    if (this.surface !== 'ios') {
      await this.device.hideKeyboard()
      return
    }
    await dismissIosChatKeyboard(this)
  }

  async back(): Promise<void> {
    if (this.surface !== 'ios') {
      await this.device.back()
      return
    }
    const back = (await this.nodes()).find(
      n =>
        n.type?.includes('Button') === true &&
        n.text === 'Back' &&
        n.bounds != null
    )
    await this.tapObserved(need(back, 'Observed public Back control required'))
  }

  /** Typing a standalone at-sign transfers editing to the public member chooser. */
  async typeMentionTrigger(): Promise<void> {
    const proof: Args = {
      name: 'Typed mention trigger opens member chooser',
      outcome: 'failed'
    }
    this.steps.push(proof)
    try {
      await this.append('@')
      await this.present('chat-picker-scene')
      await this.present('chat-picker-header')
      if (this.surface === 'ios') {
        const search = await this.iosRead(
          { text: exactText('Search members') },
          'TextField'
        )
        proof.search = search
        assert(search.enabled === true, 'Actual enabled member Search required')
      } else
        await this.device.assertVisible({
          text: exactText('Search members'),
          enabled: true,
          timeout: 15000
        })
      proof.outcome = 'passed'
    } catch (error) {
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async replaceDraft(text: string): Promise<void> {
    if (this.surface === 'ios') {
      const signal = AbortSignal.timeout(90000)
      const options = { signal }
      const api = this.device as unknown as {
        tapOn: (
          args: Args,
          options: { signal: AbortSignal }
        ) => Promise<unknown>
        tapOnPoint: (
          args: Args,
          options: { signal: AbortSignal }
        ) => Promise<unknown>
        longPressOn: (
          args: Args,
          options: { signal: AbortSignal }
        ) => Promise<unknown>
        inputText: (
          args: Args,
          options: { signal: AbortSignal }
        ) => Promise<unknown>
        screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
      }
      const proof: Args = {
        name: 'Observed iOS editor replacement',
        expectedLength: text.length,
        expectedSha256: createHash('sha256').update(text).digest('hex'),
        outcome: 'failed',
        whitespaceFidelity:
          'Native AX trims outer whitespace; exact ambiguous strings are never accepted'
      }
      this.steps.push(proof)
      const editorReads: IosReadNode[] = []
      proof.editorReads = editorReads
      const read = async (): Promise<IosReadNode> => {
        signal.throwIfAborted()
        const node = await this.iosRead(
          { id: 'chat-composer' },
          'TextView',
          signal
        )
        editorReads.push(node)
        assert(node.enabled === true, 'Actual enabled iOS editor required')
        return node
      }
      const exact = (node: IosReadNode): string | undefined => {
        const value = node.index >= 0 ? node.value : node.text
        return value != null &&
          value !== node.label &&
          value !== node.placeholderValue
          ? value
          : undefined
      }
      const rawEmpty = (node: IosReadNode): boolean =>
        node.index >= 0 &&
        typeof node.placeholderValue === 'string' &&
        node.placeholderValue !== '' &&
        node.value == null
      const tap = async (node: PublicNode): Promise<void> => {
        const box = need(
          node.bounds,
          'Actual observed editor action bounds required'
        )
        await api.tapOnPoint(
          {
            point: `${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}`
          },
          options
        )
      }
      const actionReads: Args[] = []
      proof.actionReads = actionReads
      const actionRaw = async (): Promise<Uint8Array> => {
        const bytes = await this.iosRaw(signal)
        const path = join(
          this.runDir,
          'ios-editor-actions-' + Date.now() + '-' + randomUUID() + '.json'
        )
        writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
        actionReads.push({
          path,
          sha256: createHash('sha256').update(bytes).digest('hex')
        })
        return bytes
      }
      const remove = async (): Promise<void> => {
        await api.longPressOn({ id: 'chat-composer', duration: 600 }, options)
        let raw = await actionRaw()
        const menu = iosPublicRead(
          raw,
          { text: exactText('Select All') },
          'MenuItem'
        ).element
        if (menu != null) {
          assert(menu.enabled === true, 'Enabled observed Select All required')
          await tap(menu)
          raw = await actionRaw()
        }
        // An absent Select All is no claim about selection; the fresh value proves deletion.
        const key = need(
          iosPublicRead(raw, { text: '^delete$' }, 'Key').element,
          'Observed Delete key required for replacement'
        )
        const keyboard = need(
          iosPublicRead(raw, {}, 'Keyboard').element?.bounds,
          'Actual Keyboard required for replacement'
        )
        const box = need(key.bounds, 'Actual Delete key bounds required')
        assert(
          key.enabled === true &&
            box.x >= keyboard.x &&
            box.y >= keyboard.y &&
            box.x + box.width <= keyboard.x + keyboard.width &&
            box.y + box.height <= keyboard.y + keyboard.height,
          'Enabled Delete key must belong to actual Keyboard'
        )
        await tap(key)
      }
      try {
        await api.tapOn({ id: 'chat-composer' }, options)
        const before = await read()
        proof.before = before
        if (!rawEmpty(before)) await remove()
        if (text !== '') {
          await api.inputText({ id: 'chat-composer', text }, options)
          const after = await read()
          proof.after = after
          assert.equal(
            exact(after),
            text,
            'Actual editor must exactly equal requested replacement'
          )
        } else {
          const placeholder = need(
            before.placeholderValue ?? before.label,
            'Observed editor placeholder/label required'
          )
          assert(
            placeholder !== '',
            'Nonempty observed editor placeholder required'
          )
          let reference = before
          if (before.index >= 0 && !rawEmpty(before)) reference = await read()
          let sentinel: string | undefined
          if (!rawEmpty(reference)) {
            const digit = need(
              ['7', '8', '9', '4', '2', '6', '3', '5', '1', '0'].find(
                value => !placeholder.includes(value)
              ),
              'Disjoint editor sentinel required'
            )
            sentinel = digit.repeat(4)
            await api.inputText(
              { id: 'chat-composer', text: sentinel },
              options
            )
            reference = await read()
            proof.sentinel = reference
            assert.equal(
              exact(reference),
              sentinel,
              'Fresh exact sentinel must prove the previous clear'
            )
            await remove()
          }
          const baseLabel = need(
            reference.placeholderValue ?? reference.label,
            'Observed product editor label required'
          )
          assert(baseLabel !== '', 'Nonempty product editor label required')
          const emptyLabels = [baseLabel, baseLabel + ' ' + baseLabel]
          proof.allowedEmptyLabels = emptyLabels
          const verify = async (): Promise<IosReadNode> => {
            const node = await read()
            proof.afterCandidate = node
            const box = need(node.bounds, 'Actual editor geometry required')
            const prior = need(
              reference.bounds,
              'Actual reference editor geometry required'
            )
            assert(
              emptyLabels.includes(node.label ?? ''),
              'Empty editor label must equal the observed product label or exact label-plus-placeholder'
            )
            assert(
              ['x', 'y', 'width', 'height'].every(
                key =>
                  Math.abs(
                    box[key as keyof Bounds] - prior[key as keyof Bounds]
                  ) <= 1
              ),
              'Same editor geometry required after deletion'
            )
            assert(
              rawEmpty(node) ||
                (node.index < 0 &&
                  sentinel != null &&
                  typeof node.label === 'string' &&
                  node.text === node.label &&
                  !node.text.includes(sentinel)),
              'Fresh editor must expose empty placeholder after deleting known disjoint sentinel'
            )
            return node
          }
          proof.after = await verify()
          const send = await this.iosRead(
            { text: exactText('Send') },
            'Button',
            signal
          )
          assert(
            typeof send.enabled === 'boolean',
            'Positive Send state required after clearing editor'
          )
          if (send.enabled)
            proof.preservedAttachment = await this.iosRead(
              { id: 'chat-attachment-chip' },
              undefined,
              signal
            )
          proof.send = send
          const path = join(
            this.runDir,
            'ios-editor-empty-' + Date.now() + '-' + randomUUID() + '.png'
          )
          proof.image = saveCapture(await api.screenshot(options), path)
          proof.revalidated = await verify()
          proof.emptyEvidence =
            sentinel == null
              ? 'Actual raw empty value and placeholder'
              : 'Known disjoint sentinel followed only by observed Delete; fresh placeholder and positive controls; lossy AX value/placeholder distinction qualified'
          proof.actualImageReviewRequired = true
        }
        proof.outcome = 'passed'
      } catch (error) {
        proof.error = error instanceof Error ? error.message : String(error)
        throw error
      }
      return
    }
    await this.id('chat-composer')
    await this.device.eraseText()
    if (text !== '') await this.append(text)
  }

  async append(text: string): Promise<void> {
    await this.device.inputText({
      text,
      ...(this.surface === 'android' ? { keyPress: true } : {})
    })
  }

  async draft(): Promise<string> {
    if (!this.native) {
      const value = (
        await this.dom(
          'return {value:document.querySelector(\'[data-testid="chat-composer"]\')?.value}'
        )
      ).value
      assert(typeof value === 'string', 'Public composer value required')
      return value
    }
    if (this.surface === 'ios') {
      const node = await this.iosRead({ id: 'chat-composer' }, 'TextView')
      assert(
        node.enabled === true,
        'Actual enabled iOS editable composer required'
      )
      if (
        node.value != null &&
        node.value !== node.placeholderValue &&
        node.value !== node.label
      )
        return node.value
      if (node.index < 0 && node.text != null && node.text !== node.label)
        return node.text
      throw new Chat2Blocked(
        'Native composer value is empty, placeholder, or ambiguous; an explicit empty-UI proof is required'
      )
    }
    const value = await this.device.copyTextFrom({ id: 'chat-composer' })
    if (typeof value.data === 'string') return value.data
    throw new Chat2Blocked('Native public composer text could not be read')
  }

  async assertKeyboard(): Promise<void> {
    if (this.surface === 'ios') {
      const signal = AbortSignal.timeout(90000)
      const evidence: Args = {
        name: 'Positive iOS composer above software keyboard',
        focusSignal: 'unavailable-on-ios',
        method:
          'Exact enabled composer and observed Keyboard geometry; raw image and ordinary text delivery require review',
        startedAt: new Date().toISOString()
      }
      this.steps.push(evidence)
      try {
        const before = await readIosComposerKeyboard(this, signal)
        evidence.before = before.geometry
        const api = this.device as unknown as {
          screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
        }
        evidence.image = saveCapture(
          await api.screenshot({ signal }),
          join(this.runDir, 'ios-composer-keyboard-' + Date.now() + '.png')
        )
        const after = await readIosComposerKeyboard(this, signal)
        evidence.after = after.geometry
        assert(
          Object.keys(before.geometry).every(key => {
            const a = before.geometry[key as keyof typeof before.geometry]
            const b = after.geometry[key as keyof typeof after.geometry]
            return (['x', 'y', 'width', 'height'] as const).every(
              axis => Math.abs(a[axis] - b[axis]) <= 1
            )
          }),
          'iOS composer/Keyboard geometry changed during its raw screenshot'
        )
        signal.throwIfAborted()
        evidence.outcome = 'passed'
      } catch (error) {
        evidence.outcome = 'failed'
        evidence.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        evidence.completedAt = new Date().toISOString()
      }
      return
    }
    await this.device.assertVisible({
      id: 'chat-composer',
      focused: true,
      timeout: 2000
    })
    if (!this.native) {
      const focus = await this.dom(
        'return {focused:document.activeElement?.getAttribute("data-testid")==="chat-composer"}'
      )
      assert(focus.focused === true, 'Explicit Reply must focus the composer')
      return
    }
    await this.keyboardVisible()
  }

  async keyboardVisible(): Promise<void> {
    assert(this.native, 'Software keyboard proof is native only')
    if (this.surface === 'ios') {
      await this.assertKeyboard()
      return
    }
    const nodes = await this.nodes()
    if (!nodes.some(n => /keyboard/i.test(n.type ?? ''))) {
      // Direct public key queries avoid the native snapshot's node cap.
      for (const key of ['q', 'w', 'e'])
        await this.device.assertVisible({
          text: '^[' + key + key.toUpperCase() + ']$',
          timeout: 2000
        })
    }
  }

  private async captureViewport(): Promise<CaptureViewport> {
    const value = await this.dom(
      'return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,coarse:matchMedia("(pointer:coarse)").matches,scale:typeof visualViewport==="undefined"||visualViewport===null?1:visualViewport.scale,scrollX,scrollY}'
    )
    assert(
      ['width', 'height', 'dpr', 'scale'].every(
        key =>
          typeof value[key] === 'number' &&
          Number.isFinite(value[key]) &&
          Number(value[key]) > 0
      ) &&
        ['scrollX', 'scrollY'].every(
          key => typeof value[key] === 'number' && Number.isFinite(value[key])
        ) &&
        typeof value.coarse === 'boolean',
      'Actual browser capture geometry required'
    )
    return value as unknown as CaptureViewport
  }

  /** Observe pixels on the same owned tab; never alter its rendering geometry. */
  async captureImage(destination: string): Promise<Args> {
    if (this.native)
      return {
        ...saveCapture(await this.device.screenshot(), destination),
        captureObserver: {
          method: 'maestro-d native screenshot',
          source: this.binding.source
        }
      }
    const cdp = need(this.cdp, 'Owned tab CDP capture observer required')
    const frame = need(
      this.webFrame,
      'Strictly measured browser frame required before capture'
    )
    const expectedRaster = {
      width: frame.width * frame.dpr,
      height: frame.height * frame.dpr
    }
    const before = await this.captureViewport()
    const expected = this.webZoom ?? { ...frame, scale: 1 }
    const parameters = {
      format: 'png' as const,
      captureBeyondViewport: false,
      fromSurface: true
    }
    const observation: Args = {
      name: 'Read-only viewport capture observer',
      method: 'CDP Page.captureScreenshot on the owned Maestro-controlled tab',
      source: this.binding.source,
      parameters,
      frame,
      expectedRaster,
      before,
      zoomGeometry: this.webZoom
    }
    this.steps.push(observation)
    try {
      assert(
        ['width', 'height', 'dpr', 'coarse', 'scale'].every(
          key =>
            before[key as keyof CaptureViewport] ===
            expected[key as keyof typeof expected]
        ),
        'Browser capture geometry differs from its measured frame or observed variant'
      )
      assert(
        Number.isInteger(expectedRaster.width) &&
          Number.isInteger(expectedRaster.height),
        'Measured browser raster must have exact integral dimensions'
      )
      if (this.webZoom != null)
        assert(
          Math.abs(before.width * before.dpr - expectedRaster.width) <
            before.dpr + 0.000001 &&
            Math.abs(before.height * before.dpr - expectedRaster.height) <
              before.dpr + 0.000001,
          'Observed browser zoom must preserve the measured physical frame'
        )
      const screenshot = await cdp.send('Page.captureScreenshot', parameters)
      assert(typeof screenshot.data === 'string', 'Raw CDP PNG bytes required')
      const bytes = Buffer.from(screenshot.data, 'base64')
      const rawPath =
        destination +
        (bytes.subarray(0, 8).equals(PNG) ? '.raw.png' : '.raw.bin')
      writeFileSync(rawPath, bytes, { mode: 0o600, flag: 'wx' })
      const rawSha256 = digest(rawPath)
      observation.rawPath = rawPath
      observation.rawSha256 = rawSha256
      const after = await this.captureViewport()
      observation.after = after
      assert(
        (Object.keys(before) as Array<keyof CaptureViewport>).every(
          key => before[key] === after[key]
        ),
        'Read-only capture changed browser viewport, pixel scale or scroll'
      )
      assert(
        bytes.length >= 24 &&
          bytes.subarray(0, 8).equals(PNG) &&
          bytes.toString('ascii', 12, 16) === 'IHDR',
        'CDP capture must return actual PNG bytes without conversion'
      )
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      observation.actualRaster = { width, height }
      assert(
        width === expectedRaster.width && height === expectedRaster.height,
        'Viewport PNG dimensions differ from the exact measured browser raster'
      )
      writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' })
      observation.outcome = 'passed'
      return {
        rawPath,
        rawSha256,
        sha256: digest(destination),
        format: 'PNG',
        width,
        height,
        captureObserver: observation
      }
    } catch (error) {
      observation.outcome = 'failed'
      throw error
    }
  }

  async shot(kind: string, note: string): Promise<void> {
    assert(/^[a-z][a-z-]+$/.test(kind), 'Safe proof name required')
    const file = `${this.surface}-${kind}-after.png`
    const path = join(
      this.runDir,
      String(this.captures.length + 1).padStart(3, '0') + '-' + file
    )
    const image = await this.captureImage(path)
    this.captures.push({
      file,
      path,
      at: new Date().toISOString(),
      note,
      ...image
    })
  }

  async finish(
    outcome: 'passed' | 'failed' | 'blocked',
    error?: unknown
  ): Promise<string> {
    try {
      if (outcome !== 'passed' && this.device != null) {
        try {
          await this.captureImage(join(this.runDir, 'failure.png'))
        } catch {}
        try {
          privateJson(
            join(this.runDir, 'failure-public-hierarchy.json'),
            await this.device.hierarchy()
          )
        } catch {}
      }
    } finally {
      if (this.cdp != null) await this.cdp.detach().catch(() => {})
      if (this.browser != null) await this.browser.disconnect()
      // Cleanup cannot inherit the UI lease's expired AbortSignal.
      const daemon =
        this.daemon == null
          ? undefined
          : await this.connectCleanup?.().catch(() => this.daemon)
      if (daemon != null) {
        try {
          await daemon.detach(this.deviceId)
        } catch (failure) {
          this.cleanup.detachError = redact(this.fixture, String(failure))
        }
        if (this.native && this.deviceId !== '') {
          try {
            await daemon.stopDevice(this.deviceId, { force: true })
            this.cleanup.deviceStopRequested = true
          } catch (failure) {
            this.cleanup.deviceStopError = redact(this.fixture, String(failure))
          }
        }
        try {
          await daemon.shutdown({ wait: 20000 })
          this.cleanup.daemonStopped = true
        } catch (failure) {
          this.cleanup.daemonError = redact(this.fixture, String(failure))
          daemon.close()
        }
        this.cleanup.daemonPid = daemon.info?.pid
      }
      try {
        if (this.native && this.deviceId !== '') {
          const platform = this.surface
          if (platform === 'ios') {
            const result = spawnSync(
              'xcrun',
              ['simctl', 'shutdown', this.deviceId],
              { encoding: 'utf8', timeout: 10000 }
            )
            const inventory = spawnSync(
              'xcrun',
              ['simctl', 'list', 'devices', '--json'],
              { encoding: 'utf8', timeout: 8000 }
            )
            let state: string | undefined
            if (inventory.status === 0) {
              const data = JSON.parse(inventory.stdout) as {
                devices: Record<string, Array<{ udid: string; state: string }>>
              }
              state = Object.values(data.devices)
                .flat()
                .find(d => d.udid === this.deviceId)?.state
            }
            this.cleanup.nativeAbsence = {
              id: this.deviceId,
              state,
              shutdownExit: result.status,
              absent: state === 'Shutdown'
            }
          } else {
            const adb = process.env.CHAT2_ADB ?? 'adb'
            const name = spawnSync(
              adb,
              ['-s', this.deviceId, 'emu', 'avd', 'name'],
              { encoding: 'utf8', timeout: 3000 }
            )
            if (name.status === 0) {
              assert(
                name.stdout.split('\n')[0].trim() ===
                  this.fixture.devices.android.name,
                'Refuse shutting down another AVD'
              )
              spawnSync(adb, ['-s', this.deviceId, 'emu', 'kill'], {
                encoding: 'utf8',
                timeout: 5000
              })
            }
            let inventory = spawnSync(adb, ['devices', '-l'], {
              encoding: 'utf8',
              timeout: 5000
            })
            for (
              let i = 0;
              i < 30 &&
              inventory.status === 0 &&
              inventory.stdout
                .split('\n')
                .some(l => l.startsWith(this.deviceId + '\t'));
              i++
            ) {
              await new Promise(resolve => setTimeout(resolve, 200))
              inventory = spawnSync(adb, ['devices', '-l'], {
                encoding: 'utf8',
                timeout: 5000
              })
            }
            this.cleanup.nativeAbsence = {
              id: this.deviceId,
              absent:
                inventory.status === 0 &&
                !inventory.stdout
                  .split('\n')
                  .some(l => l.startsWith(this.deviceId + '\t')),
              inventory: inventory.stdout
            }
          }
        }
      } catch (failure) {
        this.cleanup.deviceVerificationError = redact(
          this.fixture,
          String(failure)
        )
      }
      const daemonStatus = spawnSync(
        process.env.MAESTRO_D_BIN ?? 'maestro-d',
        ['status', '--daemon', this.daemonName, '--json'],
        { encoding: 'utf8', timeout: 5000 }
      )
      this.cleanup.daemonAbsence = {
        name: this.daemonName,
        exit: daemonStatus.status,
        absent: daemonStatus.status === 3
      }
      this.cleanup.daemonStopped = daemonStatus.status === 3
      if (this.fixture.cleanupServices) {
        try {
          this.cleanup.services = fixtureControl(this.fixture, 'cleanup')
        } catch (failure) {
          this.cleanup.servicesError = redact(this.fixture, String(failure))
        }
      }
      if (this.reportsDir != null) lockTree(this.reportsDir)
    }
    const receipt = join(this.runDir, 'result.json')
    const cleanupFailed =
      this.cleanup.daemonError != null ||
      this.cleanup.deviceStopError != null ||
      this.cleanup.servicesError != null ||
      this.cleanup.deviceVerificationError != null ||
      this.cleanup.daemonStopped !== true ||
      (this.native && object(this.cleanup.nativeAbsence).absent !== true)
    const result = {
      scenario: this.scenario,
      surface: this.surface,
      variant: process.env.CHAT2_VARIANT ?? 'default',
      outcome: cleanupFailed ? 'failed' : outcome,
      source: this.binding.source,
      binding: this.binding,
      fixtureOwnership: this.fixture.ownershipId,
      device: this.deviceId,
      daemon: this.daemonName,
      environment: this.environment,
      steps: this.steps,
      captures: this.captures,
      cleanup: this.cleanup,
      error:
        error == null
          ? undefined
          : redact(
              this.fixture,
              error instanceof Error ? error.message : 'Unknown harness failure'
            ),
      completedAt: new Date().toISOString(),
      method:
        'All UI actions through maestro-d TypeScript; CDP only for browser environment and read-only viewport capture observation; native capture through Maestro; captures prove composition, no smoothness/physical-haptic claim'
    }
    privateJson(receipt, result)
    if (result.outcome === 'passed' && this.scenario === 'capture') {
      const indexPath = join(this.artifactRoot, 'proof-index.json')
      const index = existsSync(indexPath)
        ? (JSON.parse(readFileSync(indexPath, 'utf8')) as { entries: Args[] })
        : { entries: [] as Args[] }
      for (const image of this.captures) {
        const file = String(image.file)
        const destination = join(this.artifactRoot, file)
        if (existsSync(destination))
          copyFileSync(destination, join(this.runDir, 'replaced-' + file))
        copyFileSync(String(image.path), destination)
        chmodSync(destination, 0o600)
        index.entries = index.entries.filter(row => row.file !== file)
        index.entries.push({
          ...image,
          source: this.binding.source,
          surface: this.surface,
          device: this.deviceId,
          receipt,
          imageFormat: 'PNG',
          evidenceStatus: 'captured',
          scenario: this.scenario,
          driver: this.native
            ? 'maestro-d TypeScript'
            : 'maestro-d TypeScript actions; read-only CDP viewport capture'
        })
      }
      privateJson(indexPath, index)
    }
    if (cleanupFailed)
      throw new Error(
        'Owned resource shutdown failed; see private result receipt'
      )
    return receipt
  }
}
