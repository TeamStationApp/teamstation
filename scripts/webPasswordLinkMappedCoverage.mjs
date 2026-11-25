// Walk real source-map segments and V8 ranges in generated order. A source
// line without a segment gets no entry, even if an Istanbul converter gave
// that original line a default statement counter.
import { decodedMappings, TraceMap } from '@jridgewell/trace-mapping'

export function measuredMappedLines(map, lineLengths, scripts, wanted) {
  const mappings = decodedMappings(new TraceMap(map))
  const counts = {}
  for (const script of scripts) {
    const ranges = script.functions
      .flatMap(fn => fn.ranges)
      .sort(
        (a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset
      )
    let next = 0
    let offset = 0
    const active = []
    for (const [generatedLine, segments] of mappings.entries()) {
      for (const [column, sourceIndex, sourceLine] of segments) {
        const file = map.sources[sourceIndex]
        const line = sourceLine + 1
        if (!wanted[file]?.has(line) || column >= lineLengths[generatedLine])
          continue
        const at = offset + column
        while (next < ranges.length && ranges[next].startOffset <= at) {
          const range = ranges[next++]
          while (active.length && active.at(-1).endOffset <= range.startOffset)
            active.pop()
          active.push(range)
        }
        while (active.length && active.at(-1).endOffset <= at) active.pop()
        const range = active.at(-1)
        if (range == null) continue
        const lines = (counts[file] ??= {})
        lines[line] = Math.max(lines[line] ?? 0, range.count)
      }
      offset += lineLengths[generatedLine] + 1
    }
  }
  return counts
}
