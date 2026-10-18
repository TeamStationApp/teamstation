import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import {
  SAMPLE_SCOREBOARD,
  SCOREBOARD_BOARD_SIZE,
  type ScoreboardState
} from '../../common/scoreboard'
import { fonts } from '../theme/fonts'
import { ScoreboardBoard, styles } from './ScoreboardBoard'
import { scoreboardTheme } from './scoreboardTheme'
import v1Styles from './v1ScoreboardStyles.json'

let root: Root | undefined
async function draw(
  state?: ScoreboardState,
  minWidth?: number
): Promise<HTMLElement> {
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(<ScoreboardBoard state={state} minWidth={minWidth} />)
  })
  return part('board')
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

interface Fiber {
  type: unknown
  memoizedProps: Record<string, unknown>
  child: Fiber | null
  sibling: Fiber | null
  return: Fiber | null
}

function part(name: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    `[data-scoreboard="${name}"]`
  )
  if (node == null) throw new Error(`no ${name}`)
  return node
}
function lit(name: string): boolean[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-scoreboard="${name}"]`)
  ).map(node => node.dataset.lit === 'true')
}
/** A property's value as the page's style sheets and inline style give it. */
function css(node: HTMLElement, property: string): string {
  return getComputedStyle(node).getPropertyValue(property)
}

describe('ScoreboardBoard', function () {
  it('draws the sample: 2-1, one out, second base, P: 64, VISITORS 2 and PIONEERS 3', async function () {
    await draw(SAMPLE_SCOREBOARD)
    expect(part('count').textContent).equals('2-1')
    expect(lit('out')).deep.equals([true, false])
    expect([lit('base1')[0], lit('base2')[0], lit('base3')[0]]).deep.equals([
      false,
      true,
      false
    ])
    expect(part('pitches').textContent).equals('P: 64')
    expect(part('awayTeam').textContent).equals('VISITORS')
    expect(part('awayScore').textContent).equals('2')
    expect(part('homeTeam').textContent).equals('PIONEERS')
    expect(part('homeScore').textContent).equals('3')
    expect(part('batter').textContent).equals('A. RIVERA')
    expect(part('batterLine').textContent).equals('1-3')
    expect(part('pitcher').textContent).equals('J. WILSON')
    expect(part('inning').textContent).equals('5')
    expect(part('top').dataset.lit).equals('true')
    expect(part('bottom').dataset.lit).equals('false')
    // 1.0 keeps the pitch-speed slot at 0 so the bases never move, and
    // shows nothing in it.
    expect(part('pitchSpeed').dataset.lit, 'no pitch speed at 0').equals(
      'false'
    )
    expect(css(part('pitchSpeed'), 'opacity')).equals('0')
  })

  it('shows a pitch speed above 0', async function () {
    await draw({ ...SAMPLE_SCOREBOARD, pitchSpeed: 71, half: 'bottom' })
    expect(part('pitchSpeed').textContent).equals('71MPH')
    expect(part('pitchSpeed').dataset.lit).equals('true')
    expect(css(part('pitchSpeed'), 'opacity')).not.equals('0')
    expect(part('bottom').dataset.lit).equals('true')
  })

  it('draws teams, score and count before the game has started', async function () {
    const board = await draw({
      ...SAMPLE_SCOREBOARD,
      inGame: false,
      balls: 0,
      strikes: 0,
      outs: 2
    })
    expect(board.dataset.drawn).equals('true')
    expect(part('awayTeam').textContent).equals('VISITORS')
    expect(part('homeScore').textContent).equals('3')
    expect(part('count').textContent).equals('0-0')
    expect(lit('out')).deep.equals([true, true])
  })

  it('leaves out the batter and pitcher rows when nobody is named, as 1.0 did', async function () {
    await draw({ ...SAMPLE_SCOREBOARD, batterName: ' ', pitcherName: '' })
    expect(document.querySelector('[data-scoreboard="batter"]')).equals(null)
    expect(document.querySelector('[data-scoreboard="pitches"]')).equals(null)
    expect(part('count').textContent).equals('2-1')
  })

  it("draws a long team name in 1.0's own text style", async function () {
    const name = 'X'.repeat(40)
    const board = await draw({
      ...SAMPLE_SCOREBOARD,
      homeTeam: name,
      awayTeam: 'A',
      batterName: name,
      pitcherName: name
    })
    // 1.0's card has no size of its own: the rows set it.
    expect(board.style.width).equals('')
    expect(board.style.height).equals('')
    expect(css(part('homeTeam'), 'text-overflow')).equals('clip')
    expect(part('homeTeam').textContent).equals(name)
    expect(part('awayTeam').textContent).equals('A')
    expect(part('batter').textContent).equals(name)
    expect(part('pitcher').textContent).equals(name)
  })

  it('has B of 607 × 247, the size 1.0 drew the sample at in a 1080-high window', function () {
    expect(SCOREBOARD_BOARD_SIZE).deep.equals({ width: 607, height: 247 })
  })

  it("keeps 1.0's styles except the pitch-speed font sized to fit two wide digits", function () {
    // Recorded from 1.0's own `getStyles(tsDark)` (`src/client/Scoreboard.tsx` at 25f9496e
    // at v1.0.0) in a 1920 × 1080 window. Only the "waiting for game data"
    // card's styles are gone, with the card, and 1.0's Helvetica Neue is the
    // bundled Inter (Paul, 2026-10-16: never a system font), named as this
    // platform names it: on the web with its fallback for a missing file.
    const { noGameContainer, noGameText, noGameSubtext, ...drawn } = v1Styles
    expect([noGameContainer, noGameText, noGameSubtext]).to.not.include(
      undefined
    )
    const named = JSON.parse(
      JSON.stringify(drawn).replaceAll('"Inter"', JSON.stringify(fonts.inter))
    ) as typeof drawn
    expect(JSON.parse(JSON.stringify(styles))).deep.equals({
      ...named,
      pitchSpeedNumber: {
        ...named.pitchSpeedNumber,
        fontSize: scoreboardTheme.rem(2.125)
      }
    })
  })

  it('keeps its team bars from their names, never narrower than asked, for the overlay', async function () {
    const board = await draw(
      { ...SAMPLE_SCOREBOARD, awayTeam: '', homeTeam: '' },
      SCOREBOARD_BOARD_SIZE.width
    )
    expect(css(board, 'min-width')).equals(`${SCOREBOARD_BOARD_SIZE.width}px`)
    // A phone starts a `flex: 1` box from nothing; these start from their
    // names, so an empty name keeps its bar and a long one widens the board.
    const bars = [part('awayTeam'), part('homeTeam')].map(
      name => name.parentElement!
    )
    for (const bar of [...bars, bars[0].parentElement?.parentElement]) {
      expect(
        ['flex-grow', 'flex-shrink', 'flex-basis'].map(key => css(bar!, key))
      ).deep.equals(['1', '1', 'auto'])
    }
    expect(part('awayTeam').textContent).equals('')
  })

  it('leaves its own sizing alone with no least width', async function () {
    const board = await draw(SAMPLE_SCOREBOARD)
    expect(css(board, 'min-width')).not.equals(
      `${SCOREBOARD_BOARD_SIZE.width}px`
    )
    expect(css(part('awayTeam').parentElement!, 'flex-basis')).not.equals(
      'auto'
    )
  })

  it('letters the board at its own sizes, whatever size a phone sets text to', async function () {
    const board = await draw(SAMPLE_SCOREBOARD)
    // Every text React drew, from the fibers above the board's parts.
    const key = Object.keys(board).find(one => one.startsWith('__reactFiber'))!
    let fiber = (board as unknown as Record<string, unknown>)[key] as Fiber
    while (fiber.return != null) fiber = fiber.return
    const texts: Array<Record<string, unknown>> = []
    const visit = (one: Fiber | null): void => {
      for (let child = one; child != null; child = child.sibling) {
        if (child.type === Text) texts.push(child.memoizedProps)
        visit(child.child)
      }
    }
    visit(fiber)
    expect(texts.length).greaterThan(8)
    expect(texts.filter(one => one.allowFontScaling !== false)).deep.equals([])
  })

  it('paints nothing but keeps the box with no state', async function () {
    const board = await draw(undefined)
    expect(board.dataset.drawn).equals('false')
    expect(board.children).length(0)
    expect(css(board, 'width')).equals(`${SCOREBOARD_BOARD_SIZE.width}px`)
    expect(css(board, 'height')).equals(`${SCOREBOARD_BOARD_SIZE.height}px`)
  })
})
