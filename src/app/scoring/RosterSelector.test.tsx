import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { RosterSelector, rosterThumbWidth } from './RosterSelector'
let root: Root | undefined
let host: HTMLDivElement
const Harness = (): React.ReactElement => {
  const [value, setValue] = useState(0)
  return (
    <ThemeProvider>
      <RosterSelector
        labels={['Away', 'Home']}
        value={value}
        onChange={setValue}
      />
    </ThemeProvider>
  )
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    changeTheme(tsBallpark)
  })
  root = undefined
})
describe('roster selector', function () {
  it('sizes the thumb from the measured pill, not a percentage a phone misreads', function () {
    // Lineup / Defense on a Pixel: the pill measures 214 dp while the
    // row offered it 378 dp, and Yoga drew a `50%` thumb 189 dp wide.
    expect(rosterThumbWidth(214, 2, false)).equals(107)
    expect(rosterThumbWidth(214, 2, true)).equals(107)
    expect(rosterThumbWidth(300, 3, false)).equals(100)
    // Before the first layout a phone draws no thumb; the web's percentage
    // is resolved against the pill itself and is right from the start.
    expect(rosterThumbWidth(0, 2, false)).equals(0)
    expect(rosterThumbWidth(0, 2, true)).equals('50%')
    expect(rosterThumbWidth(0, 4, true)).equals('25%')
  })

  it('draws the web thumb over one segment before the pill is measured', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterSelector
            fitContent
            labels={['Lineup', 'Defense']}
            value={0}
            onChange={() => {}}
          />
        </ThemeProvider>
      )
    })
    const thumb = host.querySelector<HTMLElement>(
      '[data-testid="Roster selector thumb"]'
    )!
    expect(thumb.style.width).equals('50%')
    expect(thumb.style.position).equals('absolute')
  })

  it('names the roster screen’s three and four tabs by their words', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    for (const [labels, width] of [
      [['Roster', 'Lineup', 'Defense'], `${100 / 3}%`],
      [['Box Score', 'Roster', 'Lineup', 'Defense'], '25%']
    ] as const) {
      const chosen: number[] = []
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <RosterSelector
              fitContent
              labels={[...labels]}
              value={1}
              onChange={index => {
                chosen.push(index)
              }}
            />
          </ThemeProvider>
        )
      })
      const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      expect(tabs.map(tab => tab.getAttribute('aria-label'))).deep.equals(
        labels
      )
      expect(tabs.map(tab => tab.textContent)).deep.equals(labels)
      expect(tabs[1].getAttribute('aria-selected')).equals('true')
      expect(
        host.querySelector<HTMLElement>(
          '[data-testid="Roster selector thumb"]'
        )!.style.width
      ).equals(width)
      await act(async () => {
        tabs.at(-1)!.click()
      })
      expect(chosen).deep.equals([labels.length - 1])
    }
  })

  it('draws no thumb and selects no tab for a value of -1, and a tap or a drag still chooses', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const chosen: number[] = []
    const Chooser = (): React.ReactElement => {
      const [value, setValue] = useState(-1)
      return (
        <ThemeProvider>
          <RosterSelector
            fitContent
            labels={['Roster', 'Lineup', 'Defense']}
            value={value}
            onChange={index => {
              chosen.push(index)
              setValue(index)
            }}
          />
        </ThemeProvider>
      )
    }
    await act(async () => {
      root!.render(<Chooser />)
    })
    const thumb = (): HTMLElement | null =>
      host.querySelector<HTMLElement>('[data-testid="Roster selector thumb"]')
    const tabs = (): HTMLElement[] => [
      ...host.querySelectorAll<HTMLElement>('[role="tab"]')
    ]
    const selected = (): Array<string | null> =>
      tabs().map(tab => tab.getAttribute('aria-selected'))
    const colors = (): string[] =>
      tabs().map(tab => getComputedStyle(tab.firstElementChild!).color)
    expect(thumb()).equals(null)
    expect(selected()).deep.equals(['false', 'false', 'false'])
    // Every label in the idle colour: none is drawn as chosen.
    expect(new Set(colors()).size).equals(1)
    await act(async () => {
      tabs()[1].click()
    })
    expect(chosen).deep.equals([1])
    expect(selected()).deep.equals(['false', 'true', 'false'])
    expect(thumb()).not.equals(null)
    expect(new Set(colors()).size).equals(2)
    // From none, a drag across the pill chooses where it is let go.
    await act(async () => {
      root!.render(<Chooser key="again" />)
    })
    expect(thumb()).equals(null)
    const wrapper = host.firstElementChild!.firstElementChild as HTMLElement
    wrapper.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 300,
      height: 36,
      right: 300,
      bottom: 36,
      toJSON: () => ({})
    })
    for (const [type, x] of [
      ['pointerdown', 20],
      ['pointermove', 160],
      ['pointerup', 260]
    ] as const)
      await act(async () => {
        const event = new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: 10
        })
        Object.defineProperty(event, 'pointerId', { value: 1 })
        wrapper.dispatchEvent(event)
      })
    expect(chosen).deep.equals([1, 2])
    expect(selected()).deep.equals(['false', 'false', 'true'])
  })

  it('uses themed halves and supports tap, immediate swipe, child capture loss and cancellation', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<Harness />)
    })
    const wrapper = host.firstElementChild as HTMLElement
    wrapper.getBoundingClientRect = () => ({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      width: 320,
      height: 48,
      right: 330,
      bottom: 58,
      toJSON: () => ({})
    })
    const send = async (
      type: string,
      x: number,
      target: HTMLElement = wrapper
    ): Promise<void> => {
      await act(async () => {
        const e = new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: 20
        })
        Object.defineProperty(e, 'pointerId', { value: 1 })
        target.dispatchEvent(e)
      })
    }
    const tab = (name: string): HTMLElement =>
      host.querySelector(`[aria-label="${name}"]`)!
    for (const theme of [tsBallpark, tsDark]) {
      await act(async () => {
        changeTheme(theme)
      })
      expect(tab('Away').style.width).equals('50%')
      expect(tab('Home').style.width).equals('50%')
      expect(
        (wrapper.firstElementChild as HTMLElement).style.backgroundColor
      ).equals(
        theme.scoringSelectorIdle === '#D9DDD6'
          ? 'rgb(217, 221, 214)'
          : 'rgb(87, 93, 84)'
      )
      await act(async () => {
        tab('Home').click()
      })
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
      await act(async () => {
        tab('Away').click()
      })
      await send('pointerdown', 60, tab('Away'))
      await send('pointermove', 240)
      await send('lostpointercapture', 240, tab('Away'))
      await send('pointerup', 240)
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
      // A compatibility click cannot undo the swipe by activating its starting tab.
      await act(async () => {
        tab('Away').click()
      })
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
      await send('pointerdown', 240)
      await send('pointermove', 40)
      await send('pointercancel', 40)
      await send('pointerup', 40)
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
      await send('pointerdown', 240)
      await send('pointermove', 40)
      await send('lostpointercapture', 40)
      await send('pointerup', 40)
      expect(tab('Home').getAttribute('aria-selected')).equals('true')
    }
  })

  it('shows captions in their own row above the pill and names tabs apart from their text', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const changes: number[] = []
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterSelector
            labels={['Owls', 'Hawks']}
            captions={['Away', 'Home']}
            accessibilityLabels={['Away Team', 'Home Team']}
            value={0}
            onChange={value => changes.push(value)}
          />
        </ThemeProvider>
      )
    })
    const captions = host.querySelector(
      '[data-testid="Roster selector captions"]'
    )!
    expect(captions.textContent).equals('AwayHome')
    const cells = Array.from(captions.children) as HTMLElement[]
    expect(cells.map(cell => cell.style.width)).deep.equals(['50%', '50%'])
    // The caption row comes before the pill, outside it.
    const away = host.querySelector('[aria-label="Away Team"]')!
    expect(
      captions.compareDocumentPosition(away) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    expect(captions.contains(away)).equals(false)
    expect(away.textContent).equals('Owls')
    expect(host.querySelector('[aria-label="Home Team"]')!.textContent).equals(
      'Hawks'
    )
    expect(host.querySelector('[aria-label="Owls"]')).equals(null)
    await act(async () => {
      host.querySelector<HTMLElement>('[aria-label="Home Team"]')!.click()
    })
    expect(changes).deep.equals([1])
  })

  for (const name of ['Owls', ''])
    it(`keeps two tabs with the same label ${JSON.stringify(name)} apart`, async function () {
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      const warnings: unknown[] = []
      const error = console.error
      console.error = (...args: unknown[]) => {
        warnings.push(args)
      }
      const changes: number[] = []
      try {
        await act(async () => {
          root!.render(
            <ThemeProvider>
              <RosterSelector
                labels={[name, name]}
                captions={['Away', 'Home']}
                accessibilityLabels={['Away Team', 'Home Team']}
                value={0}
                onChange={value => changes.push(value)}
              />
            </ThemeProvider>
          )
        })
        const tabs = host.querySelectorAll('[role="tab"]')
        expect(tabs).length(2)
        await act(async () => {
          host.querySelector<HTMLElement>('[aria-label="Home Team"]')!.click()
        })
        await act(async () => {
          host.querySelector<HTMLElement>('[aria-label="Away Team"]')!.click()
        })
        expect(changes).deep.equals([1, 0])
        expect(
          warnings.filter(args => String(args).includes('same key'))
        ).deep.equals([])
      } finally {
        console.error = error
      }
    })
})
