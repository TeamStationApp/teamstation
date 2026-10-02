import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { OutcomeControls } from './OutcomeControls'
import { OutcomePicker, PRIMARY_OUTCOMES } from './OutcomePicker'
import { OutcomePicker as NativePicker } from './OutcomePicker.native'
let root: Root | undefined
function button(label: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(node, label).not.equals(null)
  return node!
}
async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
}
async function mount(onChoose: (outcome: string) => void): Promise<void> {
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root!.render(
      <OutcomePicker
        disabled={false}
        onChoose={onChoose}
        onActive={() => undefined}
      />
    )
  })
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})
describe('ball-in-play outcome menu', function () {
  it('keeps tap priority, toggles the left submenu and accepts only leaves', async function () {
    const chosen: string[] = []
    await mount(outcome => {
      chosen.push(outcome)
    })
    await click('Swing in Play')
    expect(
      Array.from(document.querySelectorAll('[data-outcome]')).map(node =>
        node.getAttribute('aria-label')
      )
    ).deep.equals([...PRIMARY_OUTCOMES])
    expect(document.querySelector('[aria-label="Batter Interference"]')).equals(
      null
    )
    await click('Batter Out')
    expect(
      Array.from(
        button('Batter Out options').querySelectorAll('[data-outcome]')
      ).map(n => n.getAttribute('data-outcome'))
    ).deep.equals(['Throw Out', 'Ball Caught', 'Batter Interference'])
    expect(button('Throw Out')).not.equals(null)
    expect(chosen).has.length(0)
    await click('Batter Out')
    expect(document.querySelector('[aria-label="Throw Out"]')).equals(null)
    await click('Batter Out')
    await click('Throw Out')
    expect(chosen).deep.equals(['Throw Out'])
    for (const label of [
      'Single',
      'Double',
      'Triple',
      'Home Run',
      "Fielder's Choice",
      'Error',
      'Batter Interference'
    ]) {
      await click('Swing in Play')
      if (label === 'Batter Interference') await click('Batter Out')
      await click(label)
    }
    expect(chosen).has.length(8)
    await click('Swing in Play')
    await click('Swing in Play')
    expect(document.querySelector('[role="menu"]')).equals(null)
    await click('Swing in Play')
    await act(async () => {
      button('Swing in Play').dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    expect(document.querySelector('[role="menu"]')).equals(null)
  })
  it('reverses drag priority, keeps the gap open and cancels interrupted releases without an action', async function () {
    const chosen: string[] = []
    await mount(outcome => {
      chosen.push(outcome)
    })
    // Save the host method solely for restoration.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const hitTest = document.elementsFromPoint
    let hit: Element[] = []
    document.elementsFromPoint = () => hit
    const pointer = async (
      type: string,
      x: number,
      y: number
    ): Promise<void> => {
      await act(async () => {
        const event = new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y
        })
        Object.defineProperty(event, 'pointerId', { value: 1 })
        button('Swing in Play').dispatchEvent(event)
      })
    }
    try {
      await pointer('pointerdown', 900, 800)
      await pointer('pointermove', 900, 700)
      expect(
        Array.from(document.querySelectorAll('[data-outcome]')).map(node =>
          node.getAttribute('aria-label')
        )
      ).deep.equals([...PRIMARY_OUTCOMES].reverse())
      hit = [button('Batter Out')]
      await pointer('pointermove', 900, 680)
      expect(button('Ball Caught')).not.equals(null)
      hit = []
      await pointer('pointermove', 700, 680)
      expect(button('Ball Caught')).not.equals(null)
      hit = [button('Single')]
      await pointer('pointermove', 900, 640)
      expect(document.querySelector('[aria-label="Ball Caught"]')).equals(null)
      hit = [button('Batter Out')]
      await pointer('pointermove', 900, 680)
      hit = [button('Batter Interference')]
      await pointer('pointermove', 200, 680)
      await pointer('pointerup', 200, 680)
      expect(chosen).deep.equals(['Batter Interference'])
      // Consume the browser's post-drag click; it must not reopen the menu.
      await click('Swing in Play')
      expect(document.querySelector('[role="menu"]')).equals(null)
      hit = []
      await pointer('pointerdown', 900, 800)
      await pointer('pointermove', 900, 700)
      await pointer('pointercancel', 900, 700)
      expect(chosen).has.length(1)
      await pointer('pointerdown', 900, 800)
      await pointer('pointermove', 900, 700)
      await pointer('lostpointercapture', 900, 700)
      expect(document.querySelector('[role="menu"]')).equals(null)
      await act(async () => {
        root!.render(
          <NativePicker
            disabled
            onChoose={() => undefined}
            onActive={() => undefined}
          />
        )
      })
      expect(button('Swing in Play').getAttribute('aria-disabled')).equals(
        'true'
      )
      await act(async () => {
        root!.render(
          <NativePicker
            contactKind="bunt"
            disabled
            onChoose={() => undefined}
            onActive={() => undefined}
          />
        )
      })
      expect(button('Bunt in Play').getAttribute('aria-disabled')).equals(
        'true'
      )
    } finally {
      document.elementsFromPoint = hitTest
    }
  })
})

