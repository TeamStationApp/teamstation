import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { ContentInsetContext, useContentInset } from './contentInset'
import { PillTabs } from './PillTabs'
import { Screen } from './Screen'

let root: Root | undefined
let host: HTMLElement | undefined

async function render(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

/** A `#rrggbb` color as the DOM writes it back. */
function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

const TABS = [
  { id: 'past', label: 'Past' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'all', label: 'All' }
]

function strip(container: HTMLElement): {
  list: HTMLElement
  content: HTMLElement
} {
  const list = container.querySelector<HTMLElement>('[role="tablist"]')
  const content = list?.firstElementChild
  if (list == null || !(content instanceof HTMLElement)) {
    throw new Error('no pill strip')
  }
  return { list, content }
}

const pills = (
  <PillTabs tabs={TABS} selected="past" onSelect={() => undefined} />
)

describe('PillTabs', function () {
  it('runs out through the column’s padding, with its first pill on the margin', async function () {
    const container = await render(
      <ContentInsetContext.Provider value={{ left: 16, right: 20 }}>
        {pills}
      </ContentInsetContext.Provider>
    )
    const { list, content } = strip(container)
    expect(getComputedStyle(list).marginLeft).equals('-16px')
    expect(getComputedStyle(list).marginRight).equals('-20px')
    expect(getComputedStyle(content).paddingLeft).equals('16px')
    expect(getComputedStyle(content).paddingRight).equals('20px')
  })

  it('stays inside its panel when told not to bleed', async function () {
    const container = await render(
      <ContentInsetContext.Provider value={{ left: 16, right: 16 }}>
        <PillTabs
          bleed={false}
          tabs={TABS}
          selected="past"
          onSelect={() => undefined}
        />
      </ContentInsetContext.Provider>
    )
    const { list, content } = strip(container)
    expect(getComputedStyle(list).marginLeft).not.equals('-16px')
    expect(getComputedStyle(content).paddingLeft).equals(
      `${tsBallpark.rem(tsBallpark.spaceXsRem)}px`
    )
  })

  it('draws dense strips with smaller gaps and unchanged label clearance', async function () {
    const sides = async (dense: boolean): Promise<string[]> => {
      const container = await render(
        <PillTabs
          dense={dense}
          tabs={TABS}
          selected="past"
          onSelect={() => undefined}
        />
      )
      const { content } = strip(container)
      const row = content.firstElementChild as HTMLElement
      const pill = row.querySelector<HTMLElement>('[role="tab"] > div')!
      const style = getComputedStyle(pill)
      const drawn = [
        style.paddingLeft,
        style.minHeight,
        getComputedStyle(row).gap
      ]
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      host?.remove()
      return drawn
    }
    const rem = (value: number): string => `${tsBallpark.rem(value)}px`
    expect(await sides(false)).deep.equals([
      rem(1.125),
      rem(2.25),
      rem(tsBallpark.spaceSmRem)
    ])
    expect(await sides(true)).deep.equals([
      rem(1.125),
      rem(2.25),
      rem(tsBallpark.spaceXsRem)
    ])
  })

  it('draws small strips as the RSVP capsule, stacked with no gaps', async function () {
    const drawn = async (
      size: 'compact' | 'small',
      stacked: boolean
    ): Promise<string[]> => {
      const container = await render(
        <PillTabs
          size={size}
          stacked={stacked}
          tabs={TABS}
          selected="past"
          onSelect={() => undefined}
        />
      )
      const { content } = strip(container)
      const row = content.firstElementChild as HTMLElement
      const target = row.querySelector<HTMLElement>('[role="tab"]')!
      const pill = target.firstElementChild as HTMLElement
      const label = pill.querySelector<HTMLElement>('div[dir], span, div')!
      const result = [
        getComputedStyle(pill).height,
        getComputedStyle(pill).paddingLeft,
        getComputedStyle(target).minHeight,
        getComputedStyle(target).paddingLeft,
        getComputedStyle(row).gap,
        getComputedStyle(content).paddingTop,
        getComputedStyle(label).fontSize,
        getComputedStyle(row).marginLeft
      ]
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      host?.remove()
      return result
    }
    const rem = (value: number): string => `${tsBallpark.rem(value)}px`
    expect(await drawn('small', true)).deep.equals([
      '32px',
      rem(1.125),
      '44px',
      '4px',
      '0px',
      '0px',
      '12px',
      // Pulled out by a target's side: the first pill sits on the margin.
      '-4px'
    ])
    // Unstacked, a small strip keeps its room above and below.
    expect((await drawn('small', false))[5]).equals(rem(tsBallpark.spaceXsRem))
    // Compact strips are as they were.
    expect((await drawn('compact', false))[7]).equals('0px')
    expect((await drawn('compact', false)).slice(0, 5)).deep.equals([
      rem(2.25),
      rem(1.125),
      '48px',
      '0px',
      rem(tsBallpark.spaceSmRem)
    ])
  })

  it('puts a red dot before a live tab\u2019s label, and only there', async function () {
    const container = await render(
      <PillTabs
        tabs={[
          ...TABS,
          { id: 'live', label: 'Live', role: 'button', live: true }
        ]}
        selected="past"
        onSelect={() => undefined}
      />
    )
    const dots = container.querySelectorAll('[data-testid="pill-live-dot"]')
    expect(dots).length(1)
    const live = dots[0].closest('[role="button"]')
    expect(live?.textContent).equals('Live')
    expect(getComputedStyle(dots[0]).backgroundColor).equals(
      hexToRgb(tsBallpark.liveColor)
    )
  })

  it('keeps its own small inset where nothing pads it', async function () {
    const container = await render(pills)
    const { list, content } = strip(container)
    expect(getComputedStyle(list).marginLeft).not.match(/^-/)
    expect(getComputedStyle(content).paddingLeft).equals(
      `${tsBallpark.rem(tsBallpark.spaceXsRem)}px`
    )
  })
})

describe('Screen', function () {
  it('tells what is inside it how far its column is padded', async function () {
    let seen = { left: -1, right: -1 }
    function Probe(): null {
      seen = useContentInset()
      return null
    }
    await render(
      <Screen scroll={false}>
        <Probe />
      </Screen>
    )
    expect(seen.left).greaterThan(0)
    expect(seen.right).greaterThan(0)
  })
})
