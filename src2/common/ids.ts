import { randomBytes } from 'crypto'

/**
 * Every row's id carries a short prefix, so an id in a log or a URL says what
 * it is without a lookup. The rest is 96 random bits in base64url, which is
 * shorter than a UUID and safe in a path segment.
 */
export const idPrefixes = {
  adminRole: 'adm',
  apiToken: 'atk',
  audit: 'aud',
  authSession: 'ses',
  emailCode: 'emc',
  event: 'evt',
  eventPlayer: 'evp',
  externalId: 'ext',
  game: 'gam',
  league: 'lea',
  membership: 'mem',
  playerSeasonStats: 'pss',
  season: 'sea',
  team: 'tem',
  teamSeasonRecord: 'tsr',
  user: 'usr',
  userLink: 'lnk',
  video: 'vid'
} as const

export type IdKind = keyof typeof idPrefixes

export function makeId(kind: IdKind): string {
  return `${idPrefixes[kind]}_${randomBytes(12).toString('base64url')}`
}

/** True when `id` looks like one of ours, of that kind. */
export function isId(kind: IdKind, id: string): boolean {
  return id.startsWith(`${idPrefixes[kind]}_`) && id.length > 4
}
