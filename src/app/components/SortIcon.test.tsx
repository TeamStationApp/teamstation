import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { byTestId, render, unmount } from '../../test/tessTestKit'
import { SortIcon } from './SortIcon'

const RED = '#AA0000'
const RED_RGB = 'rgb(170, 0, 0)'

describe('SortIcon', () => {
  afterEach(async () => {
    await unmount()
    document.body.replaceChildren()
  })

  for (const glyph of ['AZ', 'ZA', '19', '91'] as const)
    it(`draws ${glyph} as its two characters with a caret above and below between them`, async () => {
      await render(<SortIcon glyph={glyph} color={RED} />)
      const icon = byTestId('sort-icon')!
      const texts = [...icon.querySelectorAll<HTMLElement>('[dir="auto"]')]
      expect(texts.map(text => text.textContent)).deep.equals([
        glyph[0],
        glyph[1]
      ])
      for (const text of texts)
        expect(getComputedStyle(text).color).equals(RED_RGB)
      // Up above down, both between the characters.
      const up = byTestId('sort-icon-up')!
      const down = byTestId('sort-icon-down')!
      expect(up.compareDocumentPosition(down)).equals(
        Node.DOCUMENT_POSITION_FOLLOWING
      )
      expect(texts[0].compareDocumentPosition(up)).equals(
        Node.DOCUMENT_POSITION_FOLLOWING
      )
      expect(down.compareDocumentPosition(texts[1])).equals(
        Node.DOCUMENT_POSITION_FOLLOWING
      )
      expect(icon.querySelectorAll('path')).length(2)
      for (const path of icon.querySelectorAll('path'))
        expect(path.getAttribute('stroke')).equals(RED)
      expect(icon.getAttribute('aria-hidden')).equals('true')
      expect(getComputedStyle(icon).height).equals('16px')
    })

  it('draws no sort as two arrows, in the colour it is given', async () => {
    await render(<SortIcon glyph="none" color={RED} />)
    const icon = byTestId('sort-icon')!
    expect(icon.querySelectorAll('[dir="auto"]')).length(0)
    const paths = icon.querySelectorAll('path')
    expect(paths).length(1)
    // An arrow up and an arrow down: two shafts and their heads.
    expect(paths[0].getAttribute('d')!.match(/M/g)).length(4)
    expect(paths[0].getAttribute('stroke')).equals(RED)
    expect(getComputedStyle(icon).width).equals('16px')
    expect(getComputedStyle(icon).height).equals('16px')
  })
})
