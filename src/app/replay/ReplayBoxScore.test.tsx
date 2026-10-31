import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import type {
  ReplayBoxScore as Box,
  ReplaySide
} from '../../common/replay/replayBoxScore'
import { render, unmount } from '../../test/tessTestKit'
import { openablePlayers } from './GameReplayScreen'
import { ReplayBoxScore } from './ReplayBoxScore'

/** A side of a nine-inning game, with one batter and one pitcher. */
function side(name: string, innings: number[]): ReplaySide {
  return {
    name,
    innings,
    runs: innings.reduce((sum, runs) => sum + runs, 0),
    hits: 4,
    errors: 1,
    batting: [
      {
        id: name.length,
        name: `${name} Batter`,
        ab: 4,
        r: 1,
        h: 2,
        rbi: 1,
        bb: 0,
        k: 1,
        sub: false,
        current: false
      }
    ],
    pitching: [
      {
        id: name.length + 100,
        name: `${name} Pitcher`,
        outs: 27,
        ip: '9.0',
        h: 4,
        r: 1,
        er: 1,
        bb: 2,
        k: 9,
        pc: 101,
        current: false
      }
    ]
  }
}

const nine: Box = {
  away: side('Harbor Hawks', [0, 0, 0, 0, 0, 0, 0, 0, 0]),
  home: side('Valley Pines', [0, 0, 1, 0, 0, 0, 0, 0, 0]),
  from: null
}

const leaves = (root: Element): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('*')].filter(
    node => node.children.length === 0
  )

describe('the replay box score', () => {
  afterEach(async () => {
    await unmount()
  })

  it('keeps the team names outside the scroll of innings and totals', async () => {
    await render(<ReplayBoxScore box={nine} />)
    const line = document.querySelector(
      '[data-testid="replay-box-score-line"]'
    )!
    const figures = document.querySelector<HTMLElement>(
      '[data-testid="replay-box-score-line-figures"]'
    )!
    expect(line.contains(figures)).equals(true)
    expect(getComputedStyle(figures).overflowX).not.equals('visible')
    for (const name of ['Harbor Hawks', 'Valley Pines']) {
      const cell = leaves(line).find(node => node.textContent === name)
      expect(cell, name).not.equals(undefined)
      expect(figures.contains(cell!), name).equals(false)
    }
    const inside = leaves(figures).map(node => node.textContent)
    for (const label of ['1', '7', '8', '9', 'R', 'H', 'E'])
      expect(inside, label).includes(label)
    // Each side's figures, in the row beside its name.
    const rows = [...figures.firstElementChild!.firstElementChild!.children]
    expect(rows.map(row => row.textContent)).deep.equals([
      '123456789RHE',
      '000000000041',
      '001000000141'
    ])
    // The names column has the same rows, every one of a fixed height in both
    // halves, so each name sits level with its figures.
    const names = line.firstElementChild!
    expect(names.contains(figures)).equals(false)
    expect([...names.children].map(row => row.textContent)).deep.equals([
      '',
      'Harbor Hawks',
      'Valley Pines'
    ])
    const heights = [...names.children, ...rows].map(
      row => getComputedStyle(row).height
    )
    expect(new Set(heights).size).equals(1)
  })

  it('ends each side’s batting and pitching with its totals, never the current line', async () => {
    const box: Box = {
      ...nine,
      away: {
        ...nine.away,
        batting: [
          ...nine.away.batting,
          { ...nine.away.batting[0], id: 77, name: 'Second', ab: 1, h: 1 }
        ],
        pitching: [
          { ...nine.away.pitching[0], outs: 4, ip: '1.1', pc: 20 },
          { ...nine.away.pitching[0], id: 78, outs: 5, ip: '1.2', pc: 31 }
        ]
      }
    }
    await render(<ReplayBoxScore box={box} />)
    const column = document.querySelector(
      '[data-testid="replay-box-score-column"]'
    )!
    const rows = [...column.querySelectorAll('div')].filter(
      node => node.firstElementChild?.textContent === 'Totals'
    )
    expect(rows.map(row => row.textContent)).deep.equals([
      // AB R H RBI BB K
      'Totals523202',
      // IP H R ER BB K PC
      'Totals3.082241851',
      'Totals412101',
      'Totals9.041129101'
    ])
    for (const row of rows) {
      expect(row.getAttribute('data-testid')).equals(null)
      // Last in its table: the next thing is a heading or nothing.
      expect(row.nextElementSibling?.firstElementChild?.textContent).not.equals(
        'Totals'
      )
    }
    const text = column.textContent ?? ''
    expect(text.indexOf('Second')).lessThan(text.indexOf('Totals523202'))
    expect(text.indexOf('Totals523202')).lessThan(
      text.indexOf('Harbor Hawks pitching')
    )
  })

  it('grows no totals line under a table with no lines', async () => {
    await render(
      <ReplayBoxScore
        box={{ ...nine, home: { ...nine.home, batting: [], pitching: [] } }}
      />
    )
    const column = document.querySelector(
      '[data-testid="replay-box-score-column"]'
    )!
    expect(
      [...column.querySelectorAll('div')].filter(
        node => node.firstElementChild?.textContent === 'Totals'
      )
    ).length(2)
  })

  it('leaves the batting and pitching tables as they were', async () => {
    await render(<ReplayBoxScore box={nine} />)
    const column = document.querySelector(
      '[data-testid="replay-box-score-column"]'
    )!
    const text = column.textContent ?? ''
    expect(text).includes('Harbor Hawks batting')
    expect(text).includes('Valley Pines pitching')
    expect(text).includes('Harbor Hawks Batter412101')
    expect(text).includes('Valley Pines Pitcher9.041129101')
    expect(
      column.querySelector('[data-testid="replay-box-score-line-figures"]')
    ).equals(null)
  })

  it('opens a name the reader may open, and leaves the rest as text', async () => {
    const opened: string[] = []
    await render(
      <ReplayBoxScore
        box={{
          ...nine,
          home: {
            ...nine.home,
            batting: [{ ...nine.home.batting[0], id: 77 }]
          }
        }}
        players={new Map([[nine.away.batting[0].id, 'usr_away']])}
        onOpenPlayer={userId => opened.push(userId)}
      />
    )
    const buttons = [...document.querySelectorAll('[role="button"]')].map(
      node => node.getAttribute('aria-label')
    )
    expect(buttons).deep.equals(['Open Harbor Hawks Batter'])
    document
      .querySelector<HTMLElement>('[aria-label="Open Harbor Hawks Batter"]')!
      .click()
    expect(opened).deep.equals(['usr_away'])
  })
})

describe('who a replay may open', () => {
  it('reads the box score’s own answer', () => {
    const line = (fields: object): any => ({
      userId: 'usr_1',
      gumboIds: [1],
      openable: true,
      ...fields
    })
    const players = openablePlayers({
      stats: undefined,
      batting: [
        line({}),
        line({ userId: null, gumboIds: [2] }),
        line({ userId: 'usr_3', gumboIds: [3], openable: false })
      ],
      pitching: [line({ userId: 'usr_5', gumboIds: [5] })]
    })
    expect([...players]).deep.equals([
      [1, 'usr_1'],
      [5, 'usr_5']
    ])
  })
})
