import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import legacyRecord from '../../test/legacyChatKeyRecord.json'
import { b64, recordFromJson, recordToJson } from './keyRecord'

const legacyRecordJson = JSON.stringify(legacyRecord)

describe('saved numeric chat identity upgrade', () => {
  it('rejects malformed persisted key bytes rather than treating a damaged device as new', () => {
    const changes = [
      (r: typeof legacyRecord) => {
        r.device.box.secretKey = 'AA'
      },
      (r: typeof legacyRecord) => {
        r.device.sign.publicKey = '*'.repeat(43)
      },
      (r: typeof legacyRecord) => {
        r.identity.keys.secretKey = 'AA'
      },
      (r: typeof legacyRecord) => {
        r.puks[0].keys.publicKey = 'AA'
      },
      (r: typeof legacyRecord) => {
        r.pins[7] = 'AA'
      },
      (r: typeof legacyRecord) => {
        r.previousPins[7] = 'AA'
      },
      (r: typeof legacyRecord) => {
        r.epochKeys.cnv_legacy['8'] = 'AA'
      },
      (r: typeof legacyRecord) => {
        r.logs.cnv_legacy.hash = 'AA'
      }
    ]
    for (const change of changes) {
      const raw = structuredClone(legacyRecord)
      change(raw)
      expect(() => recordFromJson(JSON.stringify(raw))).throws()
    }
  })
  it('normalizes every identity without losing device, user, epoch or pending keys', () => {
    const record = recordFromJson(legacyRecordJson)
    expect(record.userId).equals(userIdOfGumbo(42))
    expect(record.pins).deep.equals({
      [userIdOfGumbo(7)]: legacyRecord.pins[7],
      [userIdOfGumbo(42)]: legacyRecord.pins[42]
    })
    expect(record.previousPins).deep.equals({
      [userIdOfGumbo(7)]: legacyRecord.previousPins[7]
    })
    expect(record.logs.cnv_legacy.members).deep.equals([
      userIdOfGumbo(7),
      userIdOfGumbo(42)
    ])
    expect(record.logs.cnv_legacy.resets).deep.equals([
      { userId: userIdOfGumbo(7), seq: 4, at: 1234 }
    ])
    expect(record.deviceId).equals('cdv_legacy')
    expect(b64(record.device.box.secretKey)).equals(
      legacyRecord.device.box.secretKey
    )
    expect(b64(record.device.box.publicKey)).equals(
      legacyRecord.device.box.publicKey
    )
    expect(b64(record.device.sign.secretKey)).equals(
      legacyRecord.device.sign.secretKey
    )
    expect(b64(record.device.sign.publicKey)).equals(
      legacyRecord.device.sign.publicKey
    )
    expect(record.identity?.id).equals('cid_legacy')
    expect(b64(record.identity!.keys.secretKey)).equals(
      legacyRecord.identity.keys.secretKey
    )
    expect(b64(record.identity!.keys.publicKey)).equals(legacyRecord.pins[42])
    expect(
      record.puks.map(puk => [
        puk.generation,
        b64(puk.keys.secretKey),
        b64(puk.keys.publicKey)
      ])
    ).deep.equals([
      [
        2,
        legacyRecord.puks[0].keys.secretKey,
        legacyRecord.puks[0].keys.publicKey
      ]
    ])
    expect(record.pendingLinkId).equals('clk_pending_legacy')
    expect(record.epochKeys).deep.equals(legacyRecord.epochKeys)
    expect(record.logs.cnv_legacy.hash).equals(
      legacyRecord.logs.cnv_legacy.hash
    )
    const saved = recordToJson(record)
    expect(JSON.parse(saved).version).equals(2)
    expect(recordFromJson(saved)).deep.equals(record)
    expect(JSON.parse(legacyRecordJson).version).equals(1)
  })
})
