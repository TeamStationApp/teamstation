import { expect } from 'chai'
import { describe, it } from 'mocha'

import { newDeviceKeys, newPukKey } from '../../common/chatCrypto/keys'
import {
  b64,
  epochKeyOf,
  latestPuk,
  newRecord,
  pinIdentity,
  recordFromJson,
  recordToJson,
  unb64,
  withEpochKey
} from './keyRecord'

/** U11: the record both key stores keep. */
describe('chat key record', function () {
  const device = newDeviceKeys()

  it('round-trips every field through JSON, bytes as base64url', function () {
    const identity = newDeviceKeys().sign
    const record = withEpochKey(
      {
        ...newRecord(42, 'cdv_one', device),
        identity: { id: 'cid_abcdefghijklmnop', keys: identity },
        puks: [
          { generation: 2, keys: newPukKey() },
          { generation: 1, keys: newPukKey() }
        ],
        pendingLinkId: 'clk_x',
        pins: { 7: 'AAAA' }
      },
      'cnv_1',
      3,
      Uint8Array.of(1, 2, 3)
    )
    const text = recordToJson(record)
    expect(text).not.contains('"secretKey":{')
    const back = recordFromJson(text)
    expect(back.userId).equals(42)
    expect(back.deviceId).equals('cdv_one')
    expect(b64(back.device.box.secretKey)).equals(b64(device.box.secretKey))
    expect(b64(back.device.sign.publicKey)).equals(b64(device.sign.publicKey))
    expect(back.identity?.id).equals('cid_abcdefghijklmnop')
    expect(b64(back.identity!.keys.secretKey)).equals(b64(identity.secretKey))
    // Oldest first, whatever order they were written in.
    expect(back.puks.map(puk => puk.generation)).deep.equals([1, 2])
    expect(back.pendingLinkId).equals('clk_x')
    expect(back.pins).deep.equals({ 7: 'AAAA' })
    expect([...epochKeyOf(back, 'cnv_1', 3)!]).deep.equals([1, 2, 3])
  })

  it('keeps a new device’s record with nothing of the user’s', function () {
    const back = recordFromJson(recordToJson(newRecord(1, 'cdv_new', device)))
    expect(back.identity).equals(undefined)
    expect(back.puks).deep.equals([])
    expect(back.pendingLinkId).equals(undefined)
    expect(back.pins).deep.equals({})
    expect(back.epochKeys).deep.equals({})
    expect(latestPuk(back)).equals(undefined)
  })

  it('refuses what it did not write', function () {
    expect(() => recordFromJson('not json')).throws()
    expect(() => recordFromJson('{"version":2}')).throws()
    expect(() =>
      recordFromJson(
        JSON.stringify({
          ...JSON.parse(recordToJson(newRecord(1, 'c', device))),
          userId: 'x'
        })
      )
    ).throws()
  })

  it('pins an identity on first sight and reports a change', function () {
    const first = Uint8Array.of(9, 9)
    const start = newRecord(1, 'cdv', device)
    const pinned = pinIdentity(start, 5, first)
    expect(pinned.seen).equals('new')
    expect(pinned.record.pins).deep.equals({ 5: b64(first) })
    expect(start.pins).deep.equals({})
    const again = pinIdentity(pinned.record, 5, first)
    expect(again.seen).equals('same')
    expect(again.record).equals(pinned.record)
    const changed = pinIdentity(pinned.record, 5, Uint8Array.of(1))
    expect(changed.seen).equals('changed')
    expect(changed.record.pins[5]).equals(b64(Uint8Array.of(1)))
  })

  it('caches epoch keys per conversation and epoch', function () {
    const start = newRecord(1, 'cdv', device)
    const one = withEpochKey(start, 'cnv_a', 1, Uint8Array.of(1))
    const two = withEpochKey(one, 'cnv_a', 2, Uint8Array.of(2))
    expect(epochKeyOf(two, 'cnv_a', 1)).deep.equals(Uint8Array.of(1))
    expect(epochKeyOf(two, 'cnv_a', 2)).deep.equals(Uint8Array.of(2))
    expect(epochKeyOf(two, 'cnv_a', 3)).equals(undefined)
    expect(epochKeyOf(two, 'cnv_b', 1)).equals(undefined)
    expect(start.epochKeys).deep.equals({})
    expect(unb64(two.epochKeys.cnv_a['2'])).deep.equals(Uint8Array.of(2))
  })
})
