import { randomBytes } from 'crypto'

/**
 * Every row's id carries a short prefix, so an id in a log or a URL says what
 * it is without a lookup. The rest is 96 random bits in base64url, which is
 * shorter than a UUID and safe in a path segment.
 */
export const idPrefixes = {
  apiToken: 'atk',
  audit: 'aud',
  authSession: 'ses',
  chatAttachment: 'cat',
  chatDevice: 'cdv',
  chatIdentity: 'cid',
  chatLink: 'clk',
  chatMessage: 'msg',
  chatReport: 'crp',
  conversation: 'cnv',
  emailCode: 'emc',
  event: 'evt',
  eventCredit: 'evc',
  eventPlayer: 'evp',
  externalId: 'ext',
  game: 'gam',
  gamePlayArchive: 'gpa',
  gamePlayerStats: 'gps',
  directorUpload: 'dup',
  invite: 'inv',
  inviteRedemption: 'ivr',
  league: 'lea',
  leagueMember: 'lmb',
  liveStream: 'liv',
  loginRequest: 'lgr',
  membership: 'mem',
  plateAppearance: 'pap',
  rateEvent: 'rte',
  scopeRole: 'rol',
  schedulePreview: 'spv',
  season: 'sea',
  seasonMember: 'smb',
  team: 'tem',
  teamEvent: 'tev',
  umpireNoteType: 'unt',
  umpireType: 'uty',
  umpireLevel: 'ulv',
  user: 'usr',
  userApiKey: 'uak',
  userEmail: 'uem',
  userLink: 'lnk',
  venue: 'ven',
  venueClaim: 'vcl',
  venueField: 'fld',
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
