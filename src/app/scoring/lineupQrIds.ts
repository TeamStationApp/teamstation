import { base64url } from 'rfc4648'

import { asGumboId } from '../../common/userId'
import { sha256Hex, utf8 } from '../walkup/localFileId'

/**
 * TeamStation's ids, packed into version-8 UUIDs for a GameChanger lineup
 * QR code, which accepts any well-formed UUID and refuses anything else.
 * The same id always packs to the same UUID, and `unpackId` reads it back.
 *
 * Of a UUID's 128 bits, 4 are the version (8) and 2 the variant (`10`). The
 * other 122 hold a 4-bit kind and a 118-bit payload:
 *
 * - `team` (1) and `game` (2): the 96 random bits of a `tem_`/`gam_` id;
 * - `player` (3): a player's gumbo id, rostered or game-only, at most 53 bits.
 */
export type PackedKind = 'team' | 'game' | 'player'

const KINDS: Record<PackedKind, bigint> = {
  team: 1n,
  game: 2n,
  player: 3n
}
const PAYLOAD_BITS = 118n

export function packId(kind: PackedKind, payload: bigint): string {
  if (payload < 0n || payload >= 1n << PAYLOAD_BITS)
    throw new RangeError('A packed id payload has at most 118 bits')
  const value = (KINDS[kind] << PAYLOAD_BITS) | payload
  const high = value >> 74n
  const middle = (value >> 62n) & 0xfffn
  const low = value & ((1n << 62n) - 1n)
  const n = (high << 80n) | (8n << 76n) | (middle << 64n) | (2n << 62n) | low
  const hex = n.toString(16).padStart(32, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The kind and payload of a UUID `packId` made, or null for any other. */
export function unpackId(
  uuid: string
): { kind: PackedKind; payload: bigint } | null {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)
  )
    return null
  const n = BigInt('0x' + uuid.replace(/-/g, ''))
  if (((n >> 76n) & 0xfn) !== 8n || ((n >> 62n) & 3n) !== 2n) return null
  const value =
    ((n >> 80n) << 74n) |
    (((n >> 64n) & 0xfffn) << 62n) |
    (n & ((1n << 62n) - 1n))
  const code = value >> PAYLOAD_BITS
  const kind = (Object.keys(KINDS) as PackedKind[]).find(
    name => KINDS[name] === code
  )
  if (kind == null) return null
  return { kind, payload: value & ((1n << PAYLOAD_BITS) - 1n) }
}

/**
 * The 96 bits of a `tem_`/`gam_` id. An id not in the random 16-character
 * form (a fixture's `gam_demo000000000001`) is hashed to 96 bits instead.
 */
export function idBits(id: string): bigint {
  if (/^[a-z]{3}_[A-Za-z0-9_-]{16}$/.test(id)) {
    const bytes = base64url.parse(id.slice(4), { loose: true })
    return BigInt(
      '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
    )
  }
  return BigInt('0x' + sha256Hex(utf8(id)).slice(0, 24))
}

export const packTeamId = (teamId: string): string =>
  packId('team', idBits(teamId))
export const packGameId = (gamePk: string): string =>
  packId('game', idBits(gamePk))
export const packPlayerId = (gumboId: number): string =>
  packId('player', BigInt(asGumboId(gumboId)))
