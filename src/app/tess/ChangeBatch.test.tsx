import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { View } from 'react-native'

import {
  byLabel,
  byTestId,
  click,
  type ManualClock,
  manualClock,
  render,
  unmount
} from '../../test/tessTestKit'
import { ChangeBatch } from './ChangeBatch'
import { HOLD_MS } from './HoldToConfirm'
import { TessOverlayHost, TessOverlayProvider } from './TessOverlay'
import type { TessChange } from './tessTypes'

let clock: ManualClock | undefined

const game = (
  id: string,
  date: string,
  status: TessChange['status'] = 'pending'
): TessChange => ({
  id,
  // The model's words disagree with what will run.
  summary: 'Rename the team to Comets',
  method: 'POST',
  path: '/teams/t1/games',
  body: { games: [{ opponent: { name: 'Demo Eagles' }, date }] },
  status,
  details: [
    { label: 'Opponent', value: 'Demo Eagles' },
    { label: 'Date', value: date },
    { label: 'Field', value: 'Demo Field' }
  ]
})
const GAMES = [
  game('g1', 'Sat May 22'),
  game('g2', 'Sat May 29'),
  game('g3', 'Sat Jun 5')
]
const FOLLOW: TessChange = {
  id: 'f1',
  summary: 'Follow Demo Hawks',
  method: 'DELETE',
  path: '/me/follows/team/t1',
  body: null,
  status: 'pending'
}

function texts(id: string): string[] {
  return [...document.body.querySelectorAll(`[data-testid="${id}"]`)].map(
    node => node.textContent ?? ''
  )
}

function toggle(): HTMLElement {
  return [
    ...document.body.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(node => node.textContent?.includes('Request details') === true)!
}

describe('ChangeBatch', function () {
  afterEach(async () => {
    await unmount()
    clock?.restore()
    clock = undefined
  })

  it('shows a reply’s changes as one table of plain words, with no request in sight', async function () {
    await render(<ChangeBatch changes={GAMES} onConfirmAll={() => undefined} />)
    expect(texts('Tess change table')).length(1)
    const table = byTestId('Tess change table')!
    expect(table.firstElementChild!.textContent).equals('OpponentDateField')
    expect(texts('Tess change')).deep.equals([
      'Demo EaglesSat May 22Demo Field',
      'Demo EaglesSat May 29Demo Field',
      'Demo EaglesSat Jun 5Demo Field'
    ])
    // Nothing of the request until it is asked for.
    expect(document.body.textContent).not.includes('/teams/t1/games')
    expect(document.body.textContent).not.includes('"opponent"')
    expect(texts('Tess change status')).deep.equals([])
    expect(toggle().getAttribute('aria-expanded')).equals('false')
  })

  it('opens the request of each change, method, path and body, and folds it again', async function () {
    await render(
      <ChangeBatch
        changes={[GAMES[0], FOLLOW]}
        onConfirmAll={() => undefined}
      />
    )
    // A change without details is a row of its summary, in a table of its own.
    expect(texts('Tess change table')).length(2)
    expect(texts('Tess change').at(-1)).equals('Follow Demo Hawks')
    await click(toggle())
    expect(toggle().getAttribute('aria-expanded')).equals('true')
    expect(texts('Tess change request')).deep.equals([
      'POST /teams/t1/games',
      'DELETE /me/follows/team/t1'
    ])
    // Only the change with a body shows one.
    expect(texts('Tess change body')).deep.equals([
      JSON.stringify(GAMES[0].body, null, 2)
    ])
    await click(toggle())
    expect(texts('Tess change request')).deep.equals([])
  })

  it('confirms every pending change, in order, with one full hold', async function () {
    const confirmed: string[][] = []
    clock = manualClock()
    await render(
      <ChangeBatch
        changes={[
          GAMES[0],
          game('g9', 'Sat Jun 12', 'expired'),
          ...GAMES.slice(1)
        ]}
        onConfirmAll={ids => confirmed.push(ids)}
      />
    )
    expect(texts('Tess hold')).length(1)
    await act(async () => {
      byLabel('Hold to confirm').dispatchEvent(
        new window.MouseEvent('mousedown', { bubbles: true })
      )
      await new Promise(resolve => setTimeout(resolve, 80))
    })
    await clock.advance(HOLD_MS - 1)
    expect(confirmed).deep.equals([])
    await clock.advance(1)
    expect(confirmed).deep.equals([['g1', 'g2', 'g3']])
  })

  it('takes no hold while Tess answers, says Confirming… while they run, and shows a Status column once any has ended', async function () {
    await render(
      <ChangeBatch
        changes={GAMES}
        onConfirmAll={() => undefined}
        holdDisabled
      />
    )
    expect(byLabel('Hold to confirm').getAttribute('aria-disabled')).equals(
      'true'
    )
    await unmount()
    await render(
      <ChangeBatch
        changes={GAMES.map(change => ({ ...change, status: 'running' }))}
        onConfirmAll={() => undefined}
      />
    )
    expect(byLabel('Confirming…').getAttribute('aria-disabled')).equals('true')
    expect(texts('Tess change status')).deep.equals([])
    await unmount()
    await render(
      <ChangeBatch
        changes={[
          game('g1', 'Sat May 22', 'done'),
          game('g2', 'Sat May 29', 'failed'),
          game('g3', 'Sat Jun 5', 'expired'),
          game('g4', 'Sat Jun 12', 'unknown')
        ]}
        onConfirmAll={() => undefined}
      />
    )
    expect(
      byTestId('Tess change table')!.firstElementChild!.textContent
    ).equals('OpponentDateFieldStatus')
    expect(texts('Tess change status')).deep.equals([
      'Done',
      'Failed',
      'Expired',
      'Check'
    ])
    expect(document.body.textContent).includes(
      'A change marked Check may or may not have run.'
    )
    expect(byTestId('Tess hold')).equals(null)
    await unmount()
    // One ended and one waiting: the column, and a hold for the other.
    await render(
      <ChangeBatch
        changes={[game('g1', 'Sat May 22', 'done'), GAMES[1]]}
        onConfirmAll={() => undefined}
      />
    )
    expect(texts('Tess change status')).deep.equals(['Done', ''])
    expect(byTestId('Tess hold')).not.equals(null)
    expect(document.body.textContent).not.includes('marked Check')
  })

  it('offers Expand only beside a pane, and opens the table over it', async function () {
    await render(<ChangeBatch changes={GAMES} onConfirmAll={() => undefined} />)
    expect(
      document.body.querySelector(
        '[aria-label="Expand the changes over the page"]'
      )
    ).equals(null)
    await unmount()
    await render(
      <TessOverlayProvider>
        <View testID="chat">
          <ChangeBatch changes={GAMES} onConfirmAll={() => undefined} />
        </View>
        <View testID="pane">
          <TessOverlayHost />
        </View>
      </TessOverlayProvider>
    )
    expect(byTestId('Tess overlay')).equals(null)
    await click(byLabel('Expand the changes over the page'))
    const overlay = byTestId('Tess overlay')!
    const frame = overlay.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).equals('')
    const page = frame.getAttribute('srcdoc')!
    expect(page).includes('<th>Opponent</th><th>Date</th><th>Field</th>')
    expect(page).includes('<td>Sat Jun 5</td>')
    await click(byLabel('Close'))
    expect(byTestId('Tess overlay')).equals(null)
  })
})
