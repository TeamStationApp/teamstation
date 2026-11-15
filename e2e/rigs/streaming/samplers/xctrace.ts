import type { Exec, MemorySample } from './sample'

/**
 * Memory on the iPad, the Apple TV and the iPhones, from Instruments' Activity Monitor
 * template: a recording attached to the app (or every process, on the iPhone that also
 * runs Safari), exported as XML and reduced to each process's physical footprint per
 * minute. The export dedupes repeated values: an element with `ref="N"` is the earlier
 * one with `id="N"`.
 */

export interface RecordOptions {
  udid: string
  /** The app to attach to; omitted for every process. */
  attach?: string
  timeLimit?: string
  output: string
}

export function recordArgs(options: RecordOptions): string[] {
  return [
    'xctrace',
    'record',
    '--template',
    'Activity Monitor',
    '--device',
    options.udid,
    ...(options.attach == null
      ? ['--all-processes']
      : ['--attach', options.attach]),
    '--time-limit',
    // xctrace takes one unit: 2h15m is refused with its usage and exit 49.
    options.timeLimit ?? '135m',
    '--output',
    options.output
  ]
}

export const PROCESS_TABLE = 'activity-monitor-process-live'

export function exportArgs(trace: string, table = PROCESS_TABLE): string[] {
  return [
    'xctrace',
    'export',
    '--input',
    trace,
    '--xpath',
    `/trace-toc/run[@number="1"]/data/table[@schema="${table}"]`
  ]
}

interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
  text: string
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** A small XML reader: elements, attributes and text, which is all the export uses. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const token =
    /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|([^<]+)/g
  for (const match of xml.matchAll(token)) {
    const [, closing, name, attrText, selfClosing, text] = match
    const top = stack[stack.length - 1]
    if (text != null) {
      top.text += decode(text)
      continue
    }
    if (name == null) continue
    if (closing === '/') {
      if (stack.length > 1) stack.pop()
      continue
    }
    const attrs: Record<string, string> = {}
    for (const attr of (attrText ?? '').matchAll(
      /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    )) {
      attrs[attr[1]] = decode(attr[2] ?? attr[3])
    }
    const element: XmlElement = { name, attrs, children: [], text: '' }
    top.children.push(element)
    if (selfClosing !== '/') stack.push(element)
  }
  return root
}

function* all(element: XmlElement): Generator<XmlElement> {
  yield element
  for (const child of element.children) yield* all(child)
}

export interface ProcessRow {
  atNs: number
  name: string
  pid: number | null
  bytes: number
}

const FOOTPRINT = [
  'memory-physical-footprint',
  'physical-footprint',
  'footprint',
  'memory-real',
  'resident-size',
  'memory'
]

/** The rows of an Activity Monitor process table: time, process, footprint. */
export function parseProcessTable(xml: string): ProcessRow[] {
  const root = parseXml(xml)
  const elements = [...all(root)]
  const schema = elements.find(e => e.name === 'schema')
  if (schema == null) throw new Error('the xctrace export has no schema')
  const columns = schema.children
    .filter(col => col.name === 'col')
    .map(
      col => col.children.find(c => c.name === 'mnemonic')?.text.trim() ?? ''
    )
  const timeAt = columns.findIndex(
    c => c === 'start' || c === 'time' || c.endsWith('start-time')
  )
  const processAt = columns.findIndex(c => c === 'process')
  const footprintAt =
    FOOTPRINT.map(name => columns.indexOf(name)).find(at => at >= 0) ?? -1
  if (timeAt < 0 || processAt < 0 || footprintAt < 0) {
    throw new Error(
      `the xctrace export lacks a column it needs: ${columns.join(', ')}`
    )
  }
  const byId = new Map<string, XmlElement>()
  for (const element of elements) {
    if (element.attrs.id != null) byId.set(element.attrs.id, element)
  }
  const resolve = (element: XmlElement): XmlElement =>
    element.attrs.ref != null
      ? (byId.get(element.attrs.ref) ?? element)
      : element
  const rows: ProcessRow[] = []
  for (const row of elements.filter(e => e.name === 'row')) {
    const cells = row.children.map(resolve)
    const time = cells[timeAt]
    const process = cells[processAt]
    const footprint = cells[footprintAt]
    if (time == null || process == null || footprint == null) continue
    if (process.name === 'sentinel' || footprint.name === 'sentinel') continue
    const label = process.attrs.fmt ?? process.text.trim()
    const named = /^(.*?)\s*\((\d+)\)\s*$/.exec(label)
    const pidCell = process.children
      .map(resolve)
      .find(child => child.name === 'pid')
    const pid =
      pidCell != null
        ? Number(pidCell.text.trim())
        : named != null
          ? Number(named[2])
          : null
    rows.push({
      atNs: Number(time.text.trim()),
      name: named != null ? named[1] : label,
      pid,
      bytes: Number(footprint.text.trim())
    })
  }
  return rows
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** One sample per process and minute: the median footprint in that minute. */
export function perMinute(
  rows: ProcessRow[],
  options: { device: string; process: string; traceStartMs: number }
): MemorySample[] {
  const groups = new Map<string, ProcessRow[]>()
  for (const row of rows) {
    const minute = Math.floor(row.atNs / 60e9)
    const key = `${row.pid ?? ''}/${minute}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()]
    .map(group => ({
      device: options.device,
      process: options.process,
      atMs: options.traceStartMs + Math.floor(group[0].atNs / 60e9) * 60_000,
      bytes: medianOf(group.map(row => row.bytes)),
      ...(group[0].pid == null ? {} : { pid: group[0].pid })
    }))
    .sort((a, b) => a.atMs - b.atMs)
}

export const WEB_CONTENT = 'com.apple.WebKit.WebContent'

/**
 * The samples a recording gives: the app's own, the process named exactly `appName`
 * (another installed app can share its name's start, as TeamStation does with
 * TeamStation Develop, and would read as relaunches of it), and
 * on an all-process recording also the WebContent process serving the game's tab, the
 * one with the largest footprint while Safari was in front.
 */
export function samplesFromExport(
  xml: string,
  options: {
    device: string
    appName: string
    traceStartMs: number
    webContent?: { during: Array<[number, number]> }
  }
): MemorySample[] {
  const rows = parseProcessTable(xml)
  const app = rows.filter(row => row.name === options.appName)
  const out = perMinute(app, {
    device: options.device,
    process: options.appName,
    traceStartMs: options.traceStartMs
  })
  if (options.webContent != null) {
    const during = options.webContent.during
    const inFront = (row: ProcessRow): boolean => {
      const at = options.traceStartMs + row.atNs / 1e6
      return during.some(([from, to]) => at >= from && at < to)
    }
    const web = rows.filter(row => row.name === WEB_CONTENT)
    const totals = new Map<number | null, number>()
    for (const row of web.filter(inFront))
      totals.set(row.pid, Math.max(totals.get(row.pid) ?? 0, row.bytes))
    const tab = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (tab !== undefined) {
      out.push(
        ...perMinute(
          web.filter(row => row.pid === tab),
          {
            device: options.device,
            process: WEB_CONTENT,
            traceStartMs: options.traceStartMs
          }
        )
      )
    }
  }
  return out
}

/** Exports a finished recording's process table through `xcrun`. */
export async function exportTrace(exec: Exec, trace: string): Promise<string> {
  return await exec('xcrun', exportArgs(trace))
}
