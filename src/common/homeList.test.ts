import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HOME_LIST_PREVIEW, windowHomeList } from './homeList'

const rows = ['a', 'b', 'c', 'd', 'e', 'f']

describe('windowHomeList', function () {
  it('shows five rows and a toggle when there are more', () => {
    const windowed = windowHomeList(rows, false)
    expect(windowed.rows).deep.equals(rows.slice(0, HOME_LIST_PREVIEW))
    expect(windowed.toggle).equals(true)
    expect(windowed.expanded).equals(false)
  })

  it('shows every row and no toggle when there are five or fewer', () => {
    for (const count of [0, 1, HOME_LIST_PREVIEW]) {
      const windowed = windowHomeList(rows.slice(0, count), false)
      expect(windowed.rows).deep.equals(rows.slice(0, count))
      expect(windowed.toggle).equals(false)
      expect(windowed.expanded).equals(false)
    }
  })

  it('shows every row when the section is expanded', () => {
    const windowed = windowHomeList(rows, true)
    expect(windowed.rows).deep.equals(rows)
    expect(windowed.toggle).equals(true)
    expect(windowed.expanded).equals(true)
    const short = windowHomeList(rows.slice(0, 2), true)
    expect(short.rows).deep.equals(rows.slice(0, 2))
    expect(short.toggle).equals(false)
  })
})
