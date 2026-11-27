/** Public-UI readers for the chat specs: hierarchy, keyboard and composer state, as maestro-d reports them. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'

import type { Chat2UI } from '../../src/test/chat2Ui'
import { pngFromJpeg } from '../../src/test/rasterImage'
import { Chat2Blocked, digest, need } from '../fixtures/chat2Fixture'

export type Args = Record<string, unknown>
export interface Chat2Device {
  pasteText: () => Promise<unknown>
  setClipboard: (args: Args) => Promise<unknown>
  grantPermissions: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>
  setDarkMode: (args: Args) => Promise<unknown>
  stopApp: (args: Args) => Promise<unknown>
  launchApp: (args: Args) => Promise<unknown>
  openLink: (args: Args) => Promise<unknown>
  tapOn: (args: Args, options?: { signal: AbortSignal }) => Promise<unknown>
  tapOnPoint: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>
  longPressOn: (args: Args) => Promise<unknown>
  swipe: (args: Args, options?: { signal: AbortSignal }) => Promise<unknown>
  scroll: (args: Args, options?: { signal: AbortSignal }) => Promise<unknown>
  dragAndDrop: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>
  inputText: (args: Args, options?: { signal: AbortSignal }) => Promise<unknown>
  copyTextFrom: (
    args: Args
  ) => Promise<{ data?: unknown; element?: { bounds?: Bounds } }>
  eraseText: (args?: Args) => Promise<unknown>
  pressKey: (args: Args) => Promise<unknown>
  hideKeyboard: (
    value?: undefined,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>
  back: () => Promise<unknown>
  assertVisible: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>
  assertNotVisible: (args: Args) => Promise<unknown>
  scrollUntilVisible: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>
  doubleTapOn: (args: Args) => Promise<unknown>
  uploadFile: (args: Args) => Promise<unknown>
  addMedia: (args: Args) => Promise<unknown>
  startRecording: (args: Args) => Promise<unknown>
  stopRecording: () => Promise<unknown>
  mockNetwork: (args: Args) => Promise<unknown>
  clearNetworkMocks: () => Promise<unknown>
  setNetworkConditions: (args: Args) => Promise<unknown>
  screenshot: (options?: { signal: AbortSignal }) => Promise<Uint8Array>
  hierarchy: (options?: { signal: AbortSignal }) => Promise<unknown>
  platformInfo: (options?: { signal: AbortSignal }) => Promise<Args>
  evalBrowserScript: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<{ data?: unknown }>
}
export interface Daemon {
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
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** A browser protocol call that cannot stall a run: it fails after `ms`. */
export async function bounded<T>(
  work: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(what + ' timed out'))
        }, ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Parse the same OS window formats used by the Android driver, with positive visibility. */
export function androidImeFrame(
  raw: string,
  viewport: { width: number; height: number }
): Bounds {
  assert(
    /\bInputMethod\b/.test(raw),
    'Actual InputMethod window output required'
  )
  const flags = [...raw.matchAll(/\b(isOnScreen|mInputShown)\s*=\s*(\S+)/g)]
  assert(flags.length > 0, 'Positive Android IME visibility required')
  assert(
    flags.every(flag => flag[2] === 'true'),
    'Hidden, conflicting or unknown Android IME visibility'
  )
  const frames = [
    ...raw.matchAll(/mFrame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/g)
  ]
  const regions = [...raw.matchAll(/touchable region=SkRegion\(([^\n]*)\)/g)]
  const frameMarkers = [...raw.matchAll(/\bmFrame\b/g)]
  const regionMarkers = [...raw.matchAll(/\btouchable region\b/g)]
  assert(
    frameMarkers.length <= 1 && regionMarkers.length <= 1,
    'Unambiguous Android IME window geometry required'
  )
  assert(frames.length === frameMarkers.length, 'Malformed Android IME frame')
  assert(
    regions.length === regionMarkers.length,
    'Malformed Android IME touchable region'
  )
  const region =
    regions[0] == null
      ? undefined
      : /^\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)$/.exec(regions[0][1])
  if (regions.length > 0)
    assert(region != null, 'Single rectangular Android IME region required')
  const parsed = (match: RegExpMatchArray): Bounds => {
    const [x, y, right, bottom] = match.slice(1).map(Number)
    assert(
      [x, y, right, bottom].every(Number.isSafeInteger),
      'Finite Android IME coordinates required'
    )
    assert(right > x && bottom > y, 'Positive Android IME frame required')
    return { x, y, width: right - x, height: bottom - y }
  }
  const box = parsed(
    need(frames[0] ?? region, 'Observed Android IME frame required')
  )
  if (frames[0] != null && region != null) {
    const touch = parsed(region)
    assert(
      touch.x >= box.x &&
        touch.y >= box.y &&
        touch.x + touch.width <= box.x + box.width &&
        touch.y + touch.height <= box.y + box.height,
      'Android IME region contradicts its window frame'
    )
  }
  assert(
    [viewport.width, viewport.height].every(
      value => Number.isFinite(value) && value > 0
    ) &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width + 2 &&
      box.y + box.height <= viewport.height + 2,
    'Android IME frame must fit the observed native viewport'
  )
  return box
}
export interface CaptureViewport {
  width: number
  height: number
  dpr: number
  coarse: boolean
  scale: number
  scrollX: number
  scrollY: number
}

