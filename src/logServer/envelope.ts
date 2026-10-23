import type { AppCode, EventRecord } from '../common/observability/contract'
import { errorRecord } from '../common/observability/errors'

/** Parse by bytes: native envelope lengths count UTF-8 bytes, not JS characters. */
export function envelope(
  buffer: Buffer,
  app: AppCode,
  now = Date.now()
): EventRecord[] {
  if (buffer.length > 262144) throw new Error('Envelope too large')
  let at = 0
  function line(): unknown {
    const end = buffer.indexOf(10, at)
    if (end < 0) throw new Error('Missing envelope header newline')
    const value = JSON.parse(buffer.subarray(at, end).toString('utf8'))
    at = end + 1
    return value
  }
  const header = line()
  if (header == null || typeof header !== 'object' || Array.isArray(header))
    throw new Error('Invalid envelope header')
  const rows: EventRecord[] = []
  while (at < buffer.length) {
    const item = line() as { type?: unknown; length?: unknown }
    if (item?.type !== 'event') throw new Error('Unsupported envelope item')
    let end: number
    if (item.length != null) {
      if (
        typeof item.length !== 'number' ||
        !Number.isInteger(item.length) ||
        item.length < 1 ||
        item.length > 262144
      )
        throw new Error('Invalid envelope length')
      end = at + item.length
      if (end > buffer.length || (end < buffer.length && buffer[end] !== 10))
        throw new Error('Invalid envelope boundary')
    } else {
      end = buffer.indexOf(10, at)
      if (end < 0) end = buffer.length
    }
    const raw = JSON.parse(buffer.subarray(at, end).toString('utf8'))
    rows.push(errorRecord(raw, app, now))
    at = end + (buffer[end] === 10 ? 1 : 0)
    if (rows.length > 50) throw new Error('Too many envelope items')
  }
  if (rows.length === 0) throw new Error('Empty envelope')
  return rows
}
