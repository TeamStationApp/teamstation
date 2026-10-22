import { type Kysely, type Selectable, sql } from 'kysely'

import {
  badRequest,
  notFound,
  unavailable,
  unsupportedMedia
} from '../../common/errors'
import { calendarDateText } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import {
  asWeeklyHours,
  type FieldChanges,
  type FieldSize,
  type PhotoUpload,
  type VenueChanges,
  type VenueDetail,
  type VenueField,
  type VenueSummary,
  type WeekdayHours
} from '../../common/venues'
import { adminScopes } from '../access'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database, VenueFieldsTable, VenuesTable } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import { currentActor } from '../groups/rights'
import { limitGoogleLookup } from '../location/googleLookupLimits'
import type { GooglePlaces, VenuePlace } from '../location/googlePlaces'
import { type ImageKind, storeImage, UnreadableImage } from '../media/images'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { spaceConfigured } from '../media/spacesHls'
import { notifyGameChange } from '../socket/gameChanges'
import { noteScopeChange } from '../socket/syncRevision'
import { asPictureBody } from '../teams/storeTeamPictures'
import {
  type ClaimRow,
  decideClaim,
  describeClaims,
  endClaim,
  fileClaim,
  liveClaims,
  ownershipOf,
  requireVenueEditor,
  settleClaims,
  venueRights
} from './ownership'
import { noticeClaimDecided, noticeClaimFiled } from './venueNotices'

/** What the venue service needs from the server beyond the database. */
export interface VenueServices {
  places?: GooglePlaces
  media: MediaContext
  map: { tileUrl: string; googleMapsApiKey?: string }
  clock?: Clock
}

const SEARCH_LIMIT = 50
const GROUPS = ['yours', 'claimed', 'unclaimed'] as const

type VenueRow = Selectable<VenuesTable>
type FieldRow = Selectable<VenueFieldsTable>

function hoursOf(raw: unknown): WeekdayHours[] {
  return asWeeklyHours(raw)
}
function datesOf(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map(value => calendarDateText(value)!).sort()
    : []
}

/** A field as the API returns it. */
export function fieldOf(row: FieldRow, media: MediaContext): VenueField {
  return {
    id: row.id,
    name: row.name,
    sizes: row.sizes as FieldSize[],
    pin:
      row.pin_latitude == null || row.pin_longitude == null
        ? null
        : { latitude: row.pin_latitude, longitude: row.pin_longitude },
    startsOn: calendarDateText(row.starts_on),
    endsOn: calendarDateText(row.ends_on),
    hours: row.hours == null ? null : hoursOf(row.hours),
    blackouts: datesOf(row.blackouts),
    photoUrl: imageUrl(media.space, row.photo_path, 640),
    photoLargeUrl: imageUrl(media.space, row.photo_path, 1280)
  }
}

/** A venue's defaults, for availability and the API. */
export function venueDefaults(row: VenueRow): {
  defaultHours: WeekdayHours[]
  defaultBlackouts: string[]
  timezone: string
} {
  return {
    defaultHours: hoursOf(row.default_hours),
    defaultBlackouts: datesOf(row.default_blackouts),
    timezone: row.timezone
  }
}

/**
 * Settles the venue's matured claims and tells their leagues, before
 * anything reads or changes the venue.
 */
async function settle(
  db: Kysely<Database>,
  venueId: string,
  clock: Clock
): Promise<void> {
  for (const claim of await settleClaims(db, venueId, clock))
    await noticeClaimDecided(db, claim, null)
}

async function venueRow(
  db: Kysely<Database>,
  venueId: string
): Promise<VenueRow> {
  const venue = await db
    .selectFrom('venues')
    .selectAll()
    .where('id', '=', venueId)
    .executeTakeFirst()
  if (venue == null) throw notFound('Choose a venue')
  return venue
}

