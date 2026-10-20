import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  idBits,
  packGameId,
  packId,
  packPlayerId,
  packTeamId,
  unpackId
} from './lineupQrIds'

const VERSION_8 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('lineup QR ids', function () {
  it('packs each kind into a version-8 UUID that unpacks to it', function () {
    const cases = [
      ['team', idBits('tem_vShybFtE3zX82D8W')],
      ['game', idBits('gam_pRdMXg3WOKXHnRht')],
      ['player', 5187822249608915n]
    ] as const
    for (const [kind, payload] of cases) {
      const uuid = packId(kind, payload)
      expect(uuid).matches(VERSION_8)
      expect(unpackId(uuid)).deep.equals({ kind, payload })
    }
  })

  it('packs the same id to the same UUID', function () {
    expect(packTeamId('tem_vShybFtE3zX82D8W')).equals(
      packTeamId('tem_vShybFtE3zX82D8W')
    )
    expect(packGameId('gam_pRdMXg3WOKXHnRht')).not.equals(
      packGameId('gam_pRdMXg3WOKXHnRhu')
    )
  })

  it('matches the layout GameChanger accepted in a scan', function () {
    // The team id of the code GameChanger imported while this was designed.
    expect(packTeamId('tem_4KJCugw0e2qkX7nV')).equals(
      '10000038-2890-8ae8-8c34-7b6aa45fb9d5'
    )
    expect(packPlayerId(948323533514222)).equals(
      '30000000-0000-8000-8003-5e7ec758e5ee'
    )
  })

  it('round-trips the largest gumbo id and refuses one out of range', function () {
    expect(unpackId(packPlayerId(Number.MAX_SAFE_INTEGER))).deep.equals({
      kind: 'player',
      payload: BigInt(Number.MAX_SAFE_INTEGER)
    })
    expect(() => packPlayerId(0)).throws(TypeError)
    expect(() => packId('player', 1n << 118n)).throws(RangeError)
    expect(() => packId('player', -1n)).throws(RangeError)
  })

  it('hashes an id that is not in the random form', function () {
    const bits = idBits('gam_demo000000000001x')
    expect(bits < 1n << 96n).equals(true)
    expect(idBits('gam_demo000000000001x')).equals(bits)
    expect(packGameId('gam_event_future_end')).matches(VERSION_8)
  })

  it('reads no kind from a UUID it did not make', function () {
    expect(unpackId('b4843d45-b016-4555-83de-cc88d9520c64')).equals(null)
    expect(unpackId('not a uuid')).equals(null)
    expect(unpackId('f0000000-0000-8000-8000-000000000000')).equals(null)
  })
})
