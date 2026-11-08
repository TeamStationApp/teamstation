import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asChatEpochs } from '../../common/api'
import { newIdentityId } from '../../common/chatCrypto/messageIds'
import { userIdOfGumbo } from '../../common/userId'
import { asServerConfig } from '../serverConfigSchema'
import {
  asEpochMode,
  asHistoryGrantsBody,
  asRecoveryLimit,
  boxDeliveryQuery,
  historyQuery
} from './historyValidation'

describe('history recovery wire validation', () => {
  it('preserves legacy defaults and independently negotiates fresh publication', () => {
    expect(asEpochMode(undefined)).equals(undefined)
    for (const mode of ['fresh', 'continue'])
      expect(asEpochMode(mode)).equals(mode)
    expect(() => asEpochMode('reset')).throws()
    const old = {
      latest: 0,
      needsRotation: false,
      noHolder: false,
      epochs: [],
      boxes: []
    }
    expect(asChatEpochs(old).historyRecoveryVersion).equals(undefined)
    expect(
      asChatEpochs({
        ...old,
        historyRecoveryVersion: 1,
        freshEpochsEnabled: false
      }).historyRecoveryVersion
    ).equals(1)
    expect(() => asChatEpochs({ ...old, historyRecoveryVersion: 2 })).throws()
    expect(asServerConfig({}).chatHistoryRecoveryEnabled).equals(false)
    for (const value of [false, true])
      expect(
        asServerConfig({ chatHistoryRecoveryEnabled: value })
          .chatHistoryRecoveryEnabled
      ).equals(value)
    expect(() =>
      asServerConfig({ chatHistoryRecoveryEnabled: 'true' })
    ).throws()
  })
  it('requires explicit scope and canonical bounded pagination', () => {
    expect(historyQuery({})).equals(undefined)
    expect(historyQuery({ scope: 'history' })).deep.equals({
      cursor: '0',
      limit: 100
    })
    expect(
      historyQuery({ scope: 'history', cursor: '9007199254740993', limit: '1' })
    ).deep.equals({ cursor: '9007199254740993', limit: 1 })
    for (const query of [
      { scope: 'other' },
      { cursor: '0' },
      { limit: '1' },
      { scope: ['history'] },
      { scope: 'history', cursor: '-1' }
    ])
      expect(() => historyQuery(query)).throws()
    expect(boxDeliveryQuery({})).equals(undefined)
    expect(boxDeliveryQuery({ boxesAfter: '0' })).deep.equals({
      boxesAfter: '0',
      boxLimit: 100
    })
    expect(() => boxDeliveryQuery({ boxLimit: '1' })).throws()
    expect(boxDeliveryQuery({ boxesAfter: '7', boxLimit: '2' })).deep.equals({
      boxesAfter: '7',
      boxLimit: 2
    })
    for (const value of [0, 101, 1.5, '01', 'x', [], Infinity])
      expect(() => asRecoveryLimit(value)).throws()
  })
  it('binds each box to a fixed goal and actual epoch with bounded payloads', () => {
    const box = {
      requestId: '1',
      conversationId: 'cnv_synthetic',
      targetEpoch: 2,
      epoch: 1,
      userId: userIdOfGumbo(123),
      identityId: newIdentityId(),
      pukGeneration: 1,
      box: Buffer.alloc(80).toString('base64url')
    }
    expect(
      asHistoryGrantsBody({ boxes: [box] }).boxes[0].approveHistory
    ).equals(false)
    expect(
      asHistoryGrantsBody({ boxes: [{ ...box, approveHistory: true }] })
        .boxes[0].approveHistory
    ).equals(true)
    for (const invalid of [
      { epoch: 0 },
      { epoch: 1.5 },
      { epoch: 2147483648 },
      { targetEpoch: -1 },
      { identityId: 'invalid' },
      { conversationId: '' },
      { conversationId: 'x'.repeat(101) },
      { pukGeneration: 1000001 },
      { box: 'bad' },
      { approveHistory: 1 }
    ])
      expect(() =>
        asHistoryGrantsBody({ boxes: [{ ...box, ...invalid }] })
      ).throws()
    expect(() => asHistoryGrantsBody({ boxes: [] })).throws()
    expect(() => asHistoryGrantsBody({ boxes: Array(101).fill(box) })).throws()
    expect(
      asHistoryGrantsBody({ boxes: Array(100).fill(box) }).boxes.length
    ).equals(100)
  })
})
