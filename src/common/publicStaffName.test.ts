import { expect } from 'chai'
import { describe, it } from 'mocha'

import { publicStaffName } from './publicStaffName'

describe('public staff names', () => {
  it('uses first name and one surname grapheme without serializing full names', () => {
    expect(publicStaffName({ firstName: 'Mike', lastName: 'Trout' })).equals(
      'Mike T.'
    )
    expect(publicStaffName({ displayName: '  Mike   Trout  ' })).equals(
      'Mike T.'
    )
    expect(publicStaffName({ displayName: 'Ichiro' })).equals('Ichiro')
    expect(
      publicStaffName({ firstName: 'José', lastName: 'A\u0301lvarez' })
    ).equals('José A\u0301.')
  })
  it('never exposes an email as a public name', () => {
    expect(publicStaffName({ displayName: 'hidden@example.com' })).equals(
      'Staff member'
    )
    expect(
      publicStaffName({ firstName: 'hidden@example.com', lastName: 'Secret' })
    ).equals('Staff member')
    expect(publicStaffName({})).equals('Staff member')
  })
})
