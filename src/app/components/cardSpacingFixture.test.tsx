import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { mount, press, settle, unmount } from '../../test/gameFormDom'
import { CardSpacingFixture } from './cardSpacingFixture'
import { teamTint } from './teamTile'

function rgb(hex: string): string {
  return `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
}

describe('the card spacing preview', () => {
  afterEach(unmount)

  it('draws its cards, each team tile on its id’s colour', async () => {
    await mount(<CardSpacingFixture />)
    await press('Cards')
    await settle()
    const tile = (letters: string): string => {
      const leaf = [...document.querySelectorAll<HTMLElement>('*')].find(
        node => node.children.length === 0 && node.textContent === letters
      )
      if (leaf?.parentElement == null) throw new Error(`no tile ${letters}`)
      return getComputedStyle(leaf.parentElement).backgroundColor
    }
    expect(document.body.textContent).includes('Comets')
    expect(tile('CF')).equals(rgb(teamTint('tem_copperFoxes')))
  })
})
