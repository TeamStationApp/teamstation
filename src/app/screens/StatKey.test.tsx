import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { render, unmount } from '../../test/tessTestKit'
import { ThemeProvider } from '../theme/ThemeContext'
import { StatKey } from './StatKey'

const batting = [
  ['GP', 'Games played'],
  ['PA', 'Plate appearances'],
  ['AB', 'At bats'],
  ['AVG', 'Batting average'],
  ['OBP', 'On-base percentage'],
  ['OPS', 'On-base percentage plus slugging percentage'],
  ['SLG', 'Slugging percentage'],
  ['H', 'Hits'],
  ['1B', 'Single'],
  ['2B', 'Doubles'],
  ['3B', 'Triples'],
  ['HR', 'Home runs'],
  ['RBI', 'Runs batted in'],
  ['R', 'Runs scored'],
  ['BB', 'Base on balls (walks)'],
  ['SO', 'Strikeouts'],
  ['K-L', 'Strikeouts Looking'],
  ['HBP', 'Hit by pitch'],
  ['SAC', 'Sacrifice hits & bunts'],
  ['SF', 'Sacrifice flies'],
  ['ROE', 'Reached on error'],
  ['FC', "Hit into fielder's choice"],
  ['SB', 'Stolen bases'],
  ['SB%', 'Stolen base percentage'],
  ['CS', 'Caught stealing'],
  ['PIK', 'Picked off']
]
const pitching = [
  ['IP', 'Innings pitched'],
  ['GP', 'Games played'],
  ['GS', 'Games started'],
  ['BF', 'Batters faced'],
  ['#P', 'Pitches'],
  ['W', 'Wins'],
  ['L', 'Losses'],
  ['SV', 'Saves'],
  ['SVO', 'Save opportunities'],
  ['BS', 'Blown saves'],
  ['SV%', 'Save percentage'],
  ['H', 'Hits'],
  ['R', 'Runs scored'],
  ['ER', 'Earned runs'],
  ['BB', 'Base on balls (walks)'],
  ['SO', 'Strikeouts'],
  ['K-L', 'Strikeouts Looking'],
  ['HBP', 'Hit by pitch'],
  ['ERA', 'Earned run average'],
  ['WHIP', 'Walks and hits per inning pitched'],
  ['LOB', 'Runners left on base'],
  ['BK', 'Balks'],
  ['PIK', 'Picked off'],
  ['CS', 'Caught stealing'],
  ['SB', 'Stolen bases'],
  ['SB%', 'Stolen base percentage'],
  ['WP', 'Wild pitches'],
  ['BAA', 'Opponent batting average']
]
afterEach(unmount)
describe('stat keys', function () {
  for (const [kind, entries] of [
    ['batting', batting],
    ['pitching', pitching]
  ] as const) {
    it(`renders the exact ${kind} key down two columns with hanging meanings`, async function () {
      const host = await render(
        <ThemeProvider>
          <StatKey kind={kind} />
        </ThemeProvider>
      )
      const key = host.querySelector(`[data-testid="${kind}-stat-key"]`)!
      expect(key.children).has.length(2)
      for (let i = 0; i < 2; i++) {
        const rows = [...key.children[i].children]
        const expected = entries.slice(
          (i * entries.length) / 2,
          ((i + 1) * entries.length) / 2
        )
        expect(rows.map(row => row.textContent)).deep.equals(
          expected.map(([label, meaning]) => `${label} - ${meaning}`)
        )
        for (const row of rows) {
          const prefix = row.children[0] as HTMLElement
          const meaning = row.children[1] as HTMLElement
          expect((prefix.children[0] as HTMLElement).style.fontWeight).equals(
            '700'
          )
          expect(meaning.style.flex).equals('1 1 0%')
          expect(meaning.textContent).not.equals('')
        }
      }
    })
  }
})
