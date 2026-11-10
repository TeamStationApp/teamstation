import type { RosterCandidate } from '../../common/api'

/**
 * The names kept on the phone beside a queued add of `candidate`: his short
 * name by user id, and by gumbo id when he has one, so the phone's roster
 * lists him by name before the server answers. Beside a name full only for
 * this reader go its format and the public label (`nameFormat`,
 * `compactName`, `compactFormat`), which the field, the board strip and the
 * lineup QR draw.
 */
export function candidateNames(
  candidate: RosterCandidate | undefined
): Record<string, string> | undefined {
  if (candidate == null) return undefined
  return {
    [candidate.userId]: candidate.shortName,
    ...(candidate.gumboId == null
      ? {}
      : { [String(candidate.gumboId)]: candidate.shortName }),
    ...(candidate.nameFormat == null
      ? {}
      : { nameFormat: candidate.nameFormat }),
    ...(candidate.compactName == null
      ? {}
      : { compactName: candidate.compactName }),
    ...(candidate.compactFormat == null
      ? {}
      : { compactFormat: candidate.compactFormat })
  }
}
