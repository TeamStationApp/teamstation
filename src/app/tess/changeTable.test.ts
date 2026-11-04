import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  cellsOf,
  changeBatches,
  changeTableHtml,
  changeTables,
  columnsOf,
  columnWeights,
  escapeHtml,
  outcomeOf,
  showsStatus
} from './changeTable'
import type { TessChange, TessMessage } from './tessTypes'

const game = (
  id: string,
  date: string,
  status: TessChange['status'] = 'pending'
): TessChange => ({
  id,
  summary: `Add a home game against Demo Eagles on ${date}`,
  method: 'POST',
  path: '/teams/t1/games',
  body: { games: [{ opponent: { name: 'Demo Eagles' } }] },
  status,
  details: [
    { label: 'Opponent', value: 'Demo Eagles' },
    { label: 'Date', value: date },
    { label: 'Time', value: '10:00 AM' }
  ]
})

const follow: TessChange = {
  id: 'f1',
  summary: 'Follow Demo Hawks',
  method: 'PUT',
  path: '/me/follows/team/t1',
  body: null,
  status: 'pending'
}

function message(
  id: string,
  role: 'user' | 'assistant',
  changes: TessChange[] = []
): TessMessage {
  return {
    id,
    role,
    text: '',
    attachments: [],
    changes,
    createdAt: '2026-05-02T10:00:00.000Z'
  }
}

describe("Tess's change tables", () => {
  it('makes one table of a run of changes with the same labels, and another where they change', () => {
    const renamed: TessChange = {
      ...game('g4', 'Sat Jun 12'),
      details: [
        { label: 'Date', value: 'Sat Jun 12' },
        { label: 'Opponent', value: 'Demo Eagles' },
        { label: 'Time', value: '10:00 AM' }
      ]
    }
    const tables = changeTables([
      game('g1', 'Sat May 22'),
      game('g2', 'Sat May 29'),
      follow,
      { ...follow, id: 'f2', details: [] },
      game('g3', 'Sat Jun 5'),
      renamed
    ])
    expect(
      tables.map(table => [
        table.labels,
        table.changes.map(change => change.id)
      ])
    ).deep.equals([
      [
        ['Opponent', 'Date', 'Time'],
        ['g1', 'g2']
      ],
      // No details, or empty ones: a column of summaries.
      [[], ['f1', 'f2']],
      [['Opponent', 'Date', 'Time'], ['g3']],
      // The same labels in another order are another table.
      [['Date', 'Opponent', 'Time'], ['g4']]
    ])
    expect(changeTables([])).deep.equals([])
  })

  it('heads a table with its labels, or "Change" for summaries, and Status last when shown', () => {
    const [games, follows] = changeTables([game('g1', 'Sat May 22'), follow])
    expect(columnsOf(games, false)).deep.equals(['Opponent', 'Date', 'Time'])
    expect(columnsOf(games, true)).deep.equals([
      'Opponent',
      'Date',
      'Time',
      'Status'
    ])
    expect(columnsOf(follows, false)).deep.equals(['Change'])
    expect(cellsOf(game('g1', 'Sat May 22'))).deep.equals([
      'Demo Eagles',
      'Sat May 22',
      '10:00 AM'
    ])
    expect(cellsOf(follow)).deep.equals(['Follow Demo Hawks'])
  })

  it('weighs each column by its longest word, or half its longest text', () => {
    const [games] = changeTables([
      game('g1', 'Sat May 22'),
      {
        ...game('g2', 'Sat May 29'),
        details: [
          { label: 'Opponent', value: 'Demo Eagles of the Northern Valley' },
          { label: 'Date', value: 'Sat May 29' },
          { label: 'Time', value: '10:00 AM' }
        ]
      }
    ])
    // Half the long name (34) beats "Opponent"; half of "Sat May 22" beats
    // "Date" and "May"; "10:00", the longest word, beats half "10:00 AM".
    expect(columnWeights(games)).deep.equals([17, 5, 5])
    const [follows] = changeTables([{ ...follow, summary: '' }])
    expect(columnWeights(follows)).deep.equals([6])
  })

  it('shows the Status column once any change has ended', () => {
    expect(outcomeOf('pending')).equals(undefined)
    expect(outcomeOf('running')).equals(undefined)
    expect(
      (['done', 'failed', 'expired', 'unknown'] as const).map(outcomeOf)
    ).deep.equals(['Done', 'Failed', 'Expired', 'Check'])
    expect(showsStatus([follow, { ...follow, status: 'running' }])).equals(
      false
    )
    expect(showsStatus([follow, { ...follow, status: 'failed' }])).equals(true)
  })

  it('puts each turn’s changes under its last reply, a turn running from one message of the person’s to the next', () => {
    const batches = changeBatches([
      message('1', 'user'),
      message('2', 'assistant', [game('g1', 'Sat May 22')]),
      message('3', 'assistant', [game('g2', 'Sat May 29')]),
      // The report on a confirm is a reply of the same turn.
      message('4', 'assistant'),
      message('5', 'user'),
      message('6', 'assistant'),
      message('7', 'user'),
      message('8', 'assistant', [follow])
    ])
    expect(
      [...batches].map(([id, changes]) => [
        id,
        changes.map(change => change.id)
      ])
    ).deep.equals([
      ['4', ['g1', 'g2']],
      ['8', ['f1']]
    ])
    // A reply before any message of the person's still has its batch.
    expect([
      ...changeBatches([message('1', 'assistant', [follow])]).keys()
    ]).deep.equals(['1'])
  })

  it('writes the tables as HTML with every word escaped', () => {
    const hostile: TessChange = {
      ...game('g1', 'Sat <b>May</b> 22'),
      details: [
        { label: 'Opponent', value: '<img src=x onerror=alert(1)>' },
        { label: 'Date', value: 'Sat "May" 22 & \'later\'' },
        { label: 'Time', value: '10:00 AM' }
      ]
    }
    const html = changeTableHtml([
      hostile,
      game('g2', 'Sat May 29', 'done'),
      { ...follow, summary: 'Follow <script>x</script>' }
    ])
    expect(html).not.includes('<img')
    expect(html).not.includes('<script')
    expect(html).not.includes('<b>')
    expect(html).equals(
      [
        '<table style="margin:0 0 16px"><thead><tr><th>Opponent</th><th>Date</th><th>Time</th><th>Status</th></tr></thead><tbody>',
        '<tr><td>&lt;img src=x onerror=alert(1)&gt;</td><td>Sat &quot;May&quot; 22 &amp; &#39;later&#39;</td><td>10:00 AM</td><td></td></tr>',
        '<tr><td>Demo Eagles</td><td>Sat May 29</td><td>10:00 AM</td><td>Done</td></tr>',
        '</tbody></table>',
        '<table style="margin:0 0 16px"><thead><tr><th>Change</th><th>Status</th></tr></thead><tbody>',
        '<tr><td>Follow &lt;script&gt;x&lt;/script&gt;</td><td></td></tr>',
        '</tbody></table>'
      ].join('')
    )
    expect(escapeHtml('a&b')).equals('a&amp;b')
    // Pending only: no Status column.
    expect(changeTableHtml([follow])).equals(
      '<table style="margin:0 0 16px"><thead><tr><th>Change</th></tr></thead><tbody><tr><td>Follow Demo Hawks</td></tr></tbody></table>'
    )
  })
})
