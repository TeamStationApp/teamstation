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
