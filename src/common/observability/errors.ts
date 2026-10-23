import {
  type AppCode,
  codeFile,
  errorClass,
  type EventRecord,
  parseEvent
} from './contract'
type Bag = Record<string, unknown>
const bag = (value: unknown): Bag =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Bag)
    : {}

/** SDK event reconstruction. No raw messages, locals, contexts, breadcrumbs or user metadata. */
export function safeErrorEvent(input: unknown): Bag {
  const raw = bag(input)
  const stamp =
    typeof raw.timestamp === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(raw.timestamp)
      ? Date.parse(raw.timestamp) / 1000
      : raw.timestamp
  const values = bag(raw.exception).values
  const error = bag(
    Array.isArray(values) ? values[values.length - 1] : undefined
  )
  const frames = bag(error.stacktrace).frames
  const safeFrames: Bag[] = []
  if (Array.isArray(frames))
    for (const frame of frames.slice(-32)) {
      const row = bag(frame)
      const path =
        typeof row.filename === 'string'
          ? row.filename.replace(/\\/g, '/')
          : undefined
      // Retain only a catalogued public module suffix, never its host/root path.
      // The canonical form also survives the collector's second reconstruction.
      const module = path
        ?.match(/(?:^|\/)server\/[^?#]*\.js$/)?.[0]
        .replace(/^\//, '')
      const filename = codeFile(module) ? module : path?.split('/').pop()
      if (
        codeFile(filename) &&
        typeof row.lineno === 'number' &&
        Number.isInteger(row.lineno) &&
        row.lineno > 0 &&
        row.lineno <= 1000000
      )
        safeFrames.push({
          filename,
          lineno: row.lineno,
          ...(typeof row.colno === 'number' &&
          Number.isInteger(row.colno) &&
          row.colno >= 0 &&
          row.colno <= 100000000
            ? { colno: row.colno }
            : {})
        })
    }
  return {
    event_id:
      typeof raw.event_id === 'string' && /^[a-f0-9]{32}$/i.test(raw.event_id)
        ? raw.event_id.toLowerCase()
        : undefined,
    timestamp:
      typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : undefined,
    release:
      typeof raw.release === 'string' &&
      /^(?:app\.teamstation\.(?:app|web|director|cameraman|distributor)|teamstation-server)@[0-9][0-9A-Za-z.+_-]{0,63}$/.test(
        raw.release
      )
        ? raw.release
        : undefined,
    level: raw.level === 'fatal' ? 'fatal' : 'error',
    exception: {
      values: [
        {
          type: errorClass(error.type) ? error.type : 'Error',
          value: 'internal',
          stacktrace: { frames: safeFrames.slice(-3) }
        }
      ]
    }
  }
}

export function errorRecord(
  raw: unknown,
  app: AppCode,
  now = Date.now()
): EventRecord {
  const event = safeErrorEvent(raw)
  const id = typeof event.event_id === 'string' ? event.event_id : ''
  const I = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
  const details = (
    event.exception as {
      values: Array<{
        type: string
        stacktrace: {
          frames: Array<{ filename: string; lineno: number; colno?: number }>
        }
      }>
    }
  ).values[0]
  const P: Record<string, string | number> = {
    op: 'other',
    ec: 'internal',
    c: details.type
  }
  details.stacktrace.frames.forEach((frame, index) => {
    P['f' + index] = frame.filename
    P['l' + index] = frame.lineno
    if (frame.colno !== undefined) P['c' + index] = frame.colno
  })
  return parseEvent(
    {
      D: new Date(
        typeof event.timestamp === 'number' ? event.timestamp * 1000 : now
      ).toISOString(),
      A: app,
      I,
      E: 'app_error',
      L: event.level,
      R: 1,
      P,
      ...(typeof event.release === 'string'
        ? { V: event.release.split('@')[1] }
        : {})
    },
    now
  )
}