/** The full venue: fields, owners, claims, the person's rights and its map. */
export async function venueDetail(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  services: VenueServices
): Promise<VenueDetail> {
  const clock = services.clock ?? realClock
  await atomic(db, async trx => {
    await settle(trx, venueId, clock)
  })
  const venue = await venueRow(db, venueId)
  const fields = await db
    .selectFrom('venue_fields')
    .selectAll()
    .where('venue_id', '=', venueId)
    .where('deleted_at', 'is', null)
    .orderBy('name')
    .orderBy('id')
    .execute()
  const { owners, claims } = await describeClaims(
    db,
    await liveClaims(db, [venueId]),
    clock
  )
  return {
    id: venue.id,
    placeId: venue.google_place_id,
    name: venue.name,
    address: venue.address,
    sizeSwitchMinutes: venue.size_switch_minutes,
    ...venueDefaults(venue),
    photoUrl: imageUrl(services.media.space, venue.photo_path, 640),
    photoLargeUrl: imageUrl(services.media.space, venue.photo_path, 1280),
    owners,
    claims,
    fields: fields.map(field => fieldOf(field, services.media)),
    rights: await venueRights(db, actor, venueId, clock),
    map: mapAt(venue, services)
  }
}

/** The map the app draws a venue on: the tiles, or Google's with a key. */
function mapAt(
  point: { latitude: number; longitude: number },
  services: VenueServices
): VenueDetail['map'] {
  const key = services.map.googleMapsApiKey
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    tileUrl: services.map.tileUrl,
    googleMapsApiKey: key == null || key === '' ? undefined : key
  }
}

function placesOf(services: VenueServices): GooglePlaces {
  if (services.places == null)
    throw unavailable('Place lookup is not configured')
  return services.places
}

/** Strips the `google:` our place search puts in front of an id. */
function bareId(id: string): string {
  return id.startsWith('google:') ? id.slice('google:'.length) : id
}

/** The venue for a Google place: the registry's, or the place itself. */
export async function placeDetail(
  db: Kysely<Database>,
  actor: Actor,
  placeId: string,
  services: VenueServices
): Promise<VenueDetail> {
  const id = bareId(placeId)
  const known = await db
    .selectFrom('venues')
    .select('id')
    .where('google_place_id', '=', id)
    .executeTakeFirst()
  if (known != null) return await venueDetail(db, actor, known.id, services)
  const places = placesOf(services)
  const fresh = await currentActor(db, actor)
  await limitGoogleLookup(db, fresh.userId, true)
  const place = await places.venueDetails(id)
  return {
    id: null,
    placeId: place.placeId,
    name: place.name,
    address: place.address,
    timezone: place.timezone,
    sizeSwitchMinutes: 0,
    defaultHours: [],
    defaultBlackouts: [],
    photoUrl: null,
    photoLargeUrl: null,
    owners: [],
    claims: [],
    fields: [],
    rights: await venueRights(db, fresh, null, services.clock),
    map: mapAt(place, services)
  }
}

