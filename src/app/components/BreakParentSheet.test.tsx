import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { find, mount, press, unmount } from '../../test/gameFormDom'
import { tsBallpark } from '../theme/tsBallpark'
import { BreakParentSheet } from './BreakParentSheet'

const preview = { effects: [], expected: {}, explanation: [], actions: [] }
describe('parent review cancellation', () => {
  afterEach(unmount)
  it('centers its blue Cancel and keeps dismissal separate from confirmation', async () => {
    let kept = 0
    let broken = 0
    await mount(
      <BreakParentSheet
        preview={preview}
        cancelLabel="Cancel"
        onKeep={() => {
          kept++
        }}
        onBreak={() => {
          broken++
        }}
      />
    )
    const cancel = find('Cancel')!
    expect(getComputedStyle(cancel).alignSelf).equals('center')
    expect(getComputedStyle(cancel.firstElementChild!).color).equals(
      'rgb(21, 101, 192)'
    )
    expect(tsBallpark.linkTextColor).equals('#1565C0')
    await press('Cancel')
    expect(kept).equals(1)
    expect(broken).equals(0)
  })
  it('disables cancellation and dismissal during a write', async () => {
    let kept = 0
    await mount(
      <BreakParentSheet
        preview={preview}
        cancelLabel="Cancel"
        busy
        onKeep={() => {
          kept++
        }}
        onBreak={() => {}}
      />
    )
    await press('Cancel')
    expect(
      document
        .querySelector('[aria-label="Keep relationship"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    expect(kept).equals(0)
  })
})
