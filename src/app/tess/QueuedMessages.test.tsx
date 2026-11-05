import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { byTestId, click, render, unmount } from '../../test/tessTestKit'
import { QueuedMessages } from './QueuedMessages'
import type { QueuedMessage } from './tessQueue'

afterEach(unmount)

const QUEUED: QueuedMessage[] = [
  { id: 'q1', text: 'Who brings the snacks?', attachments: [], seq: 1 },
  {
    id: 'q2',
    text: '',
    attachments: [
      { id: 'a1', name: 'runs.csv', kind: 'csv', described: false }
    ],
    seq: 2,
    error: 'Tess is still answering another message.'
  }
]

function bubbles(): HTMLElement[] {
  return [
    ...document.body.querySelectorAll<HTMLElement>(
      '[data-testid="Tess queued"]'
    )
  ]
}

function button(bubble: HTMLElement, label: string): HTMLElement {
  const found = bubble.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (found == null) throw new Error(`No ${label}`)
  return found
}

describe('the queued messages', function () {
  it('draws nothing while none waits', async function () {
    await render(
      <QueuedMessages
        queued={[]}
        onSendNow={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
      />
    )
    expect(byTestId('Tess queue')).equals(null)
  })

  it('stacks each in order with "queued", an arrow, an X and why one failed', async function () {
    const pressed: string[] = []
    await render(
      <QueuedMessages
        queued={QUEUED}
        onSendNow={id => pressed.push(`now ${id}`)}
        onRemove={id => pressed.push(`remove ${id}`)}
        onEdit={id => pressed.push(`edit ${id}`)}
      />
    )
    const [first, second] = bubbles()
    expect(bubbles()).length(2)
    expect(first.textContent).equals(
      'Who brings the snacks?queuedclosearrow_upward'
    )
    // Files by name, and the failure in words.
    expect(second.textContent).includes('runs.csv')
    expect(
      second.querySelector('[data-testid="Tess queued error"]')!.textContent
    ).equals('Tess is still answering another message.')
    expect(first.querySelector('[data-testid="Tess queued error"]')).equals(
      null
    )
    for (const bubble of bubbles())
      for (const label of ['Send now', 'Remove from queue'])
        expect(button(bubble, label).getAttribute('role')).equals('button')

    await click(button(first, 'Send now'))
    await click(button(second, 'Remove from queue'))
    await click(button(first, 'Edit queued message: Who brings the snacks?'))
    // One of files only is named by them.
    await click(button(second, 'Edit queued message: runs.csv'))
    expect(pressed).deep.equals(['now q1', 'remove q2', 'edit q1', 'edit q2'])
  })
})