/** Kilometres between two points, along the ground. */
export function distanceKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180
  const dLat = radians(b.latitude - a.latitude)
  const dLon = radians(b.longitude - a.longitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface VenueSearch {
  query?: string
  near?: { latitude: number; longitude: number }
  leagueIds?: string[]
}

/**
 * The Field Manager's list. With leagues, the venues those leagues own.
 * Without a query: the person's leagues' venues, then other claimed venues,
 * nearest first. With a query: matches the person's leagues own, then
 * claimed ones, then unclaimed ones, Google's places last. A failed Google
 * search leaves the registry's matches.
 */
export async function searchVenues(
  db: Kysely<Database>,
  actor: Actor,
  search: VenueSearch,
  services: VenueServices
): Promise<VenueSummary[]> {
  const clock = services.clock ?? realClock
  const fresh = await currentActor(db, actor)
  const mine = (await adminScopes(db, fresh.userId, fresh.isAdmin)).leagueIds
  const query = search.query?.trim() ?? ''
  let rows: VenueRow[]
  if (search.leagueIds != null && search.leagueIds.length > 0)
    rows = await db
      .selectFrom('venues')
      .selectAll()
      .where(
        'id',
        'in',
        db
          .selectFrom('venue_claims')
          .select('venue_id')
          .where('league_id', 'in', search.leagueIds)
          .where('status', 'in', ['pending', 'approved'])
      )
      .execute()
  else if (query !== '') {
    const pattern = `%${query.replace(/[\\%_]/g, match => `\\${match}`)}%`
    rows = await db
      .selectFrom('venues')
      .selectAll()
      .where(eb =>
        eb.or([eb('name', 'ilike', pattern), eb('address', 'ilike', pattern)])
      )
      .limit(SEARCH_LIMIT)
      .execute()
  } else
    rows = await db
      .selectFrom('venues')
      .selectAll()
      .where(
        'id',
        'in',
        db
          .selectFrom('venue_claims')
          .select('venue_id')
          .where('status', 'in', ['pending', 'approved'])
      )
      .execute()
  const claims = await liveClaims(
    db,
    rows.map(row => row.id)
  )
  const described = await describeClaims(db, claims, clock)
  const byVenue = new Map<string, ClaimRow[]>()
  for (const claim of claims)
    byVenue.set(claim.venue_id, [...(byVenue.get(claim.venue_id) ?? []), claim])
  const summaries = rows.map(row => {
    const own = byVenue.get(row.id) ?? []
    const ownership = ownershipOf(own, clock)
    const owned = ownership.owners.map(claim =>
      described.owners.find(owner => owner.claimId === claim.id)!
    )
    const group = own.some(claim => mine.has(claim.league_id))
      ? 0
      : ownership.claimed
        ? 1
        : 2
    return {
      group,
      summary: {
        id: row.id,
        placeId: row.google_place_id,
        name: row.name,
        address: row.address,
        owners: owned,
        pendingClaim: ownership.pending.length > 0,
        claimed: ownership.claimed,
        group: GROUPS[group],
        distanceKm:
          search.near == null
            ? null
            : Math.round(distanceKm(search.near, row) * 10) / 10
      }
    }
  })
  const wanted =
    search.leagueIds != null && search.leagueIds.length > 0
      ? summaries
      : query === ''
        ? summaries.filter(item => item.group < 2)
        : summaries
  const ordered = wanted
    .sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group
      const distance = (a.summary.distanceKm ?? 0) - (b.summary.distanceKm ?? 0)
      return distance !== 0
        ? distance
        : a.summary.name.localeCompare(b.summary.name)
    })
    .slice(0, SEARCH_LIMIT)
    .map(item => item.summary)
  if (query === '' || services.places == null) return ordered
  const known = new Set(ordered.map(item => item.placeId))
  let google: VenueSummary[] = []
  try {
    await limitGoogleLookup(db, fresh.userId, false)
    google = (await services.places.eventPlaces(query, 'venue'))
      .map(place => ({
        id: null,
        placeId: bareId(place.id),
        name: place.name ?? place.address,
        address: place.address,
        owners: [],
        pendingClaim: false,
        claimed: false,
        group: 'unclaimed' as const,
        distanceKm: null
      }))
      .filter(place => !known.has(place.placeId))
  } catch (error) {
    // A Google outage leaves the registry's answer; a refused rate limit too.
    if (!(error instanceof Error)) throw error
  }
  // A Google place already in the registry is listed once, as the registry's.
  const registered = new Set(
    (
      await (google.length === 0
        ? Promise.resolve([])
        : db
            .selectFrom('venues')
            .select('google_place_id')
            .where(
              'google_place_id',
              'in',
              google.map(place => place.placeId)
            )
            .execute())
    ).map(row => row.google_place_id)
  )
  return [...ordered, ...google.filter(place => !registered.has(place.placeId))]
}

/**
 * Adds a Google place to the registry if it is not there, then files the
 * league's claim on it.
 */