/**
 * The iOS simulator driver's snapshot holds at most this many nodes. It was
 * 300, which a long chat history's off-screen mounted rows filled before the
 * controls on screen; the lookups that read past the cap remain for a tree
 * larger still.
 */
export const IOS_SIMULATOR_SNAPSHOT_CAP = 5000

export interface PublicNode {
  id?: string
  type?: string
  text?: string
  bounds?: Bounds
  focused?: boolean
  enabled?: boolean
}

export interface IosReadNode extends PublicNode {
  index: number
  parentIndex?: number
  value?: string
  placeholderValue?: string
  label?: string
}

export function isIosSendButton(node: IosReadNode): boolean {
  return (
    node.id === 'chat-send' ||
    (node.type === 'Button' && (node.label === 'Send' || node.text === 'Send'))
  )
}

/**
 * An element's type as the simulator driver names it: WDA on a phone reports
 * the full XCUIElementType name for the same element.
 */
export const nativeClass = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.replace(/^XCUIElementType/, '') : undefined

/**
 * The raw iOS tree as flat nodes. The simulator runner serves them as JSON;
 * a physical device's WebDriverAgent serves its XML tree, whose `name` is the
 * accessibility identifier when one is set and otherwise repeats the label.
 */
export function iosRawTree(raw: Uint8Array): { nodes: unknown[] } {
  const text = Buffer.from(raw).toString('utf8')
  if (!text.trimStart().startsWith('<')) {
    const tree = object(JSON.parse(text))
    assert(Array.isArray(tree.nodes), 'Actual raw native node array required')
    return { nodes: tree.nodes }
  }
  const dom = new JSDOM(text, { contentType: 'text/xml' })
  try {
    const nodes: Args[] = []
    const walk = (element: Element, parent?: Args): void => {
      const attr = (key: string): string | undefined =>
        element.getAttribute(key) ?? undefined
      const number = (key: string): number => Number(attr(key))
      const name = attr('name')
      const label = attr('label')
      const node: Args = {
        ...(parent == null ? {} : { parentIndex: parent.index }),
        type: (attr('type') ?? element.tagName).replace(/^XCUIElementType/, ''),
        ...(name != null && name !== label ? { identifier: name } : {}),
        ...(label == null ? {} : { label }),
        ...(attr('value') == null ? {} : { value: attr('value') }),
        ...(attr('placeholderValue') == null
          ? {}
          : { placeholderValue: attr('placeholderValue') }),
        rect: {
          x: number('x'),
          y: number('y'),
          width: number('width'),
          height: number('height')
        },
        enabled: attr('enabled') === 'true'
      }
      // A phone lists a Text nested in a Text of the same words as a second,
      // identical node inside the first; it is one element.
      const repeat =
        parent != null &&
        ['type', 'identifier', 'label', 'value', 'placeholderValue'].every(
          key => node[key] === parent[key]
        ) &&
        JSON.stringify(node.rect) === JSON.stringify(parent.rect)
      const own = repeat ? parent : { index: nodes.length, ...node }
      if (!repeat) nodes.push(own)
      for (const child of Array.from(element.children)) walk(child, own)
    }
    walk(dom.window.document.documentElement)
    return { nodes }
  } finally {
    dom.window.close()
  }
}

/** Read native metadata without copying text or changing the clipboard. */
export function iosPublicRead(
  raw: Uint8Array,
  selected: Args,
  expectedType?: string
): { nodes: IosReadNode[]; element?: IosReadNode } {
  const tree = iosRawTree(raw)
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

/**
 * The iOS driver answers assertNotVisible from one snapshot and ignores its
 * timeout. Ask again until the element is gone or the timeout passes, so an
 * overlay that is still animating out, or a row an event is about to update,
 * is not read as one that stays.
 */
export async function pollNotVisible(
  once: (args: Args) => Promise<unknown>,
  args: Args,
  pause = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 500))
  }
): Promise<unknown> {
  if (typeof args.timeout !== 'number') return await once(args)
  const until = Date.now() + args.timeout
  for (;;) {
    try {
      return await once(args)
    } catch (error) {
      // The simulator says "element visible"; WebDriverAgent on a phone says
      // "should not be visible (cause: element is visible)".
      const visible =
        /unexpectedly visible|element (?:is )?visible|should not be visible/.test(
          error instanceof Error ? error.message : String(error)
        )
      if (!visible || Date.now() >= until) throw error
      await pause()
    }
  }
}

/**
 * The iOS simulator's snapshot stops at a node cap, so a long history can
 * leave an exact-text element out, and the driver resolves only a selector
 * without pattern characters through its uncapped element query. An exact
 * pattern that was not found is asked once more as its literal text, and
 * the answer counts only when the found element's label is that text.
 */