describe('the phone in-play control', () => {
  async function mountNative(
    props: Partial<React.ComponentProps<typeof NativePicker>>,
    chosen: string[],
    active: boolean[]
  ): Promise<void> {
    const node = document.createElement('div')
    document.body.appendChild(node)
    root = createRoot(node)
    await act(async () => {
      root!.render(
        <NativePicker
          disabled={false}
          onChoose={value => chosen.push(value)}
          onActive={value => active.push(value)}
          {...props}
        />
      )
    })
  }
  it('opens the outcomes on a tap and records the one chosen', async () => {
    const chosen: string[] = []
    const active: boolean[] = []
    await mountNative({}, chosen, active)
    expect(document.querySelector('[aria-label="Single"]')).equals(null)
    await click('Swing in Play')
    expect(active).deep.equals([true])
    for (const value of PRIMARY_OUTCOMES) expect(button(value)).not.equals(null)
    await click('Double')
    expect(chosen).deep.equals(['Double'])
    expect(active).deep.equals([true, false])
    expect(document.querySelector('[aria-label="Single"]')).equals(null)
  })
  it('opens how the batter was put out beside Batter Out', async () => {
    const chosen: string[] = []
    await mountNative({}, chosen, [])
    await click('Swing in Play')
    expect(document.querySelector('[aria-label="Ball Caught"]')).equals(null)
    await click('Batter Out')
    await click('Batter Out')
    expect(document.querySelector('[aria-label="Ball Caught"]')).equals(null)
    await click('Batter Out')
    await click('Ball Caught')
    expect(chosen).deep.equals(['Ball Caught'])
  })
  it("offers a bunt no home run, and no fielder's choice with the bases empty", async () => {
    await mountNative({ contactKind: 'bunt', hasRunners: false }, [], [])
    await click('Bunt in Play')
    expect(document.querySelector('[aria-label="Home Run"]')).equals(null)
    expect(document.querySelector(`[aria-label="Fielder's Choice"]`)).equals(
      null
    )
    expect(button('Single')).not.equals(null)
    await click('Dismiss outcomes')
  })
  it('closes when it is disabled or cancelled', async () => {
    const chosen: string[] = []
    const active: boolean[] = []
    await mountNative({}, chosen, active)
    await click('Swing in Play')
    await click('Dismiss outcomes')
    expect(document.querySelector('[aria-label="Single"]')).equals(null)
    await click('Swing in Play')
    await act(async () => {
      root!.render(
        <NativePicker
          disabled
          onChoose={value => chosen.push(value)}
          onActive={value => active.push(value)}
        />
      )
    })
    expect(document.querySelector('[aria-label="Single"]')).equals(null)
    await click('Swing in Play')
    expect(document.querySelector('[aria-label="Single"]')).equals(null)
    expect(chosen).deep.equals([])
    expect(active.at(-1)).equals(false)
  })
})

describe('swing and bunt paired controls', () => {
  it('owns one menu at a time, filters bunt/FC, and delivers contact identity', async () => {
    const node = document.createElement('div')
    document.body.appendChild(node)
    root = createRoot(node)
    const choices: string[] = []
    const active: boolean[] = []
    const render = async (
      disabled: boolean,
      hasRunners = false
    ): Promise<void> => {
      await act(async () => {
        root!.render(
          <OutcomeControls
            disabled={disabled}
            hasRunners={hasRunners}
            onActive={v => {
              active.push(v)
            }}
            onChoose={(outcome, kind) => {
              choices.push(`${kind}:${outcome}`)
            }}
          />
        )
      })
    }
    await render(false)
    for (const kind of ['Bunt', 'Swing']) {
      await click(`${kind} in Play`)
      expect(button(`${kind} in Play outcomes`)).not.equals(null)
      expect(
        (
          button(
            `${kind === 'Bunt' ? 'Swing' : 'Bunt'} in Play`
          ) as HTMLButtonElement
        ).disabled
      ).equals(true)
      expect(document.querySelector('[aria-label="Home Run"]') != null).equals(
        kind === 'Swing'
      )
      expect(document.querySelector('[aria-label="Fielder\'s Choice"]')).equals(
        null
      )
      await click('Single')
      expect(active.at(-1)).equals(false)
    }
    expect(choices).deep.equals(['bunt:Single', 'swing:Single'])
    await render(false, true)
    await click('Bunt in Play')
    await click("Fielder's Choice")
    for (const outcome of ['Throw Out', 'Ball Caught', 'Batter Interference']) {
      await click('Bunt in Play')
      await click('Batter Out')
      await click(outcome)
    }
    await click('Bunt in Play')
    await render(true)
    expect(document.querySelector('[role="menu"]')).equals(null)
    expect(active.at(-1)).equals(false)
    expect((button('Bunt in Play') as HTMLButtonElement).disabled).equals(true)
    await render(false)
    await click('Swing in Play')
    await click('Home Run')
    expect(choices.at(-1)).equals('swing:Home Run')
  })
})