export async function claimPlace(
  db: Kysely<Database>,
  actor: Actor,
  placeId: string,
  leagueId: string,
  services: VenueServices
): Promise<VenueDetail> {
  const id = bareId(placeId)
  const fresh = await currentActor(db, actor)
  let venueId = (
    await db
      .selectFrom('venues')
      .select('id')
      .where('google_place_id', '=', id)
      .executeTakeFirst()
  )?.id
  if (venueId == null) {
    const places = placesOf(services)
    await limitGoogleLookup(db, fresh.userId, true)
    const place: VenuePlace = await places.venueDetails(id)
    venueId = await atomic(db, async trx => {
      await lockKeys(trx, [`venue-place:${place.placeId}`])
      const existing = await trx
        .selectFrom('venues')
        .select('id')
        .where('google_place_id', '=', place.placeId)
        .executeTakeFirst()
      if (existing != null) return existing.id
      const created = makeId('venue')
      await trx
        .insertInto('venues')
        .values({
          id: created,
          google_place_id: place.placeId,
          name: place.name,
          address: place.address,
          latitude: place.latitude,
          longitude: place.longitude,
          timezone: place.timezone
        })
        .execute()
      return created
    })
  }
  return await claimVenue(db, fresh, venueId, leagueId, services)
}

/** Files a league's claim, or its request to co-own, and announces it. */
export async function claimVenue(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  leagueId: string,
  services: VenueServices
): Promise<VenueDetail> {
  const clock = services.clock ?? realClock
  await atomic(db, async trx => {
    await settle(trx, venueId, clock)
    const claim = await fileClaim(trx, actor, venueId, leagueId, clock)
    const owners = ownershipOf(await liveClaims(trx, [venueId]), clock).owners
    await noticeClaimFiled(
      trx,
      claim,
      owners.map(owner => owner.league_id)
    )
  })
  return await venueDetail(db, actor, venueId, services)
}

/** Approves or rejects a claim, and tells its league. */
export async function decideVenueClaim(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  claimId: string,
  decision: 'approve' | 'reject',
  services: VenueServices
): Promise<VenueDetail> {
  const clock = services.clock ?? realClock
  await atomic(db, async trx => {
    await settle(trx, venueId, clock)
    const claim = await decideClaim(
      trx,
      actor,
      venueId,
      claimId,
      decision,
      clock
    )
    const decider = await trx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', claim.decided_by!)
      .executeTakeFirst()
    await noticeClaimDecided(trx, claim, decider?.display_name ?? 'An admin')
  })
  return await venueDetail(db, actor, venueId, services)
}

/** Leaves, withdraws or removes a claim. */
export async function endVenueClaim(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  claimId: string,
  services: VenueServices
): Promise<VenueDetail> {
  const clock = services.clock ?? realClock
  await atomic(db, async trx => {
    await settle(trx, venueId, clock)
    await endClaim(trx, actor, venueId, claimId, clock)
  })
  return await venueDetail(db, actor, venueId, services)
}

/** Stores a place's photo, wide, and returns the path to keep. */
async function storePhoto(
  services: VenueServices,
  kind: ImageKind,
  entityId: string,
  photo: PhotoUpload
): Promise<{ path: string; sha256: string }> {
  if (!spaceConfigured(services.media.space))
    throw unavailable('No picture store is configured')
  const picture = asPictureBody({ image: photo, source: 'upload' })
  try {
    const stored = await storeImage({
      ffmpegPath: services.media.ffmpegPath,
      space: services.media.space,
      kind,
      entityId,
      source: picture.bytes
    })
    if (stored == null) throw unavailable('The photo could not be saved')
    return { path: stored.pathPrefix, sha256: stored.sha256 }
  } catch (error) {
    if (error instanceof UnreadableImage)
      throw unsupportedMedia('That is not a picture TeamStation can read')
    throw unavailable('The picture store did not answer')
  }
}

/** Hook for writes that can change a field's games' warnings. */
export type FieldsChanged = (
  db: Kysely<Database>,
  fieldIds: string[]
) => Promise<void>

/**
 * Gives the upcoming scheduled games on these fields the place they take
 * from the registry: the venue's name and address, and the field's pin (or
 * the venue's), as linking a game to its field does.
 */
