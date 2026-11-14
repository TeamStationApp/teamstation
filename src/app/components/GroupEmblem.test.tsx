import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { mount, unmount } from '../../test/gameFormDom'
import { GroupEmblem } from './GroupEmblem'
import { ListRow } from './ListRow'
import { leagueTint, seasonTint, TEAM_TINTS, teamTint } from './teamTile'

function rgb(hex: string): string {
  return `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
}
/** The tile drawing `letters`. */
function tile(letters: string): CSSStyleDeclaration {
  const leaf = [...document.querySelectorAll<HTMLElement>('*')].find(
    node => node.children.length === 0 && node.textContent === letters
  )
  if (leaf?.parentElement == null) throw new Error(`no tile ${letters}`)
  return getComputedStyle(leaf.parentElement)
}
function pictures(): string[] {
  return [...document.querySelectorAll<HTMLImageElement>('img')].map(
    image => image.src
  )
}

describe('GroupEmblem', () => {
  afterEach(unmount)

  it('draws a team on its id’s colour, as TeamEmblem does', async () => {
    await mount(<GroupEmblem kind="team" id="tem_hawks" name="Demo Hawks" />)
    expect(tile('DH').backgroundColor).equals(rgb(teamTint('tem_hawks')))
  })

  it('draws a league on its id’s colour, in white letters', async () => {
    await mount(
      <GroupEmblem kind="league" id="lea_lakeshore" name="Demo Lakeshore" />
    )
    expect(tile('DL').backgroundColor).equals(rgb(leagueTint('lea_lakeshore')))
    const leaf = [...document.querySelectorAll<HTMLElement>('*')].find(
      node => node.children.length === 0 && node.textContent === 'DL'
    )!
    expect(getComputedStyle(leaf).color).equals('rgb(255, 255, 255)')
  })

  it('draws a league’s picture when it has one', async () => {
    await mount(
      <GroupEmblem
        kind="league"
        id="lea_lakeshore"
        name="Demo Lakeshore"
        uri="https://images.example.test/league.png"
      />
    )
    expect(pictures().join(' ')).includes('league.png')
  })

  it('draws a season with no picture in its league’s picture', async () => {
    await mount(
      <GroupEmblem
        kind="season"
        id="sea_spring"
        leagueId="lea_lakeshore"
        name="Demo Spring"
        uri={null}
        leagueUri="https://images.example.test/league.png"
      />
    )
    expect(pictures().join(' ')).includes('league.png')
  })

  it('draws a season’s own picture over its league’s', async () => {
    await mount(
      <GroupEmblem
        kind="season"
        id="sea_spring"
        leagueId="lea_lakeshore"
        name="Demo Spring"
        uri="https://images.example.test/season.png"
        leagueUri="https://images.example.test/league.png"
      />
    )
    expect(pictures().join(' ')).includes('season.png')
    expect(pictures().join(' ')).not.includes('league.png')
  })

  it('draws a season with no picture anywhere as initials on its league’s colour, or its own without a league', async () => {
    await mount(
      <>
        <GroupEmblem
          kind="season"
          id="sea_spring"
          leagueId="lea_lakeshore"
          name="Demo Spring"
        />
        <GroupEmblem kind="season" id="sea_alone" name="Lone Fall" />
      </>
    )
    expect(tile('DS').backgroundColor).equals(rgb(leagueTint('lea_lakeshore')))
    expect(tile('LF').backgroundColor).equals(
      rgb(seasonTint({ id: 'sea_alone' }))
    )
  })

  it('draws a group with no id yet on the theme’s untinted tile', async () => {
    await mount(
      <>
        <GroupEmblem kind="team" id={null} name="Draft Team" />
        <GroupEmblem kind="season" id={null} name="Next Year" />
      </>
    )
    for (const letters of ['DT', 'NY'])
      expect(TEAM_TINTS.map(rgb)).not.includes(tile(letters).backgroundColor)
  })

  it('is the tile a ListRow draws for its group', async () => {
    await mount(
      <ListRow
        title="Demo Lakeshore"
        group={{ kind: 'league', id: 'lea_lakeshore', name: 'Demo Lakeshore' }}
      />
    )
    expect(tile('DL').backgroundColor).equals(rgb(leagueTint('lea_lakeshore')))
  })
})