export async function queryExactVisible(
  once: (args: Args, options?: { signal: AbortSignal }) => Promise<unknown>,
  args: Args,
  options?: { signal: AbortSignal }
): Promise<unknown> {
  try {
    return await once(args, options)
  } catch (error) {
    return await queryExactLiteral(once, args, error, options)
  }
}

/**
 * A tap on an exact text that the capped snapshot left out lands on the
 * element the literal query finds with exactly that label, at its centre.
 */
export async function queryExactTap(
  tapOnce: (args: Args, options?: { signal: AbortSignal }) => Promise<unknown>,
  visibleOnce: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>,
  tapOnPoint: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>,
  args: Args,
  options?: { signal: AbortSignal }
): Promise<unknown> {
  try {
    return await tapOnce(args, options)
  } catch (error) {
    const found = await queryExactLiteral(visibleOnce, args, error, options)
    const box = bounds(object(object(found).element).bounds)
    if (box == null || box.width <= 0 || box.height <= 0) throw error
    return await tapOnPoint(
      {
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2)
      },
      options
    )
  }
}

/**
 * Text typed into a field named by its id. The iOS simulator driver finds an
 * id by substring in its capped snapshot, so `chat-composer` can resolve to
 * `chat-composer-band` when the field itself was capped out; it then taps
 * the band's centre and checks the band for the text. A field the snapshot
 * holds exactly is typed into as before; otherwise the field is found by its
 * exact identifier query (a text selector, which the snapshot compares only
 * with labels and values), tapped at its centre, and typed into there. The
 * driver's own check needs the id again, so each caller reads the field back.
 */
export async function queryExactInput(
  inputOnce: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>,
  visibleOnce: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>,
  tapOnPoint: (
    args: Args,
    options?: { signal: AbortSignal }
  ) => Promise<unknown>,
  args: Args,
  options?: { signal: AbortSignal },
  record: (step: Args) => void = () => {}
): Promise<unknown> {
  const id = args.id
  if (
    typeof id !== 'string' ||
    id === '' ||
    /[*+?^$\\(){}[\]|]/.test(id) ||
    !Object.keys(args).every(key => key === 'id' || key === 'text')
  )
    return await inputOnce(args, options)
  try {
    await visibleOnce({ id: exactText(id), timeout: 1 }, options)
    return await inputOnce(args, options)
  } catch (error) {
    if (code(error) !== 'COMMAND_FAILED') throw error
  }
  const element = object(
    object(await visibleOnce({ text: id, timeout: 3000 }, options)).element
  )
  assert(
    exactIdAnswer(element, id),
    'Exact queried native input field required: ' + id
  )
  const box = need(
    bounds(element.bounds),
    'Queried input field bounds required'
  )
  assert(
    box.width > 0 && box.height > 0,
    'Positive queried input field required'
  )
  const point = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2)
  }
  await tapOnPoint(point, options)
  record({
    name: 'iOS input field found by its exact identifier query',
    id,
    point,
    outcome: 'passed'
  })
  return await inputOnce({ text: args.text }, options)
}

/** The exact pattern's literal, asked once; rethrows `error` otherwise. */
async function queryExactLiteral(
  once: (args: Args, options?: { signal: AbortSignal }) => Promise<unknown>,
  args: Args,
  error: unknown,
  options?: { signal: AbortSignal }
): Promise<unknown> {
  const pattern = args.text
  const literal =
    typeof pattern === 'string' &&
    Object.keys(args).every(key => key === 'text' || key === 'timeout') &&
    /^\^.*\$$/s.test(pattern)
      ? pattern.slice(1, -1).replace(/\\(.)/gs, '$1')
      : undefined
  if (
    code(error) !== 'COMMAND_FAILED' ||
    literal == null ||
    literal === '' ||
    exactText(literal) !== pattern ||
    /[*+?^$\\(){}[\]|]/.test(literal)
  )
    throw error
  let found: unknown
  try {
    // One snapshot pass and one element query.
    found = await once({ text: literal, timeout: 1 }, options)
  } catch {
    throw error
  }
  const element =
    found != null && typeof found === 'object'
      ? (found as { element?: Args }).element
      : undefined
  const label =
    typeof element?.accessibilityLabel === 'string' &&
    element.accessibilityLabel !== ''
      ? element.accessibilityLabel
      : element?.text
  if (label !== literal) throw error
  return found
}

/**
 * Whether the iOS simulator driver's answer to an id lookup is that exact
 * element. The capped snapshot matches an id as a substring and answers with
 * the matched element's own identifier, so `chat-composer` can come back as
 * `chat-composer-band`; the uncapped element query matches the identifier
 * exactly and answers with XCTest's element UUID instead.
 */
export function exactIdAnswer(element: Args, id: string): boolean {
  return (
    element.id === id ||
    (typeof element.id === 'string' &&
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(
        element.id
      ))
  )
}

/** The Android composer's placeholder, which an empty field reads as. */
export const ANDROID_COMPOSER_PLACEHOLDER = 'Message'

