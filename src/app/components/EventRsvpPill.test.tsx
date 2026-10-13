import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { View } from 'react-native'

import type { RsvpChoice } from '../../common/eventInfo'
import { recordAnimationStarts, responderDrag } from '../../test/responderDrag'
import { ThemeProvider } from '../theme/ThemeContext'
import { EventRsvpPill } from './EventRsvpPill'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
async function render(disabled = false): Promise<string[]> {
  const choices: string[] = []
  function Harness(): React.ReactElement {
    const [value, setValue] = useState<RsvpChoice>(null)
    return (
      <EventRsvpPill
        userId={101}
        name="Babe Ruth"
        value={value}
        disabled={disabled}
        onChange={next => {
          choices.push(next)
          setValue(next)
        }}
      />
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
  })
  return choices
}
const region = (index: number): HTMLElement =>
  document.querySelector(`[data-testid="event-rsvp-101-${index}"]`)!
async function click(index: number): Promise<void> {
  await act(async () => {
    region(index).click()
  })
}
async function measure(width: number): Promise<void> {
  // JSDOM's ResizeObserver does not measure. Deliver the actual RN web layout callback.
  const track = document.querySelector(
    '[data-testid="event-rsvp-101"]'
  ) as unknown as {
    __reactLayoutHandler: (event: {
      nativeEvent: { layout: { width: number } }
    }) => void
  }
  await act(async () => {
    track.__reactLayoutHandler({ nativeEvent: { layout: { width } } })
  })
}
const fill = (): HTMLElement =>
  document.querySelector('[data-testid="event-rsvp-101-fill"]')!
describe('the independent RSVP capsule', () => {
  it('keeps a drag that strays well below the rail until it lets go', async () => {
    const choices = await render()
    await measure(300)
    // From No reply, two thirds of the way along and 150 px below the rail.
    await responderDrag(region(1), [
      [150, 10],
      [170, 12],
      [220, 90],
      [270, 160]
    ])
    expect(choices).deep.equals(['no'])
  })
  it('lets go short of another choice and slides back from where it was let go', async () => {
    const choices = await render()
    await measure(300)
    const animations = recordAnimationStarts()
    try {
      await responderDrag(region(1), [
        [150, 10],
        [170, 12],
        [180, 14]
      ])
    } finally {
      animations.restore()
    }
    expect(choices).deep.equals([])
    // Taken at x 170 and let go 10 px on, a tenth of the way past No reply:
    // it slides back from there, not from No reply itself.
    expect(animations.starts).deep.equals([1.1])
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 240))
    })
    expect(fill().style.transform).equals('translateX(100px)')
  })
  it('keeps its drag when a scrolling parent asks for it mid-way', async () => {
    const choices: string[] = []
    let asked = 0
    let taken = 0
    function Harness(): React.ReactElement {
      const [value, setValue] = useState<RsvpChoice>(null)
      return (
        <View
          onMoveShouldSetResponderCapture={() => ++asked > 1}
          onResponderGrant={() => {
            taken++
          }}
        >
          <EventRsvpPill
            userId={101}
            name="Babe Ruth"
            value={value}
            onChange={next => {
              choices.push(next)
              setValue(next)
            }}
          />
        </View>
      )
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <Harness />
        </ThemeProvider>
      )
    })
    await measure(300)
    await responderDrag(region(1), [
      [150, 10],
      [130, 12],
      [90, 90],
      [40, 200]
    ])
    expect(asked).greaterThan(1)
    expect(taken).equals(0)
    expect(choices).deep.equals(['yes'])
  })
  it('activates focused choices with Space, Enter and the legacy Spacebar key', async () => {
    const choices = await render()
    for (const [index, key] of [
      [0, ' '],
      [2, 'Enter'],
      [1, 'Spacebar']
    ] as const)
      await act(async () => {
        region(index).focus()
        region(index).dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true
          })
        )
      })
    expect(choices).deep.equals(['yes', 'no', 'maybe'])
  })
  it('supports Space and arrow navigation with one tab stop and disabled protection', async () => {
    const choices = await render()
    const key = async (index: number, key: string): Promise<void> => {
      await act(async () => {
        region(index).focus()
        region(index).dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true
          })
        )
      })
    }
    await key(1, ' ')
    expect(choices).deep.equals([])
    await key(1, 'ArrowLeft')
    expect(choices).deep.equals(['yes'])
    expect(document.activeElement).equals(region(0))
    expect(region(0).tabIndex).equals(0)
    expect(region(1).tabIndex).equals(-1)
    await key(0, 'ArrowLeft')
    expect(choices).deep.equals(['yes', 'no'])
    await key(2, 'ArrowUp')
    await key(1, 'ArrowRight')
    await key(2, 'Home')
    await key(0, 'End')
    await key(2, 'ArrowDown')
    await key(0, 'Escape')
    expect(choices).deep.equals([
      'yes',
      'no',
      'maybe',
      'no',
      'yes',
      'no',
      'yes'
    ])
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    const disabled = await render(true)
    await key(1, 'ArrowLeft')
    await key(0, ' ')
    expect(disabled).deep.equals([])
  })
  it('starts with No reply, changes center to Maybe, and offers accessible radio choices', async () => {
    const choices = await render()
    expect(region(1).getAttribute('aria-checked')).equals('true')
    expect(region(1).textContent).equals('No reply')
    await click(1)
    expect(choices).deep.equals([])
    await click(0)
    expect(region(1).textContent).equals('Maybe')
    expect(region(0).getAttribute('aria-checked')).equals('true')
    await click(1)
    await click(2)
    expect(choices).deep.equals(['yes', 'maybe', 'no'])
    expect(region(2).getAttribute('aria-checked')).equals('true')
    const track = document.querySelector(
      '[data-testid="event-rsvp-101"]'
    ) as unknown as {
      __reactLayoutHandler: (event: {
        nativeEvent: { layout: { width: number } }
      }) => void
    }
    await act(async () => {
      track.__reactLayoutHandler({ nativeEvent: { layout: { width: 216 } } })
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 220))
    })
    const fill = document.querySelector<HTMLElement>(
      '[data-testid="event-rsvp-101-fill"]'
    )!
    expect(getComputedStyle(fill).backgroundColor).equals('rgb(203, 57, 65)')
    expect(getComputedStyle(fill).transform).includes('144')
  })
  it('disables every choice during its own write', async () => {
    const choices = await render(true)
    await click(0)
    await click(2)
    expect(choices).deep.equals([])
    expect(region(0).getAttribute('aria-disabled')).equals('true')
  })
})
