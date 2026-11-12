import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { fill, mount, settle, text, unmount } from '../../test/gameFormDom'
import { hasLabel, tapLabel } from '../../test/venueDom'
import { SpreadsheetNumber } from './SpreadsheetNumber'

describe('spreadsheet number editor', () => {
  afterEach(unmount)
  it('reselects the value after native focus has placed the caret at the end', async () => {
    await mount(
      <SpreadsheetNumber
        label="Maximum"
        value={200}
        maximum={200}
        onSave={async () => undefined}
      />
    )
    await tapLabel('Maximum: 200')
    const input = document.querySelector('input')!
    await act(async () => {
      input.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
      input.setSelectionRange(3, 3)
    })
    await settle()
    expect(input.selectionStart).equals(0)
    expect(input.selectionEnd).equals(3)
  })
  it('opens a selected numeric cell, validates it, and preserves failed edits for retry', async () => {
    let fail = true
    const saves: number[] = []
    await mount(
      <SpreadsheetNumber
        label="Maximum"
        value={2}
        maximum={200}
        onSave={async value => {
          if (fail) throw new Error('Try again')
          saves.push(value)
        }}
      />
    )
    expect(document.querySelector('input')).equals(null)
    await tapLabel('Maximum: 2')
    const input = document.querySelector('input')!
    expect(document.activeElement).equals(input)
    expect(input.inputMode).equals('numeric')
    expect(input.selectionStart).equals(0)
    expect(input.selectionEnd).equals(1)
    await fill('Maximum', '201')
    await act(async () => {
      input.blur()
    })
    expect(text()).includes('Choose a maximum')
    await fill('Maximum', '3')
    await act(async () => {
      input.focus()
      input.blur()
    })
    await settle()
    expect(text()).includes('Try again')
    expect(input.value).equals('3')
    fail = false
    await act(async () => {
      input.focus()
      input.blur()
    })
    await settle()
    expect(saves).deep.equals([3])
    expect(hasLabel('Maximum: 2')).equals(true)
  })
})