/** A phone's WebDriverAgent typing rate, in keys per second. */
export const PHONE_TYPING_KEYS_PER_SECOND = 15

/**
 * WebDriverAgent types 60 keys a second by default. An iPhone 15 lost the two
 * keys after an e-mail's first letter, both times, while its keyboard left
 * the shifted layout; a phone types at a quarter of that rate.
 */
export function phoneTyping(
  platform: 'ios' | 'android',
  physical: boolean
): { typingFrequency?: number } {
  return platform === 'ios' && physical
    ? { typingFrequency: PHONE_TYPING_KEYS_PER_SECOND }
    : {}
}

/** iOS exposes no focus flag: require the actual composer above an observed IME. */
export async function readIosComposerKeyboard(
  ui: Pick<Chat2UI, 'device'> & {
    physical?: boolean
    omitsEnabledTrue?: boolean
  },
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
  const same = (a: Bounds, b: Bounds): boolean =>
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  // The keyboard reports its final frame at once while the composer band is
  // still moving with it: geometry that is not yet right is read again until
  // it has settled, and only then judged.
  let previous: { keyboard: Bounds; band: Bounds } | undefined
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
        // WebDriverAgent's normalized hierarchy, on a phone or a simulator,
        // omits enabled:true, as Android's does; an explicit false is still
        // refused.
        if (id === 'chat-composer')
          assert(
            ui.omitsEnabledTrue === true || ui.physical === true
              ? observed[0].enabled !== false
              : observed[0].enabled === true,
            'Enabled iOS composer required'
          )
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
      assert(
        exactIdAnswer(element, id),
        'Exact positive public element required: ' + id
      )
      if (id === 'chat-composer')
        assert(
          ui.omitsEnabledTrue === true || ui.physical === true
            ? element.enabled !== false
            : element.enabled === true,
          'Enabled iOS composer required'
        )
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
    const valid =
      inside(band, history) &&
      inside(composer, band) &&
      inside(keyboard, history) &&
      band.y + band.height <= keyboard.y + 1
    const settled =
      previous != null &&
      same(previous.keyboard, keyboard) &&
      same(previous.band, band)
    previous = { keyboard, band }
    // Geometry that is already right needs no second read; wrong geometry
    // is judged once it has stopped moving.
    if (!valid && !settled) {
      await new Promise(resolve => setTimeout(resolve, 50))
      continue
    }
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

/** Android's assertion response can be opaque; read focused editor geometry independently. */
export async function readAndroidComposerKeyboard(
  ui: Pick<Chat2UI, 'device' | 'readAndroidIme'>,
  signal: AbortSignal,
  timeoutMs = 10000
): Promise<{
  nodes: PublicNode[]
  geometry: Record<'composer' | 'band' | 'keyboard', Bounds>
}> {
  const api = ui.device as unknown as {
    assertVisible: (
      args: Args,
      options: { signal: AbortSignal }
    ) => Promise<unknown>
    hierarchy: (options: { signal: AbortSignal }) => Promise<unknown>
  }
  const deadline = Date.now() + timeoutMs
  const remaining = (): number => {
    signal.throwIfAborted()
    assert(
      Date.now() < deadline,
      'Android focused composer observation deadline expired'
    )
    return Math.max(1, deadline - Date.now())
  }
  signal.throwIfAborted()
  await api.assertVisible(
    {
      id: 'chat-composer',
      focused: true,
      enabled: true,
      timeout: Math.min(2000, remaining())
    },
    { signal }
  )
  const ime = await ui.readAndroidIme({
    signal,
    timeoutMs: Math.min(5000, remaining())
  })
  const nodes = flattenPublicHierarchy(await api.hierarchy({ signal }))
  const unique = (id: string): PublicNode => {
    const matches = nodes.filter(node => node.id === id)
    assert(
      matches.length === 1,
      'Unique fresh Android public element required: ' + id
    )
    return matches[0]
  }
  const editor = unique('chat-composer')
  assert(
    editor.type === 'EditText' &&
      editor.focused === true &&
      editor.enabled !== false,
    'Fresh focused Android EditText required after enabled/focused selector proof'
  )
  const band = need(
    unique('chat-composer-band').bounds,
    'Actual Android composer band required'
  )
  const composer = need(
    editor.bounds,
    'Actual Android composer geometry required'
  )
  assert(
    [band, composer].every(
      box =>
        [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
        box.width > 0 &&
        box.height > 0
    ),
    'Positive finite Android composer geometry required'
  )
  assert(
    band.x >= 0 &&
      band.y >= 0 &&
      band.x + band.width <= ime.viewport.width + 2 &&
      band.y + band.height <= ime.viewport.height + 2,
    'Android composer band must fit the observed native viewport'
  )
  assert(
    composer.x >= band.x &&
      composer.y >= band.y &&
      composer.x + composer.width <= band.x + band.width &&
      composer.y + composer.height <= band.y + band.height,
    'Android composer must remain inside its observed band'
  )
  assert(
    band.y + band.height <= ime.bounds.y + 2,
    'Android composer band must be above the observed IME'
  )
  remaining()
  return { nodes, geometry: { composer, band, keyboard: ime.bounds } }
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
  // Long conversations make every iOS read slow on a loaded simulator, and a
  // phone's read of a fully loaded history (E9's top) slower still.
  timeout = 900000
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
    assert(
      exactIdAnswer(found, id),
      'Exact positive public element required: ' + id
    )
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
      // A physical phone can still be settling its keyboard while a raster is
      // taken: that frame proves nothing, and the next observation decides
      // (within the bounded capture budget). Only a frame bracketed by one
      // unchanged geometry is ever accepted.
      if (!same(before, after)) {
        reference = undefined
        since = Date.now()
        row.movedAcrossScreenshot = Number(row.movedAcrossScreenshot ?? 0) + 1
        continue
      }
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

export function object(value: unknown): Args {
  return value != null && typeof value === 'object' ? (value as Args) : {}
}
export function bounds(raw: unknown): Bounds | undefined {
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

/** Both system pickers put newly imported photos first. iOS also labels the
 * entire grid with its children's descriptions and exposes off-screen cells. */
export function recentPickerPhoto(
  tree: unknown,
  platform: string
): PublicNode | undefined {
  const nodes = flattenPublicHierarchy(tree)
  const photos = nodes.filter(
    node => /^Photo(?: taken|,)/.test(node.text ?? '') && node.bounds != null
  )
  if (platform !== 'ios') return photos[0]
  const screen = nodes.find(
    node => node.type?.endsWith('Application') === true
  )?.bounds
  const bar = nodes.find(
    node =>
      node.type?.endsWith('NavigationBar') === true &&
      (node.id === 'Photos' || node.text === 'Photos')
  )?.bounds
  if (screen == null || bar == null) return
  return photos
    .filter(node => {
      const b = node.bounds!
      return (
        node.type?.endsWith('Image') === true &&
        b.width > 0 &&
        b.height > 0 &&
        b.x >= screen.x &&
        b.x + b.width <= screen.x + screen.width &&
        b.y >= bar.y + bar.height &&
        b.y + b.height <= screen.y + screen.height
      )
    })
    .sort((a, b) =>
      a.bounds!.y === b.bounds!.y
        ? a.bounds!.x - b.bounds!.x
        : a.bounds!.y - b.bounds!.y
    )[0]
}

export async function tapImportedPhoto(
  device: {
    hierarchy: () => Promise<unknown>
    tapOnPoint: (options: { point: string }) => Promise<unknown>
  },
  platform: string
): Promise<void> {
  let previous: PublicNode | undefined
  const tile = await until(
    async () => {
      const current = recentPickerPhoto(await device.hierarchy(), platform)
      const prior = previous
      previous = current
      if (
        current?.bounds == null ||
        prior?.bounds == null ||
        current.text !== prior.text
      )
        return
      const { x, y, width, height } = current.bounds
      if (
        x === prior.bounds.x &&
        y === prior.bounds.y &&
        width === prior.bounds.width &&
        height === prior.bounds.height
      )
        return current.bounds
    },
    'the newly imported photo to settle in the system picker',
    30000
  )
  await device.tapOnPoint({
    point:
      Math.round(tile.x + tile.width / 2) +
      ',' +
      Math.round(tile.y + tile.height / 2)
  })
}

/** Measure one scoped Android node from fresh public ancestry without copying text. */
export function androidScopedBounds(
  raw: unknown,
  selected: Args,
  expectedType?: string
): Bounds {
  const scope = object(selected.childOf)
  assert(
    typeof scope.id === 'string' &&
      scope.id !== '' &&
      Object.keys(scope).every(key => key === 'id'),
    'Exact public Android parent identifier required'
  )
  assert(
    Object.keys(selected).every(key =>
      ['id', 'text', 'childOf'].includes(key)
    ) &&
      (typeof selected.id === 'string' || typeof selected.text === 'string'),
    'Supported public Android target selector required'
  )
  const seen = new Set<object>()
  const nodes: Array<{ node: Args; parents: Args[] }> = []
  const visit = (value: unknown, parents: Args[]): void => {
    assert(
      value != null && typeof value === 'object' && !Array.isArray(value),
      'Actual normalized Android hierarchy required'
    )
    assert(!seen.has(value), 'Android public ancestry must not cycle or repeat')
    seen.add(value)
    const node = object(value)
    nodes.push({ node, parents })
    if (node.children != null) {
      assert(Array.isArray(node.children), 'Actual public child array required')
      for (const child of node.children) visit(child, [...parents, node])
    }
  }
  visit(raw, [])
  const parents = nodes.filter(entry => entry.node.id === scope.id)
  assert(parents.length === 1, 'Unique exact public Android parent required')
  const parent = parents[0].node
  const pattern =
    typeof selected.text === 'string' ? new RegExp(selected.text) : undefined
  const matches = nodes.filter(
    entry =>
      entry.parents.includes(parent) &&
      (selected.id == null || entry.node.id === selected.id) &&
      (pattern == null ||
        (typeof entry.node.text === 'string' &&
          pattern.test(entry.node.text))) &&
      (expectedType == null || entry.node.type === expectedType)
  )
  assert(matches.length === 1, 'Unique scoped public Android target required')
  const measured = (node: Args): Bounds => {
    const b = need(
      bounds(node.bounds),
      'Actual scoped public Android bounds required'
    )
    assert(
      [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
        b.x >= 0 &&
        b.y >= 0 &&
        b.width > 0 &&
        b.height > 0,
      'Positive finite scoped public Android bounds required'
    )
    return b
  }
  const outer = measured(parent)
  const box = measured(matches[0].node)
  assert(
    box.x >= outer.x - 1 &&
      box.y >= outer.y - 1 &&
      box.x + box.width <= outer.x + outer.width + 1 &&
      box.y + box.height <= outer.y + outer.height + 1,
    'Scoped public Android target must fit its observed parent'
  )
  return box
}

const positiveAndroidBox = (box: Bounds | undefined): box is Bounds =>
  box != null &&
  [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
  box.x >= 0 &&
  box.y >= 0 &&
  box.width > 0 &&
  box.height > 0
const insideAndroidBox = (child: Bounds, parent: Bounds): boolean =>
  positiveAndroidBox(child) &&
  positiveAndroidBox(parent) &&
  child.x >= parent.x - 1 &&
  child.y >= parent.y - 1 &&
  child.x + child.width <= parent.x + parent.width + 1 &&
  child.y + child.height <= parent.y + parent.height + 1

/** Retain genuine normalized ancestry instead of inferring relationships from flat labels. */
function androidTree(raw: unknown): Array<{ node: Args; parents: Args[] }> {
  const entries: Array<{ node: Args; parents: Args[] }> = []
  const seen = new Set<object>()
  const visit = (value: unknown, parents: Args[]): void => {
    assert(
      value != null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !seen.has(value),
      'Actual acyclic normalized Android ancestry required'
    )
    seen.add(value)
    const node = value as Args
    entries.push({ node, parents })
    if (node.children != null) {
      assert(
        Array.isArray(node.children),
        'Actual Android child array required'
      )
      for (const child of node.children) visit(child, [...parents, node])
    }
  }
  visit(raw, [])
  return entries
}

/** Visibility-only proof: a disabled Send is still an actual visible Button. */
export function androidComposerControl(
  raw: unknown,
  label: string,
  viewport: { width: number; height: number }
): Args {
  assert(
    ['Attach', 'Send', 'Cancel reply'].includes(label),
    'Exact composer control label required'
  )
  const frame = { x: 0, y: 0, ...viewport }
  assert(positiveAndroidBox(frame), 'Positive actual native viewport required')
  const entries = androidTree(raw)
  assert(
    !entries.some(({ node }) =>
      ['chat-message-spotlight', 'chat-picker-scene'].includes(String(node.id))
    ),
    'Physical spotlight/picker must be absent'
  )
  const one = (id: string, type: string): Args => {
    const matches = entries.filter(({ node }) => node.id === id)
    assert(
      matches.length === 1 &&
        matches[0].node.type === type &&
        positiveAndroidBox(bounds(matches[0].node.bounds)),
      'Unique typed positive ' + id + ' required'
    )
    return matches[0].node
  }
  const history = one('chat-message-history', 'ScrollView')
  const band = one('chat-composer-band', 'ViewGroup')
  const outer = bounds(history.bounds)!
  const container = bounds(band.bounds)!
  assert(
    insideAndroidBox(outer, frame) &&
      insideAndroidBox(container, outer) &&
      insideAndroidBox(container, frame),
    'Actual band/history must fit native viewport'
  )
  const matches = entries.filter(
    ({ node }) => node.type === 'Button' && node.text === label
  )
  assert(
    matches.length === 1 && matches[0].parents.includes(band),
    'Unique actual composer Button must descend from its band'
  )
  const box = bounds(matches[0].node.bounds)
  assert(
    positiveAndroidBox(box) &&
      insideAndroidBox(box, container) &&
      insideAndroidBox(box, frame),
    'Positive actual Button must fit band/viewport'
  )
  return matches[0].node
}

export interface AndroidCaptureIme {
  state: 'open' | 'already-closed'
  flags: Args
  keyboard?: Bounds
}

/** An omitted window/Boolean/surface is never evidence that the keyboard is closed. */
export function androidCaptureImeState(
  raw: string,
  viewport: { width: number; height: number }
): AndroidCaptureIme {
  assert(
    positiveAndroidBox({ x: 0, y: 0, ...viewport }),
    'Actual positive Android viewport required'
  )
  const windows = [
    ...raw.matchAll(/Window #\d+ Window\{[^\n]*\bInputMethod\}/g)
  ]
  assert(windows.length === 1, 'One actual InputMethod window required')
  const rest = raw.slice(windows[0].index)
  const next = rest.search(/\n\s*(?:Window #\d+ |mGlobalConfiguration=)/)
  const block = next < 0 ? rest : rest.slice(0, next)
  const flag = (name: string, required = false): boolean | undefined => {
    const matches = [
      ...block.matchAll(new RegExp('\\b' + name + '\\s*=\\s*(\\S+)', 'g'))
    ]
    assert(
      matches.length <= 1 && (!required || matches.length === 1),
      'Unambiguous explicit ' + name + ' required'
    )
    if (matches.length === 0) return undefined
    assert(
      ['true', 'false'].includes(matches[0][1]),
      'Literal observed ' + name + ' required'
    )
    return matches[0][1] === 'true'
  }
  const flags: Args = {
    isOnScreen: flag('isOnScreen', true),
    isVisible: flag('isVisible'),
    mInputShown: flag('mInputShown'),
    mHasSurface: flag('mHasSurface')
  }
  const surfaces = [...block.matchAll(/\bSurface:\s+shown=(\S+)/g)]
  assert(surfaces.length <= 1, 'Unambiguous IME surface visibility required')
  if (surfaces.length === 1) {
    assert(
      ['true', 'false'].includes(surfaces[0][1]),
      'Literal surface visibility required'
    )
    flags.surfaceShown = surfaces[0][1] === 'true'
  }
  assert(
    flags.surfaceShown != null || flags.mHasSurface != null,
    'Explicit observed IME surface state required'
  )
  const closed =
    flags.isOnScreen === false &&
    flags.isVisible !== true &&
    flags.mInputShown !== true &&
    flags.surfaceShown !== true &&
    (flags.surfaceShown === false || flags.mHasSurface === false)
  return closed
    ? { state: 'already-closed', flags }
    : { state: 'open', flags, keyboard: androidImeFrame(raw, viewport) }
}

export interface AndroidDismissReference {
  initialState: AndroidCaptureIme['state']
  history: Bounds
  band: Bounds
  composer: Bounds
  text: string
  reply: number
  chips: number
  keyboard?: Bounds
  viewport: { width: number; height: number }
}

/** Immutable actual context for one capture dismissal, without a fabricated prior-open frame. */
export function androidDismissReference(
  raw: unknown,
  state: AndroidCaptureIme,
  viewport: AndroidDismissReference['viewport'],
  expectedText?: string
): AndroidDismissReference {
  const entries = androidTree(raw)
  assert(
    !entries.some(({ node }) =>
      ['chat-message-spotlight', 'chat-picker-scene'].includes(String(node.id))
    ),
    'Physical spotlight/picker must be absent before capture dismissal'
  )
  const one = (id: string, type: string): Args => {
    const matches = entries.filter(({ node }) => node.id === id)
    assert(
      matches.length === 1 &&
        matches[0].node.type === type &&
        positiveAndroidBox(bounds(matches[0].node.bounds)),
      'Unique typed actual ' + id + ' required'
    )
    return matches[0].node
  }
  const history = bounds(one('chat-message-history', 'ScrollView').bounds)!
  const band = bounds(one('chat-composer-band', 'ViewGroup').bounds)!
  const editor = one('chat-composer', 'EditText')
  const composer = androidScopedBounds(
    raw,
    { id: 'chat-composer', childOf: { id: 'chat-composer-band' } },
    'EditText'
  )
  assert(
    typeof editor.text === 'string' &&
      editor.enabled !== false &&
      insideAndroidBox(band, history) &&
      insideAndroidBox(history, { x: 0, y: 0, ...viewport }) &&
      insideAndroidBox(composer, band),
    'Actual enabled editor/text and contained band/history required'
  )
  // Android exposes the placeholder and a draft containing its literal text identically.
  const text =
    expectedText === '' && editor.text === ANDROID_COMPOSER_PLACEHOLDER
      ? ''
      : editor.text
  if (expectedText != null)
    assert.equal(text, expectedText, 'Actual dismissal context changed: text')
  if (state.state === 'open')
    assert(
      editor.focused === true && positiveAndroidBox(state.keyboard),
      'Actual focused open composer and IME required'
    )
  return Object.freeze({
    initialState: state.state,
    history: Object.freeze({ ...history }),
    band: Object.freeze({ ...band }),
    composer: Object.freeze({ ...composer }),
    text,
    reply: entries.filter(
      ({ node }) => node.type === 'Button' && node.text === 'Cancel reply'
    ).length,
    chips: entries.filter(({ node }) => node.id === 'chat-attachment-chip')
      .length,
    viewport: Object.freeze({ ...viewport }),
    ...(state.state === 'open'
      ? { keyboard: Object.freeze({ ...state.keyboard! }) }
      : {})
  })
}

export function androidClosedCaptureGeometry(
  raw: unknown,
  before: AndroidDismissReference
): Args {
  const current = androidDismissReference(
    raw,
    { state: 'already-closed', flags: {} },
    before.viewport,
    before.text
  )
  for (const key of ['history', 'text', 'reply', 'chips'] as const)
    assert(
      JSON.stringify(current[key]) === JSON.stringify(before[key]),
      'Actual dismissal context changed: ' + key
    )
  const entries = androidTree(raw)
  const navigation = ['Home', 'Videos', 'Schedule', 'Search', 'Chat'].map(
    text => {
      const found = entries.filter(
        ({ node }) => node.type === 'View' && node.text === text
      )
      assert(
        found.length === 1 &&
          positiveAndroidBox(bounds(found[0].node.bounds)) &&
          insideAndroidBox(bounds(found[0].node.bounds)!, current.history),
        'Unique actually visible navigation target required: ' + text
      )
      return found[0]
    }
  )
  const parent = navigation[0].parents.at(-1)
  assert(
    parent != null &&
      navigation.every(entry => entry.parents.at(-1) === parent) &&
      navigation[4].node.selected === true,
    'Actual navigation must share its parent with Chat selected'
  )
  const boxes = navigation.map(entry => bounds(entry.node.bounds)!)
  const top = Math.min(...boxes.map(box => box.y))
  const bottom = Math.max(...boxes.map(box => box.y + box.height))
  assert(
    boxes.every(
      box =>
        Math.abs(box.y - top) <= 1 && Math.abs(box.y + box.height - bottom) <= 1
    ) && current.band.y + current.band.height <= top + 1,
    'Closed composer must remain above the complete aligned navigation'
  )
  if (before.initialState === 'open')
    assert(
      positiveAndroidBox(before.keyboard) &&
        current.band.y >= before.keyboard.y &&
        current.composer.y >= before.keyboard.y,
      'Actually open composer must move into its observed former IME region'
    )
  else
    assert(
      before.keyboard == null,
      'Already-closed proof must not invent prior keyboard movement'
    )
  androidComposerControl(raw, 'Attach', before.viewport)
  if (current.text.trim() !== '' || current.chips > 0)
    androidComposerControl(raw, 'Send', before.viewport)
  else
    assert(
      !entries.some(
        ({ node }) => node.type === 'Button' && node.text === 'Send'
      ),
      'An empty composer must hide the Send button'
    )
  return {
    history: current.history,
    band: current.band,
    composer: current.composer,
    text: current.text,
    reply: current.reply,
    chips: current.chips,
    navigation: navigation.map(entry => ({
      text: entry.node.text,
      bounds: entry.node.bounds,
      selected: entry.node.selected
    }))
  }
}

/** Verify an observed native value against one exact public raw-node identity. */
export function observedNativeValue(
  raw: Uint8Array,
  expected: {
    identifier: string
    type: string
    label: string
    value?: string
    selected?: boolean
  }
): {
  identifier: string
  type: string
  label: string
  value?: string
  selected?: boolean
} {
  assert(
    expected != null && typeof expected === 'object',
    'Observed raw value predicate required'
  )
  for (const field of ['identifier', 'type', 'label'] as const)
    assert(
      typeof expected[field] === 'string',
      'Exact observed raw strings required'
    )
  // One observed state: a value, or (as an iOS 27 segment exposes its
  // choice) a selection.
  assert(
    (typeof expected.value === 'string') !==
      (typeof expected.selected === 'boolean'),
    'Exactly one observed raw value or selection required'
  )
  assert(
    expected.type !== '' &&
      (expected.identifier !== '' || expected.label !== ''),
    'Named observed native identity required'
  )
  const tree = iosRawTree(raw)
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
  if (typeof expected.value === 'string')
    assert(
      typeof matches[0].value === 'string' &&
        matches[0].value === expected.value,
      'Actual native raw value differs from observed predicate'
    )
  else
    assert(
      (matches[0].selected === true) === expected.selected,
      'Actual native raw selection differs from observed predicate'
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

export function code(error: unknown): string | undefined {
  const value = object(error).code
  return typeof value === 'string' ? value : undefined
}
export const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
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
    try {
      const { png, ...proof } = pngFromJpeg(raw)
      writeFileSync(destination, png, { mode: 0o600, flag: 'wx' })
      conversion = proof
    } catch (error) {
      throw new Chat2Blocked(
        'JPEG driver capture did not convert: ' +
          (error instanceof Error ? error.message : String(error)) +
          '; raw bytes retained'
      )
    }
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

/**
 * The placeholder an empty iOS editor actually shows. XCUI reports it as
 * placeholderValue; the devicelab driver omits that attribute, but iOS still
 * names an empty React Native editor "<label> <placeholder>" with no value.
 * The composer's label and placeholder are the same text, so only that exact
 * doubled name counts.
 */
export function emptyEditorPlaceholder(node: {
  label?: string
  value?: string
  placeholderValue?: string
}): string | undefined {
  if (typeof node.placeholderValue === 'string' && node.placeholderValue !== '')
    return node.placeholderValue
  const label = node.label ?? ''
  const half = (label.length - 1) / 2
  if (
    node.value != null ||
    !Number.isInteger(half) ||
    half < 1 ||
    label[half] !== ' ' ||
    label.slice(0, half) !== label.slice(half + 1)
  )
    return undefined
  return label.slice(half + 1)
}
