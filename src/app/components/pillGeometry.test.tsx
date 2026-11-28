import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  TestComposer as Composer,
  type TestComposerProps as ComposerProps
} from '../chat/composer.test.helpers'
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

/** A glass tab's target: its label box and the padding above and below. */
function targetHeight(tab: HTMLElement): number {
  const style = getComputedStyle(tab)
  return (
    parseFloat(style.paddingTop) +
    parseFloat(labelBox(tab).height) +
    parseFloat(style.paddingBottom)
  )
}
function labelBox(tab: HTMLElement): CSSStyleDeclaration {
  return getComputedStyle(
    tab.querySelector<HTMLElement>('[data-testid="glass-tab-label"]')!
  )
}
function pillHeight(container: HTMLElement): string {
  return getComputedStyle(
    container.querySelector<HTMLElement>('[data-testid="glass-tab-pill"]')!
  ).height
}
/**
 * Lays out the selected tab, then checks that the strip's one pill reaches
 * past its label box by at least half the pill's height on each side.
 */
async function clearsPillArcs(
  container: HTMLElement,
  tab: HTMLElement
): Promise<void> {
  const width = 120
  await act(async () => {
    ;(
      tab as unknown as {
        __reactLayoutHandler: (event: {
          nativeEvent: {
            layout: { x: number; y: number; width: number; height: number }
          }
        }) => void
      }
    ).__reactLayoutHandler({
      nativeEvent: { layout: { x: 0, y: 0, width, height: 48 } }
    })
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  const pill = container.querySelector<HTMLElement>(
    '[data-testid="glass-tab-pill"]'
  )!
  const style = getComputedStyle(tab)
  const labelLeft = parseFloat(style.paddingLeft)
  const labelRight = width - parseFloat(style.paddingRight)
  const left = parseFloat(pill.style.left)
  const right = left + parseFloat(pill.style.width)
  const height = parseFloat(getComputedStyle(pill).height)
  expect(labelLeft - left, 'leading glyph clearance').at.least(height / 2)
  expect(right - labelRight, 'trailing glyph clearance').at.least(height / 2)
}

describe('pill label clearance', () => {
  for (const kind of ['edit', 'reply'] as const)
    it(`keeps the composer controls circular and its ${kind} context in a separate pill`, async () => {
      const context: ComposerProps['context'] =
        kind === 'edit'
          ? { kind }
          : { kind, name: 'Teammate', snippet: 'Practice time' }
      const container = await render(
        <Composer
          text="Practice time"
          onText={() => {}}
          enabled
          sending={false}
          context={context}
          onCancelContext={() => {}}
          attachments={[]}
          onRemoveAttachment={() => {}}
          sources={['photos', 'files']}
          onAttach={() => {}}
          onSend={() => {}}
        />
      )
      const toggle = container.querySelector<HTMLElement>(
        '[data-testid="chat-attachment-toggle"]'
      )!
      const field = container.querySelector<HTMLElement>(
        '[data-testid="chat-composer-field"]'
      )!
      const send = container.querySelector<HTMLElement>('[aria-label="Send"]')!
      const chip = container.querySelector<HTMLElement>(
        '[aria-label^="Cancel "]'
      )!.parentElement!
      for (const action of [toggle, send]) {
        const style = getComputedStyle(action)
        const diameter = parseFloat(style.height)
        expect(diameter).at.least(44)
        expect(parseFloat(style.width)).equals(diameter)
        expect(parseFloat(style.borderTopLeftRadius)).at.least(diameter / 2)
      }
      for (const pill of [field, chip])
        expect(parseFloat(getComputedStyle(pill).borderTopLeftRadius)).at.least(
          22
        )
      expect(field.querySelector('textarea')).not.equals(null)
      expect(field.querySelector('[aria-label="Emoji"]')).not.equals(null)
      const outer = field.parentElement!.parentElement!
      expect(['', '0px']).includes(getComputedStyle(outer).borderTopWidth)
      expect(getComputedStyle(outer).backgroundColor).equals('rgba(0, 0, 0, 0)')
    })
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
          expect(targetHeight(tab)).at.least(48)
          expect(labelBox(tab).height).equals(pillHeight(container))
        }
        await clearsPillArcs(container, tabs[0])
        await act(async () => {
          tabs[1].click()
        })
        expect(selected).equals('people')
      })
  it('small tabs keep shell clearance in 44-point targets that reach the midpoint', async () => {
    let selected = ''
    const container = await render(
      <PillTabs
        size="small"
        stacked
        selected="all"
        tabs={[
          { id: 'all', label: 'All seasons' },
          { id: 'spring', label: 'Spring Regular' }
        ]}
        onSelect={id => {
          selected = id
        }}
      />
    )
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
    const pad = pillPadding(32)
    for (const tab of tabs) {
      expect(targetHeight(tab)).equals(44)
      expect(labelBox(tab).height).equals('32px')
      // The pill's padding, then 4 of target past the pill on either side.
      expect(getComputedStyle(tab).paddingLeft).equals(`${pad + 4}px`)
      expect(getComputedStyle(tab).paddingRight).equals(`${pad + 4}px`)
    }
    expect(['', '0px']).includes(getComputedStyle(tabs[0].parentElement!).gap)
    await clearsPillArcs(container, tabs[0])
    await act(async () => {
      tabs[1].click()
    })
    expect(selected).equals('spring')
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
