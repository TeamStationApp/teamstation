import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { render, unmount } from '../../test/tessTestKit'
import { replayBoxLabels } from './boxScoreLabels'
import { battingColumns, pitchingColumns } from './statColumns'
import { StatsKey } from './StatsKey'

describe('stats keys', function () {
  afterEach(unmount)
  for (const kind of ['batting', 'pitching'] as const) {
    it(`defines every ${kind} column in two columns filled left first`, async function () {
      await render(<StatsKey kind={kind} />)
      const key = document.querySelector(`[data-testid="${kind}-stats-key"]`)!
      const columns = [...key.children]
      const labels = columns.flatMap(column =>
        [...column.children].map(row => row.firstElementChild!.textContent)
      )
      expect(columns).has.length(2)
      expect(labels).deep.equals(
        (kind === 'batting' ? battingColumns : pitchingColumns).map(
          c => c.label
        )
      )
      expect(columns.map(column => column.children.length)).deep.equals(
        kind === 'batting' ? [13, 13] : [15, 14]
      )
      for (const column of columns)
        for (const row of [...column.children]) {
          expect(row.children).has.length(3)
          expect(row.children[1].textContent).equals(' - ')
          expect(row.children[2].textContent!.length).greaterThan(0)
          expect(getComputedStyle(row.children[0]).fontWeight).equals('700')
        }
      if (kind === 'batting')
        expect(key.textContent).includes(
          'OPS - On-base percentage plus slugging percentage'
        )
      else {
        expect(key.textContent).includes('#P - Number of pitches')
        expect(key.textContent).includes('S - Strikes')
      }
    })
  }
  it('defines every box-score column once in the shared bottom key', async function () {
    await render(<StatsKey kind="box" columns={replayBoxLabels} color="#fff" />)
    const key = document.querySelector('[data-testid="box-stats-key"]')!
    const labels = [...key.children].flatMap(column =>
      [...column.children].map(row => row.firstElementChild!.textContent)
    )
    expect(labels).deep.equals([
      'AB',
      'R',
      'H',
      'RBI',
      'BB',
      'SO',
      'IP',
      'ER',
      'HBP',
      '#P',
      'S',
      'E'
    ])
    expect(new Set(labels).size).equals(labels.length)
    expect([...key.children].map(column => column.children.length)).deep.equals(
      [6, 6]
    )
    for (const column of [...key.children])
      for (const row of [...column.children])
        expect(row.children[2].textContent!.length).greaterThan(0)
    expect(key.textContent).includes('E - Errors')
    expect(key.textContent).includes('#P - Number of pitchesS - Strikes')
    expect(
      getComputedStyle(key.children[0].children[0].children[0]).color
    ).equals('rgb(255, 255, 255)')
  })
  it('uses readable TV sizing for every part of every definition', async function () {
    await render(
      <StatsKey kind="box" columns={replayBoxLabels} fontSize={28} />
    )
    const key = document.querySelector('[data-testid="box-stats-key"]')!
    for (const column of [...key.children])
      for (const row of [...column.children])
        for (const cell of [...row.children])
          expect(getComputedStyle(cell).fontSize).equals('28px')
  })
})
