/**
 * An id another system has for a row here, as every route that takes one
 * reads it: `POST /teams` and the routes that add a team's people. Shared by
 * the server and any client, so both refuse the same ids with the same words.
 */

/** One id another system has for a row here. */
export interface ExternalIdBody {
  /** Matches `EXTERNAL_ID_SYSTEM_PATTERN`, which the table's check holds too. */
  system: string
  kind: string
  id: string
}

/** The rule `external_ids.system` holds everywhere. */
export const EXTERNAL_ID_SYSTEM_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/

/**
 * The external id at `at` in a body, or a `TypeError` naming the field that
 * is wrong: `system` matching the pattern, `kind` and `id` non-empty.
 */
export function asExternalIdAt(raw: unknown, at: string): ExternalIdBody {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    throw new TypeError(`${at} must be an object`)
  }
  const { system, kind, id } = raw as Record<string, unknown>
  if (typeof system !== 'string' || !EXTERNAL_ID_SYSTEM_PATTERN.test(system)) {
    throw new TypeError(`${at}.system must match ^[a-z][a-zA-Z0-9]{0,31}$`)
  }
  if (typeof kind !== 'string' || kind === '') {
    throw new TypeError(`${at}.kind must be a non-empty string`)
  }
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`${at}.id must be a non-empty string`)
  }
  return { system, kind, id }
}
