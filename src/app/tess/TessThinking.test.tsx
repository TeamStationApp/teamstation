import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { byTestId, click, render, unmount } from '../../test/tessTestKit'
import { TessThinking } from './TessThinking'

afterEach(unmount)

const STEPS = [
  { label: 'Reading: A team’s games, newest first', status: 'done' as const },
  {
    label: 'Not allowed: Tess may not use sign-in.',
    status: 'failed' as const
  },
  { label: 'Preparing a change for you to confirm', status: 'running' as const }
]

function row(): HTMLElement {
  return byTestId('Tess thought')!.querySelector<HTMLElement>(
    '[role="button"]'
  )!
}

describe("Tess's thinking row", () => {
  it('is closed once she is done, one line saying how long she thought, and opens to the summary and steps', async () => {
    await render(
      <TessThinking thinking="I read the games." steps={STEPS} seconds={12} />
    )
    expect(row().getAttribute('aria-label')).equals('Thought for 12s')
    expect(row().getAttribute('aria-expanded')).equals('false')
    expect(row().textContent).equals('auto_awesomeThought for 12schevron_right')
    expect(byTestId('Tess thought body')).equals(null)
    await click(row())
    expect(row().getAttribute('aria-expanded')).equals('true')
    expect(byTestId('Tess thought body')!.textContent).contains(
      'I read the games.'
    )
    const steps = [
      ...document.body.querySelectorAll<HTMLElement>(
        '[data-testid="Tess step"]'
      )
    ]
    expect(steps.map(step => step.getAttribute('aria-label'))).deep.equals([
      'Reading: A team’s games, newest first, done',
      'Not allowed: Tess may not use sign-in., failed',
      'Preparing a change for you to confirm, in progress'
    ])
    expect(steps[0].querySelector('[data-testid="Tess step done"]')).not.equals(
      null
    )
    expect(steps[1].textContent).contains('close')
    expect(steps[2].querySelector('[role="progressbar"]')).not.equals(null)
    await click(row())
    expect(byTestId('Tess thought body')).equals(null)
  })

  it('says "Thinking" for a reply from history, and opens to its steps alone', async () => {
    await render(<TessThinking steps={STEPS.slice(0, 1)} />)
    expect(row().getAttribute('aria-label')).equals('Thinking')
    await click(row())
    expect(byTestId('Tess thought body')!.textContent).equals(
      'Reading: A team’s games, newest first'
    )
  })

  it('is open with a spinner while she works, and shows nothing under it until she has told something', async () => {
    await render(<TessThinking live seconds={3} />)
    expect(row().getAttribute('aria-label')).equals('Thinking')
    expect(row().getAttribute('aria-expanded')).equals('true')
    expect(row().querySelector('[role="progressbar"]')).not.equals(null)
    expect(byTestId('Tess thought body')).equals(null)
  })
})
