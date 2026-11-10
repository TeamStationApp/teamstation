import type { RosterEntry } from '../../common/api'

/**
 * Clear the private presentation data of a roster read without the right to
 * it. What the server names in `shortName` stays: it named the read's reader.
 */
export function withoutPrivateNames(
  rows: readonly RosterEntry[]
): RosterEntry[] {
  return rows.map(row => ({ ...row, nameDetails: undefined }))
}

/**
 * A roster entry held from an earlier read, as a reader who may no longer
 * read its full name reads it: no `nameDetails`, and a `shortName` full only
 * for that earlier reader (`nameFormat`) replaced by the public label kept
 * beside it (`compactName`, in `compactFormat`).
 */
export function publicRosterEntry(row: RosterEntry): RosterEntry {
  const { compactName, compactFormat, nameFormat: _nameFormat, ...rest } = row
  if (compactName == null) return { ...row, nameDetails: undefined }
  return {
    ...rest,
    nameDetails: undefined,
    shortName: compactName,
    ...(compactFormat == null ? {} : { nameFormat: compactFormat })
  }
}

/**
 * Held roster rows once their reader may no longer read their full names, as
 * soon as the current role cannot read them or while it is asked again.
 */
export function withPublicNames(rows: readonly RosterEntry[]): RosterEntry[] {
  return rows.map(publicRosterEntry)
}
