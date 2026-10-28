/**
 * Real-app chat2 scenarios. Run with node -r sucrase/register after source freeze.
 * Private env supplies CHAT2_FIXTURE_FILE, CHAT2_ARTIFACTS, CHAT2_SOURCE,
 * CHAT2_SURFACE, MAESTRO_D and the explicitly selected device/client paths.
 * prepare validates disposable inputs; capture records composition; E1–E11
 * assert behavior; E12 validates fresh per-surface functional receipts.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import emojiData from 'emojibase-data/en/compact.json'

import type {
  ChatDevice,
  ChatMyKeys,
  TeamStationClient
} from '../../common/api'
import { MAX_ATTACHMENT_SIZE } from '../../common/chatContent'
import { blobLength } from '../../common/chatCrypto/stream'
import { HttpError } from '../../common/errors'
import { gumboOfUserId } from '../../common/userId'
import {
  CHAT2_SCENARIOS,
  CHAT2_SURFACES,
  Chat2Blocked,
  type Chat2Fixture,
  type Chat2Message,
  type Chat2Scenario,
  type Chat2Surface,
  digest,
  fixtureClient,
  fixtureControl,
  fixturePeer,
  loadChat2Fixture,
  need,
  privateJson,
  requireAfterArchive,
  sourceBinding
} from '../../test/chat2Fixture.e2e'
import {
  androidScopedBounds,
  Chat2UI,
  exactText,
  flattenPublicHierarchy,
  iosPublicRead,
  iosRawTree,
  nativeClass,
  type PublicNode,
  readAndroidComposerKeyboard,
  readIosComposerKeyboard,
  saveCapture,
  until
} from '../../test/chat2Maestro.e2e'
import { type MessageView, reactionKey } from './engine/apply'

type Peer = Awaited<ReturnType<typeof fixturePeer>>
type Json = Record<string, unknown>
/** A public control that must lie inside the pinch-zoomed visual viewport. */
interface ZoomedWebControl {
  name: string
  css: string
  text?: string
  /** An editor normally counts only once focused; a reveal before its tap does not. */
  requireFocus?: boolean
}

/**
 * In-page helpers that move the browser history as a person does. The app
 * leaves an unowned (script) scroll to its pending reader restoration, which
 * a virtualized history re-applies whenever measured rows change its extent;
 * a wheel first hands the reader to the person, as real input always does.
 * Needs `h`, the history element, in scope.
 */
export const WEB_OWNED_SCROLL =
  "const own=to=>{const was=h.scrollTop,next=Math.min(Math.max(0,h.scrollHeight-h.clientHeight),Math.max(0,to));if(next===was)return false;h.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:next-was}));h.scrollTop=next;h.dispatchEvent(new Event('scroll'));return h.scrollTop!==was};" +
  'const center=n=>{const b=n.getBoundingClientRect(),p=h.getBoundingClientRect();return own(h.scrollTop+b.top+b.height/2-(p.top+h.clientHeight/2))};'

const zoomedComposer: ZoomedWebControl = {
  name: 'composer',
  css: '[data-testid="chat-composer"]',
  requireFocus: false
}
interface WebContinuationPlan {
  schema: 1
  kind: 'post-lifecycle-web-continuity'
  applicationSource: string
  harnessSource: string
  baseline: { path: string; sha256: string }
  revocationEvidence: { path: string; sha256: string }
  historicalI1: Array<{ path: string; sha256: string }>
  review: { path: string; sha256: string }
  installedDeviceObservation: { path: string; sha256: string }
  originalRevokedAt: string
  replacement: Pick<
    ChatDevice,
    'id' | 'name' | 'platform' | 'boxPublicKey' | 'signPublicKey' | 'createdAt'
  >
}
interface WebContinuationState {
  userId: string
  devices: ChatDevice[]
  keys: Omit<ChatMyKeys, 'generations'> & {
    generations: Array<Omit<ChatMyKeys['generations'][number], 'box'>>
  }
}
type MentionHeaderGeometry = Record<
  'header' | 'title' | 'cancel' | 'search',
  NonNullable<PublicNode['bounds']>
>
interface VisibleReaderAnchor {
  id: string
  bounds: NonNullable<PublicNode['bounds']>
  band: { top: number; bottom: number }
}

/** Android's header marker is a background leaf; its typed controls share the scene. */
export function androidMentionHeaderGeometry(
  raw: unknown
): MentionHeaderGeometry {
  const geometry = {
    header: androidScopedBounds(raw, {
      id: 'chat-picker-header',
      childOf: { id: 'chat-picker-scene' }
    }),
    title: androidScopedBounds(
      raw,
      {
        text: exactText('Mention a member'),
        childOf: { id: 'chat-picker-scene' }
      },
      'TextView'
    ),
    cancel: androidScopedBounds(
      raw,
      { text: exactText('Cancel'), childOf: { id: 'chat-picker-scene' } },
      'Button'
    ),
    search: androidScopedBounds(
      raw,
      {
        text: exactText('Search members'),
        childOf: { id: 'chat-picker-content' }
      },
      'EditText'
    )
  }
  // Also prove that Search content actually belongs to this same picker scene.
  androidScopedBounds(raw, {
    id: 'chat-picker-content',
    childOf: { id: 'chat-picker-scene' }
  })
  const { header, title, cancel, search } = geometry
  for (const box of [title, cancel])
    assert(
      box.x >= header.x - 1 &&
        box.y >= header.y - 1 &&
        box.x + box.width <= header.x + header.width + 1 &&
        box.y + box.height <= header.y + header.height + 1,
      'Actual Android typed header siblings must fit the measured marker'
    )
  assert(
    cancel.width >= 47 &&
      cancel.height >= 47 &&
      title.x + title.width <= cancel.x &&
      header.y + header.height <= search.y,
    'Actual Android Cancel target/title nonoverlap and Search-below geometry required'
  )
  return geometry
}

