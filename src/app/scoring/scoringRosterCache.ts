import type { RosterEntry } from '../../common/api'

/** Clear private presentation data as soon as the current role cannot read it. */
export function withoutPrivateNames(
  rows: readonly RosterEntry[]
): RosterEntry[] {
  return rows.map(row => ({ ...row, nameDetails: undefined }))
}
