/** A decimal wire cursor, never rounded through JavaScript Number. */
export function asChatBoxCursor(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(raw) ||
    BigInt(raw) > 9223372036854775807n
  )
    throw new TypeError('Expected a nonnegative bigint cursor')
  return raw
}

export interface ChatHistorySegment {
  start: number
  end: number
  closed: boolean
}

/** Signed metadata must be validated before these ranges authorize sharing. */
export function chatHistorySegments(
  epochs: ReadonlyArray<{
    epoch: number
    previousKeyBox: unknown | null
    chainBreak: boolean
  }>
): ChatHistorySegment[] {
  const segments: ChatHistorySegment[] = []
  for (let index = 0; index < epochs.length; index++) {
    const row = epochs[index]
    if (
      row.epoch !== index + 1 ||
      (row.epoch === 1
        ? row.previousKeyBox !== null || row.chainBreak
        : row.chainBreak !== (row.previousKeyBox === null))
    ) {
      throw new TypeError('Invalid epoch chain metadata')
    }
    if (row.epoch === 1 || row.chainBreak) {
      const previous = segments.at(-1)
      if (previous != null) previous.closed = true
      segments.push({ start: row.epoch, end: row.epoch, closed: false })
    } else segments[segments.length - 1].end = row.epoch
  }
  return segments
}

/** A later key reaches only the earlier epochs in its own segment. */
export function highestHistoryKey(
  segment: Pick<ChatHistorySegment, 'start' | 'end'>,
  heldEpochs: Iterable<number>,
  coveredThrough = segment.start - 1
): number | undefined {
  let highest: number | undefined
  for (const epoch of heldEpochs) {
    if (
      Number.isInteger(epoch) &&
      epoch >= segment.start &&
      epoch <= segment.end &&
      epoch > coveredThrough &&
      (highest == null || epoch > highest)
    )
      highest = epoch
  }
  return highest
}
