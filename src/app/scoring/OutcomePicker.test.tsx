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
    ).deep.equals([
      'Ground Out',
      'Out at First',
      'Ball Caught',
      'Batter Interference'
    ])
    expect(button('Ground Out')).not.equals(null)
    expect(chosen).has.length(0)
    await click('Batter Out')
    expect(document.querySelector('[aria-label="Ground Out"]')).equals(null)
    await click('Batter Out')
    await click('Ground Out')
    expect(chosen).deep.equals(['Ground Out'])
    for (const label of [
      'Single',
      'Double',
      'Triple',
      'Home Run',
      "Fielder's Choice",
      'Error',
      'Out at First',
      'Batter Interference'
    ]) {
      await click('Swing in Play')
      if (label === 'Out at First' || label === 'Batter Interference')
        await click('Batter Out')
      await click(label)
    }
    expect(chosen).has.length(9)
    expect(chosen.at(-2)).equals('Out at First')
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

const px = (value: string): number => Number.parseFloat(value)
/**
 * Lays the picker out in a deck at the bottom of a field column: the window
 * is `width`×`height`, the column `column` wide from its left edge, the deck
 * 8 inside it with its top at `deckTop`, and Swing in Play its rightmost
 * fifth.
 */
async function inDeck(
  width: number,
  height: number,
  column: number,
  deckTop: number
): Promise<{ deck: DOMRect; restore: () => void }> {
  const saved = {
    innerWidth: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
    innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight')
  }
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height
  })
  const node = document.createElement('div')
  node.dataset.testid = 'scoring-deck'
  document.body.appendChild(node)
  const deck = new window.DOMRect(8, deckTop, column - 16, 120)
  node.getBoundingClientRect = () => deck
  root = createRoot(node)
  await act(async () => {
    root!.render(
      <OutcomePicker
        disabled={false}
        onChoose={() => undefined}
        onActive={() => undefined}
      />
    )
  })
  const fifth = (deck.width - 24) / 5
  button('Swing in Play').getBoundingClientRect = () =>
    new window.DOMRect(deck.right - fifth, deckTop, fifth, 120)
  return {
    deck,
    restore: () => {
      for (const key of ['innerWidth', 'innerHeight'] as const) {
        const descriptor = saved[key]
        if (descriptor != null) Object.defineProperty(window, key, descriptor)
        else Reflect.deleteProperty(window, key)
      }
      node.remove()
    }
  }
}
describe('ball-in-play outcome menu over the deck', function () {
  it('opens above the deck in the field column beside a side column', async function () {
    // 1366×1024: a 1006-wide field column beside the 360 side column.
    const { deck, restore } = await inDeck(1366, 1024, 1006, 880)
    try {
      await click('Swing in Play')
      const panel = button('Swing in Play outcomes')
      const right = 1366 - px(panel.style.right)
      expect(right).equals(deck.right)
      expect(right).at.most(1006)
      expect(1024 - px(panel.style.bottom)).equals(deck.top - 8)
      expect(px(panel.style.width)).equals(230)
      expect(right - px(panel.style.width)).at.least(deck.left)
      expect(panel.style.maxHeight).equals(
        `calc(100dvh - ${1024 - 880 + 20}px)`
      )
      await click('Batter Out')
      const out = button('Batter Out options')
      const left = px(out.style.left)
      expect(left).at.least(deck.left)
      expect(left + px(out.style.width)).at.most(right - 230 - 8)
      expect(px(out.style.top) + 160).at.most(deck.top - 8)
    } finally {
      restore()
    }
  })
  it('keeps the phone menu directly above the deck', async function () {
    // 393×852 web: the deck under the catcher card, the log below it.
    const { deck, restore } = await inDeck(393, 852, 393, 541.12)
    try {
      await click('Swing in Play')
      const panel = button('Swing in Play outcomes')
      expect(393 - px(panel.style.right)).equals(deck.right)
      expect(852 - px(panel.style.bottom)).closeTo(deck.top - 8, 0.01)
      expect(px(panel.style.width)).closeTo(393 * 0.46, 0.01)
      await click('Batter Out')
      expect(px(button('Batter Out options').style.left)).at.least(deck.left)
      // A resize while open moves it with the deck.
      deck.y = 500
      await act(async () => {
        window.dispatchEvent(new window.Event('resize'))
      })
      expect(852 - px(panel.style.bottom)).equals(492)
    } finally {
      restore()
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
  for (const contactKind of ['swing', 'bunt'] as const)
    it(`lists Ground Out, Out at First, Ball Caught and Batter Interference under Batter Out on a ${contactKind}`, async () => {
      const chosen: string[] = []
      await mountNative({ contactKind }, chosen, [])
      await click(`${contactKind === 'bunt' ? 'Bunt' : 'Swing'} in Play`)
      await click('Batter Out')
      const rows = [
        'Ground Out',
        'Out at First',
        'Ball Caught',
        'Batter Interference'
      ]
      for (const row of rows) expect(button(row)).not.equals(null)
      const order = Array.from(
        document.querySelectorAll<HTMLElement>('[aria-label]')
      )
        .map(node => node.getAttribute('aria-label'))
        .filter(label => rows.includes(label!))
      expect(order).deep.equals(rows)
      await click('Out at First')
      expect(chosen).deep.equals(['Out at First'])
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
    for (const outcome of [
      'Ground Out',
      'Out at First',
      'Ball Caught',
      'Batter Interference'
    ]) {
      await click('Bunt in Play')
      await click('Batter Out')
      await click(outcome)
    }
    expect(choices.slice(-4)).deep.equals([
      'bunt:Ground Out',
      'bunt:Out at First',
      'bunt:Ball Caught',
      'bunt:Batter Interference'
    ])
    await click('Swing in Play')
    await click('Batter Out')
    await click('Out at First')
    expect(choices.at(-1)).equals('swing:Out at First')
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
