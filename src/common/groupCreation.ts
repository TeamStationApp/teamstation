import { type AccountPicture, asAccountName } from './accountSettings'
import { asLocality, type Locality } from './locality'
import { asCatalogId } from './pictureCatalog'

export type GroupKind = 'league' | 'season' | 'team'
export interface GroupRef {
  kind: GroupKind
  id: string
}
export interface GroupPicture {
  catalogId?: string
  image?: AccountPicture
  initials?: boolean
}
export interface CreateGroup {
  kind: GroupKind
  name: string
  locality?: Locality
  startsOn?: string
  endsOn?: string
  timezone?: string
  parent?: GroupRef
  external?: boolean
  custodian?: GroupRef
  picture?: GroupPicture
  idempotencyKey: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
export function asGroupKind(value: unknown): GroupKind {
  if (value !== 'league' && value !== 'season' && value !== 'team')
    throw new TypeError('Choose league, season or team')
  return value
}
export function asGroupRef(value: unknown): GroupRef {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id === '' ||
    value.id.length > 100
  )
    throw new TypeError('Choose a valid group')
  return { kind: asGroupKind(value.kind), id: value.id }
}
export function asCalendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new TypeError('Choose a calendar date')
  const date = new Date(value + 'T12:00:00Z')
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new TypeError('Choose a valid calendar date')
  return value
}

/** PostgreSQL date readers may return a local-midnight Date rather than text. */
export function calendarDateText(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value.slice(0, 10)
  if (value instanceof Date)
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  throw new TypeError('Invalid stored calendar date')
}
export function asCreateGroup(raw: unknown): CreateGroup {
  if (!isRecord(raw)) throw new TypeError('Enter the group details')
  const kind = asGroupKind(raw.kind)
  const name = asAccountName(raw.name)
  if (
    typeof raw.idempotencyKey !== 'string' ||
    raw.idempotencyKey.length < 8 ||
    raw.idempotencyKey.length > 120
  )
    throw new TypeError('Creation needs a retry key')
  const result: CreateGroup = { kind, name, idempotencyKey: raw.idempotencyKey }
  // A placeholder team may be named before anybody knows where it plays.
  if (
    kind !== 'season' &&
    !(kind === 'team' && raw.external === true && raw.locality == null)
  )
    result.locality = asLocality(raw.locality)
  if (kind === 'season') {
    result.startsOn = asCalendarDate(raw.startsOn)
    result.endsOn = asCalendarDate(raw.endsOn)
    if (result.endsOn < result.startsOn)
      throw new TypeError('End date must not precede start date')
    if (typeof raw.timezone !== 'string')
      throw new TypeError('Choose a timezone')
    try {
      new Intl.DateTimeFormat('en', { timeZone: raw.timezone }).format()
    } catch {
      throw new TypeError('Choose a valid timezone')
    }
    result.timezone = raw.timezone
  }
  if (raw.parent != null) {
    result.parent = asGroupRef(raw.parent)
    if (
      kind === 'league' ||
      (kind === 'season' && result.parent.kind !== 'league') ||
      result.parent.kind === 'team'
    )
      throw new TypeError('That kind of parent is not supported')
  }
  if (raw.external === true) {
    if (kind !== 'team' || raw.parent != null)
      throw new TypeError(
        'Placeholder custody is separate from management parents'
      )
    result.external = true
    result.custodian = asGroupRef(raw.custodian)
  } else if (raw.custodian != null)
    throw new TypeError('Only placeholder teams have a custodian')
  if (raw.picture != null) {
    if (
      !isRecord(raw.picture) ||
      (raw.picture.catalogId != null && raw.picture.image != null)
    )
      throw new TypeError('Choose one picture')
    if (raw.picture.catalogId != null)
      result.picture = { catalogId: asCatalogId(raw.picture.catalogId) }
    else if (raw.picture.image != null)
      result.picture = { image: raw.picture.image as AccountPicture }
    else if (raw.picture.initials === true) result.picture = { initials: true }
  }
  return result
}
