import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  byLabel,
  click,
  manualClock,
  render,
  unmount
} from '../../test/tessTestKit'
import { HOLD_MS } from './HoldToConfirm'
import { TessChat } from './TessChat'
import type { TessChange, TessMessage } from './tessTypes'
import type { TessChatState } from './useTess'

afterEach(unmount)

const tess: TessChatState = {
  loading: false,
  messages: [],
  thinking: false,
  live: null,
  thoughtSeconds: {},
  error: null,
  send: async () => true,
  queued: [],
  sendNow: async () => undefined,
  unqueue: () => undefined,
  editQueued: () => null,
  upload: async () => null,
  confirmAll: async () => undefined,
  stop: async () => undefined,
  showError: () => undefined
}

describe("Tess's chat", () => {
  it('is titled "Ask Tess" after her icon at the top left, with the X at the right', async () => {
    let closed = 0
    const host = await render(
      <TessChat
        tess={tess}
        onClose={() => {
          closed++
        }}
        onNavigate={() => undefined}
      />
    )
    const title = host.querySelector<HTMLElement>('[role="heading"]')!
    expect(title.textContent).equals('Ask Tess')
    const heading = title.parentElement!
    // The icon, then the title, in the bar's first place; the X after them.
    expect(heading.firstElementChild!.textContent).equals('auto_awesome')
    expect(heading.nextElementSibling).equals(byLabel('Close Tess'))
    await click(byLabel('Close Tess'))
    expect(closed).equals(1)
  })

  it('shows each turn’s changes as one batch under its last reply, held once', async () => {
    const change = (id: string, date: string): TessChange => ({
      id,
      summary: `Add a game on ${date}`,
      method: 'POST',
      path: '/teams/t1/games',
      body: null,
      status: 'pending',
      details: [
        { label: 'Opponent', value: 'Demo Eagles' },
        { label: 'Date', value: date }
      ]
    })
    const message = (
      id: string,
      role: 'user' | 'assistant',
      text: string,
      changes: TessChange[] = []
    ): TessMessage => ({
      id,
      role,
      text,
      attachments: [],
      changes,
      createdAt: '2026-05-02T10:00:00.000Z'
    })
    const held: string[][] = []
    const clock = manualClock()
    try {
      await render(
        <TessChat
          tess={{
            ...tess,
            messages: [
              message('1', 'user', 'Schedule two games'),
              message('2', 'assistant', 'The first.', [
                change('g1', 'Sat May 22')
              ]),
              message('3', 'assistant', 'And the second.', [
                change('g2', 'Sat May 29')
              ]),
              message('4', 'user', 'And one more'),
              message('5', 'assistant', 'Here it is.', [
                change('g3', 'Sat Jun 5')
              ])
            ],
            confirmAll: async ids => {
              held.push(ids)
            }
          }}
          onClose={() => undefined}
          onNavigate={() => undefined}
        />
      )
      const replies = [
        ...document.body.querySelectorAll('[data-testid="Tess reply"]')
      ]
      const rows = (reply: Element): string[] =>
        [...reply.querySelectorAll('[data-testid="Tess change"]')].map(
          row => row.textContent ?? ''
        )
      expect(replies.map(rows)).deep.equals([
        [],
        ['Demo EaglesSat May 22', 'Demo EaglesSat May 29'],
        ['Demo EaglesSat Jun 5']
      ])
      const pill = replies[1].querySelector<HTMLElement>(
        '[aria-label="Hold to confirm"]'
      )!
      await act(async () => {
        pill.dispatchEvent(
          new window.MouseEvent('mousedown', { bubbles: true })
        )
        await new Promise(resolve => setTimeout(resolve, 80))
      })
      await clock.advance(HOLD_MS)
      expect(held).deep.equals([['g1', 'g2']])
    } finally {
      clock.restore()
    }
  })
})
