import { isInitName } from './segmentClock'

/** Object names emitted by the live writer; temporary files are never public. */
export function isSegmentName(name: string): boolean {
  return /^seg\d{6,}\.m4s$/.test(name)
}

export function objectKey(videoId: string, name: string): string {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(videoId) ||
    (!isSegmentName(name) &&
      !isInitName(name) &&
      !['index.m3u8', 'master.m3u8'].includes(name))
  )
    throw new Error('Invalid live object name')
  return `videos/${videoId}/${name}`
}

/**
 * Publish the acknowledged prefix, retaining every segment already exposed.
 * A restamp can invalidate an acknowledgement but cannot retract its URI:
 * the previous object remains playable until its replacement is verified.
 * `published` holds sequence numbers (`segmentNumber`), which its owner keeps
 * for the whole recording without holding on to any playlist body.
 */
export function publishedPlaylist(
  onDisk: string,
  acknowledged: ReadonlySet<string>,
  published: ReadonlySet<number>
): string {
  const header: string[] = []
  const segments: Array<{ name: string; lines: string[] }> = []
  let pending: string[] = []
  let media = false
  let ended = false
  for (const line of onDisk.trimEnd().split(/\r?\n/)) {
    const text = line.trim()
    if (text === '#EXT-X-ENDLIST') {
      ended = true
      continue
    }
    if (text !== '' && !text.startsWith('#')) {
      if (!isSegmentName(text)) throw new Error('Invalid live segment URI')
      segments.push({ name: text, lines: [...pending, line] })
      pending = []
      media = true
    } else {
      if (
        /^(?:#EXTINF:|#EXT-X-DISCONTINUITY$|#EXT-X-PROGRAM-DATE-TIME:)/.test(
          text
        )
      )
        media = true
      if (media) pending.push(line)
      else header.push(line)
    }
  }
  const numbers = new Set(segments.map(segment => segmentNumber(segment.name)))
  for (const number of published)
    if (!numbers.has(number))
      throw new Error('Local playlist lost a published segment')
  let acknowledgedEnd = 0
  while (
    acknowledgedEnd < segments.length &&
    acknowledged.has(segments[acknowledgedEnd].name)
  )
    acknowledgedEnd++
  let publishedEnd = 0
  for (const [index, segment] of segments.entries())
    if (published.has(segmentNumber(segment.name))) publishedEnd = index + 1
  const end = Math.max(acknowledgedEnd, publishedEnd)
  return (
    [
      ...header,
      ...segments.slice(0, end).flatMap(segment => segment.lines),
      ...(ended && segments.length > 0 && acknowledgedEnd === segments.length
        ? ['#EXT-X-ENDLIST']
        : [])
    ].join('\n') + '\n'
  )
}

/** A piece's sequence number: `seg000042.m4s` is 42. */
export function segmentNumber(name: string): number {
  if (!isSegmentName(name)) throw new Error('Invalid live segment URI')
  return Number(name.slice(3, -4))
}

/**
 * When each piece of a playlist ends, in ms, in playlist order: its
 * `EXT-X-PROGRAM-DATE-TIME` plus its `EXTINF`, or, for a piece with no date,
 * the end of the one before it plus its `EXTINF`.
 */
export function segmentEndsMs(text: string): number[] {
  const ends: number[] = []
  let dated: number | undefined
  let duration: number | undefined
  let end = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const at = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length))
      dated = Number.isNaN(at) ? undefined : at
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice('#EXTINF:'.length))
    } else if (line !== '' && !line.startsWith('#') && duration != null) {
      end = (dated ?? end) + duration * 1000
      ends.push(end)
      dated = undefined
      duration = undefined
    }
  }
  return ends
}

/** A playlist without the pieces `drop` names, and the tags that went with them. */
export function withoutSegments(
  text: string,
  drop: (name: string) => boolean
): string {
  const kept: string[] = []
  let pending: string[] = []
  let media = false
  for (const line of text.split('\n')) {
    const value = line.trim()
    if (value !== '' && !value.startsWith('#')) {
      if (!drop(value)) kept.push(...pending, line)
      pending = []
      media = true
    } else if (
      /^(?:#EXTINF:|#EXT-X-DISCONTINUITY$|#EXT-X-PROGRAM-DATE-TIME:)/.test(
        value
      )
    ) {
      pending.push(line)
      media = true
    } else if (media) pending.push(line)
    else kept.push(line)
  }
  return [...kept, ...pending].join('\n')
}
