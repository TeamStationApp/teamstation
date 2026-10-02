import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGameDetail,
  type DjBatter,
  GameStationClient
} from '../../common/api'
import type { WalkUpSong } from '../../common/walkUpSong'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { GameScreen } from '../screens/GameScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import { DjLineupRow, type DjLineupRowProps } from './DjLineupRow'

/**
 * U30: one DJ Game row — its layout, what each side of it does, and its
 * states — and the DJ Game button on the game screen.
 */
let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const text = (): string => document.body.textContent ?? ''
function labelled(label: string): HTMLElement | null {
  return document.querySelector(`[aria-label="${label}"]`)
}

const walk: WalkUpSong = {
  provider: 'localFile',
  providerId: 'lf:0123456789abcdef',
  isrc: null,
  title: 'Walk This Way',
  artist: 'Band',
  album: null,
  artworkUrl: null,
  durationMs: 90000,
  startMs: 5000,
  endMs: 20000
}
const tom: DjBatter = { userId: 1, name: 'Tom A', walkUpSong: walk }

async function render(element: React.ReactElement): Promise<void> {
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(20)
  })
}

async function row(
  props: Partial<DjLineupRowProps> = {}
): Promise<{ plays: number; missing: number; edits: number }> {
  const counts = { plays: 0, missing: 0, edits: 0 }
  await render(
    <DjLineupRow
      batter={tom}
      song={{ handle: 'h1' }}
      playing={false}
      onPlay={() => {
        counts.plays++
      }}
      onMissing={() => {
        counts.missing++
      }}
      onEdit={() => {
        counts.edits++
      }}
      {...props}
    />
  )
  return counts
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

describe('a DJ Game row (U30)', function () {
  it('puts the note left, the name on top and the song small and muted below', async function () {
    await row()
    const box = document.querySelector('[data-testid="DJ row"]')!
    const content = box.textContent ?? ''
    expect(content.indexOf('music_note')).lessThan(content.indexOf('Tom A'))
    expect(content.indexOf('Tom A')).lessThan(
      content.indexOf('Walk This Way · Band')
    )
    const line = document.querySelector('[data-testid="DJ song line"]')!
    const name = Array.from(box.querySelectorAll('div')).find(
      node =>
        node.textContent === 'Tom A' &&
        getComputedStyle(node).fontWeight === '600'
    ) as HTMLElement
    const small = Number.parseFloat(getComputedStyle(line).fontSize)
    const big = Number.parseFloat(getComputedStyle(name).fontSize)
    expect(small).lessThan(big)
    expect(getComputedStyle(line).color).not.equals(
      getComputedStyle(name).color
    )
    // One line, however long the title.
    expect(getComputedStyle(line).whiteSpace).equals('nowrap')
  })

  it('is a bone box with the Card shadow, on the outer wrapper', async function () {
    await row()
    const outer = document.querySelector('[data-testid="DJ row"]')!
    const style = getComputedStyle(outer)
    expect(style.backgroundColor).equals('rgb(245, 247, 241)')
    expect(style.boxShadow).not.equals('')
    expect(style.borderTopLeftRadius).equals('12px')
    // The inner box clips; the wrapper does not, so the shadow survives.
    const inner = getComputedStyle(outer.firstElementChild as HTMLElement)
    expect(style.overflowX).not.equals('hidden')
    expect(inner.overflowX).equals('hidden')
  })

  it('says so when there is no song, and hides the play button', async function () {
    await row({ batter: { ...tom, walkUpSong: null } })
    expect(text()).includes('No walk-up song')
    expect(labelled('Play Tom A’s walk-up song')).equals(null)
  })

  it('edits from the left only when it may', async function () {
    const counts = await row()
    labelled('Set Tom A’s walk-up song')?.click()
    expect(counts.edits).equals(1)
    expect(counts.plays).equals(0)
    await act(async () => {
      root?.unmount()
    })
    await row({ onEdit: undefined })
    expect(labelled('Set Tom A’s walk-up song')).equals(null)
  })

  it('plays from the right, and shows stop while playing', async function () {
    const counts = await row()
    labelled('Play Tom A’s walk-up song')?.click()
    expect(counts.plays).equals(1)
    expect(counts.edits).equals(0)
    await act(async () => {
      root?.unmount()
    })
    await row({ playing: true })
    expect(labelled('Stop Tom A’s walk-up song')).not.equals(null)
    expect(document.querySelector('[data-testid="DJ stop glyph"]')).not.equals(
      null
    )
    expect(document.querySelector('[data-testid="DJ play glyph"]')).equals(null)
  })

  it('names the batter at the plate, and draws a solid play mark', async function () {
    await row({ outline: 'steady' })
    expect(text()).includes('at bat')
    const mark = document.querySelector('[data-testid="DJ at bat"]')
    const name = document.querySelector('[data-testid="DJ row"]')!
    expect(mark?.parentElement?.textContent).includes('Tom A')
    const small = Number.parseFloat(
      getComputedStyle(mark as HTMLElement).fontSize
    )
    const big = Number.parseFloat(
      getComputedStyle(
        Array.from(name.querySelectorAll('div')).find(
          node => node.textContent === 'Tom A'
        ) as HTMLElement
      ).fontSize
    )
    expect(small).lessThan(big)
    const play = document.querySelector('[data-testid="DJ play glyph"]')!
    expect(getComputedStyle(play).borderLeftWidth).not.equals('0px')
  })

  it('dims a song not on this phone, and a tap asks for the toast', async function () {
    const counts = await row({ song: 'missing' })
    const play = labelled('Play Tom A’s walk-up song')!
    expect(Number(getComputedStyle(play).opacity)).lessThan(1)
    play.click()
    expect(counts.plays).equals(0)
    expect(counts.missing).equals(1)
  })

  it('does nothing while the song is still being looked for', async function () {
    const counts = await row({ song: 'resolving' })
    labelled('Play Tom A’s walk-up song')?.click()
    expect(counts.plays).equals(0)
    expect(counts.missing).equals(0)
  })
})

describe('the DJ Game button (U30)', function () {
  function client(
    canDj: boolean,
    status = gameFixture.status
  ): GameStationClient {
    const made = new GameStationClient({ baseUrl: '/api/v1' })
    made.game = async () =>
      asGameDetail({ ...gameFixture, canDj, canScore: true, status })
    made.teams = async () => []
    return made
  }

  it('comes after Score Game, for a songkeeper with music', async function () {
    let opened = 0
    await render(
      <GameScreen
        client={client(true)}
        gameId="g1"
        onDjGame={() => {
          opened++
        }}
        music={{ available: true }}
      />
    )
    const dj = labelled('DJ Game')
    expect(dj?.getAttribute('role')).equals('button')
    const all = text()
    const score = Math.max(
      all.indexOf('Score Game'),
      all.indexOf('Continue Scoring')
    )
    expect(score).greaterThan(-1)
    expect(all.indexOf('Box score')).lessThan(all.indexOf('Videos'))
    expect(all.indexOf('Videos')).lessThan(score)
    expect(score).lessThan(all.indexOf('DJ Game'))
    await act(async () => {
      dj?.click()
    })
    expect(opened).equals(1)
  })

  it('shows for any status, and never without canDj or music', async function () {
    for (const status of ['scheduled', 'inProgress', 'final']) {
      await render(
        <GameScreen
          client={client(true, status)}
          gameId="g1"
          onDjGame={() => undefined}
          music={{ available: true }}
        />
      )
      expect(labelled('DJ Game'), status).not.equals(null)
      await act(async () => {
        root?.unmount()
      })
    }
    for (const [canDj, available] of [
      [false, true],
      [true, false]
    ]) {
      await render(
        <GameScreen
          client={client(canDj)}
          gameId="g1"
          onDjGame={() => undefined}
          music={{ available }}
        />
      )
      expect(labelled('DJ Game'), `${canDj} ${available}`).equals(null)
      await act(async () => {
        root?.unmount()
      })
    }
    root = undefined
  })
})
