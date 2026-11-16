import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { mount, unmount } from '../../test/gameFormDom'
import { hasLabel, tapLabel } from '../../test/venueDom'
import { VerticalToggle } from './VerticalToggle'

const OPTIONS = [
  { value: 'weekend', label: 'Weekend' },
  { value: 'weekdays', label: 'Weekday' }
] as const

type Days = (typeof OPTIONS)[number]['value']

async function toggle(
  props: { value: Days; locked?: Days; disabled?: boolean },
  chosen: Days[]
): Promise<HTMLElement> {
  await mount(
    <VerticalToggle
      label="Preferred days"
      options={OPTIONS}
      {...props}
      onChange={next => {
        chosen.push(next)
      }}
    />
  )
  return document.querySelector<HTMLElement>('[role="switch"]')!
}

describe('the vertical toggle', () => {
  afterEach(unmount)

  it('shows both labels inside it and moves to the other end on a tap', async () => {
    const chosen: Days[] = []
    const node = await toggle({ value: 'weekend' }, chosen)
    expect(node.textContent).equals('WeekendWeekday')
    expect(node.getAttribute('aria-checked')).equals('false')
    await tapLabel('Preferred days: Weekend')
    expect(chosen).deep.equals(['weekdays'])
  })

  it('reads the bottom end as on', async () => {
    const chosen: Days[] = []
    const node = await toggle({ value: 'weekdays' }, chosen)
    expect(hasLabel('Preferred days: Weekday')).equals(true)
    expect(node.getAttribute('aria-checked')).equals('true')
    await tapLabel('Preferred days: Weekday')
    expect(chosen).deep.equals(['weekend'])
  })

  for (const [locked, shown] of [
    ['weekdays', 'Weekend'],
    ['weekend', 'Weekday']
  ] as const)
    it(`sits on ${shown}, greyed out, with ${locked} locked`, async () => {
      const chosen: Days[] = []
      // Whatever is stored, the locked end can't be shown.
      const node = await toggle({ value: locked, locked }, chosen)
      expect(hasLabel(`Preferred days: ${shown}`)).equals(true)
      expect(node.getAttribute('aria-disabled')).equals('true')
      await act(async () => {
        node.click()
      })
      expect(chosen).deep.equals([])
    })

  it('does nothing when disabled', async () => {
    const chosen: Days[] = []
    const node = await toggle({ value: 'weekend', disabled: true }, chosen)
    await act(async () => {
      node.click()
    })
    expect(chosen).deep.equals([])
  })
})
