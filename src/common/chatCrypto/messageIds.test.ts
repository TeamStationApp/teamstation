import { expect } from 'chai'
import { describe, it } from 'mocha'

import { isMessageId, MESSAGE_ID_PATTERN, newMessageId } from './messageIds'

describe('chatCrypto messageIds', () => {
  it('matches ^msg_[a-z2-7]{26}$, and 10,000 draws never repeat', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 10000; i++) {
      const id = newMessageId()
      expect(id).match(/^msg_[a-z2-7]{26}$/)
      seen.add(id)
    }
    expect(seen.size).equals(10000)
  })

  it('isMessageId accepts only that pattern', () => {
    expect(isMessageId(newMessageId())).equals(true)
    expect(isMessageId('msg_aaaaaaaaaaaaaaaaaaaaaaaaaa')).equals(true)
    for (const bad of [
      'msg_AAAAAAAAAAAAAAAAAAAAAAAAAA',
      'msg_aaaaaaaaaaaaaaaaaaaaaaaaa',
      'msg_aaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'msg_aaaaaaaaaaaaaaaaaaaaaaaaa1',
      'cnv_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      ' msg_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      42,
      null
    ]) {
      expect(isMessageId(bad), String(bad)).equals(false)
    }
    expect(MESSAGE_ID_PATTERN.source).equals('^msg_[a-z2-7]{26}$')
  })
})
