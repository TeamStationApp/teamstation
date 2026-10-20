import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asUserId,
  asUserIdNumber,
  heldUserId,
  mintUserId,
  userIdNumber
} from './historicalUserIds'

describe('userIdNumber', function () {
  it('keeps the leading 53 bits of a 16-character payload', function () {
    expect(userIdNumber('usr_k3Jf8sQ2nP0aL9xY')).equals(5187822249608915)
  })

  it('stops at the JSON ceiling', function () {
    expect(userIdNumber('usr_' + '________________')).equals(9007199254740991)
  })

  it('rejects an id that is not that shape', function () {
    expect(() => userIdNumber('usr_boss')).throws(/usr_/)
  })

  it('draws again when the first number is taken', function () {
    const seen: number[] = []
    const minted = mintUserId(userId => {
      seen.push(userId)
      return true
    })
    expect(seen.length).equals(1)
    expect(minted.userId).not.equals(seen[0])
    expect(userIdNumber(minted.legacyId)).equals(minted.userId)
  })

  it('reads a number, a decimal string, and a usr_ id', function () {
    expect(asUserId(5187822249608915)).equals(5187822249608915)
    expect(asUserId('5187822249608915')).equals(5187822249608915)
    expect(asUserId('usr_k3Jf8sQ2nP0aL9xY')).equals(5187822249608915)
    expect(() => asUserId(-1)).throws()
    expect(() => asUserId(1.5)).throws()
    expect(() => asUserId('usr_boss')).throws(/user id/)
    expect(() => asUserId('nope')).throws(/user id/)
    expect(() => asUserId('9007199254740993')).throws(/user id/)
  })

  it('refuses 0 in every form', function () {
    expect(() => asUserId(0)).throws(/user id/)
    expect(() => asUserId('0')).throws(/user id/)
    expect(() => asUserIdNumber(0)).throws(/user id/)
  })

  it('takes only a number where a document carries a user id', function () {
    expect(asUserIdNumber(5187822249608915)).equals(5187822249608915)
    expect(() => asUserIdNumber('5187822249608915')).throws(/user id/)
    expect(() => asUserIdNumber('usr_k3Jf8sQ2nP0aL9xY')).throws(/user id/)
    expect(() => asUserIdNumber(-1)).throws(/user id/)
    expect(() => asUserIdNumber(2 ** 53)).throws(/user id/)
  })

  it('reads the user an external id points at, and names one it cannot', function () {
    expect(heldUserId('5187822249608915')).equals(5187822249608915)
    expect(heldUserId('usr_k3Jf8sQ2nP0aL9xY')).equals(5187822249608915)
    expect(() => heldUserId('tem_notAUser')).throws(
      'external id points at "tem_notAUser", which is not a user id'
    )
  })
})
