import assert from 'node:assert/strict'

/** Read the player's elapsed clock, never the status bar or total duration. */
export function nativePlaybackSeconds(
  raw: string,
  platform: 'ios' | 'android'
): number {
  const nodes: Array<Record<string, unknown>> = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value != null && typeof value === 'object') {
      nodes.push(value as Record<string, unknown>)
      Object.values(value).forEach(walk)
    }
  }
  if (raw.trim().startsWith('{')) walk(JSON.parse(raw))
  else {
    // Native hierarchy attributes are quoted XML strings. The elapsed clock
    // has only decimal digits and colons; no general XML decoding is needed.
    for (const tag of raw.matchAll(/<[^>]+>/g))
      nodes.push(
        Object.fromEntries(
          [...tag[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(match => [
            match[1],
            match[2]
          ])
        )
      )
  }
  const elapsed = nodes.filter(node => {
    const text = (value: unknown): string =>
      typeof value === 'string' ? value : ''
    if (node.visible === false || node.visible === 'false') return false
    if (platform === 'android')
      return /(?:^|[/:])exo_position$/.test(
        text(node['resource-id'] ?? node.identifier ?? node.id)
      )
    return /elapsed\s*time/i.test(
      [node.label, node.name, node.identifier].map(text).join(' ')
    )
  })
  assert.equal(elapsed.length, 1, 'One visible native elapsed clock required')
  const node = elapsed[0]
  const text = platform === 'android' ? node.text : node.value
  assert(typeof text === 'string', 'Native elapsed clock text required')
  assert(/^\d+:\d{2}(?::\d{2})?$/.test(text), 'Native elapsed time format')
  return text
    .split(':')
    .reduce((seconds, part) => seconds * 60 + Number(part), 0)
}