async function placeFieldGames(
  trx: Kysely<Database>,
  fieldIds: string[],
  clock: Clock
): Promise<void> {
  if (fieldIds.length === 0) return
  const now = clock.now()
  const moved = await sql<{ id: string }>`update games g set
      venue = v.name,
      address = v.address,
      latitude = coalesce(f.pin_latitude, v.latitude),
      longitude = coalesce(f.pin_longitude, v.longitude),
      updated_at = ${now}
    from venue_fields f join venues v on v.id = f.venue_id
    where g.field_id = f.id
      and f.id in (${sql.join(fieldIds)})
      and g.status = 'scheduled'
      and g.start_at > ${now}
      and (g.venue is distinct from v.name
        or g.address is distinct from v.address
        or g.latitude is distinct from coalesce(f.pin_latitude, v.latitude)
        or g.longitude is distinct from coalesce(f.pin_longitude, v.longitude))
    returning g.id`.execute(trx)
  for (const game of moved.rows) {
    await notifyGameChange(trx, { game: game.id, kind: 'game' })
    noteScopeChange(trx, { gameId: game.id })
  }
}

/** Changes the venue's details, defaults, switch time or photo. */
export async function updateVenue(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  changes: VenueChanges,
  services: VenueServices,
  fieldsChanged?: FieldsChanged
): Promise<VenueDetail> {
  const clock = services.clock ?? realClock
  await requireVenueEditor(db, actor, venueId, clock)
  const photo =
    changes.photo == null
      ? null
      : await storePhoto(services, 'venue', venueId, changes.photo)
  await atomic(db, async trx => {
    await lockKeys(trx, [`venue:${venueId}`])
    await requireVenueEditor(trx, actor, venueId, clock)
    await trx
      .updateTable('venues')
      .set({
        ...(changes.name == null ? {} : { name: changes.name }),
        ...(changes.sizeSwitchMinutes == null
          ? {}
          : { size_switch_minutes: changes.sizeSwitchMinutes }),
        ...(changes.defaultHours == null
          ? {}
          : { default_hours: JSON.stringify(changes.defaultHours) }),
        ...(changes.defaultBlackouts == null
          ? {}
          : { default_blackouts: changes.defaultBlackouts }),
        ...(photo == null
          ? {}
          : {
              photo_path: photo.path,
              photo_sha256: photo.sha256,
              photo_updated_at: clock.now()
            }),
        updated_at: clock.now()
      })
      .where('id', '=', venueId)
      .execute()
    // Renamed, its upcoming games show the new name.
    if (changes.name != null)
      await placeFieldGames(
        trx,
        (
          await trx
            .selectFrom('venue_fields')
            .select('id')
            .where('venue_id', '=', venueId)
            .execute()
        ).map(row => row.id),
        clock
      )
    if (
      fieldsChanged != null &&
      (changes.sizeSwitchMinutes != null ||
        changes.defaultHours != null ||
        changes.defaultBlackouts != null)
    )
      await fieldsChanged(
        trx,
        (
          await trx
            .selectFrom('venue_fields')
            .select('id')
            .where('venue_id', '=', venueId)
            .execute()
        ).map(row => row.id)
      )
  })
  return await venueDetail(db, actor, venueId, services)
}

function fieldValues(changes: FieldChanges): Partial<{
  name: string
  sizes: string[]
  pin_latitude: number | null
  pin_longitude: number | null
  starts_on: string | null
  ends_on: string | null
  hours: string | null
  blackouts: string[]
}> {
  return {
    ...(changes.name == null ? {} : { name: changes.name }),
    ...(changes.sizes == null ? {} : { sizes: [...changes.sizes] }),
    ...(changes.pin === undefined
      ? {}
      : {
          pin_latitude: changes.pin?.latitude ?? null,
          pin_longitude: changes.pin?.longitude ?? null
        }),
    ...(changes.dates === undefined
      ? {}
      : {
          starts_on: changes.dates?.startsOn ?? null,
          ends_on: changes.dates?.endsOn ?? null
        }),
    ...(changes.hours === undefined
      ? {}
      : {
          hours: changes.hours == null ? null : JSON.stringify(changes.hours)
        }),
    ...(changes.blackouts == null ? {} : { blackouts: changes.blackouts })
  }
}

