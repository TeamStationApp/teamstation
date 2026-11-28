import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { View } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { ContentInsetContext, useContentInset } from './contentInset'
import { PillButton, PillFace, PillTabs } from './PillTabs'
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

  it('takes a style of its own after its bleed, and is unchanged without one', async function () {
    const margins = async (style?: { flexGrow: number }): Promise<string[]> => {
      const container = await render(
        <ContentInsetContext.Provider value={{ left: 16, right: 20 }}>
          <PillTabs
            tabs={TABS}
            selected="past"
            onSelect={() => undefined}
            style={style}
          />
        </ContentInsetContext.Provider>
      )
      const { list } = strip(container)
      const read = getComputedStyle(list)
      return [read.marginLeft, read.marginRight, read.flexGrow]
    }
    const plain = await margins()
    expect(plain.slice(0, 2)).deep.equals(['-16px', '-20px'])
    expect(await margins({ flexGrow: 0 })).deep.equals(['-16px', '-20px', '0'])
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
      const target = content.querySelector<HTMLElement>('[role="tab"]')!
      const label = target.querySelector<HTMLElement>(
        '[data-testid="glass-tab-label"]'
      )!
      const drawn = [
        getComputedStyle(target).paddingLeft,
        getComputedStyle(label).height
      ]
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      host?.remove()
      return drawn
    }
    const rem = (value: number): string => `${tsBallpark.rem(value)}px`
    // Half the 28 points between two labels, or 24 dense; the pill's own
    // height around each label either way.
    expect(await sides(false)).deep.equals([rem(0.875), rem(2.25)])
    expect(await sides(true)).deep.equals([rem(0.75), rem(2.25)])
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
      const box = target.querySelector<HTMLElement>(
        '[data-testid="glass-tab-label"]'
      )!
      const label = box.querySelector<HTMLElement>('div[dir]')!
      const pill = row.querySelector<HTMLElement>(
        '[data-testid="glass-tab-pill"]'
      )!
      const result = [
        getComputedStyle(box).height,
        getComputedStyle(pill).height,
        getComputedStyle(target).paddingTop,
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
      '32px',
      // A 44-point target: 6 above and below the 32-point pill.
      '6px',
      // The pill's padding and 4 more, with no gap to the next target.
      '20px',
      '',
      '0px',
      '12px',
      // Pulled out by a target's outer edge.
      '-4px'
    ])
    // Unstacked, a small strip keeps its room above and below.
    expect((await drawn('small', false))[5]).equals(rem(tsBallpark.spaceXsRem))
    expect(await drawn('compact', false)).deep.equals([
      rem(2.25),
      rem(2.25),
      // A 48-point target around the 36-point pill.
      '6px',
      rem(0.875),
      '',
      rem(tsBallpark.spaceXsRem),
      '14px',
      '0px'
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

  it('draws a pill’s icon before its label inside the pill, at the same height, and a pill without one as before', async function () {
    const container = await render(
      <>
        <PillButton
          label="With icon"
          testID="with-icon"
          icon={<View testID="the-icon" style={{ width: 16, height: 16 }} />}
        />
        <PillButton label="Without" testID="without" />
      </>
    )
    const withIcon = container.querySelector<HTMLElement>(
      '[data-testid="with-icon"]'
    )!
    const without = container.querySelector<HTMLElement>(
      '[data-testid="without"]'
    )!
    const face = withIcon.querySelector<HTMLElement>(
      '[data-testid="settings-pill-tab"]'
    )!
    const icon = face.querySelector('[data-testid="the-icon"]')!
    // Inside the pill, before the label.
    expect(icon.parentElement).equals(face)
    expect(face.firstElementChild).equals(icon)
    expect(face.lastElementChild!.textContent).equals('With icon')
    const plain = without.querySelector<HTMLElement>(
      '[data-testid="settings-pill-tab"]'
    )!
    expect(plain.childElementCount).equals(1)
    expect(plain.textContent).equals('Without')
    for (const key of ['height', 'minHeight', 'paddingLeft'] as const)
      expect(getComputedStyle(face)[key]).equals(getComputedStyle(plain)[key])
    expect(getComputedStyle(face).height).equals(`${tsBallpark.rem(2.25)}px`)
    // A 48-point target, unless the pill reaches past itself instead.
    expect(getComputedStyle(without).minHeight).equals(`${tsBallpark.rem(3)}px`)
  })

  it('draws a pill with a hit slop only as tall as the pill, and its face alone', async function () {
    const container = await render(
      <>
        <PillButton label="Flush" testID="flush" hitSlop={6} />
        <PillFace label="Face" selected={false} />
      </>
    )
    const flush = container.querySelector<HTMLElement>('[data-testid="flush"]')!
    expect(getComputedStyle(flush).minHeight).equals('0px')
    const faces = container.querySelectorAll<HTMLElement>(
      '[data-testid="settings-pill-tab"]'
    )
    expect(faces).length(2)
    expect(faces[1].closest('[role="button"]')).equals(null)
    expect(getComputedStyle(faces[1]).backgroundColor).equals(
      hexToRgb(tsBallpark.pillBackground)
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
