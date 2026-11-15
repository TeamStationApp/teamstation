import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import type { PlanSyncCard } from './planInning'
import { PlanSyncNotice } from './PlanSyncNotice'

let root: Root | undefined
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

async function render(cards: PlanSyncCard[], pressed: string[]): Promise<void> {
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <PlanSyncNotice
          cards={cards}
          onRetry={card => pressed.push(`retry ${card.side}`)}
          onAccept={card => pressed.push(`accept ${card.side}`)}
        />
      </ThemeProvider>
    )
  })
}

const text = (): string | null | undefined =>
  document.querySelector('[data-testid="planSyncNotice"]')?.textContent

async function click(label: string): Promise<void> {
  const node = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(node, label).not.equals(null)
  await act(async () => {
    node?.click()
  })
}

describe('the plan sync card', function () {
  it('names the team, the away side’s first, and passes Try again and Accept on for that side', async function () {
    const pressed: string[] = []
    await render(
      [
        { side: 'home', inning: 2, teamName: 'Hawks' },
        { side: 'away', inning: 2, teamName: 'Owls' }
      ],
      pressed
    )
    expect(text()).equals(
      'Unable to sync new inning defensive lineup for OwlsAcceptTry again'
    )
    await click('Try again')
    await click('Accept')
    expect(pressed).deep.equals(['retry away', 'accept away'])
  })

  it('shows the home side’s card alone, and nothing with no card', async function () {
    await render([{ side: 'home', inning: 3, teamName: 'Hawks' }], [])
    expect(text()).includes('for Hawks')
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await render([], [])
    expect(text()).equals(undefined)
  })
})
