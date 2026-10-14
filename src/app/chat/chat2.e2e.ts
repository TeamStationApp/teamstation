/**
 * Real-app chat2 scenarios. Run with node -r sucrase/register after source freeze.
 * Private env supplies CHAT2_FIXTURE_FILE, CHAT2_ARTIFACTS, CHAT2_SOURCE,
 * CHAT2_SURFACE, MAESTRO_D and the explicitly selected device/client paths.
 * prepare validates disposable inputs; capture records composition; E1–E11
 * assert behavior; E12 validates fresh per-surface functional receipts.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
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
  Chat2UI,
  exactText,
  flattenPublicHierarchy,
  type PublicNode,
  readIosComposerKeyboard,
  until
} from '../../test/chat2Maestro.e2e'
import type { MessageView } from './engine/apply'

type Peer = Awaited<ReturnType<typeof fixturePeer>>
type Json = Record<string, unknown>

/** Compare one public selector coordinate space without assuming native raster scale. */
export async function observeMentionHeader(
  ui: Chat2UI,
  timeout = 8000
): Promise<Json> {
  type Box = NonNullable<PublicNode['bounds']>
  type Geometry = Record<'header' | 'title' | 'cancel' | 'search', Box>
  const samples: Array<{
    startedAt: string
    completedAt?: string
    bounds: Partial<Geometry>
  }> = []
  const coordinateSpace = ui.native
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
    await ui.present('chat-picker-scene')
    await ui.present('chat-picker-header')
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
          ui.surface === 'ios' ? 'StaticText' : undefined
        ))
      }
      sample.bounds.cancel = {
        ...(await ui.observedBounds(
          {
            text: exactText('Cancel'),
            childOf: { id: 'chat-picker-header' }
          },
          ui.surface === 'ios' ? 'Button' : undefined
        ))
      }
      sample.bounds.search = {
        ...(await ui.observedBounds({
          text: exactText('Search members'),
          childOf: { id: 'chat-picker-content' }
        }))
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
            titleScope: 'chat-picker-header',
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
  const tree = JSON.parse(Buffer.from(raw).toString('utf8')) as Json
  assert(Array.isArray(tree.nodes), 'Actual public native node array required')
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
    nodes.filter(node => node.type === 'ScrollView' && under(node, preview)),
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
        node.identifier === 'chat-bubble-' + expected.id && under(node, preview)
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
    const body = unique(
      nodes.filter(
        node =>
          node.type === 'StaticText' &&
          node.label === expected.body &&
          under(node, bubble)
      ),
      'body StaticText inside bubble'
    )
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

/** Static capture readiness never changes the functional hold or animation timing. */
export async function observeSpotlightCaptureReady(
  ui: Chat2UI,
  timeout = 8000,
  expected?: Pick<Chat2Message, 'id' | 'body'>
): Promise<Json> {
  type Box = NonNullable<PublicNode['bounds']>
  const samples: Json[] = []
  const observation: Json = {
    name: 'Settled spotlight capture readiness',
    outcome: 'failed',
    method: ui.native
      ? 'Public bounds and unchanged raw Maestro screenshot hashes'
      : 'Atomic public DOM geometry, computed opacity and transform',
    stableForMs: 200,
    timeoutMs: timeout,
    samples
  }
  ui.steps.push(observation)
  let lastRaw: Buffer | undefined
  let lastImage: Buffer | undefined
  try {
    await ui.present('chat-message-spotlight')
    const deadline = Date.now() + timeout
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
          for(const [name,node] of [['controls',controls],['panel',panel],['backdrop',backdrop],['preview',preview]]){
            if(node===null){if(name!=='preview')return {missing:name};continue;}
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
          ? 'Public accessibility absence, visible controls and stable raw Maestro frames; physical unmount is not inferred'
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
  const nativeProbe = async (selector: Json): Promise<Box | undefined> => {
    try {
      const args = { ...selector, timeout: Math.min(120, remaining()) }
      const options = { signal: AbortSignal.timeout(remaining()) }
      const found = (await device.assertVisible(args, options)).element
      if (ui.surface === 'ios' && found != null) {
        if (typeof selector.id === 'string')
          assert(
            found.id === selector.id,
            'Exact positive iOS composer identity required'
          )
        if (typeof selector.text === 'string')
          assert(
            found.text === selector.text && found.class === 'Button',
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
        const positive =
          ios && expected.focused === true
            ? await readIosComposerKeyboard(
                ui,
                AbortSignal.timeout(remaining())
              )
            : undefined
        const nodes =
          positive?.nodes ??
          flattenPublicHierarchy(
            await device.hierarchy({ signal: AbortSignal.timeout(remaining()) })
          )
        const overlays = nodes
          .filter(n =>
            ['chat-message-spotlight', 'chat-picker-scene'].includes(n.id ?? '')
          )
          .map(n => n.id)
        geometry = { ...positive?.geometry }
        let visible = true
        for (const [name, selector] of [
          ['composer', { id: 'chat-composer' }],
          ['band', { id: 'chat-composer-band' }],
          ['attach', { text: ios ? 'Attach' : exactText('Attach') }],
          ['send', { text: ios ? 'Send' : exactText('Send') }]
        ] as const) {
          if (geometry[name] != null) continue
          const found = await nativeProbe(selector)
          if (found == null) visible = false
          else geometry[name] = found
        }
        let focused = expected.focused !== true
        if (expected.focused === true && !ios)
          focused =
            (await nativeProbe({ id: 'chat-composer', focused: true })) != null
        const cancel = nodes.find(n => n.text === 'Cancel reply')
        let reply =
          expected.reply == null || (!expected.reply && cancel == null)
        if (expected.reply === true) {
          const found = await nativeProbe({
            text: ios ? 'Cancel reply' : exactText('Cancel reply')
          })
          reply = found != null
          if (found != null) geometry.reply = found
        }
        let keyboard = expected.focused !== true || positive != null
        if (expected.focused === true && !ios) {
          const container = nodes.find(
            n => /keyboard/i.test(n.type ?? '') && n.bounds != null
          )
          if (container?.bounds != null) {
            geometry.keyboard = container.bounds
            keyboard = true
          } else {
            keyboard = true
            for (const key of ['q', 'w', 'e']) {
              const found = await nativeProbe({
                text: '^[' + key + key.toUpperCase() + ']$'
              })
              if (found == null) keyboard = false
              else geometry['key-' + key] = found
            }
          }
        }
        if (ios && visible) {
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
          const bytes = Buffer.from(
            await device.screenshot({
              signal: AbortSignal.timeout(remaining())
            })
          )
          const raster = captureRaster(bytes)
          assert(
            raster.width > 0 && raster.height > 0,
            'Positive native screenshot dimensions required'
          )
          sample.image = {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.length,
            ...raster
          }
        }
        eligible =
          overlays.length === 0 &&
          visible &&
          (ios ? expected.focused !== true || positive != null : focused) &&
          reply &&
          keyboard &&
          (!ios || sample.rawPairStable === true)
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
        image: ui.surface === 'ios' ? sample.raster : sample.image
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

export class Scenarios {
  readonly group: string
  readonly viewerKey: string
  readonly viewerId: number
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
      45000
    )
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

  async run(name: Chat2Scenario): Promise<void> {
    await this[name]()
  }

  async check(name: string, action: () => Promise<void>): Promise<void> {
    await this.ui.step(name, action)
  }

  async signIn(key = this.viewerKey): Promise<void> {
    const ui = this.ui
    const m = ui.device
    const actor = this.f.actors[key]
    await ui.open('/chat')
    if (await ui.visible({ text: '^Account,.*$' }, 500)) {
      await m.tapOn({ text: '^Account,.*$' })
      if (await ui.visible({ text: exactText(actor.email) }, 2000))
        await ui.back()
      else {
        requireAfterArchive(this.f)
        await m.scrollUntilVisible({
          element: { text: exactText('Sign out') },
          direction: 'DOWN',
          timeout: 15000
        })
        await ui.text('Sign out')
        await m.assertVisible({ text: exactText('Sign in'), timeout: 15000 })
        this.observations.push({
          normalPublicSignOut: true,
          matchedAfterArchiveVerified: true,
          providerKeysReset: false
        })
        await ui.open('/chat')
      }
    }
    this.observations.push(await submitPasswordSignIn(ui, actor))
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
    if (await ui.visible({ text: 'Link this device' }, 500)) {
      const provider = await fixturePeer(this.f, key)
      try {
        await provider.approvePending()
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

  async openGroup(id = this.group): Promise<void> {
    await this.ui.open('/chat/' + encodeURIComponent(id))
    await this.ui.present('chat-message-history')
  }

  async anchor(target = this.f.messages.target): Promise<void> {
    const ui = this.ui
    if (await ui.visible({ id: 'chat-pinned-summary' }, 1000)) {
      await ui.id('chat-pinned-summary')
      if (await ui.visible({ text: exactText('Pinned messages') }, 1000))
        if (await ui.visible({ id: 'chat-pin-' + target.id }, 500))
          await ui.id('chat-pin-' + target.id)
        else await ui.text('Cancel')
    }
    if (!(await ui.visible({ id: 'chat-bubble-' + target.id }, 1000))) {
      await ui.device.scrollUntilVisible({
        element: { id: 'chat-bubble-' + target.id },
        direction: 'UP',
        timeout: 30000
      })
    }
    await ui.present('chat-bubble-' + target.id)
    if (!ui.native)
      await ui.dom(
        `const n=document.querySelector(${JSON.stringify('[data-testid="chat-bubble-' + target.id + '"]')}); if(!n)throw Error('Visible target required');n.scrollIntoView({block:'center'});return {publicDomScroll:true}`
      )
  }

  async targetBounds(id: string): Promise<NonNullable<PublicNode['bounds']>> {
    return await this.ui.publicBounds(id)
  }

  async action(
    target: Chat2Message,
    method: 'hold' | 'hover' | 'swipe' = 'hold'
  ): Promise<void> {
    const ui = this.ui
    await this.anchor(target)
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
      await ui.device.longPressOn({
        id: 'chat-bubble-' + target.id,
        duration: 550
      })
      await ui.device.assertVisible({ text: exactText('Reply'), timeout: 5000 })
    }
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

  async cancelReply(): Promise<void> {
    if (await this.ui.visible({ text: exactText('Cancel reply') }, 500))
      await this.ui.text('Cancel reply')
  }

  async peerMessage(
    body: string,
    options: { quoteId?: string; mentions?: number[] } = {},
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

  async attachPhoto(): Promise<void> {
    const ui = this.ui
    const files = need(this.f.files, 'Synthetic attachment fixture required')
    if (!ui.native) {
      await ui.device.uploadFile({
        css: 'input[type="file"]',
        path: files.photo
      })
    } else {
      await ui.device.addMedia({ files: [files.photo] })
      await ui.text('Attach')
      await ui.text('Photo library')
      for (const selector of need(
        files.nativePicker?.[ui.surface],
        'Observed public native photo-picker selectors required'
      ))
        await ui.device.tapOn(selector)
    }
    await ui.present('chat-attachment-chip')
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
    const selector = { text: exactText('Safety number with ' + member.name) }
    await ui.device.scrollUntilVisible({
      element: selector,
      direction: 'DOWN',
      timeout: 15000
    })
    if (!ui.native)
      await ui.dom(
        `const n=document.querySelector(${JSON.stringify('[aria-label="Safety number with ' + member.name + '"]')});if(!n)throw Error('Actual member safety row required');n.scrollIntoView({block:'center'});return {publicMemberScroll:true}`
      )
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
          : (await ui.device.copyTextFrom({ text: exactText(name) })).element
              ?.bounds,
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
              ? await ui.observedBounds({ text: exactText(label) }, 'Button')
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
      const result = spawnSync(
        process.env.CHAT2_ADB ?? 'adb',
        ['-s', ui.deviceId, 'shell', 'dumpsys', 'window', 'InputMethod'],
        { encoding: 'utf8', timeout: 5000 }
      )
      diagnostic = join(ui.runDir, 'android-ime-window.txt')
      writeFileSync(diagnostic, result.stdout ?? '', { mode: 0o600 })
      if (result.status === 0 && !result.stdout.includes('mInputShown=false')) {
        const match =
          /mFrame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(result.stdout) ??
          (result.stdout.includes('isOnScreen=true')
            ? /touchable region=SkRegion\(\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)\)/.exec(
                result.stdout
              )
            : null)
        if (match != null) {
          const [x, y, right, bottom] = match.slice(1).map(Number)
          if (right > x && bottom > y) {
            keyboard = { x, y, width: right - x, height: bottom - y }
            keyboardMethod =
              'Read-only exact-owned-serial OS InputMethod window frame; Maestro UIA parser strategy'
          }
        }
      }
    }
    const keys: Box[] = []
    if (ui.surface === 'ios')
      assert(
        keyboard != null,
        'Actual positive iOS Keyboard container required'
      )
    if (keyboard == null)
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
    if (!this.ui.native) await this.ui.device.pressKey({ key: 'ESC' })
    else if (
      this.ui.surface === 'ios' &&
      (await this.ui.visible({ text: exactText('Cancel') }, 500))
    )
      await this.ui.text('Cancel')
    else await this.ui.back()
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

  async E1(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E1 list identity, blank preview and row reachability',
      async () => {
        await this.signIn()
        await ui.device.assertVisible({ text: exactText('Chats') })
        for (const text of [
          'Follow a team',
          'No messages yet',
          'Loading latest message...'
        ])
          await ui.device.assertNotVisible({
            text: exactText(text),
            timeout: 3000
          })
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
        await ui.device.assertVisible({ text: exactText(body), timeout: 30000 })
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
        await ui.append(body)
        await this.attachPhoto()
        await this.cancelReply()
        assert.equal(await ui.draft(), body)
        await ui.present('chat-attachment-chip')
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
        await ui.text('Retry')
        const received = await this.delivered(body)
        assert.equal(received.quote?.id, this.f.messages.target.id)
        assert.equal(received.attachments.length, 1)
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
              text: exactText('Safety number with ' + member.name),
              childOf: { id: 'chat-info-members' }
            },
            'Button'
          )
          await ui.tapObserved(row)
        } else
          await ui.device.tapOn({
            text: exactText('Safety number with ' + member.name)
          })
        await ui.device.assertVisible({
          text: 'Safety number.*',
          timeout: 10000
        })
        await ui.back()
        await ui.back()
        assert.equal(await ui.draft(), before)
        await ui.open('/chat/' + this.group + '/members')
        await ui.present('chat-info-members')
        await ui.back()
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

  async E5(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E5 incoming/outgoing/long/file spotlight actions and dismissal',
      async () => {
        await this.openGroup()
        if (ui.native) await ui.hideKeyboard()
        for (const message of [
          need(this.f.messages.incoming, 'Incoming fixture required'),
          need(this.f.messages.outgoing, 'Outgoing fixture required'),
          this.f.messages.long,
          need(this.f.messages.file, 'Encrypted file message fixture required')
        ]) {
          let incomingLane: unknown
          if (message.authorId !== this.viewerId) {
            await this.anchor(message)
            incomingLane = await this.targetBounds(
              'chat-avatar-lane-' + message.id
            )
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
          )
            await ui.shot(
              'message-actions',
              this.touchActions
                ? 'Actual sharp coordinated spotlight over blur; static composition proof only'
                : 'Actual desktop hover and filtered More menu; spotlight not applicable'
            )
          await this.dismiss()
          await ui.absent('chat-message-spotlight')
        }
      }
    )
    await this.check(
      'E5 partially scrolled tall source keeps selected preview bounded and reader unchanged',
      async () => {
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
        } else {
          for (let step = 0; step < 8; step++) {
            const b = await this.targetBounds('chat-bubble-' + target.id)
            if (b.y < top - 12 && b.y + b.height > top + 40) break
            await ui.measuredSwipe({
              startX: Math.round(b.x + b.width / 2),
              startY: Math.round(bottom - 12),
              endX: Math.round(b.x + b.width / 2),
              endY: Math.round(top + 12),
              duration: 350
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
      }
    )
    await this.check(
      'E5 movement before hold cancels; reaction and personal pin remain usable',
      async () => {
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
          await ui.device.dragAndDrop({
            from: { point: `${b.x + 10},${b.y + 10}` },
            to: { point: `${b.x + 10},${b.y + 70}` },
            holdDuration: 50,
            duration: 200
          })
        await ui.absent('chat-message-spotlight')
        if (this.touchActions) {
          await this.action(this.f.messages.target)
          await ui.text('👍')
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
          await ui.device.tapOn({ text: exactText('thumbs up') })
        }
        await ui.absent('chat-message-spotlight')
        const peer = await this.protocolPeer()
        const view = await peer.engine.open(this.group)
        assert(
          view.messages
            .find(m => m.id === this.f.messages.target.id)
            ?.reactions.some(r => r.emoji === '👍') === true
        )
      }
    )
    await this.check(
      'E5 actual Copy, personal pin and allowed fresh own Delete',
      async () => {
        const client = await this.client()
        const target = this.f.messages.target
        await ui.clipboardSentinel('A disposable clipboard sentinel')
        await this.action(target)
        await ui.text(this.copyLabel)
        await ui.replaceDraft('')
        await ui.pasteClipboard()
        assert.equal(
          await ui.draft(),
          target.body,
          'Copy must place the real message text on clipboard'
        )
        await ui.replaceDraft('')
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
        const before = await this.targetBounds(
          'chat-bubble-' + this.f.messages.target.id
        )
        await this.action(this.f.messages.target)
        const spotlight = await this.menuState()
        for (const label of this.touchActions
          ? ['Reply', this.copyLabel]
          : [this.copyLabel])
          await ui.device.scrollUntilVisible({
            element: { text: exactText(label) },
            direction: 'DOWN',
            timeout: 5000
          })
        await ui.shot(
          'keyboard-spotlight',
          ui.native
            ? 'Actual keyboard-open bounded controls and optional compact preview; no automatic keyboard dismiss or motion claim'
            : this.touchActions
              ? 'Actual focused web composer and touch spotlight controls; no software keyboard claim'
              : 'Actual focused web composer and desktop More menu; no software keyboard or touch spotlight claim'
        )
        await this.dismiss()
        await ui.assertKeyboard()
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

  async E6(): Promise<void> {
    const ui = this.ui
    await this.check(
      'E6 personal floating pins, verified clear target and same-user state',
      async () => {
        await this.openGroup()
        await this.anchor()
        const client = await this.client()
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
        await ui.text(this.f.messages.target.body)
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
          await ui.id('chat-pin-' + oldest.id)
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
          await ui.id('chat-pin-' + oldest.id)
          await this.waitEvent(
            this.group,
            deferred,
            e => e.type === 'fault-matched'
          )
          await ui.device.swipe({ direction: 'DOWN', duration: 250 })
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
        await ui.append('@')
        await ui.device.assertVisible({ text: exactText('Mention a member') })
        this.observations.push(await observeMentionHeader(ui))
        const members = this.f.members.filter(m => m.userId !== this.viewerId)
        const first = need(members[0], 'Mention member fixtures required')
        assert(
          members.some(m => m.userId !== first.userId && m.name === first.name),
          'Duplicate-name current members required'
        )
        await ui.text('Search members')
        await ui.append(first.search)
        await ui.present('chat-mention-member-' + first.userId)
        await ui.shot(
          'mentions',
          'Actual searched member chooser with stable public member IDs'
        )
        await ui.id('chat-mention-member-' + first.userId)
        await ui.assertKeyboard()
        assert((await ui.draft()).includes('@' + first.name))
        await ui.shot(
          'mention-composer',
          'Actual readable selected mention token and focused composer'
        )
        await ui.append(' synthetic mention ' + Date.now())
        const body = await ui.draft()
        await this.attachPhoto()
        await ui.text('Send')
        const received = await this.delivered(body)
        assert.deepEqual(received.mentions, [first.userId])
        assert.equal(received.attachments.length, 1)
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
        await ui.replaceDraft('@')
        await ui.text('Cancel')
        assert.equal(await ui.draft(), '@')
        await ui.replaceDraft('@')
        await ui.id('chat-mention-member-' + this.f.members[0].userId)
        await ui.deleteBackward()
        await ui.deleteBackward()
        const body = (await ui.draft()) + ' edited token ' + Date.now()
        await ui.append(' edited token ' + body.split(' edited token ')[1])
        await this.withFault('send', async () => {
          await ui.text('Send')
          await ui.device.assertVisible({
            text: 'That did not send.*',
            timeout: 15000
          })
        })
        await ui.replaceDraft('A newer synthetic draft')
        await ui.text('Retry')
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
        await ui.device.assertNotVisible({
          id: 'chat-composer',
          enabled: true,
          timeout: 3000
        })
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
        await ui.device.assertNotVisible({
          id: 'chat-composer',
          enabled: true,
          timeout: 3000
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
          await ui.device.pressKey({ key: 'ENTER' })
          const received = await this.delivered(expected)
          assert.equal(received.attachments.length, 1)
        } else {
          await this.attachPhoto()
          const expected = await ui.draft()
          await ui.text('Send')
          assert.equal((await this.delivered(expected)).attachments.length, 1)
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
        const client = await this.client()
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
        await assert.rejects(
          async () =>
            await client.createChatAttachment({
              conversationId: this.group,
              size: 101 * 1024 * 1024,
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
        await ui.append('Keep a multiline\nreader draft')
        await this.attachPhoto()
        if (ui.native) await ui.hideKeyboard()
        const draft = await ui.draft()
        const before = await this.targetBounds(
          'chat-bubble-' + this.f.messages.target.id
        )
        await this.openInfo()
        await ui.back()
        assert.equal(await ui.draft(), draft)
        await ui.present('chat-attachment-chip')
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
          const beforeResize = await this.targetBounds(
            'chat-bubble-' + this.f.messages.target.id
          )
          const metrics = ui.metrics()
          await ui.resize(
            metrics.width === 1440 ? 390 : 1440,
            metrics.width === 1440 ? 844 : 1000
          )
          await ui.present('chat-bubble-' + this.f.messages.target.id)
          assert.equal(await ui.draft(), draft)
          await ui.resize(metrics.width, metrics.height)
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
          await ui.device.swipe({ direction: 'DOWN', duration: 500 })
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
        await ui.present('chat-attachment-chip')
        await ui.id('chat-jump-latest')
        await ui.present('chat-jump-latest')
        await this.cancelReply()
      }
    )
    await this.check(
      'E9 ordinary shared chrome routes return to selected chat',
      async () => {
        for (const label of ['Home', 'Videos', 'Schedule']) {
          const tab = (await ui.nodes()).find(
            n => n.text === label && n.bounds != null
          )
          await ui.tapObserved(
            need(tab, 'Public shared-shell tab fixture missing: ' + label)
          )
          const chat = (await ui.nodes()).find(
            n => n.text === 'Chat' && n.bounds != null
          )
          await ui.tapObserved(need(chat, 'Public Chat tab required'))
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
          await ui.present('chat-message-body-' + posted.targets[index].id)
          const body = await this.targetBounds(
            'chat-message-body-' + posted.targets[index].id
          )
          const band = await this.readingBand()
          assert(
            body.y >= band.top - 2 &&
              body.y + Math.min(body.height, 40) < band.bottom,
            'Jump target leading body must be exposed below header/pins and above composer/keyboard'
          )
          await this.expectCount(2 - index)
          this.observations.push({
            attentionStep: index + 1,
            target: posted.targets[index].id,
            body,
            unobscuredReader: band,
            remaining: 2 - index
          })
        }
        await ui.present('chat-jump-latest')
        await ui.id('chat-jump-latest')
        await ui.present('chat-bubble-' + posted.targets[2].id)
        await ui.present('chat-jump-latest')
        await this.anchor(loop.readerAnchor)
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
          const before = await this.targetBounds(
            'chat-bubble-' + fixture.neutralTail.id
          )
          const reads = await this.stableReads(conversation)
          fixtureControl(this.f, 'clear-fault')
          await this.classification()
          const after = await this.targetBounds(
            'chat-bubble-' + fixture.neutralTail.id
          )
          assert(
            Math.abs(before.y - after.y) <= 3,
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
          await this.expectCount(fixture.expectedCount)
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
          const body = await this.targetBounds(
            'chat-bubble-' + fixture.neutralTail.id
          )
          fixtureControl(this.f, 'clear-fault')
          await ui.id(this.controlId('attentionRetry'))
          await this.classification()
          assert.equal(await ui.draft(), 'Keep retry state')
          const again = await this.targetBounds(
            'chat-bubble-' + fixture.neutralTail.id
          )
          assert(
            Math.abs(again.y - body.y) <= 3,
            'Discovery Retry must preserve reader'
          )
          await this.anchor(fixture.readerAnchor)
          await this.expectCount(fixture.expectedCount)
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
          await ui.back()
          await ui.present('chat-conversation-list')
          fixtureControl(this.f, 'clear-fault')
          await ui.present('chat-conversation-list')
          await ui.id('chat-conversation-' + conversation)
          await this.classification()
          assert.equal(await ui.draft(), 'Keep cancelled verification draft')
          await this.anchor(fixture.readerAnchor)
          await this.expectCount(fixture.expectedCount)
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
          await ui.present('chat-bubble-' + fixture.neutralTail.id)
          await ui.replaceDraft('Keep terminal empty draft')
          if (ui.native) await ui.hideKeyboard()
          const body = await this.targetBounds(
            'chat-bubble-' + fixture.neutralTail.id
          )
          const start = Number(this.snapshot(conversation).lastEvent)
          fixtureControl(this.f, 'fault', {
            phase: 'history-jump',
            mode: 'empty',
            viewerId: this.viewerId,
            conversationId: conversation
          })
          await ui.id('chat-pinned-summary')
          await ui.id('chat-pin-' + fixture.ownOriginal.id)
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
          const after = await this.targetBounds(
            'chat-bubble-' + fixture.neutralTail.id
          )
          assert(
            Math.abs(after.y - body.y) <= 3,
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
        await ui.append(probe)
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
          const recording =
            variant === 'light' || variant === 'reduced-motion'
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
          await ui.replaceDraft('@')
          await ui.device.assertVisible({ text: exactText('Mention a member') })
          this.observations.push(await observeMentionHeader(ui))
          const member = need(
            this.f.members.find(m => m.userId !== this.viewerId),
            'Current mention member required'
          )
          await ui.present('chat-mention-member-' + member.userId)
          await ui.shot(
            variant + '-mentions',
            'Actual ' + variant + ' chooser row reachability and Cancel'
          )
          await ui.id('chat-mention-member-' + member.userId)
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
          await ui.replaceDraft('')
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
    if (ui.native) await ui.hideKeyboard()
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
    if (ui.native) await ui.hideKeyboard()
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
    await ui.replaceDraft('@')
    await ui.device.assertVisible({ text: exactText('Mention a member') })
    this.observations.push(await observeMentionHeader(ui))
    await ui.shot('mentions', 'Actual mention chooser before selection')
    const member = need(
      this.f.members.find(m => m.userId !== this.viewerId),
      'Current member required'
    )
    await ui.id('chat-mention-member-' + member.userId)
    this.observations.push(
      await observeComposerCaptureReady(ui, { focused: true, reply: false })
    )
    await ui.shot(
      'mention-composer',
      'Actual selected readable mention and focused composer'
    )
    if (ui.native) await ui.hideKeyboard()
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
      CHAT2_SCENARIOS.includes(command as Chat2Scenario),
    'Unknown chat2 scenario'
  )
  const ui = new Chat2UI(fixture, surface, command)
  const scenarios = new Scenarios(fixture, ui)
  let outcome: 'passed' | 'failed' | 'blocked' = 'failed'
  let failure: unknown
  const completed: Chat2Scenario[] = []
  const allScenarios = [scenarios]
  try {
    fixtureControl(fixture, 'prepare', { surface, source: ui.binding.source })
    await ui.start()
    if (command === 'capture') await scenarios.capture()
    else if (command === 'variants') await scenarios.variants()
    else {
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