/** Native header content can be an AX sibling of its marker; prove the picker tree. */
export function iosMentionHeaderGeometry(raw: Uint8Array): {
  geometry: MentionHeaderGeometry
  scope: string
  rawNodeCount: number
} {
  const { nodes } = iosPublicRead(raw, { id: 'chat-picker-scene' })
  type Node = (typeof nodes)[number]
  type Box = NonNullable<PublicNode['bounds']>
  const byIndex = new Map(nodes.map(node => [node.index, node]))
  const parents = (node: Node): Node[] => {
    const result: Node[] = []
    const seen = new Set([node.index])
    let index = node.parentIndex
    while (index != null) {
      assert(!seen.has(index), 'Acyclic actual picker ancestry required')
      seen.add(index)
      const parent = need(
        byIndex.get(index),
        'Complete picker ancestry required'
      )
      result.push(parent)
      index = parent.parentIndex
    }
    return result
  }
  const unique = (matches: Node[], name: string): Node => {
    assert(matches.length === 1, 'Unique actual picker ' + name + ' required')
    return matches[0]
  }
  const named = (id: string): Node =>
    unique(
      nodes.filter(node => node.id === id),
      id
    )
  const box = (node: Node): Box => {
    const value = need(node.bounds, 'Actual picker bounds required')
    assert(
      [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
        value.width > 0 &&
        value.height > 0,
      'Positive finite picker bounds required'
    )
    return { ...value }
  }
  const inside = (child: Box, parent: Box): boolean =>
    child.x >= parent.x - 1 &&
    child.y >= parent.y - 1 &&
    child.x + child.width <= parent.x + parent.width + 1 &&
    child.y + child.height <= parent.y + parent.height + 1
  const under = (node: Node, ancestor: Node): boolean =>
    parents(node).some(parent => parent.index === ancestor.index)
  const scene = named('chat-picker-scene')
  const transition = named('chat-picker-transition')
  const header = named('chat-picker-header')
  const content = named('chat-picker-content')
  parents(scene)
  assert(
    under(transition, scene) &&
      under(header, transition) &&
      under(content, transition),
    'Header and content must belong to the actual picker transition and scene'
  )
  const exact = (label: string, type: string): Node =>
    unique(
      nodes.filter(node => node.label === label && node.type === type),
      label
    )
  const title = exact('Mention a member', 'StaticText')
  const cancel = exact('Cancel', 'Button')
  const search = exact('Search members', 'TextField')
  assert(
    under(title, transition) &&
      under(cancel, transition) &&
      under(search, content),
    'Actual title, Cancel and Search picker ancestry required'
  )
  assert(
    cancel.enabled === true && search.enabled === true,
    'Positive enabled picker Cancel and Search required'
  )
  const geometry = {
    header: box(header),
    title: box(title),
    cancel: box(cancel),
    search: box(search)
  }
  assert(
    geometry.cancel.width >= 47 && geometry.cancel.height >= 47,
    'Actual Cancel must retain its 48-unit target within one border-rounding unit'
  )
  assert(
    geometry.title.x + geometry.title.width <= geometry.cancel.x,
    'Actual picker title and Cancel must not overlap'
  )
  const same = (a: Box, b: Box): boolean =>
    (['x', 'y', 'width', 'height'] as const).every(
      key => Math.abs(a[key] - b[key]) <= 0.01
    )
  const direct = under(title, header) && under(cancel, header)
  if (!direct) {
    const cancelParents = new Set(parents(cancel).map(node => node.index))
    const carrier = parents(title).filter(
      node =>
        cancelParents.has(node.index) &&
        node.index !== header.index &&
        node.type === 'Other' &&
        node.parentIndex === header.parentIndex &&
        same(box(node), geometry.header)
    )
    unique(carrier, 'same-bounds native header sibling')
  }
  assert(
    inside(geometry.header, box(scene)) &&
      inside(box(content), box(scene)) &&
      inside(geometry.title, geometry.header) &&
      inside(geometry.cancel, geometry.header) &&
      inside(geometry.search, box(content)) &&
      inside(geometry.search, box(scene)),
    'Actual picker title, Cancel and Search must occupy their measured bands'
  )
  assert(
    geometry.header.y + geometry.header.height <= geometry.search.y,
    'Actual picker header must be above Search'
  )
  box(transition)
  return {
    geometry,
    scope: direct
      ? 'header descendants'
      : 'same-bounds native header sibling under picker transition',
    rawNodeCount: nodes.length
  }
}

/** Compare one public selector coordinate space without assuming native raster scale. */
export async function observeMentionHeader(
  ui: Chat2UI,
  timeout = 8000
): Promise<Json> {
  type Geometry = MentionHeaderGeometry
  const samples: Array<{
    startedAt: string
    completedAt?: string
    bounds: Partial<Geometry>
    nativeScope?: string
    rawHierarchy?: { path: string; sha256: string; nodes?: number }
  }> = []
  const coordinateSpace =
    ui.surface === 'ios'
      ? 'One raw native public hierarchy coordinate space; no raster conversion assumed'
      : ui.native
        ? 'Native public scoped element bounds; no raster conversion assumed'
        : 'Public DOM CSS pixels'
  const observation: Json = {
    name: 'Settled mention chooser header geometry',
    outcome: 'failed',
    coordinateSpace,
    containmentTolerance: 1,
    stabilityTolerance: 0.01,
    stableForMs: 200,
    timeoutMs: timeout,
    samples
  }
  ui.steps.push(observation)
  try {
    if (!ui.native) {
      await ui.present('chat-picker-scene')
      await ui.present('chat-picker-header')
    }
    const deadline = Date.now() + timeout
    let reference: Geometry | undefined
    let stableSince = Date.now()
    for (;;) {
      const sample: (typeof samples)[number] = {
        startedAt: new Date().toISOString(),
        bounds: {}
      }
      samples.push(sample)
      if (samples.length > 24) samples.splice(1, 1)
      if (ui.surface === 'ios') {
        assert(
          Date.now() < deadline,
          'Timed out waiting for stable chooser geometry'
        )
        const raw = await ui.iosRaw(
          AbortSignal.timeout(Math.max(1, deadline - Date.now()))
        )
        const directory = mkdtempSync(join(ui.runDir, 'picker-geometry-'))
        const path = join(directory, 'hierarchy.json')
        writeFileSync(path, raw, { mode: 0o600, flag: 'wx' })
        sample.rawHierarchy = {
          path,
          sha256: createHash('sha256').update(raw).digest('hex')
        }
        const actual = iosMentionHeaderGeometry(raw)
        sample.rawHierarchy.nodes = actual.rawNodeCount
        sample.bounds = actual.geometry
        sample.nativeScope = actual.scope
      } else if (ui.surface === 'android') {
        assert(
          Date.now() < deadline,
          'Timed out waiting for stable chooser geometry'
        )
        const actual = await ui.androidHierarchy(
          AbortSignal.timeout(Math.max(1, deadline - Date.now()))
        )
        sample.rawHierarchy = actual.evidence as {
          path: string
          sha256: string
        }
        sample.bounds = androidMentionHeaderGeometry(actual.raw)
        sample.nativeScope =
          'typed scene descendants physically inside header marker'
      } else {
        sample.bounds.header = {
          ...(await ui.observedBounds({
            id: 'chat-picker-header',
            childOf: { id: 'chat-picker-scene' }
          }))
        }
        sample.bounds.title = {
          ...(await ui.observedBounds(
            {
              text: exactText('Mention a member'),
              childOf: { id: 'chat-picker-header' }
            },
            undefined
          ))
        }
        sample.bounds.cancel = {
          ...(await ui.observedBounds(
            {
              text: exactText('Cancel'),
              childOf: { id: 'chat-picker-header' }
            },
            undefined
          ))
        }
        sample.bounds.search = {
          ...(await ui.observedBounds({
            text: exactText('Search members'),
            childOf: { id: 'chat-picker-content' }
          }))
        }
      }
      sample.completedAt = new Date().toISOString()
      const geometry = sample.bounds as Geometry
      for (const box of Object.values(geometry))
        assert(
          [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
            box.width > 0 &&
            box.height > 0,
          'Actual measured chooser header and Search bounds required'
        )
      const before = reference
      const stable =
        before != null &&
        (Object.keys(geometry) as Array<keyof Geometry>).every(name =>
          (['x', 'y', 'width', 'height'] as const).every(
            key => Math.abs(geometry[name][key] - before[name][key]) <= 0.01
          )
        )
      if (!stable) {
        reference = geometry
        stableSince = Date.now()
      }
      assert(
        Date.now() < deadline,
        'Timed out waiting for stable chooser geometry'
      )
      if (stable && Date.now() - stableSince >= 200) {
        const { header, title, cancel, search } = geometry
        // The shared header centers a minimum hit target across a subpixel border.
        // Allow at most one measured coordinate unit, without assuming raster scale.
        for (const box of [title, cancel])
          assert(
            box.y >= header.y - 1 &&
              box.y + box.height <= header.y + header.height + 1 &&
              box.x >= header.x - 1 &&
              box.x + box.width <= header.x + header.width + 1,
            'Chooser title and Cancel must be contained in the measured header'
          )
        assert(
          header.y + header.height <= search.y,
          'Chooser title and Cancel header must be above Search, never a footer'
        )
        observation.outcome = 'passed'
        return {
          mentionHeaderGeometry: {
            ...geometry,
            coordinateSpace,
            containmentTolerance: 1,
            titleScope: sample.nativeScope ?? 'chat-picker-header',
            searchScope: 'chat-picker-content'
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } catch (error) {
    observation.error = error instanceof Error ? error.message : String(error)
    throw error
  }
}

/**
 * The innermost public node with an exact label. iOS reports a navigation tab
 * as Other (role tab has no trait) and labels the tab list with the selected
 * tab's label too, so the first match can be the whole capsule.
 */
export function innermostLabelled(
  nodes: PublicNode[],
  label: string
): NonNullable<PublicNode['bounds']> {
  type Box = NonNullable<PublicNode['bounds']>
  const area = (b: Box): number => b.width * b.height
  const contains = (outer: Box, inner: Box): boolean =>
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  const own = nodes
    .filter(n => n.text === label)
    .map(n => n.bounds)
    .filter((b): b is Box => b != null && b.width > 0 && b.height > 0)
    .sort((a, b) => area(a) - area(b))
  assert(
    own.length > 0 && own.slice(1).every(b => contains(b, own[0])),
    'One innermost public element required: ' + label
  )
  return own[0]
}

/** The shared shell's floating tab bar, by its tabs' own labels. */
export const SHELL_TABS = ['Home', 'Videos', 'Schedule', 'Search', 'Chat']

/**
 * Where a labelled control lies against the floating tab bar: the driver taps
 * a control's centre, and over the bar that tap lands on a tab.
 */
export function clearOfTabBar(
  nodes: PublicNode[],
  label: string
): {
  target: NonNullable<PublicNode['bounds']>
  barTop: number
  clear: boolean
} {
  const target = innermostLabelled(nodes, label)
  // The first node is the application's own frame, the screen; a scrolled
  // page's rows extend past it.
  const height = need(
    nodes[0]?.bounds,
    'Observed application frame required'
  ).height
  // A page can name a tab's word too (a Chat setting); the bar's tabs are the
  // ones in the screen's lowest quarter.
  const tabs = SHELL_TABS.map(tab =>
    nodes.filter(
      n =>
        n.text === tab &&
        n.bounds != null &&
        n.bounds.height > 0 &&
        n.bounds.y >= height * 0.75
    )
  )
  assert(
    tabs.every(found => found.length > 0),
    'Observed floating tab bar required'
  )
  const barTop = Math.min(...tabs.flat().map(n => n.bounds!.y))
  return { target, barTop, clear: target.y + target.height <= barTop }
}

function captureRaster(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  )
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  // The native RPC screenshot may be JPEG; inspect its actual frame header.
  if (bytes[0] === 255 && bytes[1] === 216)
    for (let offset = 2; offset + 4 <= bytes.length;) {
      assert(bytes[offset] === 255, 'Native screenshot JPEG marker required')
      const marker = bytes[offset + 1]
      if (marker === 255) {
        offset += 1
        continue
      }
      if (marker === 217 || marker === 218) break
      const length = bytes.readUInt16BE(offset + 2)
      assert(
        length >= 2 && offset + 2 + length <= bytes.length,
        'Native screenshot JPEG segment required'
      )
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207
        ].includes(marker)
      ) {
        assert(length >= 8, 'Native screenshot JPEG frame required')
        return {
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5)
        }
      }
      offset += 2 + length
    }
  throw new Error('Observed native PNG or JPEG screenshot dimensions required')
}

/** Read the selected clone from public native ancestry, independently of actions. */
export function iosSpotlightCaptureGeometry(
  raw: Uint8Array,
  expected: Pick<Chat2Message, 'id' | 'body'>
): {
  geometry: Record<string, NonNullable<PublicNode['bounds']>>
  compact: boolean
  bodyApplicable: boolean
  rawNodeCount: number
} {
  type Box = NonNullable<PublicNode['bounds']>
  const tree = iosRawTree(raw)
  const nodes = tree.nodes as Json[]
  assert(
    nodes.every(node => node != null && typeof node === 'object'),
    'Actual public native nodes required'
  )
  const byIndex = new Map<number, Json>()
  for (const node of nodes) {
    assert(Number.isInteger(node.index), 'Actual native node index required')
    const index = node.index as number
    assert(!byIndex.has(index), 'Unique native node indices required')
    byIndex.set(index, node)
  }
  const under = (node: Json, ancestor: Json): boolean => {
    const visited = new Set<number>()
    let parent = node.parentIndex
    while (typeof parent === 'number') {
      assert(!visited.has(parent), 'Acyclic public native ancestry required')
      visited.add(parent)
      if (parent === ancestor.index) return true
      const owner = byIndex.get(parent)
      if (owner == null) return false
      parent = owner.parentIndex
    }
    return false
  }
  const unique = (matches: Json[], name: string): Json => {
    assert(matches.length === 1, 'Unique selected ' + name + ' required')
    return matches[0]
  }
  const rect = (node: Json): Box => {
    const value = node.rect as Box | undefined
    assert(
      value != null &&
        [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
        value.width > 0 &&
        value.height > 0,
      'Positive finite selected native bounds required'
    )
    return value
  }
  const root = unique(
    nodes.filter(node => node.identifier === 'chat-message-spotlight'),
    'spotlight root'
  )
  const named = (id: string): Json =>
    unique(
      nodes.filter(node => node.identifier === id && under(node, root)),
      id
    )
  const controls = rect(named('chat-message-spotlight-controls'))
  const panel = rect(named('chat-message-spotlight-panel'))
  const geometry: Record<string, Box> = { controls, panel }
  const previews = nodes.filter(
    node =>
      node.identifier === 'chat-message-spotlight-preview' && under(node, root)
  )
  const same = (a: Box, b: Box): boolean =>
    (['x', 'y', 'width', 'height'] as const).every(
      key => Math.abs(a[key] - b[key]) <= 1
    )
  // Compact presentation gives the whole controls band to its actions panel.
  if (previews.length === 0 && same(panel, controls))
    return {
      geometry,
      compact: true,
      bodyApplicable: false,
      rawNodeCount: nodes.length
    }
  const preview = unique(previews, 'preview')
  geometry.preview = rect(preview)
  // The preview's animated layer keeps one window-tall frame, so XCUI lists
  // it right after the preview, at the preview's origin, not inside it.
  const next = nodes[nodes.indexOf(preview) + 1] as Json | undefined
  const nextBox = next?.rect as Box | undefined
  const layer =
    next != null &&
    next.identifier == null &&
    next.parentIndex === preview.parentIndex &&
    nextBox != null &&
    Math.abs(nextBox.x - geometry.preview.x) <= 1 &&
    Math.abs(nextBox.y - geometry.preview.y) <= 1 &&
    nextBox.height >= geometry.preview.height
      ? next
      : undefined
  const inPreview = (node: Json): boolean =>
    under(node, preview) || (layer != null && under(node, layer))
  const inside = (child: Box, parent: Box): boolean =>
    child.x >= parent.x - 1 &&
    child.y >= parent.y - 1 &&
    child.x + child.width <= parent.x + parent.width + 1 &&
    child.y + child.height <= parent.y + parent.height + 1
  const intersects = (a: Box, b: Box): boolean =>
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
  assert(
    inside(geometry.preview, controls),
    'Selected preview must occupy its controls band'
  )
  const scroll = unique(
    nodes.filter(node => node.type === 'ScrollView' && inPreview(node)),
    'preview ScrollView'
  )
  geometry.scroll = rect(scroll)
  assert(
    inside(geometry.scroll, geometry.preview),
    'Selected ScrollView must occupy its preview'
  )
  const bubble = unique(
    nodes.filter(
      node =>
        node.identifier === 'chat-bubble-' + expected.id && inPreview(node)
    ),
    'bubble inside preview'
  )
  geometry.bubble = rect(bubble)
  assert(
    intersects(geometry.bubble, geometry.preview),
    'Selected bubble must intersect its visible preview'
  )
  const bodyApplicable = expected.body.trim() !== ''
  if (bodyApplicable) {
    // The wrapper can repeat its label; only the actual StaticText is body proof.
    const texts = nodes.filter(
      node =>
        node.type === 'StaticText' &&
        node.label === expected.body &&
        under(node, bubble)
    )
    // A phone lists a Text nested in a Text of the same words as a StaticText
    // inside a StaticText with one frame: one body, read at its outer node.
    const outer = texts.filter(
      node => !texts.some(other => other !== node && under(node, other))
    )
    assert(
      outer.length !== 1 ||
        texts.every(node => same(rect(node), rect(outer[0]))),
      'A nested body StaticText must share its outer frame'
    )
    const body = unique(outer, 'body StaticText inside bubble')
    geometry.body = rect(body)
    assert(
      intersects(geometry.body, geometry.preview),
      'Selected text must intersect its visible preview'
    )
  }
  return {
    geometry,
    compact: false,
    bodyApplicable,
    rawNodeCount: nodes.length
  }
}

/** An Android loaded-row sweep drag's duration: slow enough not to fling a screen. */
export const ANDROID_SWEEP_MS = 1500

/** A short Android reader-tall drag's duration, clear of the long press. */
export const ANDROID_SHORT_DRAG_MS = 300

/** A phone's settled-spotlight budget: about fifteen of its samples. */
export const PHYSICAL_SPOTLIGHT_MS = 30000

/** Static capture readiness never changes the functional hold or animation timing. */
export async function observeSpotlightCaptureReady(
  ui: Chat2UI,
  timeout = 8000,
  expected?: Pick<Chat2Message, 'id' | 'body'>
): Promise<Json> {
  type Box = NonNullable<PublicNode['bounds']>
  const samples: Json[] = []
  // One phone sample (a raw tree and a full screenshot) takes about 2 s, so
  // the simulator budget leaves a phone four samples to see two equal ones.
  const budget = ui.physical
    ? Math.max(timeout, PHYSICAL_SPOTLIGHT_MS)
    : timeout
  const observation: Json = {
    name: 'Settled spotlight capture readiness',
    outcome: 'failed',
    method: ui.native
      ? 'Public bounds and unchanged raw Maestro screenshot hashes'
      : 'Atomic public DOM geometry, computed opacity and transform',
    stableForMs: 200,
    timeoutMs: budget,
    samples
  }
  ui.steps.push(observation)
  let lastRaw: Buffer | undefined
  let lastImage: Buffer | undefined
  try {
    await ui.present('chat-message-spotlight')
    const deadline = Date.now() + budget
    let reference: string | undefined
    let stableSince = Date.now()
    for (;;) {
      const sample: Json = { startedAt: new Date().toISOString() }
      samples.push(sample)
      if (samples.length > 24) samples.splice(1, 1)
      let geometry: Record<string, Box>
      let opaque = true
      if (ui.native) {
        if (ui.surface === 'ios' && expected != null) {
          const api = ui.device as unknown as {
            hierarchyRaw: (options: {
              signal: AbortSignal
            }) => Promise<Uint8Array>
          }
          const remaining = Math.max(1, deadline - Date.now())
          lastRaw = Buffer.from(
            await api.hierarchyRaw({
              signal: AbortSignal.timeout(remaining)
            })
          )
          try {
            const actual = iosSpotlightCaptureGeometry(lastRaw, expected)
            geometry = actual.geometry
            sample.selected = {
              compact: actual.compact,
              bodyApplicable: actual.bodyApplicable,
              rawNodeCount: actual.rawNodeCount
            }
          } catch (error) {
            geometry = {}
            opaque = false
            sample.selectedError =
              error instanceof Error ? error.message : String(error)
          }
        } else {
          geometry = {
            controls: await ui.publicBounds('chat-message-spotlight-controls'),
            panel: await ui.publicBounds('chat-message-spotlight-panel')
          }
        }
        sample.bounds = geometry
        // Only the last raw bytes are retained temporarily for failed diagnostics.
        const api = ui.device as unknown as {
          screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
        }
        const bytes = Buffer.from(
          ui.surface === 'ios' && expected != null
            ? await api.screenshot({
                signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
              })
            : await ui.device.screenshot()
        )
        lastImage = bytes
        sample.image = {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length
        }
        const raster = captureRaster(bytes)
        sample.image = { ...(sample.image as Json), ...raster }
        assert(
          raster.width > 0 && raster.height > 0,
          'Positive native screenshot dimensions required'
        )
      } else {
        const actual = await ui.dom(`
          const root=document.querySelector('[data-testid="chat-message-spotlight"]');
          const controls=root&&root.querySelector('[data-testid="chat-message-spotlight-controls"]');
          const panel=root&&root.querySelector('[data-testid="chat-message-spotlight-panel"]');
          const preview=root&&root.querySelector('[data-testid="chat-message-spotlight-preview"]');
          const backdrop=root&&root.firstElementChild;
          const geometry={},styles={};
          // Each part's fade and motion live on its first child, its animated layer.
          for(const [name,node] of [['controls',controls],['panel',panel],['panelLayer',panel&&panel.firstElementChild],['backdrop',backdrop],['preview',preview],['previewLayer',preview&&preview.firstElementChild]]){
            if(node==null){if(name==='controls'||name==='panel'||name==='backdrop')return {missing:name};continue;}
            const box=node.getBoundingClientRect(),style=getComputedStyle(node);
            geometry[name]={x:box.x,y:box.y,width:box.width,height:box.height};
            styles[name]={opacity:Number(style.opacity),transform:style.transform,display:style.display,visibility:style.visibility};
          }
          return {geometry,styles};
        `)
        sample.publicDOM = actual
        geometry = (actual.geometry ?? {}) as Record<string, Box>
        const styles = Object.values(
          (actual.styles ?? {}) as Record<
            string,
            { opacity: number; display: string; visibility: string }
          >
        )
        opaque =
          actual.missing == null &&
          styles.length >= 3 &&
          styles.every(
            style =>
              style.opacity === 1 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden'
          )
      }
      const finite =
        Object.keys(geometry).length >= 2 &&
        Object.values(geometry).every(
          box =>
            [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
            box.width > 0 &&
            box.height > 0
        )
      sample.completedAt = new Date().toISOString()
      sample.ready = finite && opaque
      const signature = JSON.stringify({
        geometry,
        publicDOM: sample.publicDOM,
        image: sample.image
      })
      const stable = finite && opaque && signature === reference
      if (!stable) {
        reference = finite && opaque ? signature : undefined
        stableSince = Date.now()
      }
      assert(
        Date.now() < deadline,
        'Timed out waiting for settled spotlight presentation'
      )
      if (stable && Date.now() - stableSince >= 200) {
        observation.outcome = 'passed'
        return {
          spotlightCaptureReady: true,
          method: observation.method,
          stableForMs: Date.now() - stableSince
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } catch (error) {
    observation.error = error instanceof Error ? error.message : String(error)
    if (ui.surface === 'ios' && expected != null) {
      const prefix = join(
        ui.runDir,
        'spotlight-readiness-failure-' + Date.now()
      )
      const artifacts: Json[] = []
      for (const [suffix, bytes] of [
        ['hierarchy.raw.json', lastRaw],
        [
          lastImage
            ?.subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) === true
            ? 'image.raw.png'
            : lastImage?.[0] === 255 && lastImage?.[1] === 216
              ? 'image.raw.jpg'
              : 'image.raw.bin',
          lastImage
        ]
      ] as const) {
        if (bytes == null) continue
        const path = prefix + '-' + suffix
        writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
        artifacts.push({
          path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length
        })
      }
      observation.failureArtifacts = artifacts
    }
    throw error
  }
}

/** Static stills require outgoing overlays to finish without changing UI timing. */
/** Compare whole, unmodified frames; only a blue caret-sized editable stripe may vary. */
export function compareIosComposerFrames(input: {
  previous: string
  current: string
  composer: NonNullable<PublicNode['bounds']>
  viewport: { width: number; height: number }
  timeout: number
}): Json {
  const result = spawnSync(
    process.env.CHAT2_PYTHON ?? 'python3',
    [
      '-c',
      `import sys,json,math
from PIL import Image,ImageChops
p=json.loads(sys.argv[1])
a=Image.open(p['previous']); a.load()
b=Image.open(p['current']); b.load()
assert a.format==b.format=='PNG', 'Actual raw PNG frames required'
assert a.size==b.size, 'Unchanged native raster required'
v=p['viewport']; c=p['composer']
assert all(math.isfinite(n) for n in [v['width'],v['height'],*c.values()])
assert v['width']>0 and v['height']>0 and c['width']>0 and c['height']>0
assert c['x']>=0 and c['y']>=0 and c['x']+c['width']<=v['width'] and c['y']+c['height']<=v['height']
sx=a.width/v['width']; sy=a.height/v['height']
assert sx>=1 and abs(sx-sy)<0.000001 and abs(sx-round(sx))<0.000001, 'Actual uniform native raster scale required'
aa=a.convert('RGBA'); bb=b.convert('RGBA')
diff=ImageChops.difference(aa,bb)
boxes=[band.getbbox() for band in diff.split()]
boxes=[box for box in boxes if box is not None]
box=None if not boxes else [min(x[0] for x in boxes),min(x[1] for x in boxes),max(x[2] for x in boxes),max(x[3] for x in boxes)]
editable=[math.ceil(c['x']*sx),math.ceil(c['y']*sy),math.floor((c['x']+c['width'])*sx),math.floor((c['y']+c['height'])*sy)]
# Two native units plus one raster pixel allow only caret edge rounding/antialiasing.
limit=math.ceil(2*sx)+1
mask=diff.split()[0]
for band in diff.split()[1:]: mask=ImageChops.lighter(mask,band)
changed=mask.point(lambda value:255 if value else 0).histogram()[255]
out={'accepted':box is None,'reason':'identical decoded pixels' if box is None else 'non-caret whole-frame change','width':a.width,'height':a.height,'scale':sx,'editableRasterBounds':editable,'maximumStripeWidthPixels':limit,'caretRgb':[66,107,242],'maximumChannelRounding':3,'diffBounds':box,'changedPixels':changed,'invalidCaretPixels':0,'strongBluePixels':0}
if box is not None and editable[0]<=box[0]<box[2]<=editable[2] and editable[1]<=box[1]<box[3]<=editable[3] and box[2]-box[0]<=limit:
 rows=set()
 for y in range(box[1],box[3]):
  for x in range(box[0],box[2]):
   p0=aa.getpixel((x,y)); p1=bb.getpixel((x,y))
   if p0==p1: continue
   rows.add(y)
   strong=any(q[2]>=200 and q[2]-q[0]>=80 and q[2]-q[1]>=60 for q in [p0,p1])
   def toward_blue(start,end):
    # Observed scene caret RGB; a blink may blend over dark glyph ink as well as the field.
    vector=[target-value for target,value in zip([66,107,242],start)]
    delta=[end[i]-start[i] for i in range(3)]
    norm=sum(value*value for value in vector)
    if norm==0: return False
    opacity=sum(delta[i]*vector[i] for i in range(3))/norm
    return 0<opacity<=1.02 and max(abs(delta[i]-opacity*vector[i]) for i in range(3))<=3
   opacity=toward_blue(p0[:3],p1[:3]) or toward_blue(p1[:3],p0[:3])
   if not (p0[3]==p1[3] and opacity): out['invalidCaretPixels']+=1
   if strong: out['strongBluePixels']+=1
 out['accepted']=out['invalidCaretPixels']==0 and out['strongBluePixels']>0 and len(rows)==box[3]-box[1]
 if out['accepted']: out['reason']='blue editable caret-sized stripe only'
print(json.dumps(out))`,
      JSON.stringify(input)
    ],
    { encoding: 'utf8', timeout: Math.max(1, Math.min(10000, input.timeout)) }
  )
  assert(
    result.status === 0,
    'Read-only whole-frame comparison failed: ' +
      (result.error?.message ?? result.stderr)
  )
  return JSON.parse(result.stdout) as Json
}

export async function observeComposerCaptureReady(
  ui: Chat2UI,
  expected: { focused?: boolean; reply?: boolean } = {},
  timeout = ui.native ? 90000 : 8000
): Promise<Json> {
  type Box = NonNullable<PublicNode['bounds']>
  const samples: Json[] = []
  const observation: Json = {
    name: 'Settled composer capture readiness',
    outcome: 'failed',
    method:
      ui.surface === 'ios'
        ? 'Two fresh positive iOS composer/Keyboard and control probes with matching geometry/public guards, each followed by an adjacent whole-frame comparison allowing only a blue caret-sized editable stripe; raw originals retained; no AX focus signal; actual image and text delivery review required'
        : ui.native
          ? 'Two fresh positive Android IME/focus/control and public overlay probes with matching geometry, each followed by an exact adjacent raw Maestro frame pair; original JPEG/PNG bytes retained; physical unmount is not inferred'
          : 'Atomic public DOM physical overlay absence, visibility, focus and geometry',
    expected,
    stableForMs: 200,
    timeoutMs: timeout,
    samples
  }
  ui.steps.push(observation)
  const deadline = Date.now() + timeout
  const message = 'Timed out waiting for settled composer presentation'
  const remaining = (): number => {
    assert(Date.now() < deadline, message)
    return Math.max(1, deadline - Date.now())
  }
  const device = ui.device as unknown as {
    hierarchy: (options: { signal: AbortSignal }) => Promise<unknown>
    screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
    assertVisible: (
      args: Json,
      options: { signal: AbortSignal }
    ) => Promise<{
      element?: { id?: string; text?: string; class?: string; bounds?: Box }
    }>
    evalBrowserScript: (
      args: Json,
      options: { signal: AbortSignal }
    ) => Promise<{ data?: unknown }>
    platformInfo: (options: { signal: AbortSignal }) => Promise<Json>
  }
  const nativeProbe = async (
    selector: Json,
    observed?: PublicNode[]
  ): Promise<Box | undefined> => {
    if (
      ui.surface === 'android' &&
      typeof selector.text === 'string' &&
      ['^Attach$', '^Send$', '^Cancel reply$'].includes(selector.text)
    )
      return await ui.androidComposerControl(
        selector.text.slice(1, -1),
        AbortSignal.timeout(remaining())
      )
    try {
      const args = { ...selector, timeout: Math.min(120, remaining()) }
      const options = { signal: AbortSignal.timeout(remaining()) }
      const found = (await device.assertVisible(args, options)).element
      if (ui.surface === 'android') {
        const matches = need(
          observed,
          'Fresh Android hierarchy required for control geometry'
        ).filter(node =>
          typeof selector.id === 'string'
            ? node.id === selector.id
            : typeof selector.text === 'string' &&
              new RegExp(selector.text).test(node.text ?? '')
        )
        assert(matches.length === 1, 'Unique observed Android control required')
        if (typeof selector.text === 'string')
          assert(
            matches[0].type === 'Button',
            'Typed Android composer Button required'
          )
        const bounds = need(
          matches[0].bounds,
          'Observed Android control bounds required'
        )
        assert(
          [bounds.x, bounds.y, bounds.width, bounds.height].every(
            Number.isFinite
          ) &&
            bounds.width > 0 &&
            bounds.height > 0,
          'Positive finite observed Android control bounds required'
        )
        return bounds
      }
      if (ui.surface === 'ios' && found != null) {
        if (typeof selector.id === 'string')
          assert(
            found.id === selector.id,
            'Exact positive iOS composer identity required'
          )
        if (typeof selector.text === 'string')
          assert(
            found.text === selector.text &&
              nativeClass(found.class) === 'Button',
            'Exact observed iOS composer Button required'
          )
      }
      return found?.bounds
    } catch (error) {
      remaining()
      if (
        error != null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'COMMAND_FAILED'
      )
        return undefined
      throw error
    }
  }
  try {
    let rawDirectory: string | undefined
    let rawSequence = 0
    let viewport: { width: number; height: number } | undefined
    let reference: string | undefined
    let stableSince = Date.now()
    for (;;) {
      remaining()
      const sample: Json = { startedAt: new Date().toISOString() }
      samples.push(sample)
      if (samples.length > 24) samples.splice(1, 1)
      let geometry: Record<string, Box>
      let eligible: boolean
      if (ui.native) {
        const ios = ui.surface === 'ios'
        const androidPositive =
          ui.surface === 'android' && expected.focused === true
            ? await readAndroidComposerKeyboard(
                ui,
                AbortSignal.timeout(remaining()),
                remaining()
              )
            : undefined
        const positive =
          ios && expected.focused === true
            ? await readIosComposerKeyboard(
                ui,
                AbortSignal.timeout(remaining())
              )
            : undefined
        const nodes =
          positive?.nodes ??
          androidPositive?.nodes ??
          flattenPublicHierarchy(
            await device.hierarchy({ signal: AbortSignal.timeout(remaining()) })
          )
        const overlays = nodes
          .filter(n =>
            ['chat-message-spotlight', 'chat-picker-scene'].includes(n.id ?? '')
          )
          .map(n => n.id)
        geometry = { ...positive?.geometry, ...androidPositive?.geometry }
        let visible = true
        for (const [name, selector] of [
          ['composer', { id: 'chat-composer' }],
          ['band', { id: 'chat-composer-band' }],
          ['attach', { text: ios ? 'Attach' : exactText('Attach') }],
          ['send', { text: ios ? 'Send' : exactText('Send') }]
        ] as const) {
          if (geometry[name] != null) continue
          const found = await nativeProbe(
            selector,
            ui.surface === 'android' ? nodes : undefined
          )
          if (found == null) visible = false
          else geometry[name] = found
        }
        let focused = expected.focused !== true
        if (expected.focused === true && !ios) focused = androidPositive != null
        const cancel = nodes.find(n => n.text === 'Cancel reply')
        let reply =
          expected.reply == null || (!expected.reply && cancel == null)
        if (expected.reply === true) {
          const found = await nativeProbe(
            {
              text: ios ? 'Cancel reply' : exactText('Cancel reply')
            },
            ui.surface === 'android' ? nodes : undefined
          )
          reply = found != null
          if (found != null) geometry.reply = found
        }
        const keyboard =
          expected.focused !== true ||
          positive != null ||
          androidPositive != null
        if ((ios || ui.surface === 'android') && visible) {
          const band = geometry.band
          visible =
            band != null &&
            [
              'composer',
              'attach',
              'send',
              ...(expected.reply === true ? ['reply'] : [])
            ].every(name => {
              const child = geometry[name]
              return (
                child != null &&
                child.x >= band.x - 1 &&
                child.y >= band.y - 1 &&
                child.x + child.width <= band.x + band.width + 1 &&
                child.y + child.height <= band.y + band.height + 1
              )
            })
        }
        sample.publicAccessibility = {
          overlays,
          visible,
          ...(ios
            ? {
                focusSignal: 'unavailable-on-ios',
                positiveComposerKeyboard: positive != null
              }
            : { focused }),
          reply,
          keyboard
        }
        if (ios) {
          // Pair adjacent frames between expensive public metadata probes.
          const burstDeadline = Math.min(deadline, Date.now() + 2000)
          const frames: Json[] = []
          sample.rawFrames = frames
          let previous: (Json & { path: string }) | undefined
          let previousAt = 0
          sample.rawPairStable = false
          while (Date.now() < burstDeadline) {
            remaining()
            const bytes = Buffer.from(
              await device.screenshot({
                // A normal burst ending must not abort a valid in-flight capture.
                signal: AbortSignal.timeout(remaining())
              })
            )
            const raster = captureRaster(bytes)
            assert(
              raster.width > 0 && raster.height > 0,
              'Positive native screenshot dimensions required'
            )
            assert(
              bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
              'Actual raw native PNG required for composer comparison'
            )
            rawDirectory ??= mkdtempSync(join(ui.runDir, 'composer-frames-'))
            const path = join(rawDirectory, String(++rawSequence) + '.raw.png')
            writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
            const frame = {
              path,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              bytes: bytes.length,
              ...raster
            }
            const at = Date.now()
            const recorded: Json = { ...frame, at: new Date().toISOString() }
            frames.push(recorded)
            if (frames.length > 12) frames.splice(1, 1)
            sample.image = frame
            sample.raster = raster
            if (previous != null && at - previousAt >= 200) {
              let accepted =
                previous.sha256 === frame.sha256 &&
                frame.width === previous.width &&
                frame.height === previous.height
              if (!accepted && expected.focused === true && positive != null) {
                if (viewport == null) {
                  const screen = await device.platformInfo({
                    signal: AbortSignal.timeout(remaining())
                  })
                  viewport = {
                    width: Number(screen.screenWidth),
                    height: Number(screen.screenHeight)
                  }
                }
                recorded.comparison = compareIosComposerFrames({
                  previous: previous.path,
                  current: path,
                  composer: geometry.composer,
                  viewport,
                  timeout: remaining()
                })
                accepted = (recorded.comparison as Json).accepted === true
              }
              recorded.comparedWith = previous.path
              if (accepted) {
                sample.rawPairStable = true
                sample.rawPairStableForMs = at - previousAt
                break
              }
            }
            previous = frame
            previousAt = at
            const pause = Math.min(200, burstDeadline - Date.now(), remaining())
            if (pause > 0)
              await new Promise(resolve => setTimeout(resolve, pause))
          }
        } else {
          const burstDeadline = Math.min(deadline, Date.now() + 2000)
          const frames: Json[] = []
          sample.rawFrames = frames
          let previous: (Json & { path: string }) | undefined
          let previousAt = 0
          sample.rawPairStable = false
          while (Date.now() < burstDeadline) {
            remaining()
            const bytes = Buffer.from(
              await device.screenshot({
                // Burst expiry stops new captures; only the overall deadline aborts one.
                signal: AbortSignal.timeout(remaining())
              })
            )
            const png = bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            const jpeg = bytes[0] === 255 && bytes[1] === 216
            assert(
              (png &&
                bytes.length >= 36 &&
                bytes.readUInt32BE(bytes.length - 12) === 0 &&
                bytes.toString('ascii', bytes.length - 8, bytes.length - 4) ===
                  'IEND') ||
                (jpeg && bytes.at(-2) === 255 && bytes.at(-1) === 217),
              'Complete original native PNG or JPEG required'
            )
            const raster = captureRaster(bytes)
            assert(
              raster.width > 0 && raster.height > 0,
              'Positive native screenshot dimensions required'
            )
            rawDirectory ??= mkdtempSync(join(ui.runDir, 'composer-frames-'))
            const path = join(
              rawDirectory,
              String(++rawSequence) + (png ? '.raw.png' : '.raw.jpg')
            )
            writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
            const at = Date.now()
            const frame = {
              path,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              bytes: bytes.length,
              ...raster
            }
            const recorded: Json = { ...frame, at: new Date().toISOString() }
            frames.push(recorded)
            if (frames.length > 12) frames.splice(1, 1)
            sample.image = frame
            sample.raster = raster
            if (previous != null && at - previousAt >= 200) {
              recorded.comparedWith = previous.path
              if (
                previous.sha256 === frame.sha256 &&
                previous.width === frame.width &&
                previous.height === frame.height
              ) {
                sample.rawPairStable = true
                sample.rawPairStableForMs = at - previousAt
                break
              }
            }
            previous = frame
            previousAt = at
            const pause = Math.min(200, burstDeadline - Date.now(), remaining())
            if (pause > 0)
              await new Promise(resolve => setTimeout(resolve, pause))
          }
        }
        eligible =
          overlays.length === 0 &&
          visible &&
          (ios ? expected.focused !== true || positive != null : focused) &&
          reply &&
          keyboard &&
          sample.rawPairStable === true
      } else {
        const script = `
          const overlays=['chat-message-spotlight','chat-picker-scene'].filter(id=>document.querySelector('[data-testid="'+id+'"]')!==null);
          const composer=document.querySelector('[data-testid="chat-composer"]');
          const band=document.querySelector('[data-testid="chat-composer-band"]');
          const geometry={},styles={};let visible=true;
          const entries=[['composer',composer],['band',band],['attach',band&&band.querySelector('[aria-label="Attach"]')],['send',band&&band.querySelector('[aria-label="Send"]')]];
          if(${expected.reply === true})entries.push(['reply',band&&band.querySelector('[aria-label="Cancel reply"]')]);
          for(const [name,node] of entries){
            if(node===null){visible=false;continue;}
            const box=node.getBoundingClientRect();geometry[name]={x:box.x,y:box.y,width:box.width,height:box.height};
            const chain=[];for(let current=node;current!==null;current=current.parentElement){const style=getComputedStyle(current);chain.push({opacity:style.opacity,transform:style.transform,display:style.display,visibility:style.visibility});if(current.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)visible=false;}
            styles[name]=chain;
          }
          const focused=composer!==null&&composer===document.activeElement;
          const editable=composer!==null&&!composer.disabled&&!composer.readOnly;
          const hasReply=band!==null&&band.querySelector('[aria-label="Cancel reply"]')!==null;
          const viewport={width:innerWidth,height:innerHeight};
          if(typeof visualViewport!=='undefined'&&visualViewport!==null)Object.assign(viewport,{visualWidth:visualViewport.width,visualHeight:visualViewport.height,offsetTop:visualViewport.offsetTop,offsetLeft:visualViewport.offsetLeft,scale:visualViewport.scale});
          return {overlays,geometry,styles,visible,focused,editable,hasReply,viewport};
        `
        const result = await device.evalBrowserScript(
          {
            script: 'return JSON.stringify((()=>{' + script + '})())',
            timeout: Math.min(500, remaining())
          },
          { signal: AbortSignal.timeout(remaining()) }
        )
        const actual = (
          typeof result.data === 'string'
            ? JSON.parse(result.data)
            : result.data
        ) as Json
        assert(
          actual != null && typeof actual === 'object',
          'Actual public composer observation required'
        )
        sample.publicDOM = actual
        geometry = (actual.geometry ?? {}) as Record<string, Box>
        eligible =
          Array.isArray(actual.overlays) &&
          actual.overlays.length === 0 &&
          actual.visible === true &&
          actual.editable === true &&
          (expected.focused !== true || actual.focused === true) &&
          (expected.reply == null || actual.hasReply === expected.reply)
      }
      sample.bounds = geometry
      const finite =
        Object.keys(geometry).length >= 4 &&
        Object.values(geometry).every(
          box =>
            [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
            box.width > 0 &&
            box.height > 0
        )
      sample.ready = eligible && finite
      sample.completedAt = new Date().toISOString()
      const signature = JSON.stringify({
        geometry,
        publicDOM: sample.publicDOM,
        publicAccessibility: sample.publicAccessibility,
        image: ui.native ? sample.raster : sample.image
      })
      const stable = eligible && finite && signature === reference
      if (!stable) {
        reference = eligible && finite ? signature : undefined
        stableSince = Date.now()
      }
      remaining()
      if (stable && Date.now() - stableSince >= 200) {
        observation.outcome = 'passed'
        return {
          composerCaptureReady: true,
          method: observation.method,
          expected,
          stableForMs: Date.now() - stableSince
        }
      }
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(50, remaining()))
      )
    }
  } catch (error) {
    observation.error = error instanceof Error ? error.message : String(error)
    throw error
  }
}

/** Replace retained form values and submit the focused password input normally. */
export async function submitPasswordSignIn(
  ui: Chat2UI,
  actor: Pick<Chat2Fixture['actors'][string], 'email' | 'password'>
): Promise<Json> {
  const observation: Json = {
    name: 'Public password form submission',
    outcome: 'failed',
    providerKeysReset: false
  }
  ui.steps.push(observation)
  const password = await ui.visible({ text: exactText('Password') }, 500)
  const codeForm = await ui.visible(
    { text: exactText('Use a password instead') },
    500
  )
  if (!password && !codeForm) {
    if (!(await ui.visible({ text: exactText('Sign in') }, 500))) {
      observation.outcome = 'passed'
      return { passwordFormSubmitted: false }
    }
    const buttons = (await ui.nodes()).filter(
      node =>
        node.text === 'Sign in' &&
        /button$/i.test(node.type ?? '') &&
        node.enabled !== false &&
        node.bounds != null
    )
    observation.observedEntryButtons = buttons.length
    assert(buttons.length === 1, 'Unique observed Sign in button required')
    await ui.tapObserved(buttons[0])
  }
  if (!(await ui.visible({ text: exactText('Password') }, 500))) {
    await ui.device.assertVisible({
      text: exactText('Use a password instead'),
      timeout: 15000
    })
    await ui.text('Use a password instead')
  }
  await ui.device.assertVisible({ text: exactText('Password'), timeout: 15000 })
  // On a loaded simulator the typed password sometimes never reaches the
  // secure field and the form answers with the wrong-credentials notice;
  // the fields are filled and submitted once more, and that is recorded.
  for (let attempt = 0; ; attempt++) {
    for (const [label, value] of [
      ['E-mail address', actor.email],
      ['Password', actor.password]
    ]) {
      await ui.text(label)
      if (await ui.visible({ text: exactText('Clear ' + label) }, 200))
        await ui.text('Clear ' + label)
      await ui.text(label)
      await ui.append(value)
    }
    await ui.device.pressKey({ key: 'ENTER' })
    if (
      ui.surface !== 'ios' ||
      attempt > 0 ||
      !(await ui.visible({ text: '^Wrong e-mail or password' }, 8000))
    )
      break
    observation.wrongCredentialsRetried = true
  }
  // A fresh install offers to save the typed password (iOS, or Google
  // Password Manager on a phone), over whatever the app shows next; the
  // synthetic password is never saved.
  // Google offers Never instead of Not now once it has been declined before.
  const decline = ui.surface === 'ios' ? '^Not Now$' : '^(Not now|Never)$'
  if (ui.native && (await ui.visible({ text: decline }, 5000))) {
    await ui.device.tapOn({ text: decline })
    observation.savePasswordDeclined = true
  }
  observation.outcome = 'passed'
  observation.fieldsReplaced = true
  observation.submit = 'Focused password input Enter'
  return { passwordFormSubmitted: true, retainedFieldsReplaced: true }
}

/** Capture readiness is separate from functional error and Retry scenarios. */
export async function observeInfoCaptureReady(
  ui: Chat2UI,
  timeout = 15000
): Promise<Json> {
  const samples: Json[] = []
  const observation: Json = {
    name: 'Information capture readiness',
    outcome: 'failed',
    timeoutMs: timeout,
    samples
  }
  ui.steps.push(observation)
  try {
    await ui.present('chat-info-hero')
    await ui.present('chat-info-members')
    const deadline = Date.now() + timeout
    const nativeScreen =
      ui.surface === 'ios' ? await ui.device.platformInfo() : undefined
    let reference: string | undefined
    let stableSince = Date.now()
    for (;;) {
      const nodes = await ui.nodes()
      const loading = nodes
        .filter(node => /^Loading(?:…|\.{3})$/.test(node.text ?? ''))
        .map(node => node.text)
      const failed = nodes.some(
        node =>
          node.id === 'chat-load-error' ||
          node.text === 'Chat could not be opened.'
      )
      const retry = nodes.some(node => node.text === 'Retry')
      const chrome =
        ui.surface === 'ios'
          ? nodes.filter(
              node =>
                node.type === 'Button' &&
                (node.text === 'Back' ||
                  node.text?.startsWith('Account, ') === true)
            )
          : []
      const headerReady =
        ui.surface !== 'ios' ||
        (chrome.filter(node => node.text === 'Back').length === 1 &&
          chrome.filter(node => node.text?.startsWith('Account, ') === true)
            .length === 1 &&
          chrome.every(
            node =>
              node.bounds != null &&
              [
                node.bounds.x,
                node.bounds.y,
                node.bounds.width,
                node.bounds.height
              ].every(Number.isFinite) &&
              node.bounds.width > 0 &&
              node.bounds.height > 0 &&
              node.bounds.x >= 0 &&
              node.bounds.y >= 0 &&
              node.bounds.x + node.bounds.width <=
                Number(nativeScreen?.screenWidth) &&
              node.bounds.y + node.bounds.height <=
                Number(nativeScreen?.screenHeight)
          ))
      const signature = JSON.stringify(
        chrome.map(node => ({ text: node.text, bounds: node.bounds }))
      )
      const stable = headerReady && signature === reference
      if (!stable) {
        reference = headerReady ? signature : undefined
        stableSince = Date.now()
      }
      samples.push({
        at: new Date().toISOString(),
        loading,
        failed,
        retry,
        headerReady,
        chrome
      })
      if (samples.length > 24) samples.splice(1, 1)
      assert(!failed && !retry, 'Information capture has a load error or Retry')
      if (
        loading.length === 0 &&
        (ui.surface !== 'ios' || (stable && Date.now() - stableSince >= 200))
      ) {
        observation.outcome = 'passed'
        return { informationCaptureReady: true, observedLoadingAbsent: true }
      }
      assert(
        Date.now() < deadline,
        'Timed out waiting for information loading and actual header geometry to settle'
      )
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } catch (error) {
    observation.error = error instanceof Error ? error.message : String(error)
    throw error
  }
}

/**
 * The targets a recorded visit viewed by the app's own rule
 * (attentionBodyViewed): the body's top inside the reading area with its
 * first 24 pt above the bottom. A tall body that only overlapped the area
 * from above was visible but not viewed.
 */
function viewedInVisit(record: Json | undefined): Set<string> {
  const area = record?.band as { top: number; bottom: number } | undefined
  return new Set(
    ((record?.visibleBodies ?? []) as Json[])
      .filter(body => {
        const b = body.bounds as NonNullable<PublicNode['bounds']> | undefined
        return (
          area != null &&
          b != null &&
          b.y >= area.top &&
          b.y + Math.min(24, b.height) <= area.bottom
        )
      })
      .map(body => String(body.id).replace('chat-message-body-', ''))
  )
}

export class Scenarios {
  readonly group: string
  readonly viewerKey: string
  readonly viewerId: string
  readonly peers = new Map<string, Peer>()
  readonly observations: Json[] = []
  get touchActions(): boolean {
    return this.ui.native || this.ui.metrics().coarse
  }

  get copyLabel(): string {
    return this.touchActions ? 'Copy' : 'Copy text'
  }

  async readingBand(): Promise<{ top: number; bottom: number }> {
    const history = await this.targetBounds('chat-message-history')
    const identity = await this.targetBounds('chat-conversation-identity')
    const composer = await this.targetBounds('chat-composer-band')
    let top = Math.max(history.y, identity.y + identity.height)
    if (await this.ui.visible({ id: 'chat-pinned-band' }, 200)) {
      const pins = await this.targetBounds('chat-pinned-band')
      top = Math.max(top, pins.y + pins.height)
    }
    const bottom = Math.min(history.y + history.height, composer.y)
    assert(bottom > top, 'Actual unobscured reading band required')
    return { top, bottom }
  }

  async menuState(): Promise<Json> {
    if (this.touchActions) return await this.spotlightState()
    await this.ui.absent('chat-message-spotlight')
    await this.ui.device.assertVisible({ text: exactText(this.copyLabel) })
    const state = await this.ui.dom(
      'const n=document.querySelector(\'[aria-label^="Message from "]\');if(!n)throw Error("Actual desktop message menu required");const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,viewportWidth:innerWidth,viewportHeight:innerHeight}'
    )
    assert(
      Number(state.x) >= -2 &&
        Number(state.y) >= -2 &&
        Number(state.x) + Number(state.width) <=
          Number(state.viewportWidth) + 2 &&
        Number(state.y) + Number(state.height) <=
          Number(state.viewportHeight) + 2,
      'Actual desktop menu must fit viewport'
    )
    return { desktopMenu: state, spotlightApplicable: false }
  }

  constructor(
    readonly f: Chat2Fixture,
    readonly ui: Chat2UI,
    scenario = ui.scenario
  ) {
    this.group = f.conversations.group.id
    this.viewerKey = need(
      f.scenarioViewers[scenario + ':' + ui.surface] ??
        f.scenarioViewers[scenario] ??
        f.viewers[ui.surface],
      'Fixture viewer for this surface required'
    )
    this.viewerId = need(
      f.actors[this.viewerKey],
      'Fixture viewer missing'
    ).userId
  }

  async stableReads(conversation: string): Promise<unknown> {
    const client = await this.client()
    let previous = ''
    let stable = 0
    let result: unknown
    await until(
      async () => {
        result = (await client.chatReads(conversation)).filter(
          r => r.userId === this.viewerId
        )
        const value = JSON.stringify(result)
        stable = value === previous ? stable + 1 : 0
        previous = value
        return stable >= 3 ? true : undefined
      },
      'ordinary initial read cursor to settle',
      8000
    )
    return result
  }

  async spotlightState(): Promise<Json> {
    const ui = this.ui
    await ui.present('chat-message-spotlight')
    const preview = await ui.visible(
      { id: 'chat-message-spotlight-preview' },
      500
    )
    const controls = await ui.publicBounds('chat-message-spotlight-controls')
    const info = ui.native ? await ui.device.platformInfo() : ui.metrics()
    const width = Number('screenWidth' in info ? info.screenWidth : info.width)
    const height = Number(
      'screenHeight' in info ? info.screenHeight : info.height
    )
    assert(
      controls.width > 0 &&
        controls.height > 0 &&
        controls.x >= 0 &&
        controls.x + controls.width <= width + 2 &&
        controls.y >= 0 &&
        controls.y + controls.height <= height + 2,
      'Actual spotlight controls must fit the visible device viewport'
    )
    if (!preview) {
      assert(ui.native, 'Web standard viewport must preserve selected preview')
      await ui.keyboardVisible()
      this.observations.push({
        compactSpotlight: true,
        actualKeyboardVisible: true,
        controls,
        staticCompositionOnly: true
      })
    }
    return { preview, controls, width, height }
  }

  async protocolPeer(
    key = this.f.scenarioPeers[this.ui.scenario] ?? this.f.peer
  ): Promise<Peer> {
    let peer = this.peers.get(key)
    if (peer == null) {
      peer = await fixturePeer(this.f, key)
      this.peers.set(key, peer)
    }
    return peer
  }

  close(): void {
    for (const peer of this.peers.values()) peer.close()
  }

  controlId(name: string): string {
    return need(
      this.f.controls[name],
      'Final public control ID is required: ' + name
    )
  }

  async count(): Promise<number> {
    await this.ui.present('chat-attention-count')
    const text = await this.ui.publicText('chat-attention-count')
    const matches = text.match(/\d+/g)
    assert(
      matches?.length === 1,
      'Attention count must expose one public number'
    )
    return Number(matches[0])
  }

  async expectCount(expected: number): Promise<void> {
    if (expected === 0) {
      await until(
        async () =>
          !(await this.ui.visible({ id: 'chat-attention-count' }, 200))
            ? true
            : undefined,
        'zero verified attention'
      )
      return
    }
    await until(
      async () => ((await this.count()) === expected ? true : undefined),
      'complete verified attention count ' + expected,
      // A cold iOS workspace counts a long history up page by page.
      this.ui.surface === 'ios' ? 180000 : 45000
    )
  }

  /**
   * The attention count is the targets below the reading area, and a viewed
   * target is not counted. The fixture's count assumes none was viewed; on
   * native, targets on screen below the anchor or seen earlier in this case
   * (iOS E11's cold open showed four) are subtracted, and recorded.
   */
  async belowReaderCount(
    fixture: NonNullable<Chat2Fixture['historyStress']>
  ): Promise<number> {
    const ui = this.ui
    if (!ui.native) return fixture.expectedCount
    const nodes = await ui.nodes()
    const box = (id: string): NonNullable<PublicNode['bounds']> | undefined =>
      nodes.find(node => node.id === id)?.bounds
    const header = need(
      box('chat-conversation-identity'),
      'Actual conversation header required'
    )
    const pins = box('chat-pinned-band')
    const composer = need(
      box('chat-composer-band'),
      'Actual composer band required'
    )
    const top = Math.max(
      header.y + header.height,
      pins == null ? 0 : pins.y + pins.height
    )
    const anchor = need(
      box('chat-message-body-' + fixture.readerAnchor.id),
      'Actual reader anchor body required'
    )
    const viewed = fixture.targetIds.filter(id => {
      const body = box('chat-message-body-' + id)
      return (
        body != null &&
        body.y > anchor.y &&
        body.y >= top &&
        body.y + Math.min(24, body.height) <= composer.y
      )
    })
    // A target the current visit already had in its reading area (a cold
    // open lands on a few) was viewed then, and the app no longer counts it.
    // Reopening the conversation starts a new count, so only the latest
    // reading-area record applies.
    const latest = [...this.observations]
      .reverse()
      .find(row => row.visibleReaderAnchor != null)
    const seenEarlier = viewedInVisit(latest?.visibleReaderAnchor as Json)
    const viewedEarlier = fixture.targetIds.filter(
      id => seenEarlier.has(id) && !viewed.includes(id)
    )
    const count = fixture.expectedCount - viewed.length - viewedEarlier.length
    this.observations.push({
      belowReaderCount: count,
      fixtureCount: fixture.expectedCount,
      viewedTargetsBelowAnchor: viewed,
      viewedTargetsEarlier: viewedEarlier,
      readingArea: { top, bottom: composer.y }
    })
    return count
  }

  /**
   * On native, which earlier visits' viewed targets the app still discounts
   * after a reopen varies (iOS E11 showed 216 and 217 for the same model),
   * so the count must lie between the latest visit's discount and that of
   * every visit in this case, by the app's own viewed rule; later steps use
   * the observed value. Web keeps the exact count.
   */
  async expectBelowReaderCount(
    fixture: NonNullable<Chat2Fixture['historyStress']>
  ): Promise<number> {
    const highest = await this.belowReaderCount(fixture)
    if (!this.ui.native) {
      await this.expectCount(highest)
      return highest
    }
    const model = this.observations.at(-1)!
    const below = new Set(model.viewedTargetsBelowAnchor as string[])
    const seen = new Set<string>()
    for (const row of this.observations)
      if (row.visibleReaderAnchor != null)
        for (const id of viewedInVisit(row.visibleReaderAnchor as Json))
          if (fixture.targetIds.includes(id) && !below.has(id)) seen.add(id)
    const lowest = fixture.expectedCount - below.size - seen.size
    let previous: number | undefined
    // Each change of the public count, kept so a count outside the range is
    // reported with what the app actually showed.
    const proof: Json = {
      belowReaderCountRange: [lowest, highest],
      observedCounts: []
    }
    this.observations.push(proof)
    const actual = await until(
      async () => {
        const count = await this.count()
        if (count !== previous)
          (proof.observedCounts as Json[]).push({
            count,
            at: new Date().toISOString()
          })
        const settled =
          count >= lowest && count <= highest && count === previous
        previous = count
        return settled ? count : undefined
      },
      `complete verified attention count between ${lowest} and ${highest}`,
      180000
    )
    proof.observedBelowReaderCount = actual
    return actual
  }

  async classification(): Promise<void> {
    await until(
      async () =>
        !(await this.ui.visible(
          { id: this.controlId('attentionLoading') },
          200
        )) &&
        !(await this.ui.visible({ id: this.controlId('attentionRetry') }, 200))
          ? true
          : undefined,
      'completed history classification',
      60000
    )
  }

  snapshot(conversationId: string, afterEvent = 0): Json {
    return fixtureControl(this.f, 'snapshot', {
      viewerId: this.viewerId,
      conversationId,
      afterEvent
    })
  }

  async waitEvent(
    conversationId: string,
    afterEvent: number,
    predicate: (event: Json) => boolean
  ): Promise<Json> {
    return await until(
      async () => {
        const data = this.snapshot(conversationId, afterEvent)
        return (data.events as Json[]).find(predicate)
      },
      'actual matched history request',
      30000
    )
  }

  async peerTarget(
    peer: Peer,
    conversation: string,
    id: string
  ): Promise<void> {
    let view = await peer.engine.open(conversation)
    for (
      let pages = 0;
      !view.messages.some(m => m.id === id) && view.hasEarlier && pages < 30;
      pages++
    )
      view = await peer.engine.loadEarlier(conversation)
    assert(
      view.messages.some(m => m.id === id && m.status === 'ok'),
      'Protocol edit/delete target must be verified in own peer history'
    )
  }

  async client(): Promise<TeamStationClient> {
    return await fixtureClient(this.f, this.viewerKey)
  }

  async run(name: Chat2Scenario | 'I1' | 'I2' | 'I3'): Promise<void> {
    await this[name]()
  }

  async check(name: string, action: () => Promise<void>): Promise<void> {
    await this.ui.step(name, action)
  }

  /**
   * On a phone the driver's direction swipe (a hold, then a drag) leaves the
   * Account page where it is, so Sign out can stay under the floating tab
   * bar, where the driver's tap opens a tab. On a phone, the page is dragged
   * by measured points until Sign out's observed frame clears the bar (at
   * most four drags), and Sign out is tapped at that frame.
   */
  async tapSignOut(): Promise<void> {
    const ui = this.ui
    if (!(ui.surface === 'ios' && ui.physical)) {
      await ui.text('Sign out')
      return
    }
    const proof: Json = { physicalSignOut: [] }
    this.observations.push(proof)
    for (let drags = 0; ; drags++) {
      const place = clearOfTabBar(await ui.nodes(), 'Sign out')
      ;(proof.physicalSignOut as Json[]).push({ ...place, drags })
      if (place.clear) {
        await ui.tapObserved({ text: 'Sign out', bounds: place.target })
        return
      }
      assert(drags < 4, 'Sign out must clear the floating tab bar')
      const x = Math.round(place.target.x + place.target.width / 2)
      const startY = Math.round(place.barTop - 40)
      const travel = place.target.y + place.target.height - place.barTop + 120
      await ui.measuredSwipe({
        startX: x,
        endX: x,
        startY,
        endY: Math.round(Math.max(startY - travel, 150)),
        duration: 300
      })
    }
  }

  async signIn(key = this.viewerKey): Promise<void> {
    const ui = this.ui
    const m = ui.device
    const actor = this.f.actors[key]
    const i2Target =
      ui.scenario === 'I2'
        ? need(
            this.f.identityCompatibility?.i2Target,
            'Explicit I2 target mode required'
          )
        : undefined
    if (ui.scenario === 'I2')
      assert(
        i2Target === 'retained-linked' || i2Target === 'new-empty',
        'Valid explicit I2 target mode required'
      )
    const retainedI2 = i2Target === 'retained-linked'
    if (i2Target === 'new-empty')
      assert.equal(
        ui.surface,
        'web-wide',
        'Only an explicit new wide target may link'
      )
    await ui.open('/chat')
    if (retainedI2)
      for (const label of [
        'Sign in',
        'Password',
        'Link this device',
        'Reset chat'
      ])
        assert(
          !(await ui.visible({ text: exactText(label) }, 500)),
          'Retained I2 target must already be signed in and linked: ' + label
        )
    if (await ui.visible({ text: '^Account,.*$' }, 500)) {
      await m.tapOn({ text: '^Account,.*$' })
      // On a native device the page can fail to open, or be routed away
      // before it is read; its first section proves it is the Account page.
      if (
        ui.native &&
        !(await ui.visible({ text: exactText('Name') }, 10000))
      ) {
        this.observations.push({ accountPageRetapped: true })
        await m.tapOn({ text: '^Account,.*$' })
        await m.assertVisible({ text: exactText('Name'), timeout: 15000 })
      }
      if (await ui.visible({ text: exactText(actor.email) }, 2000))
        await ui.back()
      else {
        if (['I1', 'I2', 'W1'].includes(ui.scenario))
          throw new Chat2Blocked(
            'Compatibility requires its own prepared profile; account replacement is prohibited'
          )
        requireAfterArchive(
          this.f,
          ui.scenario === 'capture' ? ui.surface : undefined
        )
        await m.scrollUntilVisible({
          element: { text: exactText('Sign out') },
          direction: 'DOWN',
          timeout: 15000
        })
        // The driver counts Sign out as visible while the floating tab bar
        // covers it, and its tap then lands on a tab. It is the page's last
        // control, and the page's end padding clears the bar: scroll there.
        for (let i = 0; i < 2; i++)
          await m.swipe({ direction: 'UP', duration: 400 })
        await this.tapSignOut()
        // A tap while the swipes still fling only stops the page.
        if (
          !(await ui.visible({ text: exactText('Sign in') }, 5000)) &&
          (await ui.visible({ text: exactText('Sign out') }, 500))
        ) {
          this.observations.push({ signOutRetapped: true })
          await this.tapSignOut()
        }
        await m.assertVisible({ text: exactText('Sign in'), timeout: 15000 })
        this.observations.push({
          normalPublicSignOut: true,
          matchedAfterArchiveVerified: true,
          providerKeysReset: false
        })
        await ui.open('/chat')
      }
    }
    if (retainedI2) {
      await m.assertVisible({
        text: exactText(actor.accountLabel),
        timeout: 30000
      })
      await ui.present('chat-conversation-list')
    } else this.observations.push(await submitPasswordSignIn(ui, actor))
    if (await ui.visible({ text: exactText('Not Now') }, 500))
      await ui.text('Not Now')
    if (
      ui.native &&
      !(await ui.visible({ id: 'chat-conversation-list' }, 1000))
    ) {
      const tab = (await ui.nodes())
        .filter(n => n.text === 'Chat' && n.bounds != null)
        .sort((a, b) => (b.bounds?.y ?? 0) - (a.bounds?.y ?? 0))[0]
      if (tab != null) await ui.tapObserved(tab)
    }
    if (!ui.native) {
      const readiness: Json = {
        browserIdentityReadiness: [],
        startedAt: new Date().toISOString()
      }
      this.observations.push(readiness)
      await until(
        async () => {
          const link = await ui.visible(
            { text: exactText('Link this device') },
            500
          )
          const list = await ui.visible({ id: 'chat-conversation-list' }, 500)
          ;(readiness.browserIdentityReadiness as unknown[]).push({
            at: new Date().toISOString(),
            link,
            list
          })
          return link || list ? true : undefined
        },
        'actual browser Link or conversation-list readiness',
        30000
      )
    }
    if (await ui.visible({ text: 'Link this device' }, 500)) {
      assert(
        !['I1', 'W1'].includes(ui.scenario) && !retainedI2,
        'The preserved legacy profile or retained I2 target must not request another device link'
      )
      const signal = ui.native
        ? undefined
        : AbortSignal.any([ui.deadline, AbortSignal.timeout(30000)])
      const provider = await fixturePeer(this.f, key, signal)
      try {
        if (signal == null) await provider.approvePending()
        else await this.approveBrowserLink(provider, signal)
      } finally {
        provider.close()
      }
    }
    await m.assertVisible({
      text: exactText(actor.accountLabel),
      timeout: 30000
    })
    await ui.present('chat-conversation-list')
    assert.equal(
      (await (await fixtureClient(this.f, key)).whoAmI())?.id,
      actor.userId
    )
  }

  async approveBrowserLink(provider: Peer, signal: AbortSignal): Promise<void> {
    const proof: Json = {
      browserLinkApproval: [],
      startedAt: new Date().toISOString(),
      outcome: 'failed',
      providerApiAbortBound: true
    }
    this.observations.push(proof)
    const visible = async (selector: Json): Promise<boolean> => {
      signal.throwIfAborted()
      try {
        await this.ui.device.assertVisible(
          { ...selector, timeout: 500 },
          { signal }
        )
        return true
      } catch (error) {
        signal.throwIfAborted()
        if (
          error == null ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'COMMAND_FAILED'
        )
          throw error
        return false
      }
    }
    try {
      await until(
        async () => {
          signal.throwIfAborted()
          const list = await visible({ id: 'chat-conversation-list' })
          const link = await visible({ text: exactText('Link this device') })
          signal.throwIfAborted()
          const sample: Json = { at: new Date().toISOString(), list, link }
          ;(proof.browserLinkApproval as unknown[]).push(sample)
          assert(!(list && link), 'Ambiguous browser Link/list readiness')
          if (list) return true
          if (link) {
            sample.pendingCount = (await provider.client.chatLinks()).length
            signal.throwIfAborted()
            if (Number(sample.pendingCount) > 0) {
              await provider.approvePending()
              signal.throwIfAborted()
              // The helper enumerates its own fresh snapshot; this is a call result.
              sample.approvalCompletedAt = new Date().toISOString()
              sample.pendingAfter = (await provider.client.chatLinks()).length
            }
          }
          return undefined
        },
        'existing-provider approval and actual browser conversation list',
        30000
      )
      proof.outcome = 'passed'
    } finally {
      proof.finishedAt = new Date().toISOString()
    }
  }

  async openGroup(id = this.group): Promise<void> {
    await this.ui.open('/chat/' + encodeURIComponent(id))
    await this.ui.present('chat-message-history')
  }

  /**
   * Runs an iOS history drag. On a loaded simulator a drag can register as a
   * hold and open the message actions over the history, sometimes seconds
   * after the drag; they are closed and the drag repeated, at most three
   * times, each recorded under `key`.
   */
  async withoutDragActions(
    drag: () => Promise<unknown>,
    key: string,
    target: string
  ): Promise<void> {
    const ui = this.ui
    await drag()
    for (
      let attempt = 0;
      ui.surface === 'ios' &&
      attempt < 3 &&
      (await ui.visible({ id: 'chat-message-spotlight' }, 3000));
      attempt++
    ) {
      this.observations.push({ [key]: target, attempt })
      await this.dismiss()
      await ui.absent('chat-message-spotlight')
      await drag()
    }
  }

  /**
   * Scrolls an iOS tall bubble until its top is above the reader and its body
   * still crosses it. A quick drag flings the history about twice its length
   * (E5 passed the bubble by thousands of points), so each drag is slow, aims
   * the bubble's top a third of its height (at most 120 pt) above the reader,
   * and comes back when it went past.
   */
  async iosTallSourceAboveReader(
    id: string,
    top: number,
    bottom: number
  ): Promise<void> {
    const span = bottom - top - 24
    for (let step = 0; step < 8; step++) {
      const b = await this.targetBounds('chat-bubble-' + id)
      if (b.y < top - 12 && b.y + b.height > top + 40) return
      const goal = top - Math.min(b.height / 3, 120)
      const travel = Math.max(-span, Math.min(span, b.y - goal))
      const from = travel > 0 ? bottom - 12 : top + 12
      const x = Math.round(b.x + b.width / 2)
      await this.withoutDragActions(
        async () => {
          await this.ui.measuredSwipe({
            startX: x,
            startY: Math.round(from),
            endX: x,
            endY: Math.round(from - travel),
            duration: 1000
          })
        },
        'iosTallSourceDragOpenedActions',
        id
      )
    }
  }

  /**
   * The pinned list slides in, and a phone's driver finds a row and taps its
   * centre while the row still moves, so the tap misses and the list stays
   * open. On iOS a row is tapped once two reads of its frame agree.
   */
  async tapPinnedRow(messageId: string): Promise<void> {
    const ui = this.ui
    const id = 'chat-pin-' + messageId
    if (ui.surface === 'ios') {
      await ui.present(id)
      let previous: string | undefined
      const frame = await until(
        async () => {
          const current = JSON.stringify(await ui.publicBounds(id))
          const settled = current === previous
          previous = current
          return settled ? current : undefined
        },
        'settled pinned row',
        30000
      )
      this.observations.push({
        settledPinnedRow: messageId,
        frame: JSON.parse(frame) as Json
      })
    }
    await ui.id(id)
  }

  async anchor(target = this.f.messages.target): Promise<void> {
    const ui = this.ui
    if (await ui.visible({ id: 'chat-pinned-summary' }, 1000)) {
      await ui.id('chat-pinned-summary')
      // One iOS read can outlast the list's entrance; a missed list stays
      // open over the history.
      if (
        await ui.visible(
          { text: exactText('Pinned messages') },
          ui.surface === 'ios' ? 10000 : 1000
        )
      )
        // A phone's list can still be sliding in above its keyboard, and
        // after a fresh sign-in its rows wait for the pinned posts; its row
        // gets the time two iPhone reads take. Without it the target is
        // climbed to page by page, which a grown history cannot finish.
        if (
          await ui.visible(
            { id: 'chat-pin-' + target.id },
            ui.native && ui.physical ? 10000 : 500
          )
        ) {
          await this.tapPinnedRow(target.id)
          if (ui.native) await this.nativePinJumpReady(target)
        } else if (ui.native) await this.closeNativePinList()
        else await this.dismiss()
    }
    if (!ui.native) await this.webHistoryTarget(target)
    else {
      await this.nativeHistoryTarget(target)
      await this.withoutDragActions(
        async () => await this.nativeAnchorReady(target),
        'nativeFramingOpenedActions',
        target.id
      )
    }
    await ui.present('chat-bubble-' + target.id)
    if (!ui.native)
      await ui.dom(
        `const n=document.querySelector(${JSON.stringify('[data-testid="chat-bubble-' + target.id + '"]')}); if(!n)throw Error('Visible target required');const h=document.querySelector('[data-testid="chat-message-history"]');if(!h||!h.contains(n))throw Error('Visible target required');${WEB_OWNED_SCROLL}center(n);return {publicDomScroll:true,userOwned:true}`
      )
    if (!ui.native) await this.webAnchorReady(target)
  }

  /**
   * The pinned list's Cancel is its full-screen backdrop, and the driver taps
   * an element's centre, which is the list itself. Tap the backdrop where the
   * list leaves it exposed, then require the list gone.
   */
  async closeNativePinList(): Promise<void> {
    const ui = this.ui
    type Box = NonNullable<PublicNode['bounds']>
    const nodes = await ui.nodes()
    // A single pin's summary jumps without opening a list, and its own first
    // line reads "Pinned messages" until its post loads: with no list row
    // and no backdrop there is no list to close.
    if (
      !nodes.some(n => n.id?.startsWith('chat-pin-') === true) &&
      !nodes.some(n => n.text === 'Cancel')
    ) {
      this.observations.push({ nativePinListClosed: 'no list open' })
      return
    }
    const largest = (text: string): Box =>
      need(
        nodes
          .filter(n => n.text === text && n.bounds != null)
          .map(n => n.bounds!)
          .sort((a, b) => b.width * b.height - a.width * a.height)[0],
        'Actual pinned list element required: ' + text
      )
    const frame = largest('Cancel')
    const list = largest('Pinned messages')
    const above = { ...frame, height: list.y - frame.y - 8 }
    const below = {
      ...frame,
      y: list.y + list.height + 8,
      height: frame.y + frame.height - (list.y + list.height + 8)
    }
    // A phone's list sits above its keyboard, which covers the backdrop
    // below the card (a tap there types a key and the list stays open), so
    // the backdrop above the card is tapped whenever it is exposed.
    const clear = [above, below].find(b => b.height >= 44)
    const row = need(
      nodes.find(n => n.id?.startsWith('chat-pin-') === true)?.id,
      'Actual pinned list row required'
    )
    await ui.tapObserved({
      bounds: need(clear, 'Exposed pinned list backdrop required')
    })
    await ui.absent(row)
  }

  /** Let an explicitly selected public pin finish before manual history gestures. */
  async nativePinJumpReady(target: Chat2Message): Promise<void> {
    const ui = this.ui
    assert(ui.native, 'Native pin jump observation required')
    const signal = AbortSignal.any([ui.deadline, AbortSignal.timeout(30000)])
    const proof: Json = {
      nativePinJump: target.id,
      samples: [],
      outcome: 'failed'
    }
    this.observations.push(proof)
    let previous: string | undefined
    let stableSince = Date.now()
    await until(
      async () => {
        signal.throwIfAborted()
        const nodes = await ui.nodes(undefined, signal)
        signal.throwIfAborted()
        const pending = nodes.some(
          node => node.id === 'chat-history-jump-cancel'
        )
        assert(
          !nodes.some(node => node.id === 'chat-history-jump-retry'),
          'Selected native pin jump failed; public Retry requires investigation'
        )
        const matches = nodes.filter(
          node => node.id === 'chat-bubble-' + target.id
        )
        assert(
          matches.length <= 1,
          'Unique selected native pin target required'
        )
        const box = matches[0]?.bounds
        let signature: string | undefined
        let band: { top: number; bottom: number } | undefined
        if (!pending && box != null && box.height > 0) {
          const bounds = (id: string): NonNullable<PublicNode['bounds']> => {
            const matches = nodes.filter(node => node.id === id)
            assert.equal(
              matches.length,
              1,
              'Unique native pin geometry required: ' + id
            )
            const b = need(
              matches[0].bounds,
              'Actual native pin bounds required'
            )
            assert(
              [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
                b.width > 0 &&
                b.height > 0,
              'Finite positive native pin geometry required'
            )
            return b
          }
          const history = bounds('chat-message-history')
          const header = bounds('chat-conversation-identity')
          const composer = bounds('chat-composer-band')
          const pins = nodes.filter(node => node.id === 'chat-pinned-band')
          assert(pins.length <= 1, 'Unique native pin band required')
          const pin = pins.length === 1 ? bounds('chat-pinned-band') : undefined
          band = {
            top: Math.max(
              history.y,
              header.y + header.height,
              pin == null ? history.y : pin.y + pin.height
            ),
            bottom: Math.min(history.y + history.height, composer.y)
          }
          assert(
            band.bottom - band.top > 64,
            'Actual unobscured native pin reading band required'
          )
          bounds('chat-bubble-' + target.id)
          if (box.y < band.bottom && box.y + box.height > band.top)
            signature = JSON.stringify({
              box,
              band,
              ids: [
                ...new Set(
                  nodes.flatMap(node =>
                    node.id?.startsWith('chat-bubble-') === true
                      ? [node.id]
                      : []
                  )
                )
              ].sort()
            })
        }
        ;(proof.samples as unknown[]).push({ pending, box, band })
        if (signature == null || signature !== previous) {
          previous = signature
          stableSince = Date.now()
          return undefined
        }
        return Date.now() - stableSince >= 200 ? true : undefined
      },
      'selected native pin target and loaded window to settle',
      30000
    )
    proof.outcome = 'passed'
  }

  /**
   * A conversation read on a phone. A system overlay (a delivered
   * notification, iOS's "Connecting…" HUD) can hide the app from one
   * snapshot, which then lists no history at all: read again, briefly.
   */
  async conversationNodes(signal: AbortSignal): Promise<PublicNode[]> {
    const ui = this.ui
    let nodes = await ui.nodes(undefined, signal)
    for (
      let attempt = 0;
      attempt < 5 &&
      ui.native &&
      !nodes.some(node => node.id === 'chat-message-history');
      attempt++
    ) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      nodes = await ui.nodes(undefined, signal)
    }
    return nodes
  }

  /** Native existence assertions include clipped and occluded rows; measure before acting. */
  async nativeAnchorReady(
    target: Chat2Message,
    earlier = false,
    parentSignal = this.ui.deadline,
    // Set on the one retry after a scroll to top carried the reader past it.
    recovered = false
  ): Promise<PublicNode[]> {
    const ui = this.ui
    assert(ui.native, 'Native anchor geometry required')
    const id = earlier ? 'Load earlier messages' : 'chat-bubble-' + target.id
    const matchesTarget = (node: PublicNode): boolean =>
      earlier
        ? node.text === id && /(?:^|\.)Button$/.test(node.type ?? '')
        : node.id === id
    const proof: Json = {
      ...(earlier
        ? { nativeEarlierControlFor: target.id }
        : { nativeAnchor: target.id }),
      samples: [],
      gestures: []
    }
    this.observations.push(proof)
    const startedAt = Date.now()
    // A long QA history can put an iOS target twenty swipes away.
    // Paging a long QA history up to an old target takes minutes on iOS.
    let end = startedAt + (ui.surface === 'ios' ? 1200000 : 120000)
    const signal = (): AbortSignal => {
      assert(Date.now() < end, 'Native anchor observation deadline expired')
      return AbortSignal.any([
        ui.deadline,
        parentSignal,
        AbortSignal.timeout(Math.max(1, end - Date.now()))
      ])
    }
    let loadedTargetNodes: PublicNode[] | undefined
    const handoff = (): PublicNode[] => {
      assert(loadedTargetNodes != null, 'Actual loaded native target required')
      proof.outcome = 'target-loaded'
      return loadedTargetNodes
    }
    const read = async (): Promise<
      | {
          nodes: PublicNode[]
          box: NonNullable<PublicNode['bounds']>
          band: { top: number; bottom: number }
        }
      | undefined
    > => {
      const nodes = await this.conversationNodes(signal())
      if (earlier) {
        const matches = nodes.filter(
          node => node.id === 'chat-bubble-' + target.id
        )
        assert(
          matches.length <= 1,
          'Unique exact native history target required'
        )
        if (matches.length === 1) {
          loadedTargetNodes = nodes
          proof.loadedTarget = { id: target.id, bounds: matches[0].bounds }
          // Loading is not framing; the caller must still measure this target.
          return undefined
        }
      }
      const one = (
        key: string,
        clipped = false
      ): NonNullable<PublicNode['bounds']> => {
        const matches = nodes.filter(node =>
          key === id ? matchesTarget(node) : node.id === key
        )
        assert.equal(
          matches.length,
          1,
          'Unique native anchor element required: ' + key
        )
        const b = need(
          matches[0].bounds,
          'Actual native anchor bounds required'
        )
        assert(
          [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
            b.width > 0 &&
            (clipped || b.height > 0),
          'Finite actual native geometry required'
        )
        return b
      }
      const history = one('chat-message-history')
      const header = one('chat-conversation-identity')
      const composer = one('chat-composer-band')
      const pins = nodes.filter(node => node.id === 'chat-pinned-band')
      assert(pins.length <= 1, 'Unique native pin band required')
      const top = Math.max(
        history.y,
        header.y + header.height,
        ...(pins.length === 0
          ? []
          : [one('chat-pinned-band').y + one('chat-pinned-band').height])
      )
      const band = {
        top,
        bottom: Math.min(history.y + history.height, composer.y)
      }
      assert(
        band.bottom - band.top > 64,
        'Actual unobscured native reading band required'
      )
      const box = one(id, true)
      ;(proof.samples as unknown[]).push({ box, band })
      return { nodes, box, band }
    }
    // Each earlier page puts the next one ~10,000 pt further up a growing
    // QA history, and an iOS read takes seconds; the climbs below share it.
    if (earlier) end = startedAt + (ui.surface === 'ios' ? 900000 : 600000)
    // A page loaded above a phone's reader can leave the next earlier control
    // outside the rendered window, so it is in no tree at all. There the
    // status bar's scroll to top climbs toward the history's start (where the
    // control is the list's header) until the control mounts; each touch must
    // mount a different set of rows.
    if (earlier && ui.surface === 'ios' && ui.physical) {
      const climb: Json[] = []
      for (;;) {
        const nodes = await ui.nodes(undefined, signal())
        if (
          nodes.some(matchesTarget) ||
          nodes.some(node => node.id === 'chat-bubble-' + target.id)
        )
          break
        const rows = nodes
          .flatMap(node =>
            node.id?.startsWith('chat-bubble-') === true ? [node.id] : []
          )
          .join('\n')
        assert(
          climb.length === 0 || climb.at(-1)!.rows !== rows,
          'System scroll to top must move toward the earlier control'
        )
        assert(climb.length < 20, 'Earlier control must mount near the start')
        climb.push({ rows })
        proof.earlierControlClimb = climb.length
        await ui.device.tapOnPoint({ x: 60, y: 20 }, { signal: signal() })
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }
    // Android has no status-bar scroll to top: drags toward the history's
    // start, inside the actual reading band, bring the header control in.
    if (earlier && ui.surface === 'android') {
      const climb: Json[] = []
      for (;;) {
        const nodes = await ui.nodes(undefined, signal())
        if (
          nodes.some(matchesTarget) ||
          nodes.some(node => node.id === 'chat-bubble-' + target.id)
        )
          break
        const rows = nodes
          .flatMap(node =>
            node.id?.startsWith('chat-bubble-') === true ? [node.id] : []
          )
          .join('\n')
        assert(
          climb.length === 0 || climb.at(-1)!.rows !== rows,
          'Drags toward the start must move the history'
        )
        assert(climb.length < 120, 'Earlier control must mount near the start')
        climb.push({ rows })
        proof.earlierControlClimb = climb.length
        const box = (key: string): NonNullable<PublicNode['bounds']> =>
          need(
            nodes.find(node => node.id === key)?.bounds,
            'Actual native climb geometry required: ' + key
          )
        const history = box('chat-message-history')
        const header = box('chat-conversation-identity')
        const pins = nodes.find(node => node.id === 'chat-pinned-band')?.bounds
        const top = Math.max(
          history.y,
          header.y + header.height,
          pins == null ? 0 : pins.y + pins.height
        )
        const bottom = Math.min(
          history.y + history.height,
          box('chat-composer-band').y
        )
        assert(bottom - top > 160, 'Actual native climb band required')
        const x = Math.round(history.x + history.width / 2)
        await ui.measuredSwipe(
          {
            startX: x,
            endX: x,
            startY: Math.round(top + (bottom - top) * 0.2),
            endY: Math.round(top + (bottom - top) * 0.8),
            duration: 250
          },
          signal()
        )
        await new Promise(resolve => setTimeout(resolve, 600))
      }
    }
    const initial = await read()
    if (initial == null) return handoff()
    let current = initial
    const keyboard =
      ui.surface === 'ios'
        ? current.nodes
            .filter(node => node.type === 'Keyboard')
            .map(node => node.bounds)
        : current.nodes.some(
              node => node.id === 'chat-composer' && node.focused === true
            )
          ? // A phone keeps the composer focused with its keyboard hidden.
            [(await ui.readAndroidImeState()).keyboard].filter(
              (box): box is NonNullable<typeof box> => box != null
            )
          : []
    if (keyboard.length > 0) end = Math.max(end, startedAt + 120000)
    // iOS swipes about a screen per read of a ~2600-node tree, and the
    // earlier control sits a long history above the reader (budget above).
    assert(keyboard.length <= 1, 'Unique actual native Keyboard required')
    const intersects = (): boolean =>
      current.box.height > 0 &&
      current.box.y < current.band.bottom &&
      current.box.y + current.box.height > current.band.top
    // A phone's WebDriverAgent reports whole-point frames: the app's own pin
    // jump puts a row 8 pt under the pins (178.67 under 170.67 on the
    // simulator), which a phone reads as 167 under 160. Its margin takes one
    // point of that rounding.
    const margin = ui.surface === 'ios' && ui.physical ? 6.5 : 7.5
    const safe = (): boolean =>
      intersects() &&
      current.box.y >= current.band.top + margin &&
      current.box.y +
        Math.min(
          current.box.height,
          current.band.bottom - current.band.top - 32
        ) <=
        current.band.bottom - margin
    // A target taller than the reader leaves only a narrow landing window.
    const readerTall = (): boolean =>
      current.box.height >= current.band.bottom - current.band.top - 32
    const distance = (): number =>
      current.box.y >= current.band.bottom
        ? current.box.y - current.band.bottom
        : current.band.top - current.box.y - current.box.height
    const swipe = async (delta: number, duration = 200): Promise<boolean> => {
      const { box, band } = current
      const middle = (band.top + band.bottom) / 2
      const input = {
        startX: Math.round(box.x + box.width / 2),
        endX: Math.round(box.x + box.width / 2),
        startY: Math.round(middle - delta / 2),
        endY: Math.round(middle + delta / 2),
        duration
      }
      assert(
        // A slow drag (iOS, or a short one for a reader-tall Android target)
        // is sized from its touch slop, so it may be as short as 20.
        Math.abs(delta) >=
          ((ui.surface === 'ios' && duration >= 1000) ||
          (ui.surface === 'android' && duration === ANDROID_SHORT_DRAG_MS)
            ? 20
            : 48) &&
          Math.min(input.startY, input.endY) > band.top &&
          Math.max(input.startY, input.endY) < band.bottom,
        'Meaningful gesture must stay inside actual reading band'
      )
      ;(proof.gestures as unknown[]).push(input)
      await ui.measuredSwipe(input, signal())
      await new Promise(resolve => setTimeout(resolve, 350))
      const next = await read()
      if (next == null) return true
      current = next
      return false
    }
    let crossingLimit = Number.POSITIVE_INFINITY
    let reversed = false
    if (!intersects()) {
      const k = keyboard[0]
      if (k != null)
        assert(
          k.width > 0 && k.height > 0 && current.band.bottom <= k.y + 1,
          'Native reading band must clear actual Keyboard'
        )
      // A phone's driver paces every drag itself, so its flicks carry no
      // fling: about 450 pt each, and a target sixty screens up both outlasts
      // the bounded drags and leaves the rendered window on the way. There the
      // system's own scroll to top, a touch on the status bar, brings the
      // loaded history's start (where the paged-in target lies) toward the
      // reader first; the measured drags take over from there. Above a freshly
      // loaded page one touch stops about 1,200 pt nearer while the new rows
      // measure, so the history is read until it rests, and touched at most
      // twenty times, each required to bring the target nearer. A phone's
      // 450 pt drags also get three times the simulator's forty.
      const statusBar: Json[] = []
      while (
        ui.surface === 'ios' &&
        ui.physical &&
        statusBar.length < 20 &&
        current.box.y < current.band.top &&
        distance() > (current.band.bottom - current.band.top) * 8
      ) {
        const before = distance()
        const point = { x: 60, y: 20 }
        proof.statusBarScrollToTop = statusBar
        await ui.device.tapOnPoint(point, { signal: signal() })
        for (let reads = 0; reads < 5; reads++) {
          await new Promise(resolve => setTimeout(resolve, 1000))
          let next: Awaited<ReturnType<typeof read>>
          try {
            next = await read()
          } catch (error) {
            // A short history's start can lie just past the target: the touch
            // carries the reader beyond it, and the rendered window lets it
            // go. It is found again among the loaded rows (from the start
            // toward the latest) and framed from there, once.
            if (
              earlier ||
              recovered ||
              (await this.conversationNodes(signal())).some(matchesTarget)
            )
              throw error
            proof.statusBarPassedTarget = statusBar.length + 1
            assert(
              await this.nativeLoadedTarget(target, signal(), 'older'),
              'A target the scroll to top passed must be found again'
            )
            return await this.nativeAnchorReady(
              target,
              earlier,
              parentSignal,
              true
            )
          }
          if (next == null) return handoff()
          const resting = Math.abs(next.box.y - current.box.y) < 1
          current = next
          if (reads > 0 && resting) break
        }
        statusBar.push({ point, before, after: distance() })
        assert(
          intersects() || distance() < before - 1,
          'System scroll to top must bring the far target nearer'
        )
      }
      for (let step = 0; !intersects(); step++) {
        assert(
          step < (ui.physical ? 120 : 40) && Date.now() < end,
          'Bounded native reading-band scroll required'
        )
        const before = distance()
        const previous = current
        const below = current.box.y >= current.band.bottom
        const height = current.band.bottom - current.band.top
        // Long iOS histories need measured progress; damp the final approach to avoid a fling past the target.
        const travel =
          ui.surface === 'ios'
            ? Math.min(height * 0.8, Math.max(48, (before + height / 4) / 2))
            : Math.min(
                height * 0.6,
                Math.max(48, (Math.max(0, before) + height / 4) / 2),
                crossingLimit
              )
        // A target many screens away (a long QA history) is reached with
        // momentum flicks; the measured drags take over near it.
        const far = ui.surface === 'ios' && before > height * 8
        if (await swipe((below ? -1 : 1) * travel, far ? 80 : 200))
          return handoff()
        const nowBelow = current.box.y >= current.band.bottom
        const crossed =
          ui.surface !== 'ios' && !intersects() && below !== nowBelow
        if (ui.surface !== 'ios') {
          const movement = below
            ? Math.max(
                previous.box.y - current.box.y,
                previous.box.y +
                  previous.box.height -
                  current.box.y -
                  current.box.height
              )
            : Math.max(
                current.box.y - previous.box.y,
                current.box.y +
                  current.box.height -
                  previous.box.y -
                  previous.box.height
              )
          assert(
            movement > 1,
            'Exact target must advance in the requested native gesture direction'
          )
          if (crossed) {
            assert(
              !reversed &&
                Math.abs(previous.band.top - current.band.top) < 1 &&
                Math.abs(previous.band.bottom - current.band.bottom) < 1,
              'Only one target crossing of the unchanged reading band may reverse'
            )
            reversed = true
            crossingLimit = Math.max(48, travel / 2)
            proof.nativeAnchorReversal = {
              from: previous.box,
              to: current.box,
              band: current.band,
              movement,
              nextMaximum: crossingLimit
            }
          }
        }
        assert(
          intersects() || distance() < before - 1 || crossed,
          'Exact target must advance after native gesture'
        )
      }
    }
    for (let step = 0; !safe(); step++) {
      assert(
        // A phone's slow, fling-free drags move a tall row a little at a
        // time: both platforms get eight measured framing drags.
        step < 8 && current.box.height > 0,
        'Positive native target must clear header, pins and composer'
      )
      const { box, band } = current
      const desired =
        (band.top + band.bottom) / 2 -
        box.y -
        Math.min(box.height, band.bottom - band.top - 32) / 2
      // A quick short drag still flings an iOS history about 200 pt (E10's
      // tall target never landed in its 17 pt window); a slow one does not,
      // and moves it about its own length, so on iOS one slow drag may span
      // the reader: a growing QA history left E9/E10 hundreds of points away
      // after the flicks, past eight eighth-of-a-reader steps.
      // Android's quick drags flung E10's reader-tall target past the same
      // narrow window, so a reader-tall Android target is dragged slowly too.
      const slow = ui.surface === 'ios' || readerTall()
      const limit = slow
        ? band.bottom - band.top - 24
        : Math.max(48, (band.bottom - band.top) / 8)
      // A slow drag moves about its touch slop less than its length (about
      // 10 pt on iOS, 8 dp on the Pixel), so it can land in a 17 pt window; a
      // 48 pt minimum overshot it both ways for E10's reader-tall target.
      const slop = ui.surface === 'ios' ? 10 : 21
      const size = slow
        ? Math.min(limit, Math.max(20, Math.abs(desired) + slop))
        : Math.min(limit, Math.max(48, Math.abs(desired)))
      // An Android drag shorter than 48 px held for a second is still inside
      // the Pixel's 21 px touch slop when the long-press timeout ends, and
      // opens the message's actions; it moves in 300 ms instead, still far
      // below the fling speed.
      const duration = !slow
        ? 200
        : ui.surface === 'android' && size < 48
          ? ANDROID_SHORT_DRAG_MS
          : 1000
      if (await swipe(Math.sign(desired) * size, duration)) return handoff()
    }
    proof.outcome = 'passed'
    return current.nodes
  }

  /**
   * The app-header Back, as the browser case requires it. iOS's Back is that
   * control already; Android's system Back from a cold-linked chat returns
   * to Home, so Android taps the observed header Back.
   */
  async headerBack(): Promise<void> {
    const ui = this.ui
    if (ui.surface !== 'android') {
      await ui.back()
      return
    }
    const backs = (await ui.nodes()).filter(
      node =>
        node.text === 'Back' &&
        /(?:^|\.)Button$/.test(node.type ?? '') &&
        node.enabled !== false &&
        node.bounds != null
    )
    assert.equal(backs.length, 1, 'Unique observed app-header Back required')
    await ui.tapObserved(backs[0])
  }

  /** A chat's newest post, as the protocol peer reads it. */
  async newestPost(conversation: string): Promise<MessageView> {
    const peer = await this.protocolPeer()
    return need(
      (await peer.engine.open(conversation)).messages.at(-1),
      'Newest verified post required'
    )
  }

  /** Which half of the protocol peer's newest page of this chat holds the post. */
  async newestPageSide(
    target: Chat2Message
  ): Promise<'latest' | 'older' | undefined> {
    const peer = await this.protocolPeer()
    const view = await peer.engine.open(this.group)
    const index = view.messages.findIndex(message => message.id === target.id)
    // The half of the newest page the post lies in tells which end of the
    // loaded history is nearer.
    const side =
      index < 0
        ? undefined
        : index >= view.messages.length / 2
          ? 'latest'
          : 'older'
    this.observations.push({ newestPagePost: target.id, side })
    return side
  }

  /** Fetch absent native rows through the actual public earlier-page button. */
  async nativeHistoryTarget(target: Chat2Message): Promise<void> {
    const ui = this.ui
    assert(ui.native, 'Native history paging required')
    const id = 'chat-bubble-' + target.id
    // Android's and a phone's normalized hierarchy omit enabled:true (an
    // explicit false is still refused); the simulator's must prove it.
    const enabled = (node: PublicNode): boolean =>
      ui.surface === 'android' || ui.physical
        ? node.enabled !== false
        : node.enabled === true
    // Each iOS page is a long climb to its earlier control (see nativeAnchorReady).
    const signal = AbortSignal.any([
      ui.deadline,
      AbortSignal.timeout(ui.surface === 'ios' ? 1200000 : 900000)
    ])
    const targetCount = (nodes: PublicNode[]): number => {
      const count = nodes.filter(node => node.id === id).length
      assert(count <= 1, 'Unique exact native history target required')
      return count
    }
    const read = async (observationSignal = signal): Promise<PublicNode[]> => {
      observationSignal.throwIfAborted()
      return await ui.nodes(undefined, observationSignal)
    }
    let nodes = await read()
    if (targetCount(nodes) === 1) return
    const earlierButton = (node: PublicNode): boolean =>
      node.text === 'Load earlier messages' &&
      /(?:^|\.)Button$/.test(node.type ?? '')
    // The app loads the newest page first, so a post of the protocol peer's
    // newest page is loaded and only outside the mounted window; a phone's
    // slow drags cannot afford pages climbed in the wrong direction, so it is
    // searched among the loaded rows first.
    if (ui.surface === 'ios' && ui.physical && nodes.some(earlierButton)) {
      const side = await this.newestPageSide(target)
      if (side != null && (await this.nativeLoadedTarget(target, signal, side)))
        return
    }
    // With every page loaded, the virtualized history may still hold the
    // target outside its mounted window.
    const oldest = target.seq <= (this.f.messages.oldest?.seq ?? -Infinity)
    if (!nodes.some(earlierButton)) {
      if (
        await this.nativeLoadedTarget(
          target,
          signal,
          oldest ? 'older' : 'latest',
          oldest
        )
      )
        return
      nodes = await read()
    }
    const proof: Json = { nativeHistoryTarget: target.id, pages: [] }
    this.observations.push(proof)
    for (let page = 0; ; page++) {
      if (targetCount(nodes) === 1) {
        proof.outcome = 'passed'
        return
      }
      // The last page loaded above a reader that stayed on its row: the
      // target is a loaded row outside the mounted window, most likely above.
      if (page > 0 && !nodes.some(earlierButton)) {
        if (await this.nativeLoadedTarget(target, signal, 'older', oldest)) {
          proof.outcome = 'passed'
          return
        }
        nodes = await read()
      }
      assert(page < 10, 'Bounded native earlier-page count required')
      const controls = nodes.filter(
        node =>
          node.text === 'Load earlier messages' &&
          /(?:^|\.)Button$/.test(node.type ?? '')
      )
      // A virtualized history mounts its earlier control only near the top;
      // the climb below brings it into the window.
      assert(
        controls.length <= 1,
        'Unique public native earlier Button required'
      )
      assert(
        controls.every(enabled),
        'Enabled public native earlier Button required'
      )
      nodes = await this.nativeAnchorReady(target, true, signal)
      if (targetCount(nodes) === 1) continue
      const control = nodes.filter(
        node =>
          node.text === 'Load earlier messages' &&
          /(?:^|\.)Button$/.test(node.type ?? '')
      )
      assert(
        control.length === 1 && enabled(control[0]),
        'Actual earlier Button must remain enabled'
      )
      const box = need(
        control[0].bounds,
        'Framed public earlier Button required'
      )
      const before = new Set(
        nodes.flatMap(node =>
          node.id?.startsWith('chat-bubble-') === true ? [node.id] : []
        )
      )
      const sample: Json = { page, box, before: [...before] }
      ;(proof.pages as unknown[]).push(sample)
      signal.throwIfAborted()
      await ui.device.tapOnPoint(
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        { signal }
      )
      // One iOS read of a long history takes seconds; the page load itself
      // follows the tap.
      const progressWait = ui.surface === 'ios' ? 60000 : 10000
      const progressSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(progressWait)
      ])
      nodes = await until(
        async () => {
          const next = await read(progressSignal)
          if (
            targetCount(next) === 1 ||
            next.some(
              node =>
                node.id?.startsWith('chat-bubble-') === true &&
                !before.has(node.id)
            )
          )
            return next
          return undefined
        },
        'actual native earlier-page message progress',
        progressWait
      )
      sample.after = nodes.flatMap(node =>
        node.id?.startsWith('chat-bubble-') === true ? [node.id] : []
      )
    }
  }

  /**
   * The virtualized history mounts only the rows near its reading band.
   * Swipe through the loaded rows in both directions (latest end first, or
   * older rows first after a page loaded above the reader) until the target
   * is mounted or the history stops moving at both ends.
   */
  async nativeLoadedTarget(
    target: Chat2Message,
    signal: AbortSignal,
    first: 'latest' | 'older' = 'latest',
    // The oldest post is never below the reader. Sweeping older lets the
    // history load its earlier pages as it reaches them.
    olderOnly = false
  ): Promise<boolean> {
    const ui = this.ui
    const id = 'chat-bubble-' + target.id
    const proof: Json = { nativeLoadedTarget: target.id, swipes: [] }
    this.observations.push(proof)
    // A phone's drag moves a tall-row history less than its mounted window,
    // so the same rows stay mounted while it moves; there only rows that also
    // keep their places mean the history stopped.
    const placed = ui.surface === 'ios' && ui.physical
    const bubbles = (nodes: PublicNode[]): string =>
      nodes
        .flatMap(node =>
          node.id?.startsWith('chat-bubble-') === true
            ? [
                placed
                  ? node.id + '@' + Math.round(node.bounds?.y ?? 0)
                  : node.id
              ]
            : []
        )
        .join('\n')
    let nodes = await this.conversationNodes(signal)
    // A phone's drags carry no fling, so sweeping sixty screens back takes a
    // quarter of an hour. There the history's start is reached with the status
    // bar's scroll to top (touched until the rows rest, as a fresh page can
    // stop one touch short), and one sweep toward the latest rows from there
    // covers what the first sweep did not.
    // A post sought latest-first is reached from the latest end, which the
    // app's own Go to latest control brings to the reader.
    const sweeps: Array<1 | -1 | 'start' | 'end'> = olderOnly
      ? [1]
      : placed
        ? first === 'latest'
          ? ['end', 1, 'start', -1]
          : ['start', -1]
        : first === 'latest'
          ? // From the latest end one sweep toward older rows reaches every
            // loaded row; sweeping there first from the reader repeats it.
            ui.surface === 'android'
            ? ['end', 1]
            : [-1, 1]
          : [1, -1]
    for (const [index, direction] of sweeps.entries()) {
      if (nodes.some(node => node.id === id)) break
      if (direction === 'end') {
        if (await ui.visible({ id: 'chat-jump-latest' }, 500)) {
          await ui.id('chat-jump-latest')
          await new Promise(resolve => setTimeout(resolve, 1500))
          nodes = await ui.nodes(undefined, signal)
          proof.latestJump = true
        }
        continue
      }
      if (direction === 'start') {
        let touches = 0
        while (touches < 20) {
          touches += 1
          const before = bubbles(nodes)
          await ui.device.tapOnPoint({ x: 60, y: 20 }, { signal })
          await new Promise(resolve => setTimeout(resolve, 1500))
          nodes = await ui.nodes(undefined, signal)
          if (nodes.some(node => node.id === id) || bubbles(nodes) === before)
            break
        }
        proof.statusBarStart = touches
        continue
      }
      let still = 0
      // On a phone the sweep back from the latest end only looks near it: the
      // sweep from the history's start that follows covers every loaded row,
      // and an old target in a grown history is far nearer that end.
      const limit = placed && first === 'latest' && index === 1 ? 30 : 200
      // A few loaded pages are many screens; each end stops the history.
      for (let step = 0; step < limit && still < 2; step++) {
        if (nodes.some(node => node.id === id)) break
        const one = (key: string): NonNullable<PublicNode['bounds']> =>
          need(
            nodes.find(node => node.id === key)?.bounds,
            'Native reading band element required: ' + key
          )
        const history = one('chat-message-history')
        const header = one('chat-conversation-identity')
        const composer = one('chat-composer-band')
        const pins = nodes.find(node => node.id === 'chat-pinned-band')?.bounds
        const top = Math.max(
          history.y,
          header.y + header.height,
          pins == null ? 0 : pins.y + pins.height
        )
        const bottom = Math.min(history.y + history.height, composer.y)
        assert(
          bottom - top > 64,
          'Actual unobscured native reading band required'
        )
        // A finger moving up reads toward the latest rows, down toward older.
        const middle = (top + bottom) / 2
        // A quick Pixel drag flings more than a screen between reads, past a
        // row the driver lists only while it is on screen (E10's loop anchor
        // was swept past); Android drags most of a reader slowly instead,
        // which never moves a row past the screen between reads.
        const slowAndroid = ui.surface === 'android'
        const delta =
          direction *
          (bottom - top) *
          (slowAndroid ? 0.8 : olderOnly ? 0.9 : 0.6)
        const x = Math.round(history.x + history.width / 2)
        const input = {
          startX: x,
          endX: x,
          startY: Math.round(middle - delta / 2),
          endY: Math.round(middle + delta / 2),
          duration: slowAndroid ? ANDROID_SWEEP_MS : 200
        }
        ;(proof.swipes as unknown[]).push(input)
        const before = bubbles(nodes)
        await ui.measuredSwipe(input, signal)
        await new Promise(resolve => setTimeout(resolve, 350))
        nodes = await this.conversationNodes(signal)
        still = bubbles(nodes) === before ? still + 1 : 0
      }
    }
    const found = nodes.some(node => node.id === id)
    proof.outcome = found ? 'found' : 'absent'
    return found
  }

  /** Page through the real public history control; browser scroll does not fetch older rows. */
  async webHistoryTarget(target: Chat2Message): Promise<void> {
    const ui = this.ui
    assert(!ui.native, 'Browser history paging required')
    // Sweeping a virtualized history a screen at a time through a few hundred
    // loaded rows takes longer than finding a row that is always in the DOM.
    const end = Date.now() + 180000
    const signal = AbortSignal.any([ui.deadline, AbortSignal.timeout(180000)])
    const proof: Json = {
      publicHistoryTarget: target.id,
      samples: [],
      actions: []
    }
    this.observations.push(proof)
    const read = async (position = ''): Promise<Json> => {
      assert(Date.now() < end, 'Public history paging exceeded its budget')
      const value = await ui.dom(
        `
        const id=${JSON.stringify('chat-bubble-' + target.id)},position=${JSON.stringify(position)};
        const histories=document.querySelectorAll('[data-testid="chat-message-history"]');if(histories.length!==1)throw Error('Unique actual history required');const h=histories[0];
        const targets=Array.from(document.querySelectorAll('[data-testid='+JSON.stringify(id)+']'));if(targets.length>1||targets.some(n=>!h.contains(n)))throw Error('Ambiguous or unscoped history target');
        const controls=Array.from(h.querySelectorAll('button,[role="button"]')).filter(n=>n.textContent.trim()==='Load earlier messages');if(controls.length>1)throw Error('Unique public Load earlier control required');const control=controls[0];
        ${WEB_OWNED_SCROLL}
        if(position==='earlier'){if(!control)throw Error('No earlier control for missing target');center(control)}
        let moved=false;if(position==='latest'||position==='sweep'||position==='down')moved=own(position==='latest'?h.scrollHeight:position==='down'?h.scrollTop+h.clientHeight*0.8:h.scrollTop-h.clientHeight*0.8);
        if(position==='target'){if(targets.length!==1)throw Error('Actual target required');center(targets[0])}
        let css;if(control){let n=control,parts=[];while(n!==h){const p=n.parentElement;if(!p)throw Error('Actual history ancestry required');parts.unshift('*:nth-child('+(Array.from(p.children).indexOf(n)+1)+')');n=p}css='[data-testid="chat-message-history"] > '+parts.join(' > ');if(document.querySelectorAll(css).length!==1||document.querySelector(css)!==control)throw Error('Unique scoped earlier control required')}
        const box=n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};
        return {position,moved,offset:h.scrollTop,content:h.scrollHeight,targetCount:targets.length,target:targets[0]?box(targets[0]):null,history:box(h),earlier:control?{css,disabled:control.disabled===true,ariaDisabled:control.getAttribute('aria-disabled'),box:box(control)}:null,ids:Array.from(h.querySelectorAll('[data-testid^="chat-bubble-"]')).map(n=>n.getAttribute('data-testid'))};
      `,
        signal
      )
      ;(proof.samples as unknown[]).push({
        at: new Date().toISOString(),
        value
      })
      return value
    }
    // A virtualized history keeps correcting its reader while rows measure.
    // Settled means the same offset and extent across three reads.
    const settled = async (): Promise<Json> => {
      const samples: Json[] = []
      return await until(
        async () => {
          const next = await read()
          samples.push(next)
          const recent = samples.slice(-3)
          return recent.length === 3 &&
            recent.every(
              sample =>
                sample.offset === recent[0].offset &&
                sample.content === recent[0].content
            )
            ? next
            : undefined
        },
        'settled public history geometry',
        Math.max(1, end - Date.now())
      )
    }
    // The virtualized history mounts only the rows near its reading band, so
    // a loaded target can be absent from the DOM. Search the loaded rows
    // (from the latest end, or from the reader up, or down to the latest
    // end) before paging older ones.
    const search = async (from: 'latest' | 'sweep' | 'down'): Promise<Json> => {
      const step = from === 'down' ? 'down' : 'sweep'
      let swept = await read(from)
      // From the latest end the sweep always climbs, even when the reader was
      // already there. Each history end stops it; a bound covers an end that
      // never reports.
      let moving = swept.moved === true || from === 'latest'
      for (
        let steps = 0;
        steps < 500 && swept.targetCount !== 1 && moving;
        steps++
      ) {
        await new Promise(resolve => setTimeout(resolve, 200))
        swept = await read()
        if (swept.targetCount !== 1) swept = await read(step)
        moving = swept.moved === true
      }
      return await settled()
    }
    for (let pages = 0; pages <= 10; pages++) {
      let current = await read()
      if (current.targetCount !== 1)
        current = await search(pages === 0 ? 'latest' : 'sweep')
      // Every page is loaded: the target can only be below the reader.
      if (current.targetCount !== 1 && current.earlier == null)
        current = await search('down')
      if (current.targetCount === 1) {
        const intersects = (sample: Json): boolean => {
          const box = sample.target as PublicNode['bounds']
          const history = sample.history as NonNullable<PublicNode['bounds']>
          return (
            sample.targetCount === 1 &&
            box != null &&
            [
              box.x,
              box.y,
              box.width,
              box.height,
              history.x,
              history.y,
              history.width,
              history.height
            ].every(Number.isFinite) &&
            box.width > 0 &&
            box.height > 0 &&
            history.width > 0 &&
            history.height > 0 &&
            box.x < history.x + history.width &&
            box.x + box.width > history.x &&
            box.y < history.y + history.height &&
            box.y + box.height > history.y
          )
        }
        // Rows the move brings in measure and shift the target again; centre
        // it until the settled history holds it.
        let rested = await read('target')
        for (let attempt = 0; attempt < 5; attempt++) {
          rested = await settled()
          if (rested.targetCount !== 1 || intersects(rested)) break
          await read('target')
        }
        // A target the window let go of is found again by the search.
        if (rested.targetCount !== 1) continue
        assert(
          intersects(rested),
          'Actual target must intersect public history'
        )
        return
      }
      assert(
        pages < 10 && current.earlier != null,
        'Missing target has no public earlier page within ten-page bound'
      )
      const positioned = await read('earlier')
      const control = positioned.earlier as Json
      assert(
        control?.disabled === false &&
          (control.ariaDisabled === null || control.ariaDisabled === 'false') &&
          typeof control.css === 'string',
        'Enabled scoped public earlier control required'
      )
      const response = await ui.device.tapOn(
        {
          css: control.css,
          enabled: true,
          timeout: Math.max(1, end - Date.now())
        },
        { signal }
      )
      ;(proof.actions as unknown[]).push({
        at: new Date().toISOString(),
        css: control.css,
        response
      })
      const before = JSON.stringify(current.ids)
      await until(
        async () => {
          const next = await read()
          return next.targetCount === 1 || JSON.stringify(next.ids) !== before
            ? true
            : undefined
        },
        'actual public history page progress',
        Math.max(1, end - Date.now())
      )
      // The reader stays on its row while the new page measures; never
      // scroll to or measure a target before that settles.
      await settled()
    }
    throw Error('Public history target not reached')
  }

  /** Fresh observations settle real layout; later measurements are never replaced or cached. */
  async webAnchorReady(target = this.f.messages.target): Promise<void> {
    const ui = this.ui
    assert(!ui.native, 'Browser anchor readiness required')
    // A resized or freshly paged virtualized history remeasures its rows
    // before it rests; a first read can take over a second.
    const budget = 10000
    const signal = AbortSignal.any([ui.deadline, AbortSignal.timeout(budget)])
    const proof: Json = { stableWebAnchor: target.id, samples: [] }
    this.observations.push(proof)
    let previous: string | undefined
    let since = 0
    let missing: string | undefined
    await until(
      async () => {
        const value = await ui.dom(
          `
        const id=${JSON.stringify(target.id)},one=id=>{const ns=document.querySelectorAll('[data-testid='+JSON.stringify(id)+']');if(ns.length!==1)throw Error('Unique actual anchor element required: '+id);return ns[0]};
        const h=one('chat-message-history'),absent=['chat-message-'+id,'chat-bubble-'+id].find(n=>document.querySelectorAll('[data-testid='+JSON.stringify(n)+']').length===0);if(absent)return {missing:absent};
        const r=one('chat-message-'+id),b=one('chat-bubble-'+id);if(!h.contains(r)||!r.contains(b))throw Error('Actual history/row/bubble ancestry required');
        const box=n=>{const b=n.getBoundingClientRect(),v={x:b.x,y:b.y,width:b.width,height:b.height};if(!Object.values(v).every(Number.isFinite)||b.width<=0||b.height<=0)throw Error('Positive finite actual anchor geometry required');return v};
        if(![h.scrollTop,h.scrollHeight,h.clientHeight,innerWidth,innerHeight].every(Number.isFinite)||h.clientHeight<=0)throw Error('Finite positive actual history/viewport required');
        return {observedMs:performance.now(),geometry:{row:box(r),bubble:box(b),history:{box:box(h),offset:h.scrollTop,content:h.scrollHeight,height:h.clientHeight},viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY}}};
      `,
          signal
        )
        ;(proof.samples as unknown[]).push({
          at: new Date().toISOString(),
          value
        })
        // A virtualized row can be briefly unmounted while its window moves;
        // it is read again once mounted, never assumed to stay.
        if (typeof value.missing === 'string') {
          missing = value.missing
          previous = undefined
          return undefined
        }
        missing = undefined
        const viewport = (
          value.geometry as { viewport: { width: number; height: number } }
        ).viewport
        const expected = ui.metrics()
        assert(
          viewport.width === expected.width &&
            viewport.height === expected.height,
          'Actual anchor viewport must match the measured requested frame'
        )
        const signature = JSON.stringify(value.geometry)
        const observed = Number(value.observedMs)
        assert(
          Number.isFinite(observed),
          'Actual browser observation time required'
        )
        if (previous !== signature) {
          previous = signature
          since = observed
        } else if (observed - since >= 200) return true
        return undefined
      },
      'stable actual row/history geometry for 200ms',
      budget
    ).catch((error: unknown) => {
      if (missing != null)
        throw Error('Unique actual anchor element required: ' + missing)
      throw error
    })
  }

  async targetBounds(id: string): Promise<NonNullable<PublicNode['bounds']>> {
    const startedAt = new Date().toISOString()
    const bounds = await this.ui.publicBounds(id)
    this.observations.push({
      actualPublicBounds: {
        id,
        startedAt,
        returnedAt: new Date().toISOString(),
        bounds
      }
    })
    return bounds
  }

  async action(
    target: Chat2Message,
    method: 'hold' | 'hover' | 'swipe' = 'hold',
    preparation: 'anchor' | 'visible' = 'anchor'
  ): Promise<void> {
    const ui = this.ui
    if (preparation === 'anchor') await this.anchor(target)
    else await ui.present('chat-bubble-' + target.id)
    if (!ui.native && (!this.touchActions || method === 'hover')) {
      await ui.dom(
        `const n=document.querySelector(${JSON.stringify('[data-testid="chat-bubble-' + target.id + '"]')});if(!n)throw Error('Visible target required');n.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));n.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}));return {method:'public DOM hover event through Maestro'}`
      )
      await ui.device.tapOn({
        css: `[data-testid="chat-message-${target.id}"] [aria-label="${method === 'hover' ? 'Reply' : 'More message actions'}"]`
      })
    } else if (method === 'swipe') {
      const b = await this.targetBounds('chat-bubble-' + target.id)
      await ui.measuredSwipe({
        startX: Math.round(b.x + b.width * 0.2),
        startY: Math.round(b.y + b.height / 2),
        endX: Math.round(b.x + b.width * 0.7),
        endY: Math.round(b.y + b.height / 2),
        duration: 200
      })
    } else {
      const point = !ui.native
        ? await this.zoomedHoldPoint(target)
        : ui.surface === 'ios' && ui.physical
          ? await this.phoneHoldPoint(target)
          : undefined
      await ui.device.longPressOn({
        id: 'chat-bubble-' + target.id,
        ...(point == null ? {} : { point }),
        duration: 550
      })
      await ui.device.assertVisible({ text: exactText('Reply'), timeout: 5000 })
    }
  }

  /**
   * A phone's driver holds an element at its frame's centre, which for a
   * reader-tall bubble lies under the composer, where the hold opens the
   * keyboard instead. There the hold point is the centre of the bubble's
   * part in the unobscured reader, relative to the bubble; a bubble whose
   * centre is in the reader keeps the driver's own centre.
   */
  async phoneHoldPoint(target: Chat2Message): Promise<string | undefined> {
    const nodes = await this.ui.nodes()
    const box = (id: string): NonNullable<PublicNode['bounds']> | undefined =>
      nodes.find(node => node.id === id)?.bounds
    const bubble = need(
      box('chat-bubble-' + target.id),
      'Actual bubble for a hold required'
    )
    const history = need(box('chat-message-history'), 'Actual history required')
    const header = need(
      box('chat-conversation-identity'),
      'Actual header required'
    )
    const composer = need(box('chat-composer-band'), 'Actual composer required')
    const pins = box('chat-pinned-band')
    const band = {
      top: Math.max(
        history.y,
        header.y + header.height,
        pins == null ? 0 : pins.y + pins.height
      ),
      bottom: Math.min(history.y + history.height, composer.y)
    }
    const centre = bubble.y + bubble.height / 2
    if (centre > band.top + 8 && centre < band.bottom - 8) return undefined
    const top = Math.max(bubble.y, band.top)
    const bottom = Math.min(bubble.y + bubble.height, band.bottom)
    assert(
      bubble.height > 0 && bottom - top >= 16,
      'Visible unobscured part of the bubble required for a hold'
    )
    const point = `50%,${Math.round((((top + bottom) / 2 - bubble.y) / bubble.height) * 1000) / 10}%`
    this.observations.push({ phoneHold: target.id, bubble, band, point })
    return point
  }

  /**
   * Under pinch zoom the driver's element hold reveals the bubble, then hit-
   * tests the centre of its visual-viewport-relative box in layout
   * coordinates; any pan moves that probe onto another element and the hold
   * fails as "cannot find element". An explicit point stays in one space
   * (box and pointer are both visual-viewport relative), so hold the centre of
   * the bubble's part that is both in the visual viewport and in the reader.
   */
  async zoomedHoldPoint(target: Chat2Message): Promise<string | undefined> {
    const located = await this.ui.dom(
      `const v=window.visualViewport;if(v==null||v.scale===1)return {scale:1};const n=document.querySelector(${JSON.stringify('[data-testid="chat-bubble-' + target.id + '"]')});if(!n)throw Error('Public zoomed bubble required');const b=n.getBoundingClientRect();return {scale:v.scale,x:b.x,y:b.y,width:b.width,height:b.height,left:v.offsetLeft,top:v.offsetTop,right:v.offsetLeft+v.width,bottom:v.offsetTop+v.height}`
    )
    if (Number(located.scale) === 1) return undefined
    const band = await this.readingBand()
    const x = Number(located.x)
    const y = Number(located.y)
    const width = Number(located.width)
    const height = Number(located.height)
    const left = Math.max(x, Number(located.left))
    const right = Math.min(x + width, Number(located.right))
    const top = Math.max(y, Number(located.top), band.top)
    const bottom = Math.min(y + height, Number(located.bottom), band.bottom)
    assert(
      width > 0 && height > 0 && right - left >= 8 && bottom - top >= 8,
      'Zoomed hold requires a visible unobscured part of the bubble'
    )
    const percent = (offset: number, size: number): string =>
      String(Math.round((offset / size) * 1000) / 10) + '%'
    const point = `${percent((left + right) / 2 - x, width)},${percent((top + bottom) / 2 - y, height)}`
    this.observations.push({ zoomedHold: target.id, located, band, point })
    return point
  }

  async reply(target = this.f.messages.target): Promise<void> {
    await this.action(
      target,
      !this.ui.native && !this.ui.metrics().coarse ? 'hover' : 'hold'
    )
    if (this.ui.native || this.ui.metrics().coarse) await this.ui.text('Reply')
    await this.ui.device.assertVisible({
      text: exactText('Cancel reply'),
      timeout: 5000
    })
    await this.ui.assertKeyboard()
  }

  async cancelReply(timeoutMs = 90000): Promise<void> {
    const ui = this.ui
    if (ui.surface !== 'ios') {
      await ui.device.assertVisible({ text: exactText('Cancel reply') })
      await ui.text('Cancel reply')
      await ui.device.assertNotVisible({ text: exactText('Cancel reply') })
      return
    }
    const deadline = Date.now() + timeoutMs
    const signal = AbortSignal.timeout(timeoutMs)
    const proof: Json = {
      requiredReplyCancellation: true,
      startedAt: new Date().toISOString()
    }
    this.observations.push(proof)
    type Node = Awaited<ReturnType<Chat2UI['iosRead']>>
    type Box = NonNullable<Node['bounds']>
    const box = (node: Node): Box => {
      const value = need(node.bounds, 'Measured reply context bounds required')
      assert(
        [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
          value.width > 0 &&
          value.height > 0,
        'Positive finite reply context geometry required'
      )
      return value
    }
    const contains = (outer: Box, inner: Box): boolean =>
      inner.x >= outer.x - 1 &&
      inner.y >= outer.y - 1 &&
      inner.x + inner.width <= outer.x + outer.width + 1 &&
      inner.y + inner.height <= outer.y + outer.height + 1
    const measure = async (): Promise<{ band: Node; editor: Node }> => {
      const band = await ui.iosRead(
        { id: 'chat-composer-band' },
        undefined,
        signal
      )
      const editor = await ui.iosRead(
        { id: 'chat-composer' },
        'TextView',
        signal
      )
      assert(
        band.id === 'chat-composer-band' &&
          editor.id === 'chat-composer' &&
          editor.type === 'TextView' &&
          editor.enabled === true &&
          typeof editor.text === 'string',
        'Exact enabled reply composer identity required'
      )
      assert(
        contains(box(band), box(editor)),
        'Actual editable composer must remain inside its band'
      )
      return { band, editor }
    }
    try {
      const cancel = await ui.iosRead(
        { text: exactText('Cancel reply') },
        'Button',
        signal
      )
      proof.cancel = cancel
      assert(
        cancel.type === 'Button' &&
          cancel.label === 'Cancel reply' &&
          cancel.enabled === true,
        'Required exact enabled Cancel reply Button must be observed'
      )
      const before = await measure()
      proof.before = before
      const control = box(cancel)
      const band = box(before.band)
      const editor = box(before.editor)
      assert(
        contains(band, control) && control.y + control.height <= editor.y + 1,
        'Cancel reply must occupy the measured context row above the editor'
      )
      const api = ui.device as unknown as {
        tapOnPoint: (
          args: { x: number; y: number },
          options: { signal: AbortSignal }
        ) => Promise<unknown>
        screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
      }
      const tap = {
        x: control.x + control.width / 2,
        y: control.y + control.height / 2
      }
      proof.tap = tap
      await api.tapOnPoint(tap, { signal })
      const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1
      const cleared = (after: Awaited<ReturnType<typeof measure>>): boolean => {
        const next = box(after.band)
        const field = box(after.editor)
        assert(
          after.editor.text === before.editor.text,
          'Reply cancellation must preserve actual editor text'
        )
        assert(
          same(next.x, band.x) &&
            same(next.width, band.width) &&
            same(next.y + next.height, band.y + band.height) &&
            (['x', 'y', 'width', 'height'] as const).every(key =>
              same(field[key], editor[key])
            ),
          'Reply cancellation must preserve the editor row and composer band edges'
        )
        return (
          next.height < band.height - 1 &&
          next.y >= control.y + control.height - 1
        )
      }
      while (Date.now() < deadline) {
        const after = await measure()
        proof.after = after
        if (cleared(after)) {
          proof.image = saveCapture(
            await api.screenshot({ signal }),
            join(
              ui.runDir,
              'required-reply-cancellation-' + Date.now() + '.png'
            )
          )
          const verified = await measure()
          proof.verified = verified
          assert(
            cleared(verified),
            'Cleared reply context must remain cleared around the actual screenshot'
          )
          proof.outcome = 'passed'
          proof.evidence =
            'Positive measured context-row removal with unchanged editor; raw image requires visual review'
          return
        }
        await new Promise(resolve =>
          setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())))
        )
      }
      throw new Error(
        'Required Cancel reply did not remove its measured context row'
      )
    } catch (error) {
      proof.outcome = 'failed'
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async peerMessage(
    body: string,
    options: { quoteId?: string; mentions?: string[] } = {},
    conversation = this.group
  ): Promise<MessageView> {
    const peer = await this.protocolPeer()
    await peer.engine.open(conversation)
    const message = need(
      await peer.engine.sendText(conversation, body, options),
      'Peer send did not produce a verified post'
    )
    this.observations.push({
      peerPost: message.id,
      seq: message.seq,
      conversation
    })
    return message
  }

  async delivered(
    body: string,
    conversation = this.group
  ): Promise<MessageView> {
    const peer = await this.protocolPeer()
    return await until(
      async () => {
        const view = await peer.engine.open(conversation)
        const matches = view.messages.filter(
          m => m.status === 'ok' && m.body === body
        )
        assert(matches.length <= 1, 'Encrypted send must not duplicate a post')
        return matches[0]
      },
      'exact decrypted peer delivery',
      30000
    )
  }

  /**
   * Whether the last attachPhoto was skipped. A phone has no driver API that
   * adds media, and no photo is placed on it by hand: there the attachment
   * is reported as not run, and only the checks of that attachment (its chip
   * and the delivered attachment count) follow it.
   */
  photoAttachSkipped = false

  /** The attachment chip, when a photo was attached. */
  async presentAttachment(): Promise<void> {
    if (!this.photoAttachSkipped) await this.ui.present('chat-attachment-chip')
  }

  /** The delivered attachment count of the composed post. */
  get expectedAttachments(): number {
    return this.photoAttachSkipped ? 0 : 1
  }

  async attachPhoto(): Promise<void> {
    const ui = this.ui
    const files = need(this.f.files, 'Synthetic attachment fixture required')
    this.photoAttachSkipped = ui.surface === 'ios' && ui.physical
    if (this.photoAttachSkipped) {
      this.observations.push({
        photoAttach: 'skipped-physical-ios-no-media-api'
      })
      ui.steps.push({
        name: 'Photo attachment',
        outcome: 'not-run',
        reason: 'skipped-physical-ios-no-media-api'
      })
      return
    }
    if (!ui.native) {
      await ui.uploadPhoto(files.photo)
      return
    } else {
      await ui.device.addMedia({ files: [files.photo] })
      await ui.text('Attach')
      // Attach toggles its sources; a retried tap that landed before they
      // rendered closes them again.
      if (!(await ui.visible({ text: exactText('Photo library') }, 3000))) {
        this.observations.push({ attachRetapped: true })
        await ui.text('Attach')
      }
      await ui.text('Photo library')
      for (const selector of need(
        files.nativePicker?.[ui.surface],
        'Observed public native photo-picker selectors required'
      ))
        await ui.device.tapOn(selector)
    }
    await ui.present('chat-attachment-chip')
  }

  async sendAgain(): Promise<void> {
    const ui = this.ui
    const draft = await ui.draft()
    assert(draft.trim() !== '', 'Actual retained failed draft required')
    const error = await ui.device.assertVisible({
      text: exactText('That did not send. Try again.'),
      timeout: 1000
    })
    const send = await ui.device.assertVisible({
      text: exactText('Send'),
      enabled: true,
      timeout: 1000
    })
    assert.equal(
      await ui.draft(),
      draft,
      'Failed draft must remain exact until retry submission'
    )
    this.observations.push({
      sendAgain: {
        error,
        send,
        retainedDraft: draft,
        at: new Date().toISOString()
      }
    })
    await ui.text('Send')
  }

  /** The fine-pointer picker returns its raw pinned glyph, including variation selectors. */
  async pickThumbsUp(): Promise<string> {
    const ui = this.ui
    assert(
      !ui.native && !this.touchActions,
      'Fine-pointer browser emoji picker required'
    )
    const css = '[role="button"][aria-label="thumbs up"]'
    const signal = AbortSignal.any([ui.deadline, AbortSignal.timeout(5000)])
    const observed = await ui.dom(
      `
      const ns=Array.from(document.querySelectorAll(${JSON.stringify(css)}));
      const buttons=ns.map(n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return {role:n.getAttribute('role'),label:n.getAttribute('aria-label'),text:n.textContent,enabled:!n.matches(':disabled')&&n.getAttribute('aria-disabled')!=='true',visible:n.isConnected&&s.display!=='none'&&!['hidden','collapse'].includes(s.visibility)&&Number(s.opacity)>0,box:{x:b.x,y:b.y,width:b.width,height:b.height},centerHits:hit===n||n.contains(hit)}});
      return {count:ns.length,buttons,viewport:{width:innerWidth,height:innerHeight}};
    `,
      signal
    )
    this.observations.push({ actualEmojiButton: observed, css })
    const button = (observed.buttons as Json[])[0]
    const box = button?.box as PublicNode['bounds']
    const viewport = observed.viewport as { width: number; height: number }
    assert(
      observed.count === 1 &&
        button.role === 'button' &&
        button.label === 'thumbs up' &&
        button.enabled === true &&
        button.visible === true &&
        button.centerHits === true &&
        box != null &&
        Object.values(box).every(Number.isFinite) &&
        box.width > 0 &&
        box.height > 0 &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height,
      'Unique enabled visible in-viewport thumbs-up Button required'
    )
    const choices = (
      emojiData as Array<{
        label: string
        unicode: string
        group?: number
        order?: number
      }>
    ).filter(
      emoji =>
        emoji.label === 'thumbs up' &&
        emoji.group != null &&
        emoji.group !== 2 &&
        emoji.order != null
    )
    assert(
      choices.length === 1 &&
        typeof button.text === 'string' &&
        button.text === choices[0].unicode,
      'Actual selected raw glyph must equal pinned picker data'
    )
    const response = await ui.device.tapOn(
      { css, enabled: true, timeout: 5000 },
      { signal }
    )
    const clicked = (response as { element?: { text?: unknown } }).element?.text
    assert(
      clicked === button.text,
      'Actual tapped semantic Button must return the observed raw glyph'
    )
    this.observations.push({
      actualEmojiSelection: {
        response,
        raw: button.text,
        viewerId: this.viewerId
      }
    })
    return button.text
  }

  /** Establish actual user-owned scroll before testing saved zero or width restoration. */
  async ownWebReader(target: Chat2Message, zero = false): Promise<void> {
    const ui = this.ui
    assert(!ui.native, 'Browser wheel ownership required')
    const end = Date.now() + 30000
    const signal = AbortSignal.any([ui.deadline, AbortSignal.timeout(30000)])
    interface Sample {
      observedMs: number
      offset: number
      maximum: number
      height: number
      bubble: NonNullable<PublicNode['bounds']>
      history: NonNullable<PublicNode['bounds']>
      viewport: { width: number; height: number }
    }
    const proof: Json = {
      actualWheelReader: target.id,
      zero,
      samples: [],
      actions: []
    }
    this.observations.push(proof)
    // Before the first wheel the point must hit plain history; once the
    // wheel moves rows, a control under the point still passes the wheel to
    // the history, and only an inner scroller would take it.
    const read = async (strict = false): Promise<Sample> => {
      assert(Date.now() < end, 'Actual user-scroll setup exceeded 30 seconds')
      const value = (await ui.dom(
        `
        const one=id=>{const ns=document.querySelectorAll('[data-testid='+JSON.stringify(id)+']');if(ns.length!==1)throw Error('Unique actual reader required');return ns[0]},h=one('chat-message-history'),b=one(${JSON.stringify('chat-bubble-' + target.id)}),x=innerWidth/2,y=innerHeight/2,hit=document.elementFromPoint(x,y);
        if(!h.contains(b)||!hit||!h.contains(hit))throw Error('Actual target and wheel hitpoint must belong to history');
        let interactive=false;for(let n=hit;n!==h;n=n.parentElement){if(!n)throw Error('Actual wheel ancestry required');const s=getComputedStyle(n),control=n.matches('input,textarea,select,button,[contenteditable],[role="slider"],[role="combobox"],[role="listbox"]');if((${strict}&&control)||(n.scrollHeight>n.clientHeight&&['auto','scroll'].includes(s.overflowY)))throw Error('Interactive or inner-scroll wheel interception');if(control)interactive=true}
        const box=n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};
        return {observedMs:performance.now(),offset:h.scrollTop,maximum:h.scrollHeight-h.clientHeight,height:h.clientHeight,history:box(h),bubble:box(b),viewport:{width:innerWidth,height:innerHeight},wheelPoint:{x,y},controlUnderWheel:interactive};
      `,
        signal
      )) as unknown as Sample
      ;(proof.samples as unknown[]).push({
        at: new Date().toISOString(),
        value
      })
      assert(
        [
          value.observedMs,
          value.offset,
          value.maximum,
          value.height,
          ...Object.values(value.history),
          ...Object.values(value.bubble)
        ].every(Number.isFinite) &&
          value.height > 0 &&
          value.maximum > 0 &&
          value.offset >= 0 &&
          value.offset <= value.maximum &&
          [value.history, value.bubble].every(b => b.width > 0 && b.height > 0),
        'Positive finite actual wheel geometry required'
      )
      const expected = ui.metrics()
      assert(
        value.viewport.width === expected.width &&
          value.viewport.height === expected.height,
        'Actual wheel viewport must match the measured browser frame'
      )
      return value
    }
    if (!zero) {
      const setup = await ui.dom(
        `
        const one=id=>{const ns=document.querySelectorAll('[data-testid='+JSON.stringify(id)+']');if(ns.length!==1)throw Error('Unique actual wheel setup element required');return ns[0]},h=one('chat-message-history'),b=one(${JSON.stringify('chat-bubble-' + target.id)}),x=innerWidth/2,y=innerHeight/2,hit=document.elementFromPoint(x,y);
        if(!h.contains(b)||!hit||!h.contains(hit))throw Error('Actual target and wheel hitpoint must belong to history');
        let blocked=false;for(let n=hit;n!==h;n=n.parentElement){if(!n)throw Error('Actual wheel ancestry required');const s=getComputedStyle(n);if(n.matches('input,textarea,select,button,[contenteditable],[role="slider"],[role="combobox"],[role="listbox"]')||(n.scrollHeight>n.clientHeight&&['auto','scroll'].includes(s.overflowY)))blocked=true}
        if(!blocked)return {positioned:false};
        const body=one(${JSON.stringify('chat-message-body-' + target.id)});if(!b.contains(body))throw Error('Exact target body must belong to the wheel source');const rect=body.getBoundingClientRect();if(![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)||rect.width<=0||rect.height<=0)throw Error('Positive actual wheel source body required');
        ${WEB_OWNED_SCROLL}const before=h.scrollTop;own(h.scrollTop+rect.y+rect.height/2-y);return {positioned:true,before,after:h.scrollTop,body:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},wheelPoint:{x,y}};
      `,
        signal
      )
      proof.noninteractiveWheelSetup = setup
      if (setup.positioned === true) await this.webAnchorReady(target)
    }
    const before = await read(true)
    assert(
      !zero || before.offset === 0,
      'Real oldest history zero required before user-scroll setup'
    )
    assert(
      before.bubble.y < before.viewport.height &&
        before.bubble.y + before.bubble.height > 0,
      'Original reader target must actually intersect the viewport'
    )
    const settled = async (
      qualifies: (value: Sample) => boolean
    ): Promise<Sample> => {
      let signature: string | undefined
      let since = 0
      return await until(
        async () => {
          const value = await read()
          // A virtualized history measures rows the wheel brings in, so its
          // extent (and the offset that holds the reader) may change; the
          // viewport and the reader's own size may not.
          assert(
            value.height === before.height &&
              JSON.stringify(value.history) ===
                JSON.stringify(before.history) &&
              JSON.stringify(value.viewport) ===
                JSON.stringify(before.viewport),
            'Reader dimensions changed during wheel ownership setup'
          )
          const current = JSON.stringify({
            offset: value.offset,
            bubble: value.bubble
          })
          if (!qualifies(value)) signature = undefined
          else if (signature !== current) {
            signature = current
            since = value.observedMs
          } else if (value.observedMs - since >= 200) return value
          return undefined
        },
        'stable actual wheel movement/return',
        Math.max(1, end - Date.now())
      )
    }
    ;(proof.actions as unknown[]).push({
      direction: 'DOWN',
      response: await ui.device.scroll({ direction: 'DOWN' }, { signal })
    })
    proof.down = await settled(
      value =>
        value.offset > before.offset + 1 && value.bubble.y < before.bubble.y - 1
    )
    await read()
    ;(proof.actions as unknown[]).push({
      direction: 'UP',
      response: await ui.device.scroll({ direction: 'UP' }, { signal })
    })
    proof.restored = await settled(
      value =>
        // Above a nonzero reader, measured rows can change the offset that
        // shows the same row; the row's own place is the reader.
        (!zero || value.offset === 0) &&
        Math.abs(value.bubble.y - before.bubble.y) <= 3 &&
        value.bubble.x === before.bubble.x &&
        value.bubble.width === before.bubble.width &&
        value.bubble.height === before.bubble.height
    )
  }

  async readable(): Promise<void> {
    const target = await this.targetBounds(
      'chat-bubble-' + this.f.messages.target.id
    )
    const composer = await this.targetBounds('chat-composer')
    const pins = await this.targetBounds('chat-pinned-band')
    assert(
      target.y >= pins.y + pins.height - 2,
      'Target must clear floating pin band'
    )
    assert(
      target.y + target.height <= composer.y + 2,
      'Short target must clear composer'
    )
    this.observations.push({ readableTarget: target, composer, pins })
  }

  async openInfo(): Promise<void> {
    await this.ui.id('chat-conversation-identity')
    await this.ui.present('chat-info-hero')
    await this.ui.present('chat-info-members')
  }

  async showInfoMember(): Promise<Chat2Fixture['members'][number]> {
    const ui = this.ui
    const member = need(
      this.f.members.find(
        m =>
          m.userId !== this.viewerId &&
          this.f.members.filter(other => other.name === m.name).length === 1
      ),
      'Current other-member with a unique public safety label required'
    )
    const selector = { id: 'chat-info-member-' + member.userId }
    // A pinch-zoomed row is wider than the visual viewport, so a vertical-only
    // reveal leaves an earlier horizontal pan, and the driver's scroll check
    // (visual-relative bounds against the layout viewport) never passes. Align
    // the row's leading edge, where its name and role are, as a reader would.
    if (!ui.native)
      await ui.dom(
        `const n=document.querySelector(${JSON.stringify('[data-testid="' + selector.id + '"]')});if(!n)throw Error('Actual member safety row required');n.scrollIntoView({block:'center',inline:'start'});return {publicMemberScroll:true}`
      )
    await ui.device.scrollUntilVisible({
      element: selector,
      direction: 'DOWN',
      timeout: 15000
    })
    const info = ui.native ? await ui.device.platformInfo() : ui.metrics()
    const width = Number('screenWidth' in info ? info.screenWidth : info.width)
    const height = Number(
      'screenHeight' in info ? info.screenHeight : info.height
    )
    assert(
      [width, height].every(value => Number.isFinite(value) && value > 0),
      'Actual finite member-framing viewport required'
    )
    const inViewport = (box: NonNullable<PublicNode['bounds']>): boolean =>
      [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
      box.width > 0 &&
      box.height > 0 &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= width &&
      box.y + box.height <= height
    const nodes = await ui.nodes()
    const header = nodes.filter(
      n =>
        n.bounds != null &&
        inViewport(n.bounds) &&
        n.bounds.y + n.bounds.height <= height / 3 &&
        (ui.surface !== 'ios' || n.type === 'Button') &&
        (n.text === 'Back' ||
          n.text === 'Notifications' ||
          n.text?.startsWith('Account, ') === true)
    )
    assert(
      header.length > 0 &&
        (ui.surface !== 'ios' ||
          header.filter(node => node.text === 'Back').length === 1),
      'Observed public header bounds required for member framing'
    )
    const top = Math.max(...header.map(n => n.bounds!.y + n.bounds!.height)) + 8
    const footer = nodes.filter(
      n =>
        n.bounds != null &&
        inViewport(n.bounds) &&
        n.bounds.height < height / 3 &&
        n.bounds.y > height / 2 &&
        ['Home', 'Videos', 'Schedule', 'Chat'].includes(n.text ?? '')
    )
    assert(
      ui.surface !== 'ios' || footer.length > 0,
      'Actual native bottom navigation bounds required for member framing'
    )
    const bottom = Math.min(height - 8, ...footer.map(n => n.bounds!.y - 8))
    assert(
      [top, bottom].every(Number.isFinite) &&
        top > 0 &&
        bottom < height &&
        bottom - top > 32,
      'Meaningful in-viewport member reading band required before any gesture'
    )
    const measure = async (): Promise<NonNullable<PublicNode['bounds']>> => {
      const box = await ui.observedBounds(
        ui.surface === 'ios'
          ? { ...selector, childOf: { id: 'chat-info-members' } }
          : selector,
        ui.surface === 'ios' ? 'Button' : undefined
      )
      assert(
        [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
          box.width > 0 &&
          box.height > 0 &&
          box.x >= 0 &&
          box.x + box.width <= width &&
          box.height <= bottom - top,
        'Finite member row must fit the actual viewport and readable band'
      )
      return box
    }
    let bounds = await measure()
    for (
      let step = 0;
      step < 8 && (bounds.y < top || bounds.y + bounds.height > bottom);
      step++
    ) {
      await ui.measuredSwipe({
        startX: Math.round(bounds.x + bounds.width / 2),
        endX: Math.round(bounds.x + bounds.width / 2),
        startY: Math.round(bounds.y < top ? top + 16 : bottom - 16),
        endY: Math.round(bounds.y < top ? bottom - 16 : top + 16),
        duration: 350
      })
      bounds = await measure()
    }
    assert(
      bounds.height > 0 &&
        bounds.y >= top &&
        bounds.y + bounds.height <= bottom,
      'Actual other-member safety row must fully clear header and bottom overlay'
    )
    await ui.device.assertVisible(selector)
    this.observations.push({
      infoMemberFraming: {
        userId: member.userId,
        selector,
        bounds,
        unobscuredBand: { top, bottom },
        expectedRole: member.role
      }
    })
    return member
  }

  async nativeKeyboardGeometry(): Promise<void> {
    const ui = this.ui
    if (!ui.native) return
    type Box = NonNullable<PublicNode['bounds']>
    const union = (boxes: Box[]): Box => {
      const x = Math.min(...boxes.map(b => b.x))
      const y = Math.min(...boxes.map(b => b.y))
      return {
        x,
        y,
        width: Math.max(...boxes.map(b => b.x + b.width)) - x,
        height: Math.max(...boxes.map(b => b.y + b.height)) - y
      }
    }
    const overlaps = (a: Box, b: Box): boolean =>
      Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 &&
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2
    const nodes = await ui.nodes()
    const screen = await ui.device.platformInfo()
    const controls: Record<string, Box> = {
      composer: await ui.publicBounds('chat-composer')
    }
    for (const name of ['Attach', 'Send'])
      controls[name] = need(
        ui.surface === 'ios'
          ? await ui.observedBounds({ text: exactText(name) }, 'Button')
          : await ui.observedBounds({ text: exactText(name) }),
        'Actual native control bounds required: ' + name
      )
    const composerBand = await ui.publicBounds('chat-composer-band')
    const tabs: Array<{ label: string; bounds: Box }> = []
    for (const label of ['Home', 'Videos', 'Schedule', 'Chat']) {
      if (await ui.visible({ text: exactText(label) }, 200))
        tabs.push({
          label,
          bounds: need(
            ui.surface === 'ios'
              ? innermostLabelled(nodes, label)
              : (await ui.device.copyTextFrom({ text: exactText(label) }))
                  .element?.bounds,
            'Visible public navigation tab bounds required'
          )
        })
    }
    const tabUnion =
      tabs.length > 0 ? union(tabs.map(tab => tab.bounds)) : undefined
    const capsule =
      tabUnion == null
        ? undefined
        : nodes
            .map(n => n.bounds)
            .filter(
              (b): b is Box =>
                b != null &&
                b.x <= tabUnion.x &&
                b.y <= tabUnion.y &&
                b.x + b.width >= tabUnion.x + tabUnion.width &&
                b.y + b.height >= tabUnion.y + tabUnion.height &&
                b.height <= tabUnion.height * 2 &&
                b.width <= tabUnion.width * 1.25
            )
            .sort((a, b) => a.width * a.height - b.width * b.height)[0]
    let keyboard = nodes.find(
      n =>
        /keyboard/i.test(n.type ?? '') &&
        n.bounds != null &&
        n.bounds.height > 0
    )?.bounds
    let keyboardMethod =
      keyboard == null
        ? 'Exact Keyboard container absent from public hierarchy'
        : 'Actual public Keyboard container bounds'
    let diagnostic: string | undefined
    if (ui.surface === 'android') {
      const observed = await ui.readAndroidIme()
      keyboard = observed.bounds
      diagnostic = observed.rawPath
      keyboardMethod =
        'Strict positive shown exact-owned-serial OS InputMethod window frame'
    }
    const keys: Box[] = []
    if (ui.surface === 'ios')
      assert(
        keyboard != null,
        'Actual positive iOS Keyboard container required'
      )
    if (keyboard == null && ui.surface !== 'android')
      for (const key of ['q', 'w', 'e'])
        keys.push(
          need(
            (
              await ui.device.copyTextFrom({
                text: '^[' + key + key.toUpperCase() + ']$'
              })
            ).element?.bounds,
            'Actual visible keyboard key bounds required'
          )
        )
    const keyRegion = keys.length > 0 ? union(keys) : undefined
    this.observations.push({
      nativeKeyboardGeometry: {
        platform: ui.surface,
        composerBand,
        controls,
        tabs,
        tabUnion,
        exposedContainingNavView: capsule,
        keyboard,
        keyboardMethod,
        diagnostic,
        visibleKeyRegion: keyRegion,
        fullKeyboardFrameInferred: false,
        exactGlassFrameInferred: false,
        actualImageVisualConfirmationRequired: true
      }
    })
    await ui.shot(
      'native-keyboard-geometry',
      'Actual native composer/send/attach, navigation and IME geometry; public bounds plus required visual occlusion review'
    )
    for (const [name, box] of Object.entries(controls)) {
      assert(
        box.width > 0 &&
          box.height > 0 &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= Number(screen.screenWidth) + 2 &&
          box.y + box.height <= Number(screen.screenHeight) + 2,
        'Native composer control must fit actual visible device bounds: ' + name
      )
      if (keyboard != null)
        assert(
          !overlaps(box, keyboard),
          'Native control overlaps actual IME frame: ' + name
        )
      else if (keyRegion != null)
        assert(
          !overlaps(box, keyRegion),
          'Native control overlaps actual visible keyboard keys: ' + name
        )
      if (tabUnion != null)
        assert(
          !overlaps(box, tabUnion),
          'Native control overlaps actual visible AppNav tabs: ' + name
        )
      if (capsule != null)
        assert(
          !overlaps(box, capsule),
          'Native control overlaps exposed AppNav containing view: ' + name
        )
    }
  }

  async dismiss(): Promise<void> {
    const ui = this.ui
    if (ui.native && ui.surface === 'ios') {
      const nodes = await ui.nodes()
      const scenes = nodes.filter(node => node.id === 'chat-message-spotlight')
      if (scenes.length !== 0) {
        assert.equal(scenes.length, 1, 'Unique actual spotlight required')
        const measured = (
          node: PublicNode
        ): NonNullable<PublicNode['bounds']> => {
          const b = need(node.bounds, 'Actual spotlight bounds required')
          assert(
            [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
              b.width > 0 &&
              b.height > 0,
            'Positive finite spotlight geometry required'
          )
          return b
        }
        const scene = measured(scenes[0])
        const keyboards = nodes.filter(node => node.type === 'Keyboard')
        const statusBars = nodes.filter(node => node.type === 'StatusBar')
        assert(
          keyboards.length <= 1 && statusBars.length <= 1,
          'Unique actual OS occlusion required'
        )
        const frameTop =
          statusBars.length === 0
            ? scene.y
            : Math.max(
                scene.y,
                measured(statusBars[0]).y + measured(statusBars[0]).height
              )
        const frameBottom =
          keyboards.length === 0
            ? scene.y + scene.height
            : Math.min(scene.y + scene.height, measured(keyboards[0]).y)
        // iOS reports no status bar element, and a touch on it is the
        // system's scroll to top, not the app's backdrop.
        const safeTop = ui.surface === 'ios' ? Math.max(frameTop, 60) : frameTop
        const frame = { ...scene, y: safeTop, height: frameBottom - safeTop }
        // The controls container lets touches through its empty space, so
        // only the reactions, the preview and the actions block the backdrop.
        assert(
          nodes.filter(node => node.id === 'chat-message-spotlight-controls')
            .length === 1,
          'Unique actual spotlight region required: chat-message-spotlight-controls'
        )
        const blocked = [
          'chat-message-spotlight-reactions',
          'chat-message-spotlight-preview',
          'chat-message-spotlight-panel'
        ]
          .map(id => {
            const found = nodes.filter(node => node.id === id)
            assert(
              found.length <= 1,
              'Unique actual spotlight region required: ' + id
            )
            return found.map(measured)
          })
          .flat()
        assert(blocked.length > 0, 'Actual spotlight content required')
        const left = Math.min(...blocked.map(b => b.x))
        const top = Math.min(...blocked.map(b => b.y))
        const right = Math.max(...blocked.map(b => b.x + b.width))
        const bottom = Math.max(...blocked.map(b => b.y + b.height))
        const inset = {
          x: frame.x + 8,
          y: frame.y + 8,
          width: frame.width - 16,
          height: frame.height - 16
        }
        const choices = [
          { ...inset, height: top - 8 - inset.y },
          {
            ...inset,
            y: bottom + 8,
            height: inset.y + inset.height - bottom - 8
          },
          { ...inset, width: left - 8 - inset.x },
          { ...inset, x: right + 8, width: inset.x + inset.width - right - 8 },
          // Beside each content region, inside its own rows: next to a long
          // message is the only exposed backdrop left.
          ...blocked.flatMap(b => [
            { x: inset.x, y: b.y, width: b.x - 8 - inset.x, height: b.height },
            {
              x: b.x + b.width + 8,
              y: b.y,
              width: inset.x + inset.width - b.x - b.width - 8,
              height: b.height
            }
          ])
        ]
          .filter(b => b.width >= 44 && b.height >= 44)
          .filter(c =>
            blocked.every(
              b =>
                c.x + c.width <= b.x ||
                c.x >= b.x + b.width ||
                c.y + c.height <= b.y ||
                c.y >= b.y + b.height
            )
          )
        choices.sort((a, b) => b.width * b.height - a.width * a.height)
        const clear = need(
          choices[0],
          'Measured exposed spotlight backdrop required'
        )
        const point = {
          x: Math.round(clear.x + clear.width / 2),
          y: Math.round(clear.y + clear.height / 2)
        }
        assert(
          point.x > frame.x &&
            point.x < frame.x + frame.width &&
            point.y > frame.y &&
            point.y < frame.y + frame.height &&
            blocked.every(
              b =>
                point.x < b.x ||
                point.x > b.x + b.width ||
                point.y < b.y ||
                point.y > b.y + b.height
            ),
          'Dismissal point must clear every actual spotlight control and preview'
        )
        this.observations.push({
          spotlightBackdropDismiss: { frame, blocked, clear, point }
        })
        await ui.tapObserved({ bounds: clear })
        return
      }
    }
    if (!ui.native) await ui.device.pressKey({ key: 'ESC' })
    else if (
      ui.surface === 'ios' &&
      (await ui.visible({ text: exactText('Cancel') }, 500))
    )
      await ui.text('Cancel')
    else await ui.back()
  }

  async withFault(
    phase: string,
    body: () => Promise<void>,
    detail: Json = {}
  ): Promise<void> {
    fixtureControl(this.f, 'fault', {
      phase,
      viewerId: this.viewerId,
      conversationId: this.group,
      ...detail
    })
    try {
      await body()
    } finally {
      fixtureControl(this.f, 'clear-fault')
    }
  }

  async identitySafety(peerId: string, expected: string): Promise<void> {
    const member = need(
      this.f.members.find(m => m.userId === peerId),
      'Safety peer must be a current member'
    )
    assert.notEqual(
      member.userId,
      this.viewerId,
      'Distinct safety peer required'
    )
    assert(member.role !== '', 'Observed public safety role required')
    assert.equal(
      this.f.members.filter(
        m =>
          m.userId !== this.viewerId &&
          m.name === member.name &&
          m.role === member.role
      ).length,
      1,
      'Unique public safety name and role required'
    )
    await this.openInfo()
    const rowId = 'chat-info-member-' + peerId
    const label = 'Safety number with ' + member.name + ', ' + member.role
    const ui = this.ui
    type Box = NonNullable<PublicNode['bounds']>
    const samples: Json[] = []
    this.observations.push({
      safetyPeer: peerId,
      publicName: member.name,
      publicRole: member.role,
      samples
    })
    if (ui.native) {
      await ui.device.scrollUntilVisible({
        element: { id: rowId },
        direction: 'DOWN',
        timeout: 15000
      })
    }
    const read = async (): Promise<{
      bounds: Box
      top: number
      bottom: number
      topmost?: boolean
    }> => {
      const info = ui.native ? await ui.device.platformInfo() : ui.metrics()
      const width = Number(
        'screenWidth' in info ? info.screenWidth : info.width
      )
      const height = Number(
        'screenHeight' in info ? info.screenHeight : info.height
      )
      assert([width, height].every(v => Number.isFinite(v) && v > 0))
      const nodes = await ui.nodes()
      const finite = (b: Box | undefined): b is Box =>
        b != null &&
        [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
        b.width > 0 &&
        b.height > 0
      const visible = (b: Box | undefined): b is Box =>
        finite(b) &&
        b.x >= 0 &&
        b.y >= 0 &&
        b.x + b.width <= width &&
        b.y + b.height <= height
      const headers = nodes.filter(
        n =>
          visible(n.bounds) &&
          n.bounds.y + n.bounds.height <= height / 3 &&
          (n.text === 'Back' ||
            n.text === 'Notifications' ||
            n.text?.startsWith('Account, ') === true)
      )
      assert(
        headers.length > 0,
        'Observed public header required before safety tap'
      )
      const footers = nodes.filter(
        n =>
          visible(n.bounds) &&
          n.bounds.height < height / 3 &&
          n.bounds.y > height / 2 &&
          ['Home', 'Videos', 'Schedule', 'Chat'].includes(n.text ?? '')
      )
      const top =
        Math.max(...headers.map(n => n.bounds!.y + n.bounds!.height)) + 8
      const bottom = Math.min(height - 8, ...footers.map(n => n.bounds!.y - 8))
      assert(
        Number.isFinite(top) &&
          Number.isFinite(bottom) &&
          top > 0 &&
          bottom < height &&
          bottom - top > 32,
        'Actual safe Info reading band required'
      )
      let target: { bounds: Box; topmost?: boolean }
      if (ui.native) {
        const rows = nodes.filter(
          n =>
            n.id === rowId &&
            (ui.surface !== 'ios' || /button$/i.test(n.type ?? '')) &&
            finite(n.bounds)
        )
        assert.equal(
          rows.length,
          1,
          'Unique actual name and role safety row required'
        )
        assert(
          rows[0].text === label || rows[0].text === label + ', Moderator',
          'Exact peer short name and visible role required'
        )
        target = { bounds: rows[0].bounds! }
      } else {
        const actual = await ui.dom(`
          const section=document.querySelector('[data-testid="chat-info-members"]');
          if(!section)throw Error('Actual Info member section required');
          const matches=Array.from(section.querySelectorAll('button,[role="button"]')).filter(n=>n.getAttribute('data-testid')===${JSON.stringify(rowId)}&&[${JSON.stringify(label)},${JSON.stringify(label + ', Moderator')}].includes(n.getAttribute('aria-label'))&&Array.from(n.querySelectorAll('*')).some(c=>c.textContent===${JSON.stringify(member.role)}&&c.closest('button,[role="button"]')===n)).map(n=>{const b=n.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return {bounds:{x:b.x,y:b.y,width:b.width,height:b.height},topmost:hit!=null&&(hit===n||n.contains(hit))}});
          return {matches};
        `)
        assert(
          Array.isArray(actual.matches) && actual.matches.length === 1,
          'Unique actual name and role safety row required'
        )
        target = actual.matches[0] as typeof target
      }
      assert(
        finite(target.bounds) &&
          target.bounds.x >= 0 &&
          target.bounds.x + target.bounds.width <= width &&
          target.bounds.height < bottom - top
      )
      samples.push({ ...target, top, bottom })
      return { ...target, top, bottom }
    }
    let target = await read()
    for (
      let step = 0;
      step < 8 &&
      (target.bounds.y < target.top ||
        target.bounds.y + target.bounds.height > target.bottom);
      step++
    ) {
      await ui.device.scroll(
        { direction: target.bounds.y < target.top ? 'UP' : 'DOWN' },
        { signal: AbortSignal.timeout(15000) }
      )
      target = await read()
    }
    assert(
      target.bounds.y >= target.top &&
        target.bounds.y + target.bounds.height <= target.bottom &&
        (ui.native || target.topmost === true),
      'Exact role-qualified safety row must fully clear overlays'
    )
    if (ui.native) await ui.tapObserved({ bounds: target.bounds })
    else
      await ui.device.tapOn(
        { id: rowId },
        { signal: AbortSignal.timeout(15000) }
      )
    await until(
      async () => {
        const groups = (await this.ui.nodes()).filter(node =>
          /^chat-safety-group-\d+$/.test(node.id ?? '')
        )
        if (groups.length !== 12) return undefined
        const ordered = groups.sort(
          (a, b) => Number(a.id!.slice(18)) - Number(b.id!.slice(18))
        )
        assert.equal(new Set(ordered.map(n => n.id)).size, 12)
        assert(ordered.every(n => /^[0-9]{5}$/.test(n.text ?? '')))
        assert.equal(
          ordered.map(n => n.text).join(''),
          expected,
          'Actual installed safety digits must match the original public-key baseline'
        )
        return true
      },
      'actual safety digits',
      15000
    )
    await this.ui.shot(
      'identity-safety',
      'Actual installed account safety digits matched the authenticated counterpart'
    )
    await this.ui.text('Done')
    await this.openGroup()
  }

  /** Native I1 reaches the old post through its recent, authenticated reply. */
  async identityLegacyAnchor(
    target: Chat2Message,
    baseline: { text: Chat2Message; reply: Chat2Message }
  ): Promise<void> {
    const ui = this.ui
    if (!ui.native) {
      await this.anchor(target)
      return
    }
    if (await ui.visible({ id: 'chat-jump-latest' }, 1000))
      await ui.id('chat-jump-latest')
    if (target.id !== baseline.text.id) {
      await this.anchor(target)
      return
    }
    assert.equal(baseline.text.authorId, this.viewerId)
    assert(Array.from(baseline.text.body).length <= 200)
    await this.anchor(baseline.reply)
    await this.identityLegacyBody(baseline.reply)
    const proof: Json = { legacyQuoteJump: target.id, reply: baseline.reply.id }
    this.observations.push(proof)
    const rowId = 'chat-message-' + baseline.reply.id
    const parent = await this.targetBounds(rowId)
    const resolvedLabel = 'Jump to message from You: ' + baseline.text.body
    const quote = await this.identityLegacyRead(baseline.reply, 'quote')
    assert(
      quote.text === resolvedLabel ||
        quote.text === 'Jump to the earlier message this replies to',
      'Exact rendered legacy quote required'
    )
    const bounds = need(quote.bounds, 'Actual legacy quote bounds required')
    const screen = await ui.device.platformInfo()
    const width = Number(screen.screenWidth)
    const height = Number(screen.screenHeight)
    assert(
      [bounds, parent].every(
        b =>
          [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
          b.width > 0 &&
          b.height > 0
      ) &&
        [width, height].every(v => Number.isFinite(v) && v > 0) &&
        bounds.x >= Math.max(0, parent.x) &&
        bounds.y >= Math.max(0, parent.y) &&
        bounds.x + bounds.width <= Math.min(width, parent.x + parent.width) &&
        bounds.y + bounds.height <= Math.min(height, parent.y + parent.height),
      'Exact legacy quote must fit its observed reply row and screen'
    )
    await ui.tapObserved({ bounds })
    await ui.present('chat-bubble-' + target.id)
    proof.outcome = 'passed'
  }

  /** Read the target's actual descendants; duplicate text in other rows is irrelevant. */
  async identityLegacyRead(
    message: Chat2Message,
    kind: 'body' | 'quote'
  ): Promise<PublicNode> {
    const ui = this.ui
    assert(ui.native, 'Native legacy scoped read required')
    const scopeId =
      (kind === 'body' ? 'chat-message-body-' : 'chat-message-') + message.id
    const text =
      kind === 'body'
        ? exactText(message.body)
        : '^(Jump to message from .*|Jump to the earlier message this replies to)$'
    const type =
      kind === 'quote'
        ? 'Button'
        : ui.surface === 'ios'
          ? 'StaticText'
          : 'TextView'
    const selected = { text, childOf: { id: scopeId } }
    const path = join(
      ui.runDir,
      'identity-legacy-' + kind + '-' + randomUUID() + '.json'
    )
    let element: PublicNode
    let nodeCount: number
    if (ui.surface === 'ios') {
      const raw = await ui.iosRaw(AbortSignal.timeout(10000))
      writeFileSync(path, raw, { mode: 0o600, flag: 'wx' })
      const read = iosPublicRead(raw, selected, type)
      const actual = need(
        read.element,
        'Exact scoped iOS legacy element required'
      )
      const byIndex = new Map(read.nodes.map(n => [n.index, n]))
      let owner = actual.parentIndex
      let owned = false
      const seen = new Set<number>()
      while (owner != null) {
        assert(!seen.has(owner), 'Acyclic actual legacy ancestry required')
        seen.add(owner)
        const parent = need(
          byIndex.get(owner),
          'Complete actual legacy ancestry required'
        )
        if (parent.id === scopeId) owned = true
        owner = parent.parentIndex
      }
      assert(
        owned,
        'Actual legacy element must descend from its exact message scope'
      )
      element = actual
      nodeCount = read.nodes.length
    } else {
      const raw = await ui.device.hierarchy({
        signal: AbortSignal.timeout(10000)
      })
      writeFileSync(path, JSON.stringify(raw), { mode: 0o600, flag: 'wx' })
      const box = androidScopedBounds(raw, selected, type)
      const nodes = flattenPublicHierarchy(raw)
      const matches = nodes.filter(
        n =>
          n.type === type &&
          new RegExp(text).test(n.text ?? '') &&
          n.bounds != null &&
          ['x', 'y', 'width', 'height'].every(
            key =>
              n.bounds![key as keyof typeof box] ===
              box[key as keyof typeof box]
          )
      )
      assert(
        matches.length === 1,
        'Unique scoped Android legacy text and bounds required'
      )
      element = matches[0]
      nodeCount = nodes.length
    }
    this.observations.push({
      legacyScopedRead: message.id,
      kind,
      scopeId,
      nodeCount,
      hierarchy: path,
      sha256: digest(path),
      element
    })
    return element
  }

  async identityLegacyBody(message: Chat2Message): Promise<void> {
    const ui = this.ui
    if (!ui.native) {
      await ui.device.assertVisible({ text: exactText(message.body) })
      return
    }
    const band = await this.readingBand()
    const samples: Json[] = []
    this.observations.push({ legacyBody: message.id, band, samples })
    let box = await this.targetBounds('chat-bubble-' + message.id)
    const requiredHeight = (): number =>
      Math.min(box.height, band.bottom - band.top - 32)
    // Native frame serialization can round by half a coordinate unit.
    const edgeTolerance = 0.5
    const fits = (): boolean =>
      box.height > 0 &&
      box.y >= band.top + 8 - edgeTolerance &&
      box.y + requiredHeight() <= band.bottom - 8 + edgeTolerance
    for (let step = 0; ; step++) {
      assert(
        [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
          box.width > 0 &&
          band.bottom - band.top > 64,
        'Finite legacy bubble and actual reading band required'
      )
      const clipped = box.height <= 0
      assert(
        !clipped || box.y < band.top || box.y >= band.bottom,
        'Clipped legacy bounds require an observed offscreen direction'
      )
      samples.push({
        ...box,
        requiredHeight: clipped ? null : requiredHeight(),
        clipped
      })
      if (fits()) break
      assert(
        step < 8,
        'Legacy bubble must clear header, pins and composer before text verification'
      )
      const delta = clipped
        ? ((box.y < band.top ? 1 : -1) * (band.bottom - band.top)) / 2
        : box.y < band.top + 8
          ? Math.min((band.bottom - band.top) / 2, band.top + 16 - box.y)
          : -Math.min(
              (band.bottom - band.top) / 2,
              box.y + requiredHeight() - band.bottom + 16
            )
      const middle = (band.top + band.bottom) / 2
      const previousY = box.y
      const previousHeight = box.height
      await ui.measuredSwipe({
        startX: Math.round(box.x + box.width / 2),
        endX: Math.round(box.x + box.width / 2),
        startY: Math.round(middle - delta / 2),
        endY: Math.round(middle + delta / 2),
        duration: 350
      })
      box = await until(
        async () => {
          const next = await this.targetBounds('chat-bubble-' + message.id)
          samples.push({ afterGesture: next })
          return Math.abs(next.y - previousY) >= 1 ||
            (previousHeight <= 0 && next.height > 0)
            ? next
            : undefined
        },
        'native legacy reader progress after measured gesture',
        2000
      )
    }
    const element = await this.identityLegacyRead(message, 'body')
    assert(element.text === message.body, 'Exact native legacy body required')
    samples.push({ scopedBodyResult: element })
  }

  async legacyHistoryAndSafety(
    baseline: NonNullable<
      Chat2Fixture['identityCompatibility']
    >['legacy'][string]
  ): Promise<void> {
    await this.openGroup()
    for (const message of [baseline.text, baseline.reply]) {
      await this.identityLegacyAnchor(message, baseline)
      await this.identityLegacyBody(message)
    }
    if (this.ui.native) {
      const label = 'Jump to message from You: ' + baseline.text.body
      const element = await this.identityLegacyRead(baseline.reply, 'quote')
      assert(
        element.text === label,
        'Exact rendered legacy reply quote required'
      )
    } else
      await this.ui.device.assertVisible({
        text: '^Jump to message from .*'
      })
    await this.identityLegacyAnchor(baseline.file, baseline)
    if (this.ui.native) await this.identityLegacyBody(baseline.file)
    await until(
      async () => {
        try {
          return await this.ui.renderedPhoto({
            id: 'chat-bubble-' + baseline.file.id
          })
        } catch {
          return undefined
        }
      },
      'actual legacy encrypted attachment',
      30000
    )
    const peer = await this.protocolPeer()
    await this.peerTarget(peer, this.group, baseline.text.id)
    await this.peerTarget(peer, this.group, baseline.reply.id)
    const history = peer.engine.view(this.group)!
    assert(
      baseline.textMentions.length + baseline.replyMentions.length > 0,
      'A real authenticated legacy numeric mention is required'
    )
    assert.deepEqual(
      history.messages.find(m => m.id === baseline.text.id)?.mentions,
      baseline.textMentions
    )
    assert.deepEqual(
      history.messages.find(m => m.id === baseline.reply.id)?.mentions,
      baseline.replyMentions
    )
    assert.equal(
      history.messages.find(m => m.id === baseline.reply.id)?.quote?.authorId,
      baseline.text.authorId
    )
    assert.equal(
      history.messages.find(m => m.id === baseline.reply.id)?.quote?.id,
      baseline.text.id
    )
    assert.equal(
      await peer.engine.safetyNumber(this.viewerId),
      baseline.safetyNumber
    )
    await this.identitySafety(
      need((await peer.client.whoAmI())?.id, 'Safety peer session required'),
      baseline.safetyNumber
    )
  }

  async I1(): Promise<void> {
    await this.check(
      'I1 preserved installed legacy identity and encrypted history',
      async () => {
        const baseline = need(
          need(
            this.f.identityCompatibility,
            'Identity compatibility descriptor required'
          ).legacy[this.ui.surface],
          'Legacy surface baseline required'
        )
        assert.equal(
          this.viewerKey,
          baseline.actor,
          'Prepared legacy profile actor required'
        )
        assert(
          gumboOfUserId(this.viewerId) != null,
          'Legacy-derived canonical account required'
        )
        const client = await this.client()
        const before = await client.myChatKeys()
        const devices = (await client.chatDevices())
          .map(d => [d.id, d.boxPublicKey, d.signPublicKey, d.revokedAt])
          .sort((a, b) => a[0]!.localeCompare(b[0]!))
        assert.equal(before.identity?.id, baseline.identityId)
        assert.equal(before.identity?.publicKey, baseline.identityPublicKey)
        assert(
          before.generations.some(
            p =>
              p.generation === baseline.pukGeneration &&
              p.publicKey === baseline.pukPublicKey
          )
        )
        assert(
          devices.some(d => d[0] === baseline.deviceId && d[3] == null),
          'Original installed device required before reopen'
        )
        await this.signIn()
        await this.legacyHistoryAndSafety(baseline)
        const body = 'Legacy identity continuity ' + Date.now()
        await this.ui.replaceDraft(body)
        await this.ui.text('Send')
        assert.equal((await this.delivered(body)).senderUserId, this.viewerId)
        const after = await client.myChatKeys()
        assert.deepEqual(after.identity, before.identity)
        assert.deepEqual(
          after.generations.map(({ box, ...p }) => p),
          before.generations.map(({ box, ...p }) => p)
        )
        assert.deepEqual(
          (await client.chatDevices())
            .map(d => [d.id, d.boxPublicKey, d.signPublicKey, d.revokedAt])
            .sort((a, b) => a[0]!.localeCompare(b[0]!)),
          devices,
          'Reopening must not enroll, revoke or replace a device'
        )
        this.observations.push({
          legacyIdentityContinuous: true,
          originalDeviceId: baseline.deviceId,
          authenticatedNumericMentionsAndQuote: true,
          legacyPhotoOpened: true,
          safetyNumberUnchanged: true
        })
        await this.ui.shot(
          'identity-legacy',
          'Actual legacy profile after lossless database and saved-record upgrade'
        )
      }
    )
  }

  /** Public installed-browser session only; never borrow a provider's current-device flag. */
  async webContinuationState(): Promise<WebContinuationState> {
    assert(this.ui.surface === 'web-narrow' && !this.ui.native)
    const state = await this.ui.dom(`
      const base=${JSON.stringify(this.f.apiUrl)};
      const get=async suffix=>{const response=await fetch(base+suffix,{credentials:'include',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Existing installed session required');return await response.json()};
      const user=await get('/auth/me'),devices=await get('/chat/devices'),keys=await get('/chat/me/keys');
      return {userId:user.id,devices,keys:{...keys,generations:keys.generations.map(({box,...publicGeneration})=>publicGeneration)}};
    `)
    return state as unknown as WebContinuationState
  }

  async webContinuationDeviceUi(
    replacement: Pick<WebContinuationPlan['replacement'], 'name'>
  ): Promise<Json> {
    const ui = this.ui
    await ui.open('/chat/devices')
    await ui.device.assertVisible({ text: exactText('Chat devices') })
    for (const label of ['Link this device', 'Reset chat'])
      await ui.device.assertNotVisible({ text: exactText(label), timeout: 500 })
    const label = replacement.name + ' (this device)'
    await ui.device.assertVisible({ text: exactText(label), timeout: 15000 })
    return await ui.dom(`
      if(document.querySelector('input[type="password"]'))throw Error('Existing signed-in device required; login forbidden');
      const label=${JSON.stringify(label)};
      const found=Array.from(document.querySelectorAll('*')).filter(n=>n.textContent===label&&!Array.from(n.children).some(c=>c.textContent===label));
      if(found.length!==1)throw Error('Unique actual this-device label required');
      const n=found[0],text=n.parentElement;
      if(!text||text.children.length!==2||text.children[0]!==n||text.children[1].textContent!=='Web · Linked'||text.children[1].children.length!==0)throw Error('This device own direct subtitle must be Web and Linked');
      n.scrollIntoView({block:'center',behavior:'instant'});
      const b=n.getBoundingClientRect(),style=getComputedStyle(n);if(!(b.width>0&&b.height>0&&b.y>=0&&b.bottom<=innerHeight&&style.visibility!=='hidden'&&Number(style.opacity)>0))throw Error('Visible actual this-device marker required');
      return {label,linkedText:'Web · Linked',bounds:{x:b.x,y:b.y,width:b.width,height:b.height}};
    `)
  }

  verifyWebContinuation(
    state: WebContinuationState,
    plan: WebContinuationPlan,
    baseline: NonNullable<
      Chat2Fixture['identityCompatibility']
    >['legacy'][string]
  ): {
    identity: WebContinuationState['keys']['identity']
    generations: WebContinuationState['keys']['generations']
    roster: Array<Omit<ChatDevice, 'lastSeenAt' | 'current'>>
  } {
    assert.equal(
      state.userId,
      this.viewerId,
      'Installed browser actor must match the preserved canonical account'
    )
    const original = state.devices.filter(
      device => device.id === baseline.deviceId
    )
    assert.equal(original.length, 1, 'Original device public record required')
    assert.equal(
      original[0].revokedAt,
      plan.originalRevokedAt,
      'Original revocation must remain exact'
    )
    const current = state.devices.filter(device => device.current)
    assert.equal(
      current.length,
      1,
      'Unique installed-session current device required'
    )
    const replacement = current[0]
    assert(
      replacement.id !== baseline.deviceId &&
        replacement.revokedAt == null &&
        replacement.linked &&
        replacement.platform === 'web',
      'Active linked replacement is distinct from the revoked original'
    )
    for (const key of [
      'id',
      'name',
      'platform',
      'boxPublicKey',
      'signPublicKey',
      'createdAt'
    ] as const)
      assert.equal(
        replacement[key],
        plan.replacement[key],
        'Observed installed replacement differs: ' + key
      )
    assert.equal(
      state.keys.deviceId,
      replacement.id,
      'Installed-session key binding must match the public this-device row'
    )
    assert(
      state.keys.linked && !state.keys.pukNeedsRotation,
      'Existing linked device and settled current public PUK chain required'
    )
    assert.equal(state.keys.identity?.id, baseline.identityId)
    assert.equal(state.keys.identity?.publicKey, baseline.identityPublicKey)
    assert(
      state.keys.generations.some(
        generation =>
          generation.generation === baseline.pukGeneration &&
          generation.publicKey === baseline.pukPublicKey
      ),
      'Original public PUK generation must remain in the current chain'
    )
    return {
      identity: state.keys.identity,
      generations: [...state.keys.generations].sort(
        (a, b) => a.generation - b.generation
      ),
      roster: state.devices
        .map(({ lastSeenAt, current, ...device }) => device)
        .sort((a, b) => a.id.localeCompare(b.id))
    }
  }

  /** Separate post-sign-out continuity proof; never an original-device I1 result. */
  async W1(): Promise<void> {
    const ui = this.ui
    assert(
      ui.surface === 'web-narrow' && !ui.native,
      'W1 is original narrow web post-lifecycle continuity only'
    )
    requireAfterArchive(this.f)
    const file = need(
      process.env.CHAT2_WEB_CONTINUATION_FILE,
      'Reviewed continuation descriptor required'
    )
    assert(
      file.startsWith(
        resolve(
          need(process.env.CHAT2_ARTIFACTS, 'Private artifacts required')
        ) + '/'
      )
    )
    assert.equal(digest(file), process.env.CHAT2_WEB_CONTINUATION_SHA256)
    const plan = JSON.parse(readFileSync(file, 'utf8')) as WebContinuationPlan
    assert.equal(plan.schema, 1)
    assert.equal(plan.kind, 'post-lifecycle-web-continuity')
    assert.equal(plan.applicationSource, ui.binding.applicationSource)
    assert.equal(plan.harnessSource, ui.binding.harnessSource)
    const checked = (ref: WebContinuationPlan['baseline']): Json => {
      assert(
        ref.path.startsWith(
          resolve(
            need(process.env.CHAT2_ARTIFACTS, 'Private artifacts required')
          ) + '/'
        )
      )
      assert.equal(digest(ref.path), ref.sha256)
      return JSON.parse(readFileSync(ref.path, 'utf8')) as Json
    }
    const original = checked(plan.baseline) as {
      identityCompatibility: NonNullable<Chat2Fixture['identityCompatibility']>
    }
    const baseline = need(
      original.identityCompatibility.legacy[ui.surface],
      'Immutable original surface baseline required'
    )
    assert.deepEqual(this.f.identityCompatibility?.legacy[ui.surface], baseline)
    assert.equal(this.viewerKey, baseline.actor)
    assert(gumboOfUserId(this.viewerId) != null)
    assert(
      plan.originalRevokedAt !== '' &&
        Number.isFinite(Date.parse(plan.originalRevokedAt))
    )
    const status = checked(plan.revocationEvidence) as {
      readOnly: boolean
      rows: Array<{
        surface: string
        expectedDevice: string
        rows: Array<{ id: string; revoked_at: string | null }>
      }>
    }
    assert.equal(status.readOnly, true)
    const revoked = status.rows.find(row => row.surface === ui.surface)
    assert.equal(revoked?.expectedDevice, baseline.deviceId)
    assert.equal(
      revoked?.rows.find(device => device.id === baseline.deviceId)?.revoked_at,
      plan.originalRevokedAt
    )
    assert(plan.historicalI1.length > 0)
    for (const ref of plan.historicalI1) {
      const historical = checked(ref)
      assert(
        historical.scenario === 'I1' &&
          historical.surface === 'web-narrow' &&
          historical.outcome === 'passed' &&
          historical.diagnosticOnly !== true
      )
      assert.deepEqual(historical.completedScenarios, ['I1'])
      assert(
        historical.source !== ui.binding.applicationSource,
        'Historical I1 must retain its actual application revision'
      )
    }
    assert.equal(digest(plan.review.path), plan.review.sha256)
    const observed = checked(plan.installedDeviceObservation)
    assert.equal(observed.kind, 'installed-web-device-public-ui')
    assert.equal(observed.applicationSource, ui.binding.applicationSource)
    assert.equal(observed.harnessSource, ui.binding.harnessSource)
    assert.equal(observed.userId, this.viewerId)
    assert.equal(
      observed.thisDeviceLabel,
      plan.replacement.name + ' (this device)'
    )
    assert.equal(observed.currentSessionDeviceId, plan.replacement.id)
    assert.deepEqual(observed.replacement, plan.replacement)
    assert.equal(digest(String(observed.screenshot)), observed.screenshotSha256)
    assert.equal(
      digest(String(observed.publicHierarchy)),
      observed.publicHierarchySha256
    )
    await this.check(
      'W1 current installed post-lifecycle account, history, identity and persistence',
      async () => {
        const before = this.verifyWebContinuation(
          await this.webContinuationState(),
          plan,
          baseline
        )
        const marker = await this.webContinuationDeviceUi(plan.replacement)
        assert.deepEqual(
          this.verifyWebContinuation(
            await this.webContinuationState(),
            plan,
            baseline
          ),
          before
        )
        privateJson(join(ui.runDir, 'continuation-start.json'), {
          kind: plan.kind,
          applicationSource: ui.binding.applicationSource,
          harnessSource: ui.binding.harnessSource,
          descriptor: { path: file, sha256: digest(file) },
          originalRevokedAt: plan.originalRevokedAt,
          replacement: plan.replacement,
          marker,
          publicState: before
        })
        await this.legacyHistoryAndSafety(baseline)
        const body = 'Post-lifecycle web continuity ' + randomUUID()
        await ui.replaceDraft(body)
        assert.equal(await ui.draft(), body)
        await ui.text('Send')
        const sent = await this.delivered(body)
        assert.equal(sent.senderUserId, this.viewerId)
        assert.deepEqual(
          this.verifyWebContinuation(
            await this.webContinuationState(),
            plan,
            baseline
          ),
          before
        )
        await ui.device.openLink({
          link:
            this.f.webUrl.replace(/\/$/, '') +
            '/chat/' +
            encodeURIComponent(this.group)
        })
        await ui.present('chat-composer')
        await ui.device.assertNotVisible({
          text: exactText('Link this device'),
          timeout: 500
        })
        await this.anchor({
          id: sent.id,
          seq: sent.seq,
          body: sent.body,
          authorId: this.viewerId
        })
        await ui.device.assertVisible({
          text: exactText(body),
          childOf: { id: 'chat-bubble-' + sent.id }
        })
        const persisted = await this.delivered(body)
        assert.equal(persisted.id, sent.id)
        await ui.shot(
          'identity-post-lifecycle-message',
          'Actual unique current-source message after full browser navigation and persisted decryption'
        )
        const afterMarker = await this.webContinuationDeviceUi(plan.replacement)
        assert.deepEqual(
          this.verifyWebContinuation(
            await this.webContinuationState(),
            plan,
            baseline
          ),
          before
        )
        this.observations.push({
          postLifecycleWebContinuity: true,
          originalDeviceContinuityClaimed: false,
          historicalI1: plan.historicalI1,
          originalRevokedAt: plan.originalRevokedAt,
          replacement: plan.replacement,
          installedPublicMarker: marker,
          reopenedPublicMarker: afterMarker,
          uniqueUiSend: {
            body,
            id: sent.id,
            canonicalSender: sent.senderUserId
          },
          currentPublicIdentityAndChainUnchanged: true,
          rosterAndPublicKeysUnchanged: true
        })
        await ui.shot(
          'identity-post-lifecycle',
          'Distinct current web continuity after deliberate sign-out and normal replacement linking'
        )
      }
    )
  }

  async I2(): Promise<void> {
    await this.check(
      'I2 full-width account with mixed replies, mentions, files and linked-device rotation',
      async () => {
        const compatibility = need(
          this.f.identityCompatibility,
          'Identity compatibility descriptor required'
        )
        assert(
          compatibility.fullWidthActors.includes(this.viewerKey),
          'Explicit fresh full-width actor required'
        )
        assert.equal(gumboOfUserId(this.viewerId), null)
        const client = await this.client()
        assert.equal(
          (await client.whoAmI())?.gumboId,
          null,
          'Fresh account must have no scoring mapping'
        )
        const original = need(
          (await client.myChatKeys()).identity,
          'Fresh full-width protocol provider must already be enrolled'
        )
        need(
          this.f.actors[this.viewerKey].provider,
          'Fresh actor requires its own pre-enrolled protocol provider'
        )
        await this.signIn()
        await this.openGroup()
        const peer = await this.protocolPeer()
        const peerId = need(
          (await peer.client.whoAmI())?.id,
          'Legacy peer account required'
        )
        assert(
          gumboOfUserId(peerId) != null,
          'Mixed legacy/full-width accounts required'
        )
        const target = this.f.messages.target
        assert.equal(
          target.authorId,
          peerId,
          'Prepared legacy peer reply target required'
        )
        await this.reply(target)
        await this.ui.typeMentionTrigger()
        const mentioned = need(
          this.f.members.find(member => member.userId === peerId),
          'Prepared current mention peer required'
        )
        await this.ui.selectMention(mentioned)
        const suffix = ' mixed identity ' + Date.now()
        await this.ui.appendComposer(suffix)
        const body = await this.ui.draft()
        assert.equal(
          body,
          '@' + mentioned.name + ' ' + suffix,
          'Selected mention and complete appended suffix must remain exact'
        )
        await this.attachPhoto()
        await this.ui.text('Send')
        const sent = await this.delivered(body)
        assert.equal(sent.senderUserId, this.viewerId)
        assert.deepEqual(sent.mentions, [peerId])
        assert.equal(sent.quote?.id, target.id)
        assert.equal(sent.quote?.authorId, target.authorId)
        assert.equal(sent.attachments.length, this.expectedAttachments)
        const own = await this.protocolPeer(this.viewerKey)
        const activeDevices = (await client.chatDevices()).filter(
          d => d.revokedAt == null && d.linked
        )
        assert(
          activeDevices.length >= 2,
          'Actual linked application and protocol devices required'
        )
        const generation = await own.rotateUserKey()
        await peer.engine.fillGrants()
        const incoming = need(
          await peer.engine.attach(
            this.group,
            [
              {
                bytes: new Uint8Array(
                  readFileSync(
                    need(this.f.files, 'Synthetic photo required').photo
                  )
                ),
                contentType: 'image/png',
                fileName: 'identity-fixture.png'
              }
            ],
            'Mixed incoming identity ' + Date.now(),
            { quoteId: sent.id, mentions: [this.viewerId] }
          ),
          'Verified mixed incoming file required'
        )
        await this.openGroup()
        await this.ui.id('chat-jump-latest')
        await this.anchor({
          id: incoming.id,
          seq: incoming.seq,
          body: incoming.body,
          authorId: peerId
        })
        await until(
          async () => {
            try {
              return await this.ui.renderedPhoto({
                id: 'chat-bubble-' + incoming.id
              })
            } catch {
              return undefined
            }
          },
          'actual mixed encrypted attachment after rotation',
          30000
        )
        await own.engine.open(this.group)
        const onSecond = need(
          own.engine
            .view(this.group)
            ?.messages.find(message => message.id === incoming.id),
          'The linked full-width protocol device must decrypt the incoming message'
        )
        assert.deepEqual(onSecond.mentions, [this.viewerId])
        assert.equal(onSecond.quote?.authorId, this.viewerId)
        const safety = need(
          await own.engine.safetyNumber(peerId),
          'Mixed safety digits required'
        )
        assert.equal(safety, await peer.engine.safetyNumber(this.viewerId))
        await this.identitySafety(peerId, safety)
        assert.deepEqual((await client.myChatKeys()).identity, original)
        this.observations.push({
          fullWidthId: this.viewerId,
          noScoringMapping: true,
          linkedDevices: activeDevices.map(d => d.id),
          rotatedGeneration: generation,
          mixedFileReplyMentionDelivered: true
        })
        await this.ui.shot(
          'identity-mixed',
          'Actual mixed account encrypted history after linked-device key rotation'
        )
      }
    )
  }

  async I3(): Promise<void> {
    await this.check(
      'I3 isolated real platform persistence and injected adapter write refusal',
      async () => {
        if (this.ui.native)
          await this.ui.device.stopApp({ appId: this.ui.fixture.appId })
        await this.ui.open('/dev/chat-bench')
        if (this.ui.native)
          await this.ui.device.assertVisible({
            text: exactText('Chat crypto bench'),
            timeout: 30000
          })
        await this.ui.device.assertVisible({
          text: exactText('vectors ok'),
          timeout: 30000
        })
        await this.ui.text('Check saved chat compatibility')
        await this.ui.device.assertVisible({
          text: exactText('identity storage ok'),
          timeout: 30000
        })
        await this.ui.device.assertNotVisible({
          text: exactText('identity storage failed'),
          timeout: 1000
        })
        for (const expected of [
          '"enrollmentAttempts":0',
          '"wipeAttempts":0',
          '"cleanup":true',
          'injected adapter write refusal'
        ])
          await this.ui.device.assertVisible({
            text: '.*' + expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*'
          })
        await this.ui.shot(
          'identity-storage',
          'Actual dedicated synthetic platform store; failure is injected at the write adapter, and cleanup is verified'
        )
        this.observations.push({
          isolatedStorageDiagnostic: true,
          injectedAdapterRefusal: true,
          protectedProfileMutation: false,
          cleanupObserved: true
        })
      }
    )
  }

  async E1(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E1 list identity, blank preview and row reachability',
      async () => {
        await this.signIn()
        await ui.device.assertVisible({ text: exactText('Chats') })
        for (const text of [
          exactText('Follow a team'),
          exactText('No messages yet'),
          // The product string ends in a real ellipsis.
          '^Loading latest message(?:…|\\.{3})$'
        ])
          await ui.device.assertNotVisible({ text, timeout: 15000 })
        await ui.present('chat-conversation-' + this.group)
        const empty = need(
          this.f.conversations.empty,
          'Empty mixed-scope list fixture required'
        )
        await ui.device.scrollUntilVisible({
          element: { id: 'chat-conversation-' + empty.id },
          direction: 'DOWN',
          timeout: 15000
        })
        await ui.present('chat-conversation-' + empty.id)
        await ui.shot(
          'chat-list',
          'Actual settled final-source list, explicit owned viewer and mixed synthetic scopes'
        )
      }
    )
    await this.check(
      'E1 personal list pin and preview delivery does not mark read',
      async () => {
        const client = await this.client()
        const original = (await client.chatConversations()).find(
          c => c.id === this.group
        )
        assert(original != null)
        const reads = await client.chatReads(this.group)
        await ui.device.tapOn({
          text: exactText(
            'Conversation actions: ' + this.f.conversations.group.title
          )
        })
        await ui.text(original.preferences.pinned ? 'Unpin' : 'Pin')
        await until(
          async () =>
            (await client.chatConversations()).find(c => c.id === this.group)
              ?.preferences.pinned !== original.preferences.pinned
              ? true
              : undefined,
          'personal list pin write'
        )
        await client.updateChatPreferences(this.group, {
          pinned: original.preferences.pinned
        })
        const body = 'A new synthetic list preview ' + Date.now()
        await this.peerMessage(body)
        // iOS exposes the row as one button named "title, preview, unread".
        await ui.device.assertVisible({
          text:
            ui.surface === 'ios'
              ? exactText(body)
                  .replace(/^\^/, '^(.+, )?')
                  .replace(/\$$/, '(, .+)?$')
              : exactText(body),
          timeout: 30000
        })
        assert.deepEqual(
          (await client.chatReads(this.group)).filter(
            r => r.userId === this.viewerId
          ),
          reads.filter(r => r.userId === this.viewerId),
          'List previews must not mark history read'
        )
      }
    )
    await this.check(
      'E1 actual isolated photo plus missing/broken initials',
      async () => {
        await this.avatarProbe()
      }
    )
  }

  async avatarProbe(): Promise<void> {
    const ui = this.ui
    const probe = need(
      this.f.avatarProbe,
      'Isolated actual-photo/initials/broken-image probe required'
    )
    await this.signIn(probe.viewer)
    await ui.open('/chat')
    const reach = async (id: string): Promise<void> => {
      await ui.device.scrollUntilVisible({
        element: { id: 'chat-conversation-' + id },
        direction: 'DOWN',
        timeout: 15000
      })
    }
    await reach(probe.photoConversation.id)
    await ui.present('chat-conversation-' + probe.photoConversation.id)
    const photo = await ui.photoMarker(probe.photoConversation.id)
    await reach(probe.initialsConversation.id)
    await ui.device.assertVisible({
      text: exactText(probe.initials),
      childOf: { id: 'chat-conversation-' + probe.initialsConversation.id }
    })
    await reach(probe.brokenConversation.id)
    await ui.device.assertVisible({
      text: exactText(probe.brokenInitials),
      childOf: { id: 'chat-conversation-' + probe.brokenConversation.id }
    })
    this.observations.push({
      isolatedAvatarProbe: photo,
      missingPhotoInitialsObserved: probe.initials,
      brokenPhotoInitialsObserved: probe.brokenInitials
    })
    await this.signIn()
  }

  async E2(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E2 compact header, group/DM and glass scroll composition',
      async () => {
        await this.signIn()
        await this.openGroup()
        await this.anchor()
        await ui.device.assertVisible({
          text: exactText(
            need(
              this.f.conversations.group.identityLabel,
              'Header identity fixture required'
            )
          )
        })
        await ui.device.assertNotVisible({
          text: exactText('Members'),
          timeout: 2000
        })
        await this.readable()
        await ui.shot(
          'conversation',
          'Verified short-message reader anchor on final glass conversation'
        )
        await ui.device.swipe({ direction: 'UP', duration: 350 })
        await ui.device.swipe({ direction: 'DOWN', duration: 350 })
        await this.openGroup(
          need(this.f.conversations.dm, 'Owned DM fixture required').id
        )
        await ui.present('chat-composer')
      }
    )
    await this.check(
      'E2 multiline composer, keyboard and small viewport',
      async () => {
        await this.openGroup()
        await this.anchor()
        await ui.replaceDraft(
          'First synthetic line\nSecond synthetic line\nThird synthetic line'
        )
        assert((await ui.draft()).includes('\n'))
        await ui.assertKeyboard()
        await this.nativeKeyboardGeometry()
        await ui.shot(
          ui.surface === 'web-320' ? 'composer' : 'keyboard-pins',
          'Actual multiline/keyboard layout; composition only, no motion claim'
        )
        if (ui.native) await ui.hideKeyboard()
        await ui.replaceDraft('')
      }
    )
  }

  async E3(): Promise<void> {
    const ui = this.ui
    const body = 'Explicit reply with synthetic photo ' + Date.now()
    await this.check(
      'E3 explicit Reply focuses before typing; cancellation keeps draft/file',
      async () => {
        await this.openGroup()
        await this.anchor()
        await ui.replaceDraft('')
        await this.reply()
        await ui.shot(
          'reply-keyboard',
          'Immediate explicit Reply focus/keyboard verified before typing'
        )
        await ui.appendComposer(body)
        await this.attachPhoto()
        await this.cancelReply()
        assert.equal(await ui.draft(), body)
        await this.presentAttachment()
        await this.reply()
      }
    )
    await this.check(
      'E3 failed reply retains owned send; retry delivers once',
      async () => {
        await this.withFault('send', async () => {
          await ui.text('Send')
          await ui.device.assertVisible({
            text: 'That did not send.*',
            timeout: 15000
          })
        })
        assert.equal(
          await ui.draft(),
          body,
          'Failed reply must retain the exact send body'
        )
        await this.presentAttachment()
        await this.sendAgain()
        const received = await this.delivered(body)
        assert.equal(received.quote?.id, this.f.messages.target.id)
        assert.equal(received.attachments.length, this.expectedAttachments)
        await ui.absent('chat-attachment-chip')
      }
    )
    await this.check(
      'E3 platform-supported explicit reply gesture focuses same target',
      async () => {
        if (ui.native) await this.action(this.f.messages.target, 'swipe')
        else await this.reply()
        this.observations.push({
          swipeApplicable: ui.native,
          actualReplyControl: ui.native
            ? 'native swipe'
            : this.touchActions
              ? 'hold then Reply'
              : 'hover Reply'
        })
        await ui.device.assertVisible({ text: exactText('Cancel reply') })
        await ui.assertKeyboard()
        await this.cancelReply()
      }
    )
  }

  async E4(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E4 hero, fixed membership exclusions and same-user mute',
      async () => {
        await this.openGroup()
        await this.anchor()
        await ui.replaceDraft('Keep this synthetic information draft')
        const before = await ui.draft()
        const client = await this.client()
        const original = need(
          (await client.chatConversations()).find(c => c.id === this.group),
          'Current synthetic conversation required'
        ).preferences
        await this.openInfo()
        await ui.shot(
          'info',
          'Actual information hero with current scope/type/mute control'
        )
        for (const label of [
          'Add members',
          'Leave conversation',
          'Disappearing messages'
        ])
          await ui.device.assertNotVisible({
            text: exactText(label),
            timeout: 1000
          })
        await ui.text(original.muted ? 'Unmute' : 'Mute')
        await until(
          async () =>
            (await client.chatConversations()).find(c => c.id === this.group)
              ?.preferences.muted !== original.muted
              ? true
              : undefined,
          'same-user mute synchronization'
        )
        const sameUser = await fixtureClient(
          this.f,
          this.f.sameUserPeer ?? this.viewerKey
        )
        assert.equal(
          (await sameUser.whoAmI())?.id,
          this.viewerId,
          'Same-user probe must be the same actor'
        )
        assert.equal(
          (await sameUser.chatConversations()).find(c => c.id === this.group)
            ?.preferences.muted,
          !original.muted
        )
        await client.updateChatPreferences(this.group, {
          muted: original.muted
        })
        const member = await this.showInfoMember()
        await ui.shot(
          'info-members',
          'Actual current other-member safety row fully exposed between header and bottom overlay; role/security composition for review'
        )
        if (ui.surface === 'ios') {
          const row = await ui.iosRead(
            {
              id: 'chat-info-member-' + member.userId,
              childOf: { id: 'chat-info-members' }
            },
            'Button'
          )
          await ui.tapObserved(row)
        } else await ui.id('chat-info-member-' + member.userId)
        await ui.device.assertVisible({
          text: 'Safety number.*',
          timeout: 10000
        })
        await ui.text('Done')
        await ui.present('chat-info-members')
        await ui.back()
        await ui.present('chat-message-history')
        assert.equal(await ui.draft(), before)
        await ui.open('/chat/' + this.group + '/members')
        await ui.present('chat-info-members')
        await ui.back()
        await ui.present('chat-message-history')
        assert.equal(await ui.draft(), before)
      }
    )
    await this.check(
      'E4 preference failure is visible and preserves current state',
      async () => {
        await this.openInfo()
        const current = need(
          (await (await this.client()).chatConversations()).find(
            c => c.id === this.group
          ),
          'Conversation required'
        ).preferences.muted
        await this.withFault('preferences', async () => {
          await ui.text(current ? 'Unmute' : 'Mute')
          await ui.device.assertVisible({ text: 'Could not.*', timeout: 10000 })
        })
        assert.equal(
          need(
            (await (await this.client()).chatConversations()).find(
              c => c.id === this.group
            ),
            'Conversation required'
          ).preferences.muted,
          current
        )
        await ui.back()
      }
    )
  }

  /** Reach the unchanged old own post through one authenticated current reply. */
  async nativeOutgoingQuoteAnchor(target: Chat2Message): Promise<void> {
    assert(this.ui.native, 'Native outgoing quote navigation required')
    assert.equal(
      target.authorId,
      this.viewerId,
      'Exact own outgoing quote author required'
    )
    const peer = await this.protocolPeer()
    let current = await peer.engine.open(this.group)
    // The seeded reply ages out of the newest page as runs add history; once
    // the original itself is loaded, every reply to it is too.
    for (
      let page = 0;
      page < 60 &&
      current.hasEarlier &&
      !current.messages.some(message => message.id === target.id);
      page++
    )
      current = await peer.engine.loadEarlier(this.group)
    const replies = current.messages.filter(
      message => message.status === 'ok' && message.quote?.id === target.id
    )
    assert.equal(
      replies.length,
      1,
      'Unique authenticated current reply to the exact outgoing required'
    )
    const reply = replies[0]
    assert(
      reply.id !== target.id && reply.seq > target.seq,
      'Unique authenticated current reply must follow its original'
    )
    assert.equal(
      reply.quote?.authorId,
      target.authorId,
      'Exact own outgoing quote author required'
    )
    await this.identityLegacyAnchor(target, {
      text: target,
      reply: {
        id: reply.id,
        seq: reply.seq,
        body: reply.body,
        authorId: reply.senderUserId
      }
    })
  }

  async E5(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E5 incoming/outgoing/long/file spotlight actions and dismissal',
      async () => {
        await this.openGroup()
        if (ui.native) await ui.hideKeyboard()
        const incomingReservations: Array<
          Awaited<ReturnType<Scenarios['incomingReservation']>>
        > = []
        for (const message of [
          need(this.f.messages.incoming, 'Incoming fixture required'),
          need(this.f.messages.outgoing, 'Outgoing fixture required'),
          this.f.messages.long,
          need(this.f.messages.file, 'Encrypted file message fixture required')
        ]) {
          if (ui.native && message.id === this.f.messages.outgoing?.id)
            await this.nativeOutgoingQuoteAnchor(message)
          let incomingLane: unknown
          if (message.authorId !== this.viewerId) {
            const reservation = await this.incomingReservation(message)
            incomingReservations.push(reservation)
            incomingLane = reservation
          }
          if (message.id === this.f.messages.file?.id) {
            await this.anchor(message)
            await until(
              async () => {
                try {
                  return await ui.renderedPhoto({
                    id: 'chat-bubble-' + message.id
                  })
                } catch {
                  return undefined
                }
              },
              'actual loaded encrypted synthetic photo',
              30000
            )
          }
          const mediaStart = Number(
            fixtureControl(this.f, 'snapshot', {
              kind: 'media',
              conversationId: this.group
            }).lastEvent
          )
          const personalPins =
            ui.surface === 'ios'
              ? await (await this.client()).chatPins(this.group)
              : undefined
          await this.action(message)
          const actions = await this.menuState()
          if (this.touchActions) {
            assert(
              actions.preview === true,
              'Keyboard-hidden touch spotlight must render the sharp selected bubble'
            )
            await ui.device.assertVisible({ text: exactText('Reply') })
          }
          await ui.device.assertVisible({ text: exactText(this.copyLabel) })
          if (incomingLane != null)
            this.observations.push({
              incomingAvatarLane: incomingLane,
              message: message.id
            })
          if (message.id === this.f.messages.file?.id) {
            // As for the clipped bubble below: read the preview once its
            // entrance fade has settled, not while it is still at opacity 0.
            if (this.touchActions) await observeSpotlightCaptureReady(ui)
            const sharpPhoto = this.touchActions
              ? await ui.renderedPhoto({
                  id: 'chat-message-spotlight-preview'
                })
              : undefined
            const network = fixtureControl(this.f, 'snapshot', {
              kind: 'media',
              conversationId: this.group,
              afterEvent: mediaStart
            })
            assert.equal(
              (network.events as Json[]).filter(
                e => e.type === 'media-request' && e.method === 'GET'
              ).length,
              0,
              'Opening loaded selected photo must not request media again'
            )
            this.observations.push({
              sharpLoadedPhoto: sharpPhoto,
              sharpCloneApplicable: this.touchActions,
              noExtraMediaRequests: network.events,
              mediaStart
            })
          }
          if (
            message.id === this.f.messages.target.id ||
            message.id === this.f.messages.long.id
          ) {
            if (this.touchActions) await observeSpotlightCaptureReady(ui)
            await ui.shot(
              'message-actions',
              this.touchActions
                ? 'Actual sharp coordinated spotlight over blur; static composition proof only'
                : 'Actual desktop hover and filtered More menu; spotlight not applicable'
            )
          }
          await this.dismiss()
          await ui.absent('chat-message-spotlight')
          if (personalPins != null)
            assert.deepEqual(
              (await (await this.client()).chatPins(this.group))
                .map(p => p.messageId)
                .sort(),
              personalPins.map(p => p.messageId).sort(),
              'Spotlight dismissal must preserve actual personal pins'
            )
        }
        await this.incomingRunEndAvatar(incomingReservations)
      }
    )
    await this.check(
      'E5 partially scrolled tall source keeps selected preview bounded and reader unchanged',
      async () => {
        const original = ui.metrics()
        const shortWide = ui.surface === 'web-wide'
        if (shortWide) {
          assert(
            original.width === 1440 && original.height === 1000,
            'Original full wide viewport required'
          )
          await ui.resize(original.width, 600)
          this.observations.push({ tallSourceViewport: ui.metrics(), original })
        }
        try {
          const target = this.f.messages.long
          await this.openGroup()
          if (ui.native) await ui.hideKeyboard()
          await this.anchor(target)
          const { top, bottom } = await this.readingBand()
          assert(bottom - top > 80, 'Actual unobscured reader band required')
          if (!ui.native) {
            await ui.dom(
              `const n=document.querySelector(${JSON.stringify('[data-testid="chat-bubble-' + target.id + '"]')});const h=document.querySelector('[data-testid="chat-message-history"]');if(!n||!h)throw Error('Public long bubble/history required');const b=n.getBoundingClientRect();h.scrollTop+=${this.touchActions ? `b.top-${top}+Math.min(b.height/3,120)` : `b.bottom-(${bottom}-20)`};h.dispatchEvent(new Event('scroll'));return {publicReaderScroll:true}`
            )
          } else if (ui.surface === 'ios')
            await this.iosTallSourceAboveReader(target.id, top, bottom)
          else {
            for (let step = 0; step < 8; step++) {
              const b = await this.targetBounds('chat-bubble-' + target.id)
              if (b.y < top - 12 && b.y + b.height > top + 40) break
              // Move only as far as puts the bubble's top above the reader, and
              // slowly: a fling carries a virtualized row out of the window.
              const needed = b.y - (top - Math.min(b.height / 3, 120))
              const delta = Math.max(48, Math.min(needed, bottom - top - 24))
              await ui.measuredSwipe({
                startX: Math.round(b.x + b.width / 2),
                startY: Math.round(bottom - 12),
                endX: Math.round(b.x + b.width / 2),
                endY: Math.round(bottom - 12 - delta),
                duration: 1000
              })
            }
          }
          const source = await this.targetBounds('chat-bubble-' + target.id)
          assert(
            source.y < top - 12 &&
              source.y + source.height > top + 40 &&
              source.height > bottom - top,
            'Long-message origin must actually extend above the visible reader'
          )
          const visibleBottom = Math.min(bottom, source.y + source.height)
          const x = source.x + source.width / 2
          const y = (top + visibleBottom) / 2
          const info = ui.native ? await ui.device.platformInfo() : ui.metrics()
          const width = Number(
            'screenWidth' in info ? info.screenWidth : info.width
          )
          const height = Number(
            'screenHeight' in info ? info.screenHeight : info.height
          )
          if (this.touchActions)
            await ui.device.longPressOn({
              id: 'chat-bubble-' + target.id,
              point: `${((x - source.x) / source.width) * 100}%,${((y - source.y) / source.height) * 100}%`,
              duration: 550
            })
          else {
            await ui.dom(
              `const n=document.querySelector(${JSON.stringify('[data-testid="chat-bubble-' + target.id + '"]')});if(!n)throw Error('Public clipped bubble required');n.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));n.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}));return {publicHover:true}`
            )
            await ui.device.tapOn({
              css: `[data-testid="chat-message-${target.id}"] [aria-label="More message actions"]`
            })
          }
          const actions = await this.menuState()
          // The entrance fade starts only after the hold is released, and
          // public bounds omit an opacity-0 node; measure the settled preview.
          if (this.touchActions) await observeSpotlightCaptureReady(ui)
          const preview = this.touchActions
            ? await ui.publicBounds('chat-message-spotlight-preview')
            : undefined
          if (preview != null)
            assert(
              preview.x >= -2 &&
                preview.y >= -2 &&
                preview.x + preview.width <= width + 2 &&
                preview.y + preview.height <= height + 2,
              'Selected preview from clipped origin must remain inside viewport'
            )
          await ui.shot(
            'partially-scrolled-spotlight',
            this.touchActions
              ? 'Actual tall bubble extends above reader; selected preview is bounded. Static composition only'
              : 'Actual partially scrolled tall bubble with bounded desktop More menu; no touch spotlight'
          )
          await this.dismiss()
          await ui.absent('chat-message-spotlight')
          const after = await this.targetBounds('chat-bubble-' + target.id)
          assert(
            Math.abs(after.y - source.y) <= 3,
            'Dismissal must preserve the partially scrolled reader anchor'
          )
          this.observations.push({
            partiallyScrolledSource: source,
            unobscuredReader: { top, bottom },
            selectedPreview: preview,
            actions,
            afterDismissal: after
          })
        } finally {
          if (shortWide) {
            await ui.resize(original.width, original.height)
            assert.deepEqual(
              ui.metrics(),
              original,
              'Original full wide viewport must restore'
            )
            this.observations.push({ tallSourceViewportRestored: ui.metrics() })
          }
        }
      }
    )
    await this.check(
      'E5 movement before hold cancels; reaction and personal pin remain usable',
      async () => {
        let expectedEmoji = '👍'
        let expectedReactionPresent = true
        await this.anchor()
        const b = await this.targetBounds(
          'chat-bubble-' + this.f.messages.target.id
        )
        if (ui.surface === 'android')
          await ui.measuredSwipe({
            startX: b.x + 10,
            startY: b.y + 10,
            endX: b.x + 10,
            endY: b.y + 70,
            duration: 200
          })
        else
          // The iOS driver takes whole points only.
          await ui.device.dragAndDrop({
            from: {
              point: `${Math.round(b.x + 10)},${Math.round(b.y + 10)}`
            },
            to: { point: `${Math.round(b.x + 10)},${Math.round(b.y + 70)}` },
            holdDuration: 50,
            duration: 200
          })
        await ui.absent('chat-message-spotlight')
        if (this.touchActions) {
          const peer = await this.protocolPeer()
          await this.peerTarget(peer, this.group, this.f.messages.target.id)
          const before = need(
            (await peer.engine.open(this.group)).messages.find(
              m => m.id === this.f.messages.target.id && m.status === 'ok'
            ),
            'Actual quick-reaction target must be verified before toggle'
          )
          // The app groups 👍 and 👍️ as one reaction (reactionKey).
          const present = before.reactions.some(
            reaction =>
              reactionKey(reaction.emoji) === reactionKey(expectedEmoji) &&
              reaction.userIds.includes(this.viewerId)
          )
          expectedReactionPresent = !present
          this.observations.push({
            actualQuickReactionToggle: {
              messageId: before.id,
              raw: expectedEmoji,
              viewerId: this.viewerId,
              beforePresent: present,
              expectedAfterPresent: expectedReactionPresent
            }
          })
          await this.action(this.f.messages.target)
          // iOS exposes the quick reaction only by its accessible name.
          await ui.text(ui.native ? 'React with 👍' : '👍')
        } else {
          await this.anchor()
          await ui.dom(
            `const n=document.querySelector(${JSON.stringify('[data-testid="chat-bubble-' + this.f.messages.target.id + '"]')});if(!n)throw Error('Public target required');n.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return {publicHover:true}`
          )
          await ui.device.tapOn({
            css: `[data-testid="chat-message-${this.f.messages.target.id}"] [aria-label="Send an emoji"]`
          })
          await ui.device.tapOn({ text: exactText('More emoji') })
          await ui.device.inputText({ text: 'thumbs up' })
          expectedEmoji = await this.pickThumbsUp()
        }
        await ui.absent('chat-message-spotlight')
        const peer = await this.protocolPeer()
        await this.peerTarget(peer, this.group, this.f.messages.target.id)
        await until(
          async () => {
            const view = await peer.engine.open(this.group)
            const target = view.messages.find(
              m => m.id === this.f.messages.target.id && m.status === 'ok'
            )
            // The picker's 👍️ joins a 👍 group shown in its first form.
            return target?.reactions.some(
              r =>
                reactionKey(r.emoji) === reactionKey(expectedEmoji) &&
                r.userIds.includes(this.viewerId)
            ) === expectedReactionPresent
              ? true
              : undefined
          },
          'Actual selected raw glyph and reacting viewer must reach the peer',
          30000
        )
      }
    )
    await this.check(
      'E5 actual Copy, personal pin and allowed fresh own Delete',
      async () => {
        const client = await this.client()
        const target = this.f.messages.target
        try {
          await ui.clipboardSentinel('A disposable clipboard sentinel')
          await this.action(target)
          await ui.text(this.copyLabel)
          await ui.replaceDraft('')
          await ui.pasteClipboard(target.body)
          assert.equal(
            await ui.draft(),
            target.body,
            'Copy must place the real message text on clipboard'
          )
          await ui.replaceDraft('')
        } finally {
          await ui.restoreClipboard()
        }
        const pins = await client.chatPins(this.group)
        const pinned = pins.some(p => p.messageId === target.id)
        try {
          await this.action(target)
          await ui.text(pinned ? 'Unpin' : 'Pin')
          await until(
            async () =>
              (await client.chatPins(this.group)).some(
                p => p.messageId === target.id
              ) !== pinned
                ? true
                : undefined,
            'actual personal pin action'
          )
        } finally {
          await client.pinChatMessage(this.group, target.id, pinned)
        }
        const body = 'Disposable own delete proof ' + Date.now()
        await ui.replaceDraft(body)
        await ui.text('Send')
        const sent = await this.delivered(body)
        await this.action({
          id: sent.id,
          seq: sent.seq,
          body: sent.body,
          authorId: this.viewerId
        })
        await ui.text('Delete')
        await ui.device.assertVisible({
          text: exactText('This message will be removed for everyone.')
        })
        await ui.text('Delete')
        await ui.device.assertNotVisible({
          text: exactText(body),
          timeout: 15000
        })
        const peer = await this.protocolPeer()
        await until(
          async () =>
            (await peer.engine.open(this.group)).messages.some(
              m => m.id === sent.id && m.status === 'removed'
            )
              ? true
              : undefined,
          'verified peer deletion'
        )
        this.observations.push({
          copiedBodyObserved: true,
          pinToggleRestored: true,
          deletedOnlyFreshOwnPost: sent.id
        })
      }
    )
    await this.check(
      'E5 keyboard-open short band keeps controls reachable and does not scroll reader',
      async () => {
        await this.openGroup()
        await this.anchor()
        await ui.id('chat-composer')
        await ui.assertKeyboard()
        const draft = ui.native ? undefined : await ui.draft()
        const focusProof: Json = {
          messageActionFocus: [],
          desktopTrigger: !this.touchActions
        }
        this.observations.push(focusProof)
        const readFocus = async (
          phase: string,
          signal = ui.deadline
        ): Promise<Json> => {
          signal.throwIfAborted()
          const current = await ui.dom(
            `
            const id=${JSON.stringify('chat-message-' + this.f.messages.target.id)};
            const histories=Array.from(document.querySelectorAll('[data-testid="chat-message-history"]'));if(histories.length!==1)throw Error('Unique message history required for action focus');
            const rows=Array.from(histories[0].querySelectorAll('[data-testid='+JSON.stringify(id)+']'));if(rows.length!==1)throw Error('Unique message row required for action focus');
            const touch=${JSON.stringify(this.touchActions)};
            const selector=touch?${JSON.stringify('[data-testid="chat-bubble-' + this.f.messages.target.id + '"]')}:'[aria-label="More message actions"]';
            const triggers=Array.from(rows[0].querySelectorAll(selector));if(triggers.length!==1||(!touch&&triggers[0].getAttribute('role')!=='button'))throw Error(touch?'Unique actual bubble trigger required':'Unique actual More trigger required');
            const a=document.activeElement,b=triggers[0].getBoundingClientRect();if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0)throw Error('Actual positive More trigger geometry required');
            return {composerFocused:a===document.querySelector('[data-testid="chat-composer"]'),triggerFocused:a===triggers[0],menus:document.querySelectorAll('[aria-label^="Message from "]').length,spotlights:document.querySelectorAll('[data-testid="chat-message-spotlight"]').length,active:{tag:a?.tagName,id:a?.getAttribute('data-testid'),label:a?.getAttribute('aria-label')},trigger:{x:b.x,y:b.y,width:b.width,height:b.height}};
          `,
            signal
          )
          ;(focusProof.messageActionFocus as unknown[]).push({
            phase,
            at: new Date().toISOString(),
            ...current
          })
          signal.throwIfAborted()
          return current
        }
        if (!ui.native) {
          const focused = await readFocus('before-opener')
          assert(
            focused.composerFocused === true,
            'Composer must own focus immediately before the action opener'
          )
        }
        const before = await this.targetBounds(
          'chat-bubble-' + this.f.messages.target.id
        )
        await this.action(this.f.messages.target, 'hold', 'visible')
        const spotlight = await this.menuState()
        for (const label of this.touchActions
          ? ['Reply', this.copyLabel]
          : [this.copyLabel])
          await ui.device.scrollUntilVisible({
            element: { text: exactText(label) },
            direction: 'DOWN',
            timeout: 5000
          })
        if (this.touchActions) await observeSpotlightCaptureReady(ui)
        await ui.shot(
          'keyboard-spotlight',
          ui.native
            ? 'Actual keyboard-open bounded controls and optional compact preview; no automatic keyboard dismiss or motion claim'
            : this.touchActions
              ? 'Actual focused web composer and touch spotlight controls; no software keyboard claim'
              : 'Actual composer-focused entry and desktop More menu with conventional trigger restoration; no software keyboard or touch spotlight claim'
        )
        await this.dismiss()
        if (ui.native) await ui.assertKeyboard()
        else {
          const signal = AbortSignal.any([
            ui.deadline,
            AbortSignal.timeout(2000)
          ])
          const focused = await until(
            async () => {
              const current = await readFocus('after-dismissal', signal)
              return current.triggerFocused === true &&
                current.menus === 0 &&
                current.spotlights === 0
                ? current
                : undefined
            },
            this.touchActions
              ? 'actual bubble focus after touch spotlight cleanup'
              : 'actual More focus after desktop menu cleanup',
            2000
          )
          assert(
            focused.triggerFocused === true &&
              focused.menus === 0 &&
              focused.spotlights === 0,
            this.touchActions
              ? 'Touch Escape must close the spotlight and restore its actual bubble trigger'
              : 'Desktop Escape must close the menu and restore its actual More trigger'
          )
        }
        if (!ui.native)
          assert.equal(
            await ui.draft(),
            draft,
            'Message actions must preserve the actual draft'
          )
        const after = await this.targetBounds(
          'chat-bubble-' + this.f.messages.target.id
        )
        assert(
          Math.abs(before.y - after.y) <= 3,
          'Opening/dismissing spotlight must not scroll background reader'
        )
        this.observations.push({ keyboardSpotlight: spotlight, before, after })
        if (ui.native) await ui.hideKeyboard()
      }
    )
  }

  /** A nonterminal lane can be empty and zero-height; measure its actual horizontal reservation. */
  async incomingReservation(message: Chat2Message): Promise<{
    message: string
    row: NonNullable<PublicNode['bounds']>
    bubble: NonNullable<PublicNode['bounds']>
    width: number
  }> {
    assert(message.authorId !== this.viewerId, 'Actual incoming post required')
    await this.anchor(message)
    const row = await this.targetBounds('chat-message-' + message.id)
    const bubble = await this.targetBounds('chat-bubble-' + message.id)
    for (const box of [row, bubble])
      assert(
        [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
          box.width > 0 &&
          box.height > 0,
        'Positive actual incoming row and bubble required'
      )
    assert(
      bubble.x > row.x &&
        bubble.y >= row.y - 2 &&
        bubble.x + bubble.width <= row.x + row.width + 2 &&
        bubble.y + bubble.height <= row.y + row.height + 2,
      'Incoming bubble must retain measured horizontal space inside its row'
    )
    return { message: message.id, row, bubble, width: bubble.x - row.x }
  }

  /** Prove a current sender-run ending with its real visible avatar, not a repeated avatar. */
  async incomingRunEndAvatar(
    reservations: Array<Awaited<ReturnType<Scenarios['incomingReservation']>>>
  ): Promise<void> {
    const proof: Json = {
      name: 'Actual incoming run-ending avatar',
      outcome: 'failed'
    }
    this.ui.steps.push(proof)
    try {
      const peer = await this.protocolPeer()
      let view = await peer.engine.open(this.group)
      const end = Date.now() + 30000
      const eligible = (messages: MessageView[]): boolean =>
        messages.some(
          (current, index) =>
            current.status === 'ok' &&
            current.senderUserId !== this.viewerId &&
            current.body.length <= 300 &&
            messages[index + 1]?.senderUserId !== current.senderUserId
        )
      proof.pages = []
      for (
        let pages = 0;
        !eligible(view.messages) && view.hasEarlier && pages < 30;
        pages++
      ) {
        assert(
          Date.now() < end,
          'Verified peer run-ending history exceeded 30 seconds'
        )
        ;(proof.pages as unknown[]).push({
          at: new Date().toISOString(),
          messages: view.messages.map(m => ({
            id: m.id,
            seq: m.seq,
            status: m.status,
            senderUserId: m.senderUserId,
            length: m.body.length
          })),
          hasEarlier: view.hasEarlier
        })
        view = await peer.engine.loadEarlier(this.group)
      }
      const choices = view.messages.flatMap((current, index) => {
        const next = view.messages[index + 1]
        return current.status === 'ok' &&
          current.senderUserId !== this.viewerId &&
          current.body.length <= 300 &&
          next?.senderUserId !== current.senderUserId
          ? [{ current, next }]
          : []
      })
      const { current, next } = need(
        choices.at(-1),
        'Current verified short incoming run-ending post required'
      )
      proof.boundary = {
        current: {
          id: current.id,
          seq: current.seq,
          senderUserId: current.senderUserId
        },
        next:
          next == null
            ? null
            : { id: next.id, seq: next.seq, senderUserId: next.senderUserId }
      }
      const reserved = await this.incomingReservation({
        id: current.id,
        seq: current.seq,
        body: current.body,
        authorId: current.senderUserId
      })
      const lane = await this.targetBounds('chat-avatar-lane-' + current.id)
      const avatar = await this.ui.observedBounds({
        id: 'chat-avatar',
        // Android's accessibility tree puts the avatar beside its empty lane,
        // under the message; the bounds checks below still hold it to the lane.
        childOf: {
          id:
            (this.ui.surface === 'android'
              ? 'chat-message-'
              : 'chat-avatar-lane-') + current.id
        }
      })
      const band = await this.readingBand()
      proof.geometry = {
        reserved,
        lane,
        avatar,
        band,
        earlierReservations: reservations
      }
      for (const box of [lane, avatar])
        assert(
          [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
            box.width > 0 &&
            box.height > 0,
          'Positive actual run-ending lane and avatar required'
        )
      assert(
        lane.x >= reserved.row.x - 2 &&
          lane.x + lane.width <= reserved.bubble.x + 2 &&
          avatar.x >= lane.x - 2 &&
          avatar.x + avatar.width <= lane.x + lane.width + 2 &&
          avatar.y >= lane.y - 2 &&
          avatar.y + avatar.height <= lane.y + lane.height + 2 &&
          Math.abs(
            avatar.y +
              avatar.height -
              reserved.bubble.y -
              reserved.bubble.height
          ) <= 2 &&
          avatar.y >= band.top - 2 &&
          avatar.y + avatar.height <= band.bottom + 2,
        'Actual incoming sender avatar must be fully exposed at the bottom-left of its bubble'
      )
      for (const earlier of [...reservations, reserved])
        assert(
          earlier.width >= lane.width - 2 &&
            Math.abs(earlier.width - reserved.width) <= 2,
          'Every incoming row must preserve the actual run-ending lane width and gap'
        )
      await this.ui.shot(
        'incoming-run-avatar',
        'Actual current incoming run-ending avatar at bottom-left; earlier incoming rows preserve its lane width without requiring repeated avatars'
      )
      proof.outcome = 'passed'
      this.observations.push({ incomingRunEndingAvatar: proof })
    } catch (error) {
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async E6(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E6 personal floating pins, verified clear target and same-user state',
      async () => {
        const client = await this.client()
        // Restore the seeded personal pins an earlier interrupted run may have
        // removed: setup through the viewer's own API, recorded, never UI.
        const restored: string[] = []
        for (const seeded of [
          this.f.messages.target,
          this.f.messages.long
        ].filter((m): m is Chat2Message => m != null)) {
          const pinned = await client.chatPins(this.group)
          if (!pinned.some(p => p.messageId === seeded.id)) {
            await client.pinChatMessage(this.group, seeded.id, true)
            restored.push(seeded.id)
          }
        }
        this.observations.push({ seededPersonalPinsRestored: restored })
        await this.openGroup()
        await this.anchor()
        const before = await client.chatPins(this.group)
        assert(before.length >= 2, 'Multiple personal pins fixture required')
        await ui.present('chat-pinned-band')
        await ui.present('chat-pinned-summary')
        await this.readable()
        await ui.shot(
          'floating-pins',
          'Actual translucent personal pins with target revealed clear of controls'
        )
        await ui.device.swipe({ direction: 'UP', duration: 350 })
        await ui.present('chat-pinned-band')
        await ui.id('chat-pinned-summary')
        await ui.device.assertVisible({ text: exactText('Pinned messages') })
        await this.tapPinnedRow(this.f.messages.target.id)
        await ui.present('chat-bubble-' + this.f.messages.target.id)
        assert.deepEqual(
          (await client.chatPins(this.group)).map(p => p.messageId),
          before.map(p => p.messageId)
        )
      }
    )
    await this.check(
      'E6 fresh disposable pin deletion does not expose removed text',
      async () => {
        const probe = await this.peerMessage(
          'Disposable personal pin probe ' + Date.now()
        )
        const client = await this.client()
        const peer = await this.protocolPeer()
        await client.pinChatMessage(this.group, probe.id, true)
        await this.openGroup()
        await peer.engine.deleteMessage(this.group, probe.id)
        await ui.device.assertNotVisible({
          text: exactText(probe.body),
          timeout: 15000
        })
        await client.pinChatMessage(this.group, probe.id, false)
      }
    )
    await this.check(
      'E6 outside-page pin failure, actual Retry and cancellation preserve draft',
      async () => {
        const client = await this.client()
        const oldest = need(
          this.f.messages.oldest,
          'Verified old personal pin outside first page required'
        )
        const originalPins = await client.chatPins(this.group)
        const already = originalPins.some(p => p.messageId === oldest.id)
        const summary = need(
          (await client.chatConversations()).find(c => c.id === this.group),
          'Owned group required'
        )
        try {
          // Read state is safely replayable in this disposable fixture; avoid unrelated unread reference discovery preloading this pin.
          await client.markChatRead(this.group, summary.lastSeq)
          await client.pinChatMessage(this.group, oldest.id, true)
          await ui.coldOpen('/chat/' + this.group)
          await this.anchor()
          if (!ui.native) await this.ownWebReader(this.f.messages.target)
          await ui.replaceDraft('Keep pin retry draft')
          if (ui.native) await ui.hideKeyboard()
          const before = await this.targetBounds(
            'chat-bubble-' + this.f.messages.target.id
          )
          const sequence = Number(this.snapshot(this.group).lastEvent)
          fixtureControl(this.f, 'fault', {
            phase: 'history-jump',
            viewerId: this.viewerId,
            conversationId: this.group,
            beforeAtMost: summary.lastSeq
          })
          await ui.id('chat-pinned-summary')
          await this.tapPinnedRow(oldest.id)
          await this.waitEvent(
            this.group,
            sequence,
            e => e.type === 'fault-matched'
          )
          await ui.present(this.controlId('jumpRetry'))
          assert.equal(await ui.draft(), 'Keep pin retry draft')
          const failed = await this.targetBounds(
            'chat-bubble-' + this.f.messages.target.id
          )
          assert(
            Math.abs(failed.y - before.y) <= 3,
            'Failed pin navigation preserves row-relative reader'
          )
          fixtureControl(this.f, 'clear-fault')
          await ui.id(this.controlId('jumpRetry'))
          await ui.present('chat-bubble-' + oldest.id)
          assert.equal(await ui.draft(), 'Keep pin retry draft')
          await ui.coldOpen('/chat/' + this.group)
          await this.anchor()
          if (!ui.native) await this.ownWebReader(this.f.messages.target)
          await ui.replaceDraft('Keep pin cancellation draft')
          if (ui.native) await ui.hideKeyboard()
          const deferred = Number(this.snapshot(this.group).lastEvent)
          fixtureControl(this.f, 'fault', {
            phase: 'history-jump',
            mode: 'defer',
            viewerId: this.viewerId,
            conversationId: this.group,
            beforeAtMost: summary.lastSeq
          })
          await ui.id('chat-pinned-summary')
          await this.tapPinnedRow(oldest.id)
          await this.waitEvent(
            this.group,
            deferred,
            e => e.type === 'fault-matched'
          )
          // A desktop mouse drag scrolls nothing, so whether it reads as a
          // user scroll depends on what lies under the viewport centre; a
          // desktop reader cancels with the wheel, toward newer posts.
          if (!ui.native && !this.touchActions)
            await ui.device.scroll({ direction: 'DOWN' })
          else await ui.device.swipe({ direction: 'DOWN', duration: 250 })
          fixtureControl(this.f, 'clear-fault')
          await ui.absent(this.controlId('jumpRetry'))
          await ui.device.assertNotVisible({
            id: 'chat-bubble-' + oldest.id,
            timeout: 2000
          })
          assert.equal(await ui.draft(), 'Keep pin cancellation draft')
          this.observations.push({
            actualOutsidePagePin: oldest.id,
            retryReachedOriginal: true,
            cancellationByPublicUserScroll: true
          })
        } finally {
          fixtureControl(this.f, 'clear-fault')
          if (!already)
            await client.pinChatMessage(this.group, oldest.id, false)
          fixtureControl(this.f, 'restore-attention', {
            viewerId: this.viewerId,
            conversationId: this.group
          })
        }
      }
    )
    await this.check(
      'E6 one then zero personal pins and exact preference restoration',
      async () => {
        const client = await this.client()
        const pins = await client.chatPins(this.group)
        const target = this.f.messages.target
        try {
          for (const pin of pins)
            if (pin.messageId !== target.id)
              await client.pinChatMessage(this.group, pin.messageId, false)
          await client.pinChatMessage(this.group, target.id, true)
          await this.openGroup()
          await ui.present('chat-pinned-summary')
          await this.action(target)
          await ui.text('Unpin')
          await until(
            async () =>
              (await client.chatPins(this.group)).length === 0
                ? true
                : undefined,
            'last personal pin removed'
          )
          await ui.absent('chat-pinned-summary')
        } finally {
          for (const pin of await client.chatPins(this.group))
            await client.pinChatMessage(this.group, pin.messageId, false)
          for (const pin of [...pins].reverse())
            await client.pinChatMessage(this.group, pin.messageId, true)
        }
      }
    )
  }

  async E7(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E7 duplicate-name current member choices and caret return',
      async () => {
        await this.openGroup()
        await ui.replaceDraft('')
        await this.reply()
        await ui.typeMentionTrigger()
        await ui.device.assertVisible({ text: exactText('Mention a member') })
        this.observations.push(await observeMentionHeader(ui))
        const members = this.f.members.filter(m => m.userId !== this.viewerId)
        const first = need(members[0], 'Mention member fixtures required')
        assert(
          members.some(m => m.userId !== first.userId && m.name === first.name),
          'Duplicate-name current members required'
        )
        await ui.text('Search members')
        const webSearch = !ui.native
          ? async (): Promise<Json> => {
              const selector =
                '[data-testid="chat-picker-content"] input[aria-label="Search members"]'
              const state = await ui.dom(
                'const fields=document.querySelectorAll(' +
                  JSON.stringify(selector) +
                  ');const n=fields[0];return {count:fields.length,value:n?.value,focused:document.activeElement===n,connected:n?.isConnected,start:n?.selectionStart,end:n?.selectionEnd}'
              )
              assert.equal(
                state.count,
                1,
                'Unique actual member Search required'
              )
              assert.equal(
                state.focused,
                true,
                'Member Search must retain focus'
              )
              assert.equal(
                state.connected,
                true,
                'Member Search must remain connected'
              )
              const session = need(
                ui.cdp,
                'Owned browser inspection session required'
              )
              const { root } = await session.send('DOM.getDocument', {
                depth: 0
              })
              const { nodeId } = await session.send('DOM.querySelector', {
                nodeId: root.nodeId,
                selector
              })
              assert(nodeId > 0, 'Actual member Search DOM node required')
              const { node } = await session.send('DOM.describeNode', {
                nodeId
              })
              return { ...state, backendNodeId: node.backendNodeId }
            }
          : undefined
        const beforeSearch = await webSearch?.()
        await ui.append(first.search)
        if (ui.native) {
          // Android's Search is the one unnamed field beside the composer,
          // and shows what was typed as its text.
          const androidField = async (): Promise<PublicNode> =>
            need(
              (await ui.nodes()).find(
                node => node.type === 'EditText' && node.id !== 'chat-composer'
              ),
              'Actual member Search field required'
            )
          const typed = async (): Promise<string | undefined> =>
            ui.surface === 'ios'
              ? (
                  await ui.iosRead(
                    { text: exactText('Search members') },
                    'TextField'
                  )
                ).value
              : (await androidField()).text
          // A loaded simulator or a phone's keyboard drops keys from fast
          // typing ("Boby", "Bby"). Clear the field, put the focus back on the
          // field itself (an id-less type focuses the last tapped point, which
          // would be the Clear button), and type the query again; at most
          // three times.
          const retyped: Array<string | undefined> = []
          for (
            let observed = await typed();
            observed !== first.search && retyped.length < 3;
            observed = await typed()
          ) {
            retyped.push(observed)
            await ui.text('Clear Search members')
            const field =
              ui.surface === 'ios'
                ? need(
                    (await ui.nodes()).find(
                      node =>
                        node.text === 'Search members' &&
                        (node.type ?? '').endsWith('TextField')
                    ),
                    'Actual member Search field required'
                  )
                : await androidField()
            await ui.tapObserved(field)
            await ui.append(first.search)
          }
          if (retyped.length > 0)
            this.observations.push({ nativeSearchRetyped: retyped })
          assert.equal(
            await typed(),
            first.search,
            'Search must retain the exact typed member query'
          )
        }
        if (webSearch != null) {
          const afterSearch = await webSearch()
          assert.equal(
            afterSearch.value,
            first.search,
            'Search must retain the exact typed member query'
          )
          assert.equal(
            afterSearch.start,
            first.search.length,
            'Search caret must follow the complete query'
          )
          assert.equal(
            afterSearch.end,
            first.search.length,
            'Search selection must remain collapsed'
          )
          assert.equal(
            afterSearch.backendNodeId,
            beforeSearch!.backendNodeId,
            'Typing must retain the same actual Search node'
          )
          this.observations.push({
            actualMemberSearch: { before: beforeSearch, after: afterSearch }
          })
        }
        await ui.present('chat-mention-member-' + first.userId)
        await ui.shot(
          'mentions',
          'Actual searched member chooser with stable public member IDs'
        )
        await ui.selectMention(first)
        await ui.assertKeyboard()
        assert((await ui.draft()).includes('@' + first.name))
        await ui.shot(
          'mention-composer',
          'Actual readable selected mention token and focused composer'
        )
        await ui.appendComposer(' synthetic mention ' + Date.now())
        const body = await ui.draft()
        await this.attachPhoto()
        await ui.text('Send')
        const received = await this.delivered(body)
        assert.deepEqual(received.mentions, [first.userId])
        assert.equal(received.attachments.length, this.expectedAttachments)
        assert.equal(received.quote?.id, this.f.messages.target.id)
        const wire = await (
          await this.client()
        ).chatMessages(this.group, { after: received.seq - 1, limit: 1 })
        assert(
          !JSON.stringify(wire).includes(body),
          'Plain mention/body must not appear in wire envelopes'
        )
      }
    )
    await this.check(
      'E7 chooser cancel, token edit and failed send ownership',
      async () => {
        await ui.replaceDraft('')
        await ui.typeMentionTrigger()
        await ui.text('Cancel')
        assert.equal(await ui.draft(), '@')
        await ui.replaceDraft('')
        await ui.typeMentionTrigger()
        await ui.selectMention(this.f.members[0])
        await ui.deleteBackward()
        await ui.deleteBackward()
        const edited = await ui.draft()
        const suffix = ' edited token ' + Date.now()
        await ui.appendComposer(suffix)
        // iOS reads a value without its trailing space ("@Bobby " as
        // "@Bobby"), so the draft is read again once the suffix ends it.
        const body = await ui.draft()
        assert(
          body.endsWith(suffix) &&
            body.slice(0, -suffix.length).trimEnd() === edited.trimEnd(),
          'Actual edited token followed by the typed suffix required'
        )
        await this.withFault('send', async () => {
          await ui.text('Send')
          await ui.device.assertVisible({
            text: 'That did not send.*',
            timeout: 15000
          })
        })
        assert.equal(
          await ui.draft(),
          body,
          'Actual failed draft must remain current before Send again'
        )
        const cutoff = Number(this.snapshot(this.group).lastEvent)
        const proof: Json = { inFlightNewerDraft: true, cutoff }
        this.observations.push(proof)
        try {
          const installed = fixtureControl(this.f, 'fault', {
            phase: 'send',
            mode: 'defer',
            remaining: 1,
            viewerId: this.viewerId,
            conversationId: this.group
          })
          const rule = installed.rule as Json
          proof.installed = installed
          assert(
            rule.mode === 'defer' &&
              rule.viewerId === this.viewerId &&
              rule.conversationId === this.group &&
              rule.remaining === 1,
            'Exact one-request owned send defer required'
          )
          await this.sendAgain()
          proof.matched = await this.waitEvent(
            this.group,
            cutoff,
            event =>
              event.type === 'fault-matched' &&
              event.mode === 'defer' &&
              event.ruleId === rule.id &&
              event.actorId === this.viewerId &&
              event.conversationId === this.group
          )
          await ui.replaceDraft('A newer synthetic draft')
          assert.equal(await ui.draft(), 'A newer synthetic draft')
          const held = this.snapshot(this.group, cutoff)
          proof.beforeRelease = held
          assert(
            !(held.events as Json[]).some(
              event =>
                event.type === 'deferred-closed' && event.ruleId === rule.id
            ),
            'Actual retry must remain held until the newer draft is observed'
          )
        } finally {
          proof.released = fixtureControl(this.f, 'clear-fault')
        }
        const sent = await this.delivered(body)
        assert.deepEqual(
          sent.mentions,
          [],
          'Editing inside a selected token removes stale identity'
        )
        assert.equal(await ui.draft(), 'A newer synthetic draft')
      }
    )
  }

  async E8(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E8 actual read-only and isolated locked history, with ordinary identity lifecycle',
      async () => {
        await this.signIn(
          need(this.f.readOnlyViewer, 'Read-only synthetic viewer required')
        )
        await this.openGroup(
          need(
            this.f.conversations.readOnly,
            'Read-only audience fixture required'
          ).id
        )
        // Prove the read-only conversation is the one on screen before the
        // composer's absence counts; the previous screen can still be up.
        await ui.device.assertVisible({
          text: exactText('Only season staff post here. You can react.'),
          timeout: ui.surface === 'ios' ? 45000 : 15000
        })
        await ui.absent('chat-composer')
        await ui.device.assertNotVisible({
          text: exactText('Mention a member'),
          timeout: 1000
        })
        const locked = need(
          this.f.lockedCases[ui.surface],
          'Fresh per-surface locked probe required'
        )
        fixtureControl(this.f, 'claim-locked', {
          viewerId: this.f.actors[locked.viewer].userId,
          conversationId: locked.conversation.id,
          generation: locked.generation,
          surface: ui.surface,
          run: ui.runDir
        })
        await this.signIn(locked.viewer)
        const listing = (
          await (await fixtureClient(this.f, locked.viewer)).chatConversations()
        ).find(c => c.id === locked.conversation.id)
        assert(
          listing?.locked === true,
          'Actual new probe must still be locked; never reset a previously granted identity'
        )
        await this.openGroup(locked.conversation.id)
        await ui.device.assertVisible({
          text: exactText(
            'History is locked — it unlocks when another member opens TeamStation'
          ),
          timeout: ui.surface === 'ios' ? 45000 : 15000
        })
        this.observations.push({
          lockedComposer: await ui.assertComposerNotEditable()
        })
        await ui.device.assertNotVisible({
          text: exactText(locked.message.body),
          timeout: 2000
        })
        await ui.device.assertNotVisible({
          text: exactText('Mention a member'),
          timeout: 1000
        })
        this.observations.push({
          lockedProbe: locked.viewer,
          generation: locked.generation,
          serverLocked: true,
          oldPlaintextNotRendered: true
        })
        const holder = await this.protocolPeer('Ec')
        await holder.engine.open(locked.conversation.id)
        await holder.engine.fillGrants()
        await ui.device.assertVisible({
          text: exactText(locked.message.body),
          timeout: 30000
        })
        await ui.present('chat-composer')
        this.observations.push({
          normalAuthorizedGrantUnlocked: locked.conversation.id,
          noKeysCopiedOrReset: true
        })
        await this.signIn()
      }
    )
    await this.check(
      'E8 preserved keyboard, branded actual file drag/drop and encrypted delivery',
      async () => {
        await this.openGroup()
        const body = 'First synthetic line ' + Date.now()
        await ui.replaceDraft(body)
        if (!ui.native) {
          await ui.device.pressKey({ key: 'SHIFT+ENTER' })
          await ui.append('Second synthetic line')
          assert((await ui.draft()).includes('\n'))
          const files = need(this.f.files, 'Synthetic drag asset required')
          const base64 = readFileSync(files.photo).toString('base64')
          await ui.dom(
            'const target=document.querySelector(\'[data-testid="chat-drop-target"]\');if(!target)throw Error("Public drop target required");const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(' +
              JSON.stringify(base64) +
              '),c=>c.charCodeAt(0))],"Synthetic practice tiles.png",{type:"image/png"}));target.dispatchEvent(new DragEvent("dragenter",{bubbles:true,dataTransfer:data}));target.dispatchEvent(new DragEvent("dragover",{bubbles:true,dataTransfer:data}));return {publicSyntheticDragEvent:true}'
          )
          await ui.present('chat-drop-overlay')
          await ui.device.assertVisible({ text: exactText('TeamStation') })
          await ui.shot(
            'branded-drop',
            'Observed public synthetic file-drag overlay; no OS file-manager drag claim'
          )
          await ui.dom(
            'const target=document.querySelector(\'[data-testid="chat-drop-target"]\');const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(' +
              JSON.stringify(base64) +
              '),c=>c.charCodeAt(0))],"Synthetic practice tiles.png",{type:"image/png"}));target.dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:data}));return {publicDropEvent:true}'
          )
          await ui.present('chat-attachment-chip')
          const expected = await ui.draft()
          // Enter sends only with a fine pointer; on touch it is a newline.
          if (ui.metrics().coarse) await ui.text('Send')
          else await ui.device.pressKey({ key: 'ENTER' })
          const received = await this.delivered(expected)
          assert.equal(received.attachments.length, 1)
        } else {
          await this.attachPhoto()
          const expected = await ui.draft()
          await ui.text('Send')
          assert.equal(
            (await this.delivered(expected)).attachments.length,
            this.expectedAttachments
          )
        }
      }
    )
    await this.check(
      'E8 real former-member, included-adult and attachment-size API denials',
      async () => {
        const former = await fixtureClient(
          this.f,
          need(this.f.formerActor, 'Disposable former actor required')
        )
        const denied = need(
          this.f.conversations.former,
          'Former-member DM required'
        )
        await assert.rejects(
          async () => await former.chatMessages(denied.id),
          e => e instanceof HttpError && [403, 404].includes(e.status)
        )
        const permission = need(
          this.f.authorization,
          'Included-adult probe parameters required'
        )
        // The asker must be someone the players are candidates for, or the
        // pair rule refuses first (notCandidate).
        const client =
          permission.asker == null
            ? await this.client()
            : await fixtureClient(this.f, permission.asker)
        const player = need(permission.playerIds[0], 'Probe player required')
        // The adult rule covers minors in SafeSport LAO leagues; the synthetic
        // league is one only for this check, so other cases' DMs stand.
        const lao = fixtureControl(this.f, 'set-lao', {
          playerId: player,
          on: true
        })
        try {
          const adults = await client.includedAdults(permission.playerIds)
          assert(
            adults.some(a => a.userId === permission.acceptedAdult),
            'Actual authorized included adult required'
          )
          await assert.rejects(
            async () => await client.createDm(permission.playerIds),
            e =>
              e instanceof HttpError &&
              e.status === 409 &&
              (e.details as Json)?.reason === 'adultRequired'
          )
        } finally {
          fixtureControl(this.f, 'set-lao', { playerId: player, on: false })
        }
        this.observations.push({
          adultRuleLeagues: lao.leagues,
          adultRuleAsker: permission.asker ?? this.viewerKey
        })
        await assert.rejects(
          async () =>
            await client.createChatAttachment({
              conversationId: this.group,
              // The declared size is the sealed blob's: a 100 MiB file seals
              // to about 102.4 MiB, so the first refused size is one past it.
              size: blobLength(MAX_ATTACHMENT_SIZE) + 1,
              digest: 'A'.repeat(43)
            }),
          e => e instanceof HttpError && [400, 413].includes(e.status)
        )
        this.observations.push({
          formerHistoryDenied: true,
          includedAdultListingVerified: true,
          adultRuleDenied: true,
          declaredOversizeRejectedWithoutUploadingBytes: true
        })
      }
    )
    await this.check(
      'E8 actual browser without WebAssembly retains native distinction',
      async () => {
        if (ui.native) {
          await this.openGroup()
          await ui.present('chat-composer')
          this.observations.push({
            noWasmCase: 'not-applicable',
            reason:
              'This native binary uses the verified native crypto core; actual native chat composing is available'
          })
          return
        }
        await ui.withoutWasm(async () => {
          await ui.device.assertVisible({
            text: exactText('Chat needs WebAssembly'),
            timeout: 15000
          })
          await ui.absent('chat-composer')
          await ui.device.assertNotVisible({
            text: exactText('Mention a member'),
            timeout: 1000
          })
        })
        await this.signIn()
        await this.openGroup()
        await ui.present('chat-composer')
      }
    )
  }

  async E9(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E9 middle/top-zero/end reader with multiline reply/file retained',
      async () => {
        await this.openGroup()
        await this.anchor()
        await this.reply()
        // Name the field: after the Reply action, iOS inputText checks the last tapped control.
        await ui.appendComposer('Keep a multiline\nreader draft')
        await this.attachPhoto()
        if (ui.native) await ui.hideKeyboard()
        const draft = await ui.draft()
        const before = await this.targetBounds(
          'chat-bubble-' + this.f.messages.target.id
        )
        await this.openInfo()
        await ui.back()
        assert.equal(await ui.draft(), draft)
        await this.presentAttachment()
        await ui.device.assertVisible({ text: exactText('Cancel reply') })
        const restored = await this.targetBounds(
          'chat-bubble-' + this.f.messages.target.id
        )
        assert(
          Math.abs(restored.y - before.y) <= 3,
          'Row-relative reader anchor must survive information navigation'
        )
        const oldest = need(
          this.f.messages.oldest,
          'Oldest readable fixture required'
        )
        await this.anchor(oldest)
        if (!ui.native) {
          const saved = await ui.dom(
            'const n=document.querySelector(\'[data-testid="chat-message-history"]\');if(!n)throw Error("Public history scroller required");n.scrollTop=0;n.dispatchEvent(new Event("scroll"));return {top:n.scrollTop}'
          )
          assert.equal(
            saved.top,
            0,
            'Explicit oldest scroller zero must actually be recorded'
          )
          await this.webAnchorReady(oldest)
          await this.ownWebReader(oldest, true)
          await this.openInfo()
          await ui.back()
          const restoredZero = await ui.dom(
            'const n=document.querySelector(\'[data-testid="chat-message-history"]\');return {top:n?.scrollTop}'
          )
          assert.equal(
            restoredZero.top,
            0,
            'Information Back must restore explicit saved zero'
          )
          await ui.open('/chat')
          await ui.id('chat-conversation-' + this.group)
          const listZero = await ui.dom(
            'const n=document.querySelector(\'[data-testid="chat-message-history"]\');return {top:n?.scrollTop}'
          )
          assert.equal(
            listZero.top,
            0,
            'List return must retain explicit saved zero'
          )
          await this.anchor()
          await this.ownWebReader(this.f.messages.target)
          const currentReader = await this.targetBounds(
            'chat-bubble-' + this.f.messages.target.id
          )
          const currentBand = await this.readingBand()
          const currentCenter = currentReader.y + currentReader.height / 2
          const currentMargin = (currentBand.bottom - currentBand.top) / 4
          const alreadyMiddle =
            currentReader.y >= currentBand.top &&
            currentReader.y + currentReader.height <= currentBand.bottom &&
            currentCenter >= currentBand.top + currentMargin &&
            currentCenter <= currentBand.bottom - currentMargin
          const middleScroll = alreadyMiddle
            ? undefined
            : await ui.device.scroll(
                { direction: 'UP' },
                { signal: ui.deadline }
              )
          await this.webAnchorReady()
          const beforeResize = await this.targetBounds(
            'chat-bubble-' + this.f.messages.target.id
          )
          const band = await this.readingBand()
          const center = beforeResize.y + beforeResize.height / 2
          const margin = (band.bottom - band.top) / 4
          assert(
            beforeResize.y >= band.top &&
              beforeResize.y + beforeResize.height <= band.bottom &&
              center >= band.top + margin &&
              center <= band.bottom - margin,
            'Exact resize reader must be clearly inside the readable band'
          )
          this.observations.push({
            middleResizeReader: {
              id: this.f.messages.target.id,
              bounds: beforeResize,
              band,
              scroll: middleScroll
            }
          })
          const metrics = ui.metrics()
          await ui.resize(
            metrics.width === 1440 ? 390 : 1440,
            metrics.width === 1440 ? 844 : 1000
          )
          await this.webAnchorReady()
          await ui.present('chat-bubble-' + this.f.messages.target.id)
          assert.equal(await ui.draft(), draft)
          await ui.resize(metrics.width, metrics.height)
          await this.webAnchorReady()
          const afterResize = await this.targetBounds(
            'chat-bubble-' + this.f.messages.target.id
          )
          assert(
            Math.abs(beforeResize.y - afterResize.y) <= 3,
            'Round-trip resize must retain measured reader anchor'
          )
          this.observations.push({
            explicitSavedZeroObserved: true,
            roundTripResize: { before: beforeResize, after: afterResize }
          })
        } else {
          await this.withoutDragActions(
            async () =>
              await ui.device.swipe({ direction: 'DOWN', duration: 500 }),
            'nativeOldestSwipeOpenedActions',
            oldest.id
          )
          await ui.device.assertNotVisible({
            text: exactText('Load earlier messages'),
            timeout: 2000
          })
          const boundary = await this.targetBounds('chat-bubble-' + oldest.id)
          await this.openInfo()
          await ui.back()
          const restoredBoundary = await this.targetBounds(
            'chat-bubble-' + oldest.id
          )
          assert(
            Math.abs(restoredBoundary.y - boundary.y) <= 3,
            'Native oldest boundary must survive navigation'
          )
          this.observations.push({
            nativeOldestBoundary: oldest.id,
            before: boundary,
            after: restoredBoundary,
            publicOffsetNumberUnavailable: true
          })
        }
        assert.equal(await ui.draft(), draft)
        await this.presentAttachment()
        await ui.id('chat-jump-latest')
        await ui.present('chat-jump-latest')
        await this.cancelReply()
      }
    )
    await this.check(
      'E9 ordinary shared chrome routes return to selected chat',
      async () => {
        // A native tab list carries the selected tab's label too.
        const tab = async (label: string): Promise<PublicNode> => {
          const nodes = await ui.nodes()
          if (ui.native)
            return { text: label, bounds: innermostLabelled(nodes, label) }
          return need(
            nodes.find(n => n.text === label && n.bounds != null),
            'Public shared-shell tab fixture missing: ' + label
          )
        }
        for (const label of ['Home', 'Videos', 'Schedule']) {
          await ui.tapObserved(await tab(label))
          await ui.tapObserved(await tab('Chat'))
          await ui.present('chat-message-history')
        }
      }
    )
  }

  async E10(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E10 three new distinct attention targets, dedup and repeated badge jumps',
      async () => {
        const loop = fixtureControl(this.f, 'prepare-loop', {
          viewerId: this.viewerId
        }) as Json & {
          conversationId: string
          readerAnchor: Chat2Message
          ownOriginal: Chat2Message
        }
        await this.openGroup(loop.conversationId)
        await this.anchor(loop.readerAnchor)
        if (!ui.native) await this.ownWebReader(loop.readerAnchor)
        await ui.replaceDraft('Synthetic typing transport probe')
        await ui.replaceDraft('')
        if (ui.native) await ui.hideKeyboard()
        const reader = await this.targetBounds(
          'chat-bubble-' + loop.readerAnchor.id
        )
        const socketBefore = fixtureControl(this.f, 'snapshot', {
          kind: 'socket'
        })
        const posted = fixtureControl(this.f, 'post-loop', {
          viewerId: this.viewerId
        }) as Json & { targets: Chat2Message[]; expectedCount: number }
        assert.equal(
          posted.targets.length,
          3,
          'Human-scale loop requires mention, reply and both'
        )
        assert.equal(posted.expectedCount, 3)
        assert.equal(new Set(posted.targets.map(t => t.id)).size, 3)
        await this.classification()
        await this.expectCount(3)
        const socketAfter = fixtureControl(this.f, 'snapshot', {
          kind: 'socket'
        })
        const active = socketAfter.activeSockets as Json[]
        const beforeSockets = socketBefore.activeSockets as Json[]
        assert(
          active.some(
            socket =>
              socket.actorId === this.viewerId &&
              socket.status === 101 &&
              Number(socket.clientPayloadBytes) > 0 &&
              posted.targets.every(target =>
                (socket.chatMessageHints as Json[]).some(
                  hint =>
                    hint.conversationId === loop.conversationId &&
                    hint.seq === target.seq
                )
              ) &&
              Number(socket.serverPayloadBytes) >
                Number(
                  beforeSockets.find(
                    before => before.connectionId === socket.connectionId
                  )?.serverPayloadBytes ?? 0
                )
          ),
          'Actual actor-bound101 socket must carry each peer target sequence and client typing bytes; polling or heartbeat bytes alone cannot satisfy E10'
        )
        this.observations.push({
          actualSocketBefore: socketBefore,
          actualSocketAfter: socketAfter
        })
        const stayed = await this.targetBounds(
          'chat-bubble-' + loop.readerAnchor.id
        )
        assert(
          Math.abs(stayed.y - reader.y) <= 3,
          'Receiving below-reader targets must not move reader'
        )
        await ui.present('chat-jump-latest')
        await ui.shot(
          'attention',
          'Three distinct verified new targets at actual older reader; mention+reply counts once'
        )
        if (!ui.native) {
          // The virtualized history mounts the first target only near the
          // reading band; bring it into the window from above it.
          await this.webMountBelow('chat-message-body-' + posted.targets[0].id)
          const band = await this.readingBand()
          const hidden = await ui.dom(
            `const n=document.querySelector(${JSON.stringify('[data-testid="chat-message-body-' + posted.targets[0].id + '"]')});const h=document.querySelector('[data-testid="chat-message-history"]');if(!n||!h)throw Error('Public target/history required');h.scrollTop+=n.getBoundingClientRect().top-(${band.bottom}+4);h.dispatchEvent(new Event('scroll'));const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}`
          )
          assert(
            Number(hidden.y) >= band.bottom,
            'Target leading body must actually remain behind composer'
          )
          let stable = 0
          await until(async () => {
            assert.equal(
              await this.count(),
              3,
              'A target still behind composer must not be consumed'
            )
            return ++stable >= 5 ? true : undefined
          }, 'unchanged attention count across actual-view reconciliation')
          this.observations.push({
            actualTargetBehindComposer: hidden,
            unobscuredReader: band,
            unseenCountObserved: 3
          })
        }
        for (let index = 0; index < posted.targets.length; index++) {
          await ui.id('chat-attention-count')
          const tappedAt = Date.now()
          await ui.present('chat-message-body-' + posted.targets[index].id)
          // The jump scrolls; a longer history takes longer to arrive. The
          // target must come to rest in the reading band, not pass through it.
          let moving: { y: number } | undefined
          const { body, band } = await until(
            async () => {
              const body = await this.targetBounds(
                'chat-message-body-' + posted.targets[index].id
              )
              const band = await this.readingBand()
              if (
                body.y < band.top - 2 ||
                body.y + Math.min(body.height, 40) >= band.bottom
              ) {
                moving = undefined
                return undefined
              }
              if (moving != null && Math.abs(moving.y - body.y) <= 1)
                return { body, band }
              moving = body
              return undefined
            },
            'Jump target leading body must be exposed below header/pins and above composer/keyboard',
            // Two equal iOS reads take several seconds on a loaded simulator.
            ui.surface === 'ios' ? 30000 : 5000
          )
          await this.expectCount(2 - index)
          this.observations.push({
            attentionStep: index + 1,
            target: posted.targets[index].id,
            settledMs: Date.now() - tappedAt,
            body,
            unobscuredReader: band,
            remaining: 2 - index
          })
        }
        await ui.present('chat-jump-latest')
        await ui.id('chat-jump-latest')
        // The loop posts three tall spacing rows after each target; a phone's
        // narrow rows put the last target screens above the latest one, so
        // a native reader proves the jump by the chat's newest post.
        await ui.present(
          'chat-bubble-' +
            (ui.native
              ? (await this.newestPost(loop.conversationId)).id
              : posted.targets[2].id)
        )
        await ui.present('chat-jump-latest')
        await this.anchor(loop.readerAnchor)
        if (!ui.native) await this.olderWebReader()
        const next = await this.peerMessage(
          'A later distinct synthetic target ' + Date.now(),
          { mentions: [this.viewerId] },
          loop.conversationId
        )
        await this.classification()
        await this.expectCount(1)
        await ui.id('chat-attention-count')
        await ui.present('chat-bubble-' + next.id)
        await this.expectCount(0)
        await ui.present('chat-jump-latest')
      }
    )
  }

  /**
   * Mount a history row below the reader without showing it: the
   * virtualized window mounts rows a screen beyond the visible band, so short
   * script scrolls (not a person's, so they consume nothing) stop as soon as
   * the row exists, before it can reach the reading band. The fixture
   * conversation grows with every run, so the walk is bounded by the history's
   * end (it stops moving) rather than by a short step count.
   */
  async webMountBelow(testId: string): Promise<void> {
    const ui = this.ui
    assert(!ui.native, 'Browser history window required')
    const proof: Json = { mountBelow: testId, steps: [] }
    this.observations.push(proof)
    for (let step = 0; step < 2000; step++) {
      const value = await ui.dom(
        `const h=document.querySelector('[data-testid="chat-message-history"]');if(!h)throw Error('Public history required');
        const n=document.querySelector(${JSON.stringify('[data-testid="' + testId + '"]')});if(n){const b=n.getBoundingClientRect();return {mounted:true,offset:h.scrollTop,top:b.top}}
        const was=h.scrollTop;h.scrollTop=Math.min(Math.max(0,h.scrollHeight-h.clientHeight),was+Math.min(200,h.clientHeight/4));h.dispatchEvent(new Event('scroll'));return {mounted:false,moved:h.scrollTop!==was,offset:h.scrollTop}`
      )
      // Keep the first and latest steps; the whole walk can be long.
      const steps = proof.steps as unknown[]
      steps.push(value)
      if (steps.length > 40) steps.splice(10, 1)
      proof.stepCount = step + 1
      if (value.mounted === true) {
        proof.outcome = 'mounted'
        return
      }
      assert(value.moved === true, 'History row never mounted: ' + testId)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    throw Error('History row never mounted: ' + testId)
  }

  /** Establish actual wheel-driven older-reader intent before starting another attention cycle. */
  async olderWebReader(): Promise<void> {
    const ui = this.ui
    assert(!ui.native, 'Browser user-scroll setup required')
    const proof: Json = {
      name: 'Measured older browser reader after Maestro wheel',
      outcome: 'failed',
      samples: []
    }
    ui.steps.push(proof)
    const read = async (): Promise<{
      offset: number
      maximum: number
      height: number
    }> => {
      const actual = await ui.dom(
        'const h=document.querySelector("[data-testid=chat-message-history]");if(!h)throw Error("Actual history required");const hit=document.elementFromPoint(innerWidth/2,innerHeight/2);return {offset:h.scrollTop,maximum:h.scrollHeight-h.clientHeight,height:h.clientHeight,wheelPointInside:hit!=null&&h.contains(hit)}'
      )
      assert(
        actual.wheelPointInside === true,
        'Maestro wheel point must hit the actual chat history'
      )
      const value = {
        offset: Number(actual.offset),
        maximum: Number(actual.maximum),
        height: Number(actual.height)
      }
      assert(
        Object.values(value).every(Number.isFinite) &&
          value.height > 0 &&
          value.maximum > value.height &&
          value.offset > 0 &&
          value.offset <= value.maximum,
        'Positive current browser history scroll geometry required'
      )
      return value
    }
    try {
      let before = await read()
      for (let gesture = 0; gesture < 4; gesture++) {
        await ui.device.scroll({ direction: 'UP' })
        const after = await until(
          async () => {
            const value = await read()
            assert(
              value.maximum === before.maximum &&
                value.height === before.height,
              'History dimensions changed during explicit user scroll'
            )
            return value.offset < before.offset - 1 ? value : undefined
          },
          'actual older-reader wheel movement',
          2000
        )
        ;(proof.samples as unknown[]).push({
          before,
          after,
          command: { direction: 'UP' }
        })
        if (after.maximum - after.offset >= after.height) {
          proof.outcome = 'passed'
          this.observations.push({ actualOlderReaderBeforeSecondCycle: proof })
          return
        }
        before = after
      }
      throw new Error(
        'Explicit user scrolling did not establish a full-viewport older-reader gap'
      )
    } catch (error) {
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /** Certify the visible reader position, independently of attention's leading-body rule. */
  async visibleReaderAnchor(
    before?: VisibleReaderAnchor,
    failure = 'Actual visible reader must not move'
  ): Promise<VisibleReaderAnchor> {
    const proof: Json = {
      name: 'Visible public message-body anchor',
      before,
      outcome: 'failed'
    }
    this.ui.steps.push(proof)
    this.observations.push({ visibleReaderAnchor: proof })
    try {
      const band = await this.readingBand()
      proof.band = band
      assert(
        Number.isFinite(band.top) &&
          Number.isFinite(band.bottom) &&
          band.bottom > band.top,
        'Positive measured unobscured reader band required'
      )
      const nodes = await this.ui.nodes('chat-message-history')
      const histories = nodes.filter(node => node.id === 'chat-message-history')
      assert(histories.length === 1, 'Unique current public history required')
      const history = need(
        histories[0].bounds,
        'Actual public history bounds required'
      )
      proof.history = history
      assert(
        [history.x, history.y, history.width, history.height].every(
          Number.isFinite
        ) &&
          history.width > 0 &&
          history.height > 0,
        'Positive finite current history bounds required'
      )
      const bodies = nodes.filter(
        node => node.id?.startsWith('chat-message-body-') === true
      )
      const eligible = bodies
        .filter(node => {
          const box = node.bounds
          return (
            box != null &&
            [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
            box.width > 0 &&
            box.height > 0 &&
            box.x >= history.x &&
            box.x + box.width <= history.x + history.width &&
            ((box.y >= band.top &&
              box.y + Math.min(box.height, 40) < band.bottom) ||
              (box.height > band.bottom - band.top &&
                Math.min(box.y + box.height, band.bottom) -
                  Math.max(box.y, band.top) >=
                  40))
          )
        })
        .sort((a, b) => a.bounds!.y - b.bounds!.y)
      proof.visibleBodies = eligible.slice(0, 24)
      const id = before?.id ?? eligible[0]?.id
      const matches = bodies.filter(node => node.id === id)
      proof.matches = matches
      assert(
        typeof id === 'string' && matches.length === 1,
        'Unique current visible message-body identity required'
      )
      const node = matches[0]
      assert(
        eligible.includes(node),
        'Actual short leading body or tall body intersection must be unobscured'
      )
      const actual = { id, bounds: { ...node.bounds! }, band }
      // Retain the original ID and both actual boxes before the strict movement assertion.
      proof.anchor = actual
      if (before != null)
        assert(Math.abs(before.bounds.y - actual.bounds.y) <= 3, failure)
      proof.outcome = 'passed'
      return actual
    } catch (error) {
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async E11(): Promise<void> {
    const ui = this.ui
    const fixture = need(
      this.f.historyStress,
      'Separate cold multi-page fixture required'
    )
    const conversation = need(
      this.f.conversations.attentionStress,
      'Stress conversation required'
    ).id
    assert.equal(
      this.viewerKey,
      fixture.viewer,
      'Cold-session UI must be the stress viewer'
    )
    let cutoff = 0
    let discovery: Json = {}
    await this.check(
      'E11 real cold workspace, deferred old-original request and completed classification',
      async () => {
        requireAfterArchive(this.f)
        await ui.coldOpen('/chat/' + conversation, () => {
          const state = fixtureControl(this.f, 'restore-attention', {
            viewerId: this.viewerId,
            conversationId: conversation
          })
          assert.equal(state.cursor, fixture.readCursor)
          cutoff = Number(
            fixtureControl(this.f, 'snapshot', {
              viewerId: this.viewerId,
              conversationId: conversation
            }).lastEvent
          )
          fixtureControl(this.f, 'fault', {
            phase: 'history-original',
            mode: 'defer',
            beforeAtMost: fixture.readCursor,
            viewerId: this.viewerId,
            conversationId: conversation
          })
        })
        try {
          await ui.present('chat-message-history')
          await ui.present('chat-bubble-' + fixture.neutralTail.id)
          const blocked = await this.waitEvent(
            conversation,
            cutoff,
            e => e.type === 'fault-matched' && e.mode === 'defer'
          )
          const rows = (
            this.snapshot(conversation, cutoff).events as Json[]
          ).filter(e => e.type === 'history-response' && e.status === 200)
          assert(rows.length > 0, 'Actual initial page receipt required')
          const first = rows[0].rows as Array<{ id: string; seq: number }>
          assert(
            !first.some(r => r.id === fixture.ownOriginal.id),
            'Original must not be in the initial loaded page'
          )
          assert(
            Number((blocked.query as Json).before) <= fixture.readCursor,
            'Discovery must cross before unread boundary'
          )
          await ui.present(this.controlId('attentionLoading'))
          await ui.replaceDraft('Keep a cold synthetic draft')
          if (ui.native) await ui.hideKeyboard()
          const before = await this.visibleReaderAnchor()
          const reads = await this.stableReads(conversation)
          fixtureControl(this.f, 'clear-fault')
          await this.classification()
          await this.visibleReaderAnchor(
            before,
            'Background discovery must not move visible reader'
          )
          assert.equal(await ui.draft(), 'Keep a cold synthetic draft')
          assert.deepEqual(
            (await (await this.client()).chatReads(conversation)).filter(
              r => r.userId === this.viewerId
            ),
            reads,
            'Background discovery must not advance read receipt after ordinary initial autoack'
          )
          const hidden = need(
            fixture.hiddenFile,
            'Cold fixture must include a real hidden encrypted historical image'
          )
          const media = fixtureControl(this.f, 'snapshot', {
            kind: 'media',
            conversationId: conversation,
            afterEvent: cutoff
          })
          assert.equal(
            (media.events as Json[]).filter(
              e =>
                e.type === 'media-request' &&
                e.method === 'GET' &&
                e.path === hidden.objectPath
            ).length,
            0,
            'Cold background verification must not fetch hidden attachment bytes'
          )
          this.observations.push({
            hiddenHistoricalAttachment: hidden.attachmentId,
            hiddenAttachmentRequests: media.events,
            explicitAnchorNotYetUsed: true
          })
          discovery = this.snapshot(conversation, cutoff)
          const history = (discovery.events as Json[]).filter(
            e => e.type === 'history-response' && e.status === 200
          )
          assert(
            history.some(
              e =>
                Number((e.query as Json).before) <= fixture.readCursor &&
                (e.rows as Array<{ id: string }>).some(
                  r => r.id === fixture.ownOriginal.id
                )
            ),
            'Actual ordinary request must deliver the own original before explicit anchor navigation'
          )
          assert(
            history.some(e => e.operationsOnly === true),
            'Actual operations-only history page required'
          )
          const cursors = history
            .filter(e => (e.query as Json).before != null)
            .map(e => Number((e.query as Json).before))
          const unique = [...new Set(cursors)]
          assert(
            unique.length >= 3,
            'Several distinct raw history cursors required'
          )
          assert(
            unique.every((n, i) => i === 0 || n < unique[i - 1]),
            'First-seen backwards page cursors must make strict progress'
          )
          const classifiedBeforeAnchor = {
            badgeVisible: await ui.visible({ id: 'chat-attention-count' }, 300),
            completedAt: new Date().toISOString()
          }
          await this.anchor(fixture.readerAnchor)
          await this.expectBelowReaderCount(fixture)
          this.observations.push({
            classifiedBeforeAnchor,
            explicitBoundaryAnchor: fixture.readerAnchor.id,
            actualBelowReaderCount: fixture.expectedCount
          })
          this.observations.push({
            coldInitialReadCursor: fixture.readCursor,
            initialPages: rows,
            originalRequestBeforeExplicitAnchor: true,
            history,
            ordinaryInitialAutoackNotAttributedToDiscovery: true
          })
        } finally {
          fixtureControl(this.f, 'clear-fault')
        }
      }
    )
    await this.check(
      'E11 visible edit/delete reduce complete count; failed original discovery remains retryable',
      async () => {
        await this.anchor(fixture.readerAnchor)
        const initial = await this.count()
        const peer = await this.protocolPeer(fixture.sender)
        const fresh: MessageView[] = []
        await peer.engine.open(conversation)
        for (let n = 0; n < 3; n++)
          fresh.push(
            need(
              await peer.engine.sendText(
                conversation,
                'Disposable stress regression ' + n + ' ' + Date.now(),
                { mentions: [this.viewerId] }
              ),
              'Fresh encrypted regression post required'
            )
          )
        await this.expectCount(initial + 3)
        const [edited, deleted, third] = fresh
        await peer.engine.edit(
          conversation,
          edited.id,
          'Edited synthetic post without a mention ' + Date.now(),
          []
        )
        await this.expectCount(initial + 2)
        await peer.engine.deleteMessage(conversation, deleted.id)
        await this.expectCount(initial + 1)
        await peer.engine.deleteMessage(conversation, third.id)
        await this.expectCount(initial)
        this.observations.push({
          actualEncryptedEdit: edited.id,
          actualEncryptedDeletes: [deleted.id, third.id],
          countBefore: initial,
          countProgress: [initial + 3, initial + 2, initial + 1, initial],
          onlyFreshRegressionPostsMutated: true
        })
        await ui.coldOpen('/chat/' + conversation, () => {
          fixtureControl(this.f, 'restore-attention', {
            viewerId: this.viewerId,
            conversationId: conversation
          })
          fixtureControl(this.f, 'fault', {
            phase: 'history-original',
            mode: 'fail',
            beforeAtMost: fixture.readCursor,
            viewerId: this.viewerId,
            conversationId: conversation
          })
        })
        try {
          await ui.present(this.controlId('attentionRetry'))
          await ui.replaceDraft('Keep retry state')
          if (ui.native) await ui.hideKeyboard()
          const body = await this.visibleReaderAnchor()
          fixtureControl(this.f, 'clear-fault')
          await ui.id(this.controlId('attentionRetry'))
          await this.classification()
          assert.equal(await ui.draft(), 'Keep retry state')
          await this.visibleReaderAnchor(
            body,
            'Discovery Retry must preserve reader'
          )
          await this.anchor(fixture.readerAnchor)
          await this.expectBelowReaderCount(fixture)
        } finally {
          fixtureControl(this.f, 'clear-fault')
        }
      }
    )
    await this.check(
      'E11 Back cancels unresolved verification without consuming unseen; empty history terminates',
      async () => {
        let start = 0
        await ui.coldOpen('/chat/' + conversation, () => {
          fixtureControl(this.f, 'restore-attention', {
            viewerId: this.viewerId,
            conversationId: conversation
          })
          start = Number(this.snapshot(conversation).lastEvent)
          fixtureControl(this.f, 'fault', {
            phase: 'history-original',
            mode: 'defer',
            beforeAtMost: fixture.readCursor,
            viewerId: this.viewerId,
            conversationId: conversation
          })
        })
        try {
          await this.waitEvent(
            conversation,
            start,
            e => e.type === 'fault-matched' && e.mode === 'defer'
          )
          await ui.present(this.controlId('attentionLoading'))
          await ui.replaceDraft('Keep cancelled verification draft')
          if (ui.native) await ui.hideKeyboard()
          if (ui.native) await this.headerBack()
          else {
            const back = await ui.dom(`
              const selector='[role="button"][aria-label="Back"]';
              return {path:location.pathname,controls:[...document.querySelectorAll(selector)].map(n=>{
                const b=n.getBoundingClientRect(),s=getComputedStyle(n),x=b.x+b.width/2,y=b.y+b.height/2;
                const hit=document.elementFromPoint(x,y);
                return {connected:n.isConnected,enabled:n.getAttribute('aria-disabled')!=='true',visible:s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0,width:b.width,height:b.height,centerVisible:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,centerHit:hit===n||n.contains(hit)};
              })};
            `)
            assert.equal(back.path, '/chat/' + conversation)
            const controls = back.controls as Json[]
            assert.equal(
              controls.length,
              1,
              'Unique actual app-header Back required'
            )
            const control = controls[0]
            for (const key of [
              'connected',
              'enabled',
              'visible',
              'centerVisible',
              'centerHit'
            ])
              assert.equal(
                control[key],
                true,
                'Usable actual app-header Back required: ' + key
              )
            assert(Number(control.width) > 0 && Number(control.height) > 0)
            await ui.device.tapOn({
              css: '[role="button"][aria-label="Back"]',
              enabled: true
            })
            this.observations.push({ actualAppHeaderBack: back })
          }
          await ui.present('chat-conversation-list')
          fixtureControl(this.f, 'clear-fault')
          await ui.present('chat-conversation-list')
          await ui.id('chat-conversation-' + conversation)
          await this.classification()
          assert.equal(await ui.draft(), 'Keep cancelled verification draft')
          await this.anchor(fixture.readerAnchor)
          await this.expectBelowReaderCount(fixture)
          this.observations.push({
            actualPublicBackDuringDeferredVerification: true,
            unseenCountAfterReturn: fixture.expectedCount,
            draftObservedPreserved: true
          })
        } finally {
          fixtureControl(this.f, 'clear-fault')
        }
        const empty = need(
          this.f.conversations.attentionEmpty,
          'Owned stress-viewer empty history fixture required'
        )
        const emptyStart = Number(
          fixtureControl(this.f, 'snapshot', { viewerId: this.viewerId })
            .lastEvent
        )
        await ui.coldOpen('/chat/' + empty.id)
        await ui.present('chat-composer')
        const response = await this.waitEvent(
          empty.id,
          emptyStart,
          e => e.type === 'history-response' && e.empty === true
        )
        await ui.absent('chat-attention-count')
        this.observations.push({ terminalEmptyHistory: response })
      }
    )
    await this.check(
      'E11 injected terminal empty older page preserves actual reader compensation',
      async () => {
        const client = await this.client()
        const summary = need(
          (await client.chatConversations()).find(c => c.id === conversation),
          'Stress summary required'
        )
        const pins = await client.chatPins(conversation)
        const had = pins.some(p => p.messageId === fixture.ownOriginal.id)
        try {
          await client.markChatRead(conversation, summary.lastSeq)
          await client.pinChatMessage(
            conversation,
            fixture.ownOriginal.id,
            true
          )
          await ui.coldOpen('/chat/' + conversation)
          // Fully read, the chat opens at its newest posts. Every E11 run adds
          // posts after the neutral tail, which is now pages back; any stable
          // reader serves, and the anchor below is read from what is visible.
          await ui.present('chat-message-history')
          await ui.replaceDraft('Keep terminal empty draft')
          if (ui.native) await ui.hideKeyboard()
          const body = await this.visibleReaderAnchor()
          const start = Number(this.snapshot(conversation).lastEvent)
          fixtureControl(this.f, 'fault', {
            phase: 'history-jump',
            mode: 'empty',
            viewerId: this.viewerId,
            conversationId: conversation
          })
          await ui.id('chat-pinned-summary')
          await this.tapPinnedRow(fixture.ownOriginal.id)
          const empty = await this.waitEvent(
            conversation,
            start,
            e =>
              e.type === 'history-response' &&
              e.empty === true &&
              e.injected === true
          )
          await ui.device.assertVisible({
            text: exactText('Message unavailable'),
            timeout: 10000
          })
          assert.equal(await ui.draft(), 'Keep terminal empty draft')
          const after = await this.visibleReaderAnchor(
            body,
            'Injected terminal empty prepend must not displace current reader'
          )
          this.observations.push({
            controlledTerminalEmptyResponse: empty,
            before: body,
            after,
            injectedProvenanceExplicit: true
          })
        } finally {
          fixtureControl(this.f, 'clear-fault')
          if (!had)
            await client.pinChatMessage(
              conversation,
              fixture.ownOriginal.id,
              false
            )
          fixtureControl(this.f, 'restore-attention', {
            viewerId: this.viewerId,
            conversationId: conversation
          })
        }
      }
    )
    await this.check(
      'E11 real public account switch clears old reader, draft and attention',
      async () => {
        requireAfterArchive(this.f)
        await this.openGroup(conversation)
        await ui.replaceDraft('Account-specific draft must not cross users')
        await this.signIn(
          need(this.f.switchActor, 'Disposable switch actor required')
        )
        await ui.absent('chat-attention-count')
        const client = await fixtureClient(
          this.f,
          need(this.f.switchActor, 'Switch actor required')
        )
        assert(
          !(await client.chatConversations()).some(c => c.id === conversation),
          'Switched user must not be authorized to old fixture'
        )
        await this.openGroup(
          need(this.f.conversations.switch, 'Switch actor readable DM required')
            .id
        )
        await ui.assertEmptyDraft()
        const probe = 'A fresh account-specific synthetic note ' + Date.now()
        await ui.id('chat-composer')
        await ui.appendComposer(probe)
        assert.equal(
          await ui.draft(),
          probe,
          'New-account composer must contain exactly the freshly typed note'
        )
        await ui.text('Send')
        const received = await this.delivered(
          probe,
          this.f.conversations.switch!.id
        )
        assert.equal(
          received.body,
          probe,
          'Ordinary new-account typing must exclude the previous draft'
        )
        await ui.device.assertNotVisible({
          text: exactText(fixture.neutralTail.body),
          timeout: 2000
        })
        await ui.absent('chat-attention-count')
        this.observations.push({
          actualNormalAccountSwitch: true,
          newUser: (await client.whoAmI())?.id,
          oldConversationForbidden: true,
          newDraftObservedEmpty: true,
          providerKeysReset: false
        })
      }
    )
  }

  /** Pinch zoom may require separate real views of controls that exceed its visual viewport. */
  async zoomedWebControlShot(
    kind: string,
    targets: ZoomedWebControl[],
    note: string
  ): Promise<void> {
    await this.frameZoomedWebControls(kind, targets, async () => {
      await this.ui.shot(kind, note)
    })
  }

  /** Pan a pinch-zoomed page to a control, as a reader would, before using it. */
  async revealZoomedWebControl(
    kind: string,
    target: ZoomedWebControl
  ): Promise<void> {
    await this.frameZoomedWebControls(kind, [target], async () => {})
  }

  /**
   * Tap a control framed in a panned, pinch-zoomed page. The driver's point is
   * relative to the visual viewport (measured: delivered client = point +
   * offset, unscaled), so the layout centre is offset into it; the control's
   * actual focus afterwards proves where the tap landed.
   */
  async tapZoomedWebControl(target: ZoomedWebControl): Promise<void> {
    const ui = this.ui
    assert(!ui.native, 'Pinch-zoomed browser page required')
    const spec = JSON.stringify(target)
    const located = await ui.dom(
      `const spec=${spec},v=visualViewport,matches=Array.from(document.querySelectorAll(spec.css));if(matches.length!==1||v==null)throw Error('Unique zoomed tap target and visual viewport required');const b=matches[0].getBoundingClientRect();return {x:b.x+b.width/2-v.offsetLeft,y:b.y+b.height/2-v.offsetTop,scale:v.scale,offsetLeft:v.offsetLeft,offsetTop:v.offsetTop}`
    )
    const point = {
      x: Math.round(Number(located.x)),
      y: Math.round(Number(located.y))
    }
    // Record where the browser actually delivers the tap, then remove the
    // listener: the evidence says which coordinate space the driver used.
    const key = '__chat2ZoomedTap' + randomUUID().replace(/-/g, '')
    await ui.dom(
      `const key=${JSON.stringify(key)},seen=[];const on=e=>seen.push({type:e.type,x:e.clientX,y:e.clientY});for(const t of ['pointerdown','mousedown'])addEventListener(t,on,{capture:true});window[key]={seen,on};return {listening:true}`
    )
    try {
      await ui.device.tapOnPoint(point, {
        signal: AbortSignal.any([ui.deadline, AbortSignal.timeout(15000)])
      })
    } finally {
      located.delivered = (
        await ui.dom(
          `const key=${JSON.stringify(key)},state=window[key];if(!state)return {seen:[]};for(const t of ['pointerdown','mousedown'])removeEventListener(t,state.on,{capture:true});delete window[key];return {seen:state.seen}`
        )
      ).seen
    }
    const landed = await ui.dom(
      `const n=document.querySelector(${JSON.stringify(target.css)});return {focused:n!=null&&document.activeElement===n}`
    )
    this.observations.push({
      zoomedWebTap: target.name,
      located,
      point,
      ...landed
    })
    assert(landed.focused === true, 'Zoomed tap must focus its actual target')
  }

  async frameZoomedWebControls(
    kind: string,
    targets: ZoomedWebControl[],
    framed: () => Promise<void>
  ): Promise<void> {
    const ui = this.ui
    assert(
      !ui.native && targets.length > 0,
      'Explicit public web controls required'
    )
    const signal = AbortSignal.any([ui.deadline, AbortSignal.timeout(5000)])
    const proof: Json = {
      zoomedWebControlCapture: kind,
      outcome: 'failed',
      samples: []
    }
    this.observations.push(proof)
    const read = async (): Promise<Json> =>
      await ui.dom(
        `
      const specs=${JSON.stringify(targets)},v=visualViewport;
      const viewport={x:v?.offsetLeft??0,y:v?.offsetTop??0,width:v?.width??innerWidth,height:v?.height??innerHeight,scale:v?.scale??1,layoutWidth:innerWidth,layoutHeight:innerHeight,dpr:devicePixelRatio};
      if(!Object.values(viewport).every(Number.isFinite)||viewport.width<=0||viewport.height<=0||viewport.scale<=0)throw Error('Actual visual viewport required');
      const controls=specs.map(spec=>{
        let matches=Array.from(document.querySelectorAll(spec.css)).filter(n=>spec.text==null||n.textContent===spec.text);
        if(matches.length>1&&spec.text!=null)matches=matches.filter(n=>!matches.some(other=>other!==n&&n.contains(other)));
        if(matches.length!==1||!matches[0].isConnected)throw Error('Unique actual zoom control required: '+spec.name);
        const n=matches[0],b=n.getBoundingClientRect(),box={x:b.x,y:b.y,width:b.width,height:b.height};
        if(!Object.values(box).every(Number.isFinite)||b.width<=0||b.height<=0)throw Error('Positive zoom control geometry required');
        let visible=true;for(let p=n;p;p=p.parentElement){const s=getComputedStyle(p);if(p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)visible=false;}
        const editor=n instanceof HTMLInputElement||n instanceof HTMLTextAreaElement;
        const enabled=n.disabled!==true&&n.readOnly!==true&&n.getAttribute('aria-disabled')!=='true';
        const intersection={width:Math.max(0,Math.min(b.right,viewport.x+viewport.width)-Math.max(b.left,viewport.x)),height:Math.max(0,Math.min(b.bottom,viewport.y+viewport.height)-Math.max(b.top,viewport.y))};
        const framed=editor?intersection.width>=44&&intersection.height>=44:b.left>=viewport.x-1&&b.top>=viewport.y-1&&b.right<=viewport.x+viewport.width+1&&b.bottom<=viewport.y+viewport.height+1;
        return {name:spec.name,box,intersection,editor,focused:document.activeElement===n,enabled,visible,ready:visible&&enabled&&framed&&(!editor||spec.requireFocus===false||document.activeElement===n)};
      });return {viewport,controls};`,
        signal
      )
    const revealed = new Set<string>()
    let reference = ''
    let stableSince = 0
    let environment = ''
    for (;;) {
      signal.throwIfAborted()
      const actual = await read()
      ;(proof.samples as Json[]).push({
        at: new Date().toISOString(),
        ...actual
      })
      const viewport = actual.viewport as Json
      const invariant = JSON.stringify([
        viewport.scale,
        viewport.dpr,
        viewport.layoutWidth,
        viewport.layoutHeight,
        viewport.width,
        viewport.height
      ])
      if (environment === '') environment = invariant
      assert.equal(
        invariant,
        environment,
        'Control reveal must preserve actual zoom and viewport dimensions'
      )
      const controls = actual.controls as Json[]
      const missing = controls.find(control => control.ready !== true)
      if (missing != null) {
        reference = ''
        assert(
          missing.visible === true && missing.enabled === true,
          'Visible enabled zoom control required'
        )
        if (!revealed.has(String(missing.name))) {
          const target = need(
            targets.find(t => t.name === missing.name),
            'Observed zoom target required'
          )
          await ui.dom(
            `const spec=${JSON.stringify(target)};let matches=Array.from(document.querySelectorAll(spec.css)).filter(n=>spec.text==null||n.textContent===spec.text);if(matches.length>1&&spec.text!=null)matches=matches.filter(n=>!matches.some(other=>other!==n&&n.contains(other)));if(matches.length!==1)throw Error('Unique public reveal target required');matches[0].scrollIntoView({block:'center',inline:'center',behavior:'instant'});return {ordinaryPublicReveal:spec.name};`,
            signal
          )
          revealed.add(String(missing.name))
        }
      } else {
        const snapshot = JSON.stringify(actual)
        if (reference !== snapshot) {
          reference = snapshot
          stableSince = Date.now()
        } else if (Date.now() - stableSince >= 200) {
          await framed()
          assert.deepEqual(
            await read(),
            actual,
            'Actual zoom controls must stay framed around the raw capture'
          )
          proof.outcome = 'passed'
          proof.revealed = [...revealed]
          return
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  async variants(): Promise<void> {
    const ui = this.ui
    await this.signIn()
    await this.openGroup()
    await this.anchor()
    for (const variant of [
      'light',
      'dark',
      'large-text',
      'reduced-motion',
      'reduced-transparency'
    ]) {
      await this.check('E12 ' + variant + ' changed-state sweep', async () => {
        await ui.variant(variant, async () => {
          await this.openGroup()
          await this.anchor()
          await this.readable()
          await ui.present('chat-conversation-identity')
          await ui.present('chat-jump-latest')
          await ui.shot(
            variant + '-conversation',
            'Actual ' +
              variant +
              ' header, composer, pins and chevron reachability/composition'
          )
          // A phone's screen has no host-side recorder on iOS.
          const recordable = ui.native && !(ui.surface === 'ios' && ui.physical)
          if (
            ui.native &&
            !recordable &&
            (variant === 'light' || variant === 'reduced-motion')
          )
            this.observations.push({
              variant,
              transitionCapture: 'unavailable on a physical iPhone'
            })
          const recording =
            recordable && (variant === 'light' || variant === 'reduced-motion')
              ? join(ui.runDir, variant + '-spotlight.mp4')
              : undefined
          const transition = async (): Promise<void> => {
            await this.action(this.f.messages.target)
            await this.menuState()
            const effects = await ui.renderedEffects()
            this.observations.push({ variant, actualRenderedEffects: effects })
            for (const label of this.touchActions
              ? ['Reply', this.copyLabel]
              : [this.copyLabel])
              await ui.device.assertVisible({ text: exactText(label) })
            if (this.touchActions)
              this.observations.push(
                await observeSpotlightCaptureReady(
                  ui,
                  8000,
                  this.f.messages.target
                )
              )
            await ui.shot(
              variant + '-spotlight',
              'Actual ' +
                variant +
                (this.touchActions
                  ? ' sharp preview and accessible actions; static composition only'
                  : ' desktop More menu and accessible controls; touch spotlight not applicable')
            )
            await this.dismiss()
            this.observations.push(await observeComposerCaptureReady(ui))
          }
          if (recording == null) await transition()
          else {
            await ui.recordTransition(recording, transition)
            this.observations.push({
              variant,
              transitionCapture: recording,
              sha256: digest(recording),
              entranceAndDismissalObserved: true,
              claim:
                'Composition and reduced-motion transition comparison only; no pacing, smoothness or physical-haptic claim'
            })
          }
          await this.openInfo()
          await ui.present('chat-info-hero')
          this.observations.push(await observeInfoCaptureReady(ui))
          await ui.shot(
            variant + '-info',
            'Actual ' + variant + ' identity, mute control and member rows'
          )
          await this.showInfoMember()
          await ui.shot(
            variant + '-info-members',
            'Actual ' +
              variant +
              ' current other-member safety row fully clear of header and bottom overlay'
          )
          await ui.back()
          if (!ui.native && variant === 'large-text') {
            await this.revealZoomedWebControl(
              variant + '-composer-reveal',
              zoomedComposer
            )
            await this.tapZoomedWebControl(zoomedComposer)
            await ui.replaceDraft('', { focused: true })
          } else await ui.replaceDraft('')
          await ui.typeMentionTrigger()
          await ui.device.assertVisible({ text: exactText('Mention a member') })
          this.observations.push(await observeMentionHeader(ui))
          if (!ui.native && variant === 'large-text') {
            await this.zoomedWebControlShot(
              variant + '-mention-heading-search',
              [
                {
                  name: 'heading',
                  css: '[data-testid="chat-picker-header"] *',
                  text: 'Mention a member'
                },
                {
                  name: 'search',
                  css: '[data-testid="chat-picker-content"] [aria-label="Search members"]'
                }
              ],
              'Actual same-zoom chooser heading and focused editable Search region in the visual viewport'
            )
            await this.zoomedWebControlShot(
              variant + '-mention-cancel',
              [
                {
                  name: 'cancel',
                  css: '[data-testid="chat-picker-header"] button,[data-testid="chat-picker-header"] [role="button"]',
                  text: 'Cancel'
                }
              ],
              'Actual same-zoom Cancel control in a separately revealed visual viewport; not a combined header claim'
            )
          }
          const member = need(
            this.f.members.find(m => m.userId !== this.viewerId),
            'Current mention member required'
          )
          await ui.present('chat-mention-member-' + member.userId)
          await ui.shot(
            variant + '-mentions',
            'Actual ' + variant + ' chooser row reachability and Cancel'
          )
          await ui.selectMention(member)
          await ui.assertKeyboard()
          this.observations.push(
            await observeComposerCaptureReady(ui, {
              focused: true,
              reply: false
            })
          )
          await this.nativeKeyboardGeometry()
          assert((await ui.draft()).includes('@' + member.name))
          await ui.shot(
            variant + '-mention-composer',
            'Actual ' + variant + ' selected token and composer line-box'
          )
          if (!ui.native && variant === 'large-text')
            await this.zoomedWebControlShot(
              variant + '-send-chevron',
              [
                {
                  name: 'send',
                  css: '[data-testid="chat-composer-band"] [aria-label="Send"]'
                },
                { name: 'chevron', css: '[data-testid="chat-jump-latest"]' }
              ],
              'Actual same-zoom enabled Send and persistent chevron in the visual viewport; original draft remains unsent'
            )
          if (ui.native) await ui.hideKeyboard()
          await this.readable()
          this.observations.push({
            variant,
            changedStates: [
              'header/composer',
              this.touchActions ? 'spotlight/actions' : 'desktop More/actions',
              'info/members',
              'floating pins',
              'mention chooser/token',
              'persistent chevron'
            ],
            actualReachabilityAndBounds: true
          })
          if (!ui.native && variant === 'large-text') {
            await this.revealZoomedWebControl(
              variant + '-composer-reveal-final',
              zoomedComposer
            )
            await this.tapZoomedWebControl(zoomedComposer)
            await ui.replaceDraft('', { focused: true })
          } else await ui.replaceDraft('')
        })
      })
    }
  }

  async capture(): Promise<void> {
    const ui = this.ui
    await this.signIn()
    if (ui.surface !== 'web-320')
      await ui.shot(
        'chat-list',
        'Settled real final-source list; composition evidence only'
      )
    await this.openGroup()
    await this.anchor()
    await ui.replaceDraft('')
    if (ui.surface === 'web-320') {
      await ui.replaceDraft('A short synthetic clipping check')
      await ui.shot('composer', 'Actual320pixel touch composer clipping check')
      return
    }
    if (ui.native) await ui.hideKeyboardForCapture()
    await ui.shot('conversation', 'Same synthetic short anchor as baseline')
    await ui.shot(
      'floating-pins',
      'Actual final floating personal pin summary at same anchor'
    )
    await this.action(this.f.messages.target)
    if (this.touchActions)
      this.observations.push(
        await observeSpotlightCaptureReady(ui, 8000, this.f.messages.target)
      )
    await ui.shot(
      'message-actions',
      this.touchActions
        ? 'Actual spotlight/reaction composition; no smoothness claim'
        : 'Actual desktop hover More menu; no touch spotlight'
    )
    if (this.touchActions) await ui.text('Reply')
    else {
      await this.dismiss()
      await this.reply()
    }
    await ui.assertKeyboard()
    this.observations.push(
      await observeComposerCaptureReady(ui, { focused: true, reply: true })
    )
    await ui.shot(
      'reply-keyboard',
      'Explicit Reply focus/keyboard checked before typing'
    )
    if (ui.native) await ui.hideKeyboardForCapture()
    await this.cancelReply()
    await this.openInfo()
    this.observations.push(await observeInfoCaptureReady(ui))
    await ui.shot('info', 'Actual information hero and mute control')
    await this.showInfoMember()
    await ui.shot(
      'info-members',
      'Actual current other-member safety row fully clear of header and bottom overlay; role/security composition for review'
    )
    await ui.back()
    await ui.replaceDraft('')
    await ui.typeMentionTrigger()
    await ui.device.assertVisible({ text: exactText('Mention a member') })
    this.observations.push(await observeMentionHeader(ui))
    await ui.shot('mentions', 'Actual mention chooser before selection')
    const member = need(
      this.f.members.find(m => m.userId !== this.viewerId),
      'Current member required'
    )
    await ui.selectMention(member)
    this.observations.push(
      await observeComposerCaptureReady(ui, { focused: true, reply: false })
    )
    await ui.shot(
      'mention-composer',
      'Actual selected readable mention and focused composer'
    )
    if (ui.native) await ui.hideKeyboardForCapture()
    await ui.shot(
      'attention',
      'Actual persistent chevron/current reader at same baseline anchor; E10 separately proves nonzero attention'
    )
    if (ui.native) {
      await ui.id('chat-composer')
      this.observations.push(
        await observeComposerCaptureReady(ui, { focused: true, reply: false })
      )
      await ui.shot('keyboard-pins', 'Actual keyboard/pin/composer layout')
    }
  }
}

async function matrix(f: Chat2Fixture): Promise<void> {
  const source = need(process.env.CHAT2_SOURCE, 'Exact final source required')
  const surfaces = CHAT2_SURFACES.filter(s => s !== 'web-320')
  const required: Array<{
    surface: Chat2Surface
    scenario: Chat2Scenario
    variant: string
  }> = surfaces.flatMap(surface =>
    CHAT2_SCENARIOS.map(scenario => ({ surface, scenario, variant: 'default' }))
  )
  required.push({ surface: 'web-320', scenario: 'E2', variant: 'default' })
  const variantNames = [
    'light',
    'dark',
    'large-text',
    'reduced-motion',
    'reduced-transparency'
  ]
  const rows: Json[] = required.map(cell => {
    const entry = f.matrix.find(
      row =>
        row.surface === cell.surface &&
        row.scenario === cell.scenario &&
        row.variant === cell.variant
    )
    if (entry == null) return { ...cell, outcome: 'missing' }
    const receipt = JSON.parse(readFileSync(entry.receipt, 'utf8')) as Json
    const cleanup = receipt.cleanup as Json | undefined
    const environment = receipt.environment as Json | undefined
    let independentlyClean = true
    let keyboardGeometryReviewed = true
    if (cell.surface === 'ios' || cell.surface === 'android') {
      if (entry.cleanupReview == null) independentlyClean = false
      else {
        const review = JSON.parse(
          readFileSync(entry.cleanupReview, 'utf8')
        ) as Json
        independentlyClean =
          review.source === source &&
          review.runReceipt === entry.receipt &&
          review.deviceStopped === true &&
          review.listenersReleased === true &&
          review.daemonStopped === true &&
          review.independent === true
      }
      if (cell.scenario === 'E2') {
        keyboardGeometryReviewed = false
        if (entry.visualReview != null) {
          const review = JSON.parse(
            readFileSync(entry.visualReview, 'utf8')
          ) as {
            source: string
            runReceipt: string
            scenario: string
            outcome: string
            controlsUnobscured: boolean
            actualGeometry: string
            images: Array<{ path: string; sha256: string }>
          }
          const captures = receipt.captures as Json[]
          keyboardGeometryReviewed =
            review.source === source &&
            review.runReceipt === entry.receipt &&
            review.scenario === 'E2' &&
            review.outcome === 'passed' &&
            review.controlsUnobscured &&
            review.actualGeometry.length > 30 &&
            review.images.length > 0 &&
            review.images.every(image => digest(image.path) === image.sha256) &&
            review.images.some(image =>
              captures.some(
                capture =>
                  capture.file ===
                    cell.surface + '-native-keyboard-geometry-after.png' &&
                  capture.path === image.path &&
                  capture.sha256 === image.sha256
              )
            )
        }
      }
    }
    return {
      ...cell,
      receipt: entry.receipt,
      visualReview: entry.visualReview,
      keyboardGeometryReviewed,
      outcome:
        receipt.source === source &&
        receipt.outcome === 'passed' &&
        receipt.surface === cell.surface &&
        (receipt.scenario === cell.scenario ||
          (receipt.scenario === 'surface' &&
            Array.isArray(receipt.completedScenarios) &&
            receipt.completedScenarios.includes(cell.scenario))) &&
        receipt.variant === cell.variant &&
        independentlyClean &&
        keyboardGeometryReviewed &&
        cleanup?.daemonStopped === true &&
        (!(cell.surface === 'ios' || cell.surface === 'android') ||
          (cleanup?.nativeAbsence as Json)?.absent === true) &&
        (cell.variant === 'default' || environment?.variantVerified === true)
          ? 'passed'
          : 'failed'
    }
  })
  for (const surface of surfaces) {
    const entry = f.matrix.find(
      row => row.surface === surface && row.scenario === 'variants'
    )
    for (const variant of variantNames) {
      if (entry == null) {
        rows.push({
          surface,
          scenario: 'variants',
          variant,
          outcome: 'missing'
        })
        continue
      }
      const receipt = JSON.parse(readFileSync(entry.receipt, 'utf8')) as Json
      const steps = receipt.steps as Json[]
      const check = steps.find(
        row =>
          row.name === 'E12 ' + variant + ' changed-state sweep' &&
          row.outcome === 'passed'
      )
      const environment = steps.find(
        row =>
          row.name === 'Accessibility variant' &&
          row.name !== undefined &&
          row.platform === surface &&
          row.outcome === 'passed' &&
          row.variant === variant
      )
      let visualReviewed = false
      if (entry.visualReview != null) {
        const review = JSON.parse(readFileSync(entry.visualReview, 'utf8')) as {
          source: string
          runReceipt: string
          entries: Array<{
            variant: string
            outcome: string
            actualEffect: string
            images: Array<{ path: string; sha256: string }>
          }>
        }
        const observed = review.entries.find(row => row.variant === variant)
        visualReviewed =
          review.source === source &&
          review.runReceipt === entry.receipt &&
          observed?.outcome === 'passed' &&
          observed.actualEffect.length > 20 &&
          observed.images.length > 0 &&
          observed.images.every(image => digest(image.path) === image.sha256)
      }
      let independentlyClean = true
      if (surface === 'ios' || surface === 'android') {
        const review =
          entry.cleanupReview == null
            ? undefined
            : (JSON.parse(readFileSync(entry.cleanupReview, 'utf8')) as Json)
        independentlyClean =
          review?.source === source &&
          review?.runReceipt === entry.receipt &&
          review?.independent === true &&
          review?.deviceStopped === true &&
          review?.daemonStopped === true &&
          review?.listenersReleased === true
      }
      rows.push({
        surface,
        scenario: 'variants',
        variant,
        receipt: entry.receipt,
        visualReview: entry.visualReview,
        preferenceApplicability: environment?.applicability ?? 'applicable',
        preferenceRationale: environment?.reason,
        outcome:
          independentlyClean &&
          visualReviewed &&
          receipt.source === source &&
          receipt.outcome === 'passed' &&
          check != null &&
          environment != null &&
          (environment.applicability !== 'not-applicable' ||
            ((variant === 'dark' ||
              (surface === 'android' && variant === 'reduced-transparency')) &&
              String(environment.reason).length > 20)) &&
          (receipt.cleanup as Json)?.daemonStopped === true
            ? environment.applicability === 'not-applicable'
              ? 'not-applicable'
              : 'passed'
            : 'failed'
      })
    }
  }
  const result = {
    scenario: 'E12',
    source,
    outcome: rows.every(
      r => r.outcome === 'passed' || r.outcome === 'not-applicable'
    )
      ? 'passed'
      : 'blocked',
    rows,
    checkedAt: new Date().toISOString()
  }
  const path = join(
    resolve(need(process.env.CHAT2_ARTIFACTS, 'Private artifacts required')),
    'chat2-matrix.json'
  )
  privateJson(path, result)
  console.log(
    JSON.stringify({
      scenario: 'E12',
      outcome: result.outcome,
      passed: rows.filter(r => r.outcome === 'passed').length,
      notApplicable: rows.filter(r => r.outcome === 'not-applicable').length,
      required: rows.length,
      receipt: path
    })
  )
  if (result.outcome !== 'passed')
    throw new Chat2Blocked(
      'Final matrix has missing/failed fresh surface or accessibility cases'
    )
}

async function main(): Promise<void> {
  const fixture = loadChat2Fixture(
    need(process.env.CHAT2_FIXTURE_FILE, 'Private CHAT2_FIXTURE_FILE required')
  )
  const command = process.argv[2] ?? 'prepare'
  if (command === 'E12') {
    await matrix(fixture)
    return
  }
  const surface = need(
    process.env.CHAT2_SURFACE,
    'CHAT2_SURFACE required'
  ) as Chat2Surface
  assert(CHAT2_SURFACES.includes(surface), 'Unknown chat2 surface')
  if (command === 'prepare') {
    const binding = sourceBinding(process.cwd(), fixture, surface)
    const control = fixtureControl(fixture, 'prepare', {
      surface,
      source: binding.source
    })
    assert.equal(
      control.source,
      binding.source,
      'Fixture relay must bind final source'
    )
    const capabilities = control.capabilities as string[]
    for (const capability of [
      'precise-one-shot-fail',
      'bounded-defer-release',
      'history-envelope-metadata',
      'recorded-read-cursor-restore',
      'media-metadata-only',
      'websocket-duplex-metadata'
    ])
      assert(
        capabilities.includes(capability),
        'Missing precise fixture control capability: ' + capability
      )
    const client = await fixtureClient(fixture, fixture.viewers[surface])
    assert((await client.health()).database === 'ok')
    console.log(
      JSON.stringify({
        outcome: 'prepared',
        source: binding.source,
        surface,
        fixtureOwnership: fixture.ownershipId,
        controlReady: control.ok,
        resets: false
      })
    )
    return
  }
  assert(
    command === 'capture' ||
      command === 'variants' ||
      command === 'surface' ||
      CHAT2_SCENARIOS.includes(command as Chat2Scenario) ||
      ['I1', 'I2', 'I3', 'W1'].includes(command),
    'Unknown chat2 scenario'
  )
  if (command === 'W1') assert.equal(surface, 'web-narrow')
  const ui = new Chat2UI(fixture, surface, command)
  const scenarios = new Scenarios(fixture, ui)
  let outcome: 'passed' | 'failed' | 'blocked' = 'failed'
  let failure: unknown
  const completed: string[] = []
  const allScenarios = [scenarios]
  try {
    fixtureControl(fixture, 'prepare', { surface, source: ui.binding.source })
    await ui.start()
    if (command === 'capture') await scenarios.capture()
    else if (command === 'variants') await scenarios.variants()
    else if (command === 'W1') {
      await scenarios.W1()
      completed.push('W1')
    } else if (['I1', 'I2', 'I3'].includes(command)) {
      await scenarios.run(command as 'I1' | 'I2' | 'I3')
      completed.push(command)
    } else {
      requireAfterArchive(fixture)
      await scenarios.signIn()
      for (const scenario of command === 'surface'
        ? CHAT2_SCENARIOS
        : [command as Chat2Scenario]) {
        const current =
          command === 'surface'
            ? new Scenarios(fixture, ui, scenario)
            : scenarios
        if (current !== scenarios) allScenarios.push(current)
        await current.signIn()
        await current.run(scenario)
        completed.push(scenario)
      }
    }
    outcome = 'passed'
  } catch (error) {
    failure = error
    outcome = error instanceof Chat2Blocked ? 'blocked' : 'failed'
  } finally {
    for (const current of allScenarios) current.close()
    privateJson(
      join(ui.runDir, 'peer-observations.json'),
      allScenarios.flatMap(current => current.observations)
    )
    const receipt = await ui.finish(outcome, failure)
    const saved = JSON.parse(readFileSync(receipt, 'utf8')) as Json
    privateJson(receipt, { ...saved, completedScenarios: completed })
    console.log(
      JSON.stringify({ scenario: command, surface, outcome, receipt })
    )
  }
  if (failure != null)
    throw failure instanceof Error
      ? failure
      : new Error('Unknown harness failure')
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(
      error instanceof Chat2Blocked
        ? 'BLOCKED: ' + error.message
        : 'FAILED: see private chat2 receipt'
    )
    process.exitCode = error instanceof Chat2Blocked ? 2 : 1
  })
