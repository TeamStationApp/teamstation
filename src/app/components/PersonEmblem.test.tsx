import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { mount, unmount } from '../../test/gameFormDom'
import { ListRow } from './ListRow'
import { PersonEmblem } from './PersonEmblem'
import { personTint } from './teamTile'

function rgb(hex: string): string {
  return `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
}
/** The leaf drawing `letters`. */
function letters(text: string): HTMLElement {
  const leaf = [...document.querySelectorAll<HTMLElement>('*')].find(
    node => node.children.length === 0 && node.textContent === text
  )
  if (leaf == null) throw new Error(`no tile ${text}`)
  return leaf
}
function pictures(): string[] {
  return [...document.querySelectorAll<HTMLImageElement>('img')].map(
    image => image.src
  )
}

describe('PersonEmblem', () => {
  afterEach(unmount)

  it('draws white initials of the shown name on the account’s colour, in a circle', async () => {
    await mount(<PersonEmblem userId="usr_ripken" name="Cal R" />)
    const leaf = letters('CR')
    expect(getComputedStyle(leaf).color).equals('rgb(255, 255, 255)')
    const tile = getComputedStyle(leaf.parentElement!)
    expect(tile.backgroundColor).equals(rgb(personTint('usr_ripken')!))
    expect(tile.borderTopLeftRadius).not.equals('0px')
  })

  it('draws the photo when there is one', async () => {
    await mount(
      <PersonEmblem
        userId="usr_ripken"
        name="Cal R"
        uri="https://images.example.test/ripken.png"
      />
    )
    expect(pictures().join(' ')).includes('ripken.png')
    expect(document.body.textContent).not.includes('CR')
  })

  it('gives a one-word name two letters', async () => {
    await mount(<PersonEmblem userId="usr_ichiro" name="Ichiro" />)
    letters('IC')
  })

  it('is another colour for another account with the same name, and one colour for one account under two names', async () => {
    await mount(
      <>
        <PersonEmblem userId="usr_smith" name="Josh S" />
        <PersonEmblem userId="usr_staumont" name="Josh S" />
        <PersonEmblem userId="usr_ripken" name="Cal Ripken" />
        <PersonEmblem userId="usr_ripken" name="C R" />
      </>
    )
    const tiles = (text: string): string[] =>
      [...document.querySelectorAll<HTMLElement>('*')]
        .filter(node => node.children.length === 0 && node.textContent === text)
        .map(leaf => getComputedStyle(leaf.parentElement!).backgroundColor)
    expect(tiles('JS')).deep.equals([
      rgb(personTint('usr_smith')!),
      rgb(personTint('usr_staumont')!)
    ])
    expect(tiles('CR')).deep.equals([
      rgb(personTint('usr_ripken')!),
      rgb(personTint('usr_ripken')!)
    ])
  })

  it('draws the theme’s neutral tile without an id', async () => {
    await mount(<PersonEmblem userId="" name="Cal R" />)
    const colours = [...document.querySelectorAll<HTMLElement>('*')].map(
      node => getComputedStyle(node).backgroundColor
    )
    expect(colours).not.includes(rgb(personTint('usr_ripken')!))
    letters('CR')
  })

  it('is what ListRow draws for a person, from the row’s title', async () => {
    await mount(
      <ListRow title="Cal Ripken" person={{ userId: 'usr_ripken' }} />
    )
    expect(document.body.textContent).includes('Cal Ripken')
    expect(
      getComputedStyle(letters('CR').parentElement!).backgroundColor
    ).equals(rgb(personTint('usr_ripken')!))
  })
})
