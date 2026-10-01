import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { GameHeroCard } from './GameHeroCard'
import { teamTint } from './teamTile'

let root: Root | undefined
let host: HTMLElement | undefined

async function render(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

/** The tile around `letters`. */
function tileOf(container: HTMLElement, letters: string): HTMLElement {
  const tile = leaf(container, letters)?.parentElement
  if (tile == null) throw new Error(`no tile with ${letters}`)
  return tile
}

function leaf(container: HTMLElement, text: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('*')).find(
    node => node.children.length === 0 && node.textContent === text
  )
}

function hex(color: string): string {
  const parts = color.match(/\d+/g)?.slice(0, 3) ?? []
  return `#${parts.map(part => Number(part).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

const oct4 = {
  awayName: 'Badgers (Ripken)',
  homeName: 'Amber Gardens',
  awayScore: null,
  homeScore: null,
  status: 'LIVE',
  compact: true,
  date: 'SUN, OCT 4',
  awayTeamId: 'tem_UvWF6hQArBXKj30H',
  homeTeamId: 'tem_vShybFtE3zX82D8W',
  awayLogoUrl: 'https://example.com/badgers.png',
  homeLogoUrl: null
}

describe('GameHeroCard', function () {
  it('gives a side with no logo a tile of its initials in its team’s colour', async function () {
    const container = await render(<GameHeroCard {...oct4} />)
    const tile = tileOf(container, 'AG')
    expect(hex(getComputedStyle(tile).backgroundColor)).equals(
      teamTint('tem_vShybFtE3zX82D8W')
    )
  })

  it('keeps the picture for a side with a logo', async function () {
    const container = await render(<GameHeroCard {...oct4} />)
    expect(leaf(container, 'BR')).equals(undefined)
    expect(container.innerHTML).includes('badgers.png')
  })

  it('colours a tile by the name where there is no team id', async function () {
    const container = await render(
      <GameHeroCard {...oct4} awayLogoUrl={null} awayTeamId={undefined} />
    )
    const tile = tileOf(container, 'BR')
    expect(hex(getComputedStyle(tile).backgroundColor)).equals(
      teamTint('Badgers (Ripken)')
    )
  })

  it('opens a side’s team from its tile as well as its name', async function () {
    const opened: string[] = []
    const container = await render(
      <GameHeroCard
        {...oct4}
        onOpenAwayTeam={() => opened.push('away')}
        onOpenHomeTeam={() => opened.push('home')}
      />
    )
    const marks = Array.from(
      container.querySelectorAll<HTMLElement>('[aria-label="Amber Gardens"]')
    )
    expect(marks.length).at.least(1)
    await act(async () => {
      marks[0].click()
    })
    expect(opened).deep.equals(['home'])
  })
})
