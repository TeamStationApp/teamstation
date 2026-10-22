import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { pillPadding } from '../theme/pill'
import { ThemeProvider } from '../theme/ThemeContext'
import { Badge, type BadgeTone } from './Badge'
import { Button, type ButtonKind } from './Button'
import { PillTabs } from './PillTabs'
import { SectionHeader } from './SectionHeader'

let root: Root | undefined
let host: HTMLElement | undefined
async function render(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
})
function clearsArcs(node: Element): void {
  const style = getComputedStyle(node)
  const height = parseFloat(style.height)
  expect(height, 'explicit shell height').greaterThan(0)
  expect(parseFloat(style.paddingLeft), 'leading glyph clearance').at.least(
    height / 2
  )
  expect(parseFloat(style.paddingRight), 'trailing glyph clearance').at.least(
    height / 2
  )
}

describe('pill label clearance', () => {
  it('derives both regular and compact clearance from the shell height', () => {
    expect(pillPadding(48)).equals(24)
    expect(pillPadding(36)).equals(18)
  })
  for (const kind of ['primary', 'secondary', 'text'] as ButtonKind[])
    for (const compact of [false, true])
      it(`${kind} ${compact ? 'compact' : 'regular'} keeps a long label between its arcs`, async () => {
        let presses = 0
        const container = await render(
          <Button
            label="Save profile picture"
            kind={kind}
            compact={compact}
            small
            block
            icon="star"
            accessibilityLabel="Save picture"
            onPress={() => {
              presses++
            }}
          />
        )
        const button = container.querySelector('[role="button"]')!
        clearsArcs(button)
        await act(async () => {
          ;(button as HTMLElement).click()
        })
        expect(presses).equals(1)
      })
  it('keeps rounded corners and custom colours without shrinking clearance', async () => {
    const container = await render(
      <Button
        label="Save"
        shape="rounded"
        color="#123456"
        textColor="#ffffff"
        onPress={() => undefined}
      />
    )
    const button = container.querySelector('[role="button"]')!
    const style = getComputedStyle(button)
    expect(parseFloat(style.paddingLeft)).at.least(
      parseFloat(style.borderTopLeftRadius)
    )
    expect(style.backgroundColor).equals('rgb(18, 52, 86)')
  })
  for (const busyLabel of [undefined, 'Saving'])
    it(`busy button ${busyLabel ?? 'spinner'} is inert and retains its shell`, async () => {
      let presses = 0
      const container = await render(
        <Button
          label="Save"
          busy
          busyLabel={busyLabel}
          onPress={() => {
            presses++
          }}
        />
      )
      const button = container.querySelector('[role="button"]')!
      clearsArcs(button)
      await act(async () => {
        ;(button as HTMLElement).click()
      })
      expect(presses).equals(0)
      expect(button.getAttribute('aria-disabled')).equals('true')
    })
  it('disabled buttons cannot invoke their action', async () => {
    let presses = 0
    const container = await render(
      <Button
        label="Save"
        disabled
        onPress={() => {
          presses++
        }}
      />
    )
    const button = container.querySelector('[role="button"]')!
    clearsArcs(button)
    await act(async () => {
      ;(button as HTMLElement).click()
    })
    expect(presses).equals(0)
  })
  it('wraps descriptive badges without constraining their height', async () => {
    const container = await render(
      <Badge wrap label="First and Third Base: 1 required, 0 optional" />
    )
    const badge = container.firstElementChild!
    expect(getComputedStyle(badge).maxWidth).equals('100%')
    expect(getComputedStyle(badge).height).equals('auto')
    expect(parseFloat(getComputedStyle(badge).borderTopLeftRadius)).at.most(
      parseFloat(getComputedStyle(badge).paddingLeft)
    )
    expect(getComputedStyle(badge.firstElementChild!).whiteSpace).not.equals(
      'nowrap'
    )
  })
  for (const tone of [
    'win',
    'loss',
    'honour',
    'neutral',
    'live'
  ] as BadgeTone[])
    it(`${tone} badges clear their arcs`, async () => {
      const container = await render(<Badge label="1st Place" tone={tone} />)
      clearsArcs(container.firstElementChild!)
    })
  for (const size of ['regular', 'compact'] as const)
    for (const dense of [false, true])
      it(`${size} tabs ${dense ? 'with dense gaps' : ''} keep shell clearance and full targets`, async () => {
        let selected = ''
        const container = await render(
          <PillTabs
            size={size}
            dense={dense}
            selected="schedule"
            tabs={[
              { id: 'schedule', label: 'Schedule', badge: '13' },
              { id: 'people', label: 'People' }
            ]}
            onSelect={id => {
              selected = id
            }}
          />
        )
        const tabs = [
          ...container.querySelectorAll<HTMLElement>('[role="tab"]')
        ]
        for (const tab of tabs) {
          expect(parseFloat(getComputedStyle(tab).minHeight)).at.least(48)
          clearsArcs(tab.firstElementChild!)
        }
        await act(async () => {
          tabs[1].click()
        })
        expect(selected).equals('people')
      })
  it('count and header action pills have clear labels and 48-point action targets', async () => {
    let presses = 0
    const container = await render(
      <SectionHeader
        title="Players"
        note="7"
        actionPill
        actionLabel="Full Schedule"
        onAction={() => {
          presses++
        }}
        actions={[
          {
            label: 'Add',
            onPress: () => {
              presses++
            }
          }
        ]}
      />
    )
    const count = [...container.querySelectorAll('div')].find(
      node => node.textContent === '7' && node.children.length === 0
    )!
    clearsArcs(count.parentElement!)
    for (const target of container.querySelectorAll<HTMLElement>(
      '[role="button"]'
    )) {
      expect(parseFloat(getComputedStyle(target).minHeight)).at.least(48)
      clearsArcs(target.firstElementChild!)
      await act(async () => {
        target.click()
      })
    }
    expect(presses).equals(2)
  })
})