/** Adds a field to the venue. */
export async function createField(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  changes: FieldChanges,
  services: VenueServices
): Promise<VenueDetail> {
  const clock = services.clock ?? realClock
  await requireVenueEditor(db, actor, venueId, clock)
  const fieldId = makeId('venueField')
  const photo =
    changes.photo == null
      ? null
      : await storePhoto(services, 'field', fieldId, changes.photo)
  await atomic(db, async trx => {
    await lockKeys(trx, [`venue:${venueId}`])
    await requireVenueEditor(trx, actor, venueId, clock)
    await trx
      .insertInto('venue_fields')
      .values({
        id: fieldId,
        venue_id: venueId,
        name: changes.name!,
        sizes: [...changes.sizes!],
        ...fieldValues(changes),
        ...(photo == null
          ? {}
          : {
              photo_path: photo.path,
              photo_sha256: photo.sha256,
              photo_updated_at: clock.now()
            })
      })
      .execute()
  })
  return await venueDetail(db, actor, venueId, services)
}

async function liveField(
  db: Kysely<Database>,
  venueId: string,
  fieldId: string
): Promise<FieldRow> {
  const field = await db
    .selectFrom('venue_fields')
    .selectAll()
    .where('id', '=', fieldId)
    .where('venue_id', '=', venueId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (field == null) throw notFound('Choose a field')
  return field
}

/** Changes a field: its name, sizes, pin, availability or photo. */
export async function updateField(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  fieldId: string,
  changes: FieldChanges,
  services: VenueServices,
  fieldsChanged?: FieldsChanged
): Promise<VenueDetail> {
  const clock = services.clock ?? realClock
  await requireVenueEditor(db, actor, venueId, clock)
  await liveField(db, venueId, fieldId)
  const photo =
    changes.photo == null
      ? null
      : await storePhoto(services, 'field', fieldId, changes.photo)
  await atomic(db, async trx => {
    await lockKeys(trx, [`venue:${venueId}`])
    await requireVenueEditor(trx, actor, venueId, clock)
    await liveField(trx, venueId, fieldId)
    const values = fieldValues(changes)
    if (Object.keys(values).length === 0 && photo == null) return
    await trx
      .updateTable('venue_fields')
      .set({
        ...values,
        ...(photo == null
          ? {}
          : {
              photo_path: photo.path,
              photo_sha256: photo.sha256,
              photo_updated_at: clock.now()
            }),
        updated_at: clock.now()
      })
      .where('id', '=', fieldId)
      .execute()
    // A pin moved moves its upcoming games' place on the map.
    if (changes.pin !== undefined) await placeFieldGames(trx, [fieldId], clock)
    if (
      fieldsChanged != null &&
      (changes.sizes != null ||
        changes.dates !== undefined ||
        changes.hours !== undefined ||
        changes.blackouts != null)
    )
      await fieldsChanged(trx, [fieldId])
  })
  return await venueDetail(db, actor, venueId, services)
}

/** Deletes a field. Games on it stay, and upcoming ones are warned. */
export async function deleteField(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  fieldId: string,
  services: VenueServices,
  fieldsChanged?: FieldsChanged
): Promise<VenueDetail> {
  const clock = services.clock ?? realClock
  await atomic(db, async trx => {
    await lockKeys(trx, [`venue:${venueId}`])
    await requireVenueEditor(trx, actor, venueId, clock)
    await liveField(trx, venueId, fieldId)
    await trx
      .updateTable('venue_fields')
      .set({ deleted_at: clock.now(), updated_at: clock.now() })
      .where('id', '=', fieldId)
      .execute()
    if (fieldsChanged != null) await fieldsChanged(trx, [fieldId])
  })
  return await venueDetail(db, actor, venueId, services)
}

/** `lat,lng` from a query, or a 400 that says what is wrong. */
export function asNear(
  raw: unknown
): { latitude: number; longitude: number } | undefined {
  if (raw == null || raw === '') return undefined
  if (typeof raw !== 'string')
    throw badRequest('near is one latitude,longitude pair')
  const parts = raw.split(',')
  const [latitude, longitude] = parts.map(Number)
  if (
    parts.length !== 2 ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw badRequest('near is one latitude,longitude pair')
  return { latitude, longitude }
}
