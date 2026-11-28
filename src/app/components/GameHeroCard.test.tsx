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
  it('labels pending approval in the status position and suppresses final scores and winner treatment', async function () {
    const container = await render(
      <GameHeroCard
        {...oct4}
        pendingApproval
        live
        awayScore={4}
        homeScore={0}
        status="FINAL"
        winner="away"
      />
    )
    expect(container.textContent).includes('Pending approval')
    expect(leaf(container, 'FINAL')).equals(undefined)
    expect(leaf(container, '4')).equals(undefined)
    expect(container.querySelector('[aria-label="Live now"]')).equals(null)
  })
  it('places a pending chip above a retained recording instead of a final-score overlay', async function () {
    const container = await render(
      <GameHeroCard
        {...oct4}
        compact={false}
        posterUrl="https://example.com/recording.png"
        pendingApproval
        awayScore={4}
        homeScore={0}
        status="FINAL"
      />
    )
    const chip = leaf(container, 'Pending approval')!.parentElement!
    expect(getComputedStyle(chip).position).equals('absolute')
    expect(getComputedStyle(chip).top).not.equals('')
    expect(container.textContent).not.includes('FINAL')
    expect(container.textContent).not.includes('Badgers (Ripken) 4')
  })
  it('gives a side with no logo a tile of its initials in its team id’s colour', async function () {
    const container = await render(<GameHeroCard {...oct4} />)
    const tile = tileOf(container, 'AG')
    expect(hex(getComputedStyle(tile).backgroundColor)).equals(
      teamTint(oct4.homeTeamId)
    )
  })

  it('shows a live game as the red live pill on the date’s line, and nowhere between the teams', async function () {
    const container = await render(<GameHeroCard {...oct4} live />)
    const pill = container.querySelector<HTMLElement>('[aria-label="Live now"]')
    if (pill == null) throw new Error('no live pill')
    expect(pill.textContent).equals('live')
    expect(leaf(container, 'LIVE')).equals(undefined)
    const date = leaf(container, 'SUN, OCT 4')
    if (date == null) throw new Error('no date')
    const row = pill.parentElement?.parentElement
    expect(row?.contains(date)).equals(true)
  })

  it('keeps the status chip for a game that is not live', async function () {
    const container = await render(<GameHeroCard {...oct4} status="FINAL" />)
    expect(container.querySelector('[aria-label="Live now"]')).equals(null)
    expect(leaf(container, 'FINAL')).not.equals(undefined)
  })

  it('keeps the picture for a side with a logo', async function () {
    const container = await render(<GameHeroCard {...oct4} />)
    expect(leaf(container, 'BR')).equals(undefined)
    expect(container.innerHTML).includes('badgers.png')
  })

  it('colours a tile by its team id', async function () {
    const container = await render(
      <GameHeroCard {...oct4} awayLogoUrl={null} />
    )
    const tile = tileOf(container, 'BR')
    expect(hex(getComputedStyle(tile).backgroundColor)).equals(
      teamTint(oct4.awayTeamId)
    )
  })

  it('draws a renamed team on the same colour', async function () {
    const container = await render(
      <GameHeroCard {...oct4} awayName="Demo Comets" awayLogoUrl={null} />
    )
    expect(
      hex(getComputedStyle(tileOf(container, 'DC')).backgroundColor)
    ).equals(teamTint(oct4.awayTeamId))
  })

  /** The rule above the summary: a top border on the card's last block. */
  function separators(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
      node => getComputedStyle(node).borderTopWidth === '1px'
    )
  }

  it('draws a member’s summary under a rule', async function () {
    const line = { h: 7, bb: 2, k: 3, hr: 1, e: 0, kDef: 4 }
    const container = await render(
      <GameHeroCard {...oct4} teamStats={{ away: line, home: null }} />
    )
    expect(container.textContent).includes('7 H · 2 BB · 3 K · 1 HR')
    // The summary's block is the one carrying the rule.
    expect(
      separators(container).some(node =>
        (node.textContent ?? '').startsWith('Badgers (Ripken)7 H')
      )
    ).equals(true)
  })

  for (const [why, teamStats] of [
    ['a non-member’s card, which is given none', null],
    ['a game whose plays were never counted', { away: null, home: null }]
  ] as const)
    it(`leaves out the summary and its rule for ${why}`, async function () {
      const withSummary = await render(
        <GameHeroCard
          {...oct4}
          teamStats={{
            away: { h: 7, bb: 2, k: 3, hr: 1, e: 0, kDef: 4 },
            home: null
          }}
        />
      )
      const ruled = separators(withSummary).length
      await act(async () => root?.unmount())
      host?.remove()
      const container = await render(
        <GameHeroCard
          {...oct4}
          awayScore={3}
          homeScore={5}
          status="FINAL"
          awayRecord="0–2"
          homeRecord="2–0"
          teamStats={teamStats}
        />
      )
      // The score and the records stay.
      for (const words of ['3', '5', 'Away · 0–2', 'Home · 2–0'])
        expect(leaf(container, words), words).not.equals(undefined)
      expect(container.textContent).not.includes(' H · ')
      expect(container.textContent).not.includes('Def:')
      expect(separators(container).length).equals(ruled - 1)
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

  describe('the game hero’s Live / Replay row', function () {
    const replay = {
      kind: 'replay' as const,
      label: 'Replay',
      onPress: () => undefined
    }
    const actions = <div data-testid="game-hero-actions">Score</div>

    for (const [layout, extra] of [
      ['compact', { compact: true }],
      [
        'poster',
        { compact: false, posterUrl: 'https://example.com/recording.png' }
      ]
    ] as const)
      it(`is the card’s last row, after the actions and centred, in the ${layout} layout`, async function () {
        const container = await render(
          <GameHeroCard
            {...oct4}
            {...extra}
            testID="event-hero"
            actions={actions}
            replay={replay}
          />
        )
        const card = container.querySelector<HTMLElement>(
          '[data-testid="event-hero"]'
        )!
        const children = Array.from(card.children)
        const row = children[children.length - 1] as HTMLElement
        expect(row.getAttribute('data-testid')).equals('game-hero-replay-row')
        expect(
          children[children.length - 2].getAttribute('data-testid')
        ).equals('game-hero-actions')
        expect(getComputedStyle(row).alignItems).equals('center')
        // The actions row holds it off what is above.
        expect(getComputedStyle(row).paddingTop).equals('0px')
        expect(getComputedStyle(row).paddingBottom).not.equals('0px')
        expect(
          row.querySelector('[data-testid="game-hero-replay"]')?.textContent
        ).equals('Replay')
      })

    it('takes a top inset of its own with no actions row above it', async function () {
      const container = await render(<GameHeroCard {...oct4} replay={replay} />)
      const row = container.querySelector<HTMLElement>(
        '[data-testid="game-hero-replay-row"]'
      )!
      expect(getComputedStyle(row).paddingTop).equals(
        getComputedStyle(row).paddingBottom
      )
    })

    it('leaves a live game’s status slot empty with no live label', async function () {
      const container = await render(
        <GameHeroCard {...oct4} live liveLabel={false} />
      )
      expect(container.querySelector('[aria-label="Live now"]')).equals(null)
      expect(leaf(container, 'LIVE')).equals(undefined)
    })

    it('keeps the inline live label by default, as the home screen draws it', async function () {
      const container = await render(<GameHeroCard {...oct4} live />)
      expect(container.querySelector('[aria-label="Live now"]')).not.equals(
        null
      )
      expect(
        container.querySelector('[data-testid="game-hero-replay-row"]')
      ).equals(null)
    })

    it('keeps a game that is not live its status chip with no live label', async function () {
      const container = await render(
        <GameHeroCard {...oct4} status="FINAL" liveLabel={false} />
      )
      expect(leaf(container, 'FINAL')).not.equals(undefined)
    })
  })
})
