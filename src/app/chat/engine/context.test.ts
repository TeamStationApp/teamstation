import { expect } from 'chai'
import { describe, it } from 'mocha'

import { newDeviceKeys } from '../../../common/chatCrypto/keys'
import { userIdOfGumbo } from '../../../common/userId'
import { type ChatKeyRecord, type ChatKeyStore, newRecord } from '../keyRecord'
import { KeyHolder } from './context'

describe('KeyHolder', () => {
  it('saves on the update after a rejected save', async () => {
    const record = newRecord(userIdOfGumbo(1), 'cdv_1', newDeviceKeys())
    const saved: ChatKeyRecord[] = []
    const store = {
      async save(next: ChatKeyRecord) {
        saved.push(next)
        if (saved.length === 1) throw new Error('Chat keys could not be opened')
      }
    }
    const holder = new KeyHolder(store as unknown as ChatKeyStore, record)
    await holder
      .update(current => ({ ...current, pendingLinkId: 'clk_first' }))
      .catch(() => undefined)
    const second = await holder.update(current => ({
      ...current,
      pendingLinkId: 'clk_second'
    }))
    expect(saved.map(item => item.pendingLinkId)).deep.equals([
      'clk_first',
      'clk_second'
    ])
    expect(second.pendingLinkId).equals('clk_second')
  })
})
