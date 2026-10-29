/** Object names emitted by the live writer; temporary files are never public. */
export function isSegmentName(name: string): boolean {
  return /^seg\d{6,}\.m4s$/.test(name)
}

export function objectKey(videoId: string, name: string): string {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(videoId) ||
    (!isSegmentName(name) &&
      !['init.mp4', 'index.m3u8', 'master.m3u8'].includes(name))
  )
    throw new Error('Invalid live object name')
  return `videos/${videoId}/${name}`
}

/**
 * Publish the acknowledged prefix, retaining every segment already exposed.
 * A restamp can invalidate an acknowledgement but cannot retract its URI:
 * the previous object remains playable until its replacement is verified.
 */
export function publishedPlaylist(
  onDisk: string,
  acknowledged: ReadonlySet<string>,
  published: ReadonlySet<string>
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
  const names = new Set(segments.map(segment => segment.name))
  for (const name of published)
    if (!names.has(name))
      throw new Error('Local playlist lost a published segment')
  let acknowledgedEnd = 0
  while (
    acknowledgedEnd < segments.length &&
    acknowledged.has(segments[acknowledgedEnd].name)
  )
    acknowledgedEnd++
  let publishedEnd = 0
  for (const [index, segment] of segments.entries())
    if (published.has(segment.name)) publishedEnd = index + 1
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
