import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  byLabel,
  byTestId,
  click,
  type ManualClock,
  manualClock,
  render,
  unmount
} from '../../test/tessTestKit'
import { ChangeCard } from './ChangeCard'
import type { TessChange } from './tessTypes'

let clock: ManualClock | undefined

const CHANGE: TessChange = {
  id: 'c1',
  // The model's words disagree with what will run.
  summary: 'Rename the team to Comets',
  method: 'POST',
  path: '/teams/t1/games',
  body: { opponent: 'Demo Eagles', startsAt: '2026-05-02T10:00:00Z' },
  status: 'pending'
}

describe('ChangeCard', function () {
  afterEach(async () => {
    await unmount()
    clock?.restore()
    clock = undefined
  })

  it('shows the stored method, path and body under the summary, even when the summary disagrees', async function () {
    await render(<ChangeCard change={CHANGE} onConfirm={() => undefined} />)
    const card = byTestId('Tess change')!
    expect(card.textContent).includes('Rename the team to Comets')
    expect(byTestId('Tess change request')!.textContent).equals(
      'POST /teams/t1/games'
    )
    expect(byTestId('Tess change body')!.textContent).equals(
      JSON.stringify(CHANGE.body, null, 2)
    )
  })

  it('folds the body away and back', async function () {
    await render(<ChangeCard change={CHANGE} onConfirm={() => undefined} />)
    const toggle = [
      ...document.body.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent?.includes('Request body') === true)!
    expect(toggle.getAttribute('aria-expanded')).equals('true')
    await click(toggle)
    expect(byTestId('Tess change body')).equals(null)
    expect(toggle.getAttribute('aria-expanded')).equals('false')
    await click(toggle)
    expect(byTestId('Tess change body')).not.equals(null)
  })

  it('has no body block for a change without one', async function () {
    await render(
      <ChangeCard
        change={{ ...CHANGE, method: 'DELETE', body: null }}
        onConfirm={() => undefined}
      />
    )
    expect(byTestId('Tess change request')!.textContent).equals(
      'DELETE /teams/t1/games'
    )
    expect(document.body.textContent).not.includes('Request body')
  })

  it('confirms its own change after a full hold', async function () {
    const confirmed: string[] = []
    clock = manualClock()
    await render(
      <ChangeCard change={CHANGE} onConfirm={id => confirmed.push(id)} />
    )
    await act(async () => {
      byLabel('Hold to confirm').dispatchEvent(
        new window.MouseEvent('mousedown', { bubbles: true })
      )
      await new Promise(resolve => setTimeout(resolve, 80))
    })
    await clock.advance(3000)
    expect(confirmed).deep.equals(['c1'])
  })

  it('holds only while pending; then says Confirming…, Done, Failed or Expired', async function () {
    await render(<ChangeCard change={CHANGE} onConfirm={() => undefined} />)
    expect(byLabel('Hold to confirm').getAttribute('aria-disabled')).not.equals(
      'true'
    )
    await unmount()
    await render(
      <ChangeCard
        change={{ ...CHANGE, status: 'running' }}
        onConfirm={() => undefined}
      />
    )
    expect(byLabel('Confirming…').getAttribute('aria-disabled')).equals('true')
    for (const [status, label] of [
      ['done', 'Done'],
      ['failed', 'Failed'],
      ['expired', 'Expired']
    ] as const) {
      await unmount()
      await render(
        <ChangeCard
          change={{ ...CHANGE, status }}
          onConfirm={() => undefined}
        />
      )
      expect(byTestId('Tess change status')!.textContent).equals(label)
      expect(byTestId('Tess hold')).equals(null)
    }
  })
})
