import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { BackHandler, Platform } from 'react-native'

import {
  byLabel,
  byTestId,
  click,
  render,
  rerender,
  settle,
  unmount
} from '../../test/tessTestKit'
import { ChatOverlayHost, ChatOverlayPortal } from '../chat/ChatOverlayHost'
import { tsBallpark } from '../theme/tsBallpark'
import {
  HeaderMenu,
  headerMenuPosition,
  type HeaderMenuProps
} from './HeaderMenu'

const LABEL = 'Open the menu'

/** A `#rrggbb` color as the DOM writes it back. */
function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

function menu(props: Partial<HeaderMenuProps> = {}): React.ReactElement {
  return (
    <ChatOverlayHost>
      <HeaderMenu
        label={LABEL}
        align="right"
        items={[
          {
            label: 'First',
            detail: 'Its detail',
            icon: null,
            onPress: () => undefined
          },
          {
            label: 'Second',
            hint: 'A hint',
            icon: null,
            onPress: () => undefined
          }
        ]}
        {...props}
      >
        <></>
      </HeaderMenu>
    </ChatOverlayHost>
  )
}

/** Presses the button; a browser measures it on a later tick. */
async function openMenu(): Promise<void> {
  await click(byLabel(LABEL))
  await settle()
}

const panel = (): HTMLElement | null => byTestId('header-menu-panel')

/**
 * Puts back the window's and the page's sizes as they were, own properties
 * and all: a size left defined here is read by every suite after this one in
 * the same process.
 */
function keepSizes(): () => void {
  const held = (
    [
      [window, 'innerWidth'],
      [window, 'innerHeight'],
      [document.documentElement, 'clientWidth'],
      [document.documentElement, 'clientHeight']
    ] as const
  ).map(([target, key]) => ({
    target,
    key,
    descriptor: Object.getOwnPropertyDescriptor(target, key)
  }))
  return () => {
    for (const { target, key, descriptor } of held)
      if (descriptor == null) Reflect.deleteProperty(target, key)
      else Object.defineProperty(target, key, descriptor)
    window.dispatchEvent(new window.Event('resize'))
  }
}

describe('HeaderMenu', () => {
  afterEach(unmount)

  it('shows only its button until pressed, and says when it is open', async () => {
    await render(menu())
    expect(panel()).equals(null)
    expect(byLabel(LABEL).getAttribute('aria-expanded')).equals('false')
    expect(byLabel(LABEL).getAttribute('aria-haspopup')).equals('dialog')
    expect(panel()).equals(null)
    await openMenu()
    expect(panel()).not.equals(null)
    expect(byLabel(LABEL).getAttribute('aria-expanded')).equals('true')
  })

  it('lists every row, with its detail', async () => {
    await render(menu())
    await openMenu()
    const rows = [...panel()!.querySelectorAll('[role="button"]')].map(row =>
      row.getAttribute('aria-label')
    )
    expect(rows).deep.equals(['First', 'Second'])
    expect(panel()!.textContent).contains('Its detail')
  })

  it('closes before running a row, and runs it once', async () => {
    const events: string[] = []
    await render(
      menu({
        items: [
          {
            label: 'First',
            icon: null,
            onPress: () => events.push('pressed')
          }
        ],
        onOpenChange: open => events.push(open ? 'opened' : 'closed')
      })
    )
    await openMenu()
    await click(byLabel('First'))
    await settle()
    expect(panel()).equals(null)
    expect(events).deep.equals(['opened', 'pressed', 'closed'])
  })

  it('closes on an outside press without running a row', async () => {
    let pressed = 0
    await render(
      menu({
        items: [{ label: 'First', icon: null, onPress: () => pressed++ }]
      })
    )
    await openMenu()
    await click(byLabel('Close menu'))
    await settle()
    expect(panel()).equals(null)
    expect(pressed).equals(0)
  })

  it('closes on Escape and returns focus to its button', async () => {
    await render(menu())
    await openMenu()
    expect(document.activeElement?.getAttribute('aria-label')).equals('First')
    await act(async () => {
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape' })
      )
    })
    await settle()
    expect(panel()).equals(null)
    expect(document.activeElement?.getAttribute('aria-label')).equals(LABEL)
  })

  it('closes when the window changes size', async () => {
    const restore = keepSizes()
    const width = window.innerWidth
    const setWidth = (value: number): void => {
      Object.defineProperty(window, 'innerWidth', {
        value,
        configurable: true,
        writable: true
      })
      Object.defineProperty(document.documentElement, 'clientWidth', {
        value,
        configurable: true
      })
    }
    await render(menu())
    await openMenu()
    try {
      await act(async () => {
        setWidth(width + 100)
        window.dispatchEvent(new window.Event('resize'))
      })
      await settle()
      expect(panel()).equals(null)
    } finally {
      restore()
    }
  })

  it('stays open when only the height changes, as a keyboard does', async () => {
    const restore = keepSizes()
    const height = window.innerHeight
    const setHeight = (value: number): void => {
      Object.defineProperty(window, 'innerHeight', {
        value,
        configurable: true,
        writable: true
      })
      Object.defineProperty(document.documentElement, 'clientHeight', {
        value,
        configurable: true
      })
    }
    await render(menu())
    await openMenu()
    try {
      await act(async () => {
        setHeight(height - 300)
        window.dispatchEvent(new window.Event('resize'))
      })
      await settle()
      expect(panel()).not.equals(null)
    } finally {
      restore()
    }
  })

  it('ties a detail or a hint to its row for a screen reader', async () => {
    await render(menu())
    await openMenu()
    const described = (label: string): string | null | undefined => {
      const id = byLabel(label).getAttribute('aria-describedby')
      return id == null ? null : document.getElementById(id)?.textContent
    }
    expect(described('First')).equals('Its detail')
    expect(described('Second')).equals('A hint')
  })

  it('closes when its key changes, and stays open otherwise', async () => {
    await render(menu({ closeKey: '/' }))
    await openMenu()
    await rerender(menu({ closeKey: '/' }))
    expect(panel()).not.equals(null)
    await rerender(menu({ closeKey: '/teams' }))
    await settle()
    expect(panel()).equals(null)
  })

  it('reports closed when it goes away while open', async () => {
    const events: boolean[] = []
    function Owner(): React.ReactElement {
      const [shown, setShown] = useState(true)
      return (
        <ChatOverlayHost>
          {shown && (
            <HeaderMenu
              label={LABEL}
              align="left"
              items={[{ label: 'First', icon: null, onPress: () => undefined }]}
              onOpenChange={open => events.push(open)}
            >
              <></>
            </HeaderMenu>
          )}
          <button
            aria-label="Remove it"
            onClick={() => {
              setShown(false)
            }}
          />
        </ChatOverlayHost>
      )
    }
    await render(<Owner />)
    await openMenu()
    expect(events).deep.equals([true])
    await click(byLabel('Remove it'))
    await settle()
    expect(events).deep.equals([true, false])
    expect(panel()).equals(null)
  })

  it("takes Android's hardware Back while open, and only then", async () => {
    const original = Object.getOwnPropertyDescriptor(
      BackHandler,
      'addEventListener'
    )!
    const os = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    const listeners = new Set<() => boolean | null | undefined>()
    Object.defineProperty(Platform, 'OS', {
      value: 'android',
      configurable: true
    })
    Object.defineProperty(BackHandler, 'addEventListener', {
      configurable: true,
      value: (_event: string, listener: () => boolean) => {
        listeners.add(listener)
        return {
          remove: () => {
            listeners.delete(listener)
          }
        }
      }
    })
    try {
      await render(menu())
      expect(listeners.size).equals(0)
      await openMenu()
      expect(listeners.size).equals(1)
      let answer: boolean | null | undefined
      await act(async () => {
        answer = [...listeners][0]()
      })
      await settle()
      expect(answer).equals(true)
      expect(panel()).equals(null)
      expect(listeners.size).equals(0)
    } finally {
      Object.defineProperty(BackHandler, 'addEventListener', original)
      Object.defineProperty(Platform, 'OS', os)
    }
  })

  it('leaves Back alone on the web', async () => {
    const original = Object.getOwnPropertyDescriptor(
      BackHandler,
      'addEventListener'
    )!
    let asked = 0
    Object.defineProperty(BackHandler, 'addEventListener', {
      configurable: true,
      value: () => {
        asked++
        return { remove: () => undefined }
      }
    })
    try {
      await render(menu())
      await openMenu()
      expect(asked).equals(0)
    } finally {
      Object.defineProperty(BackHandler, 'addEventListener', original)
    }
  })

  it('names its panel, as the dialog its button announces', async () => {
    await render(menu())
    await openMenu()
    expect(panel()?.getAttribute('role')).equals('dialog')
    expect(panel()?.getAttribute('aria-label')).equals('Menu')
  })

  it('waits for another overlay to leave, then opens', async () => {
    let leave: () => void = () => undefined
    function Holder(): React.ReactElement {
      const [closing, setClosing] = useState(true)
      leave = () => {
        setClosing(false)
      }
      return (
        <ChatOverlayHost>
          {closing && (
            <ChatOverlayPortal modal={false}>
              <span>Closing</span>
            </ChatOverlayPortal>
          )}
          <HeaderMenu
            label={LABEL}
            align="right"
            items={[{ label: 'First', icon: null, onPress: () => undefined }]}
          >
            <></>
          </HeaderMenu>
        </ChatOverlayHost>
      )
    }
    await render(<Holder />)
    await settle()
    await openMenu()
    expect(panel()).equals(null)
    expect(document.body.textContent).contains('Closing')
    await act(async () => {
      leave()
    })
    await settle()
    expect(document.body.textContent).not.contains('Closing')
    expect(panel()).not.equals(null)
  })

  it('leaves the place alone when another overlay has taken it', async () => {
    let swap: (next: boolean) => void = () => undefined
    function Swapper(): React.ReactElement {
      const [second, setSecond] = useState(false)
      swap = setSecond
      return (
        <ChatOverlayHost>
          <ChatOverlayPortal>
            <span>First overlay</span>
          </ChatOverlayPortal>
          {second && (
            <ChatOverlayPortal>
              <span>Second overlay</span>
            </ChatOverlayPortal>
          )}
        </ChatOverlayHost>
      )
    }
    await render(<Swapper />)
    await act(async () => {
      swap(true)
    })
    expect(document.body.textContent).contains('Second overlay')
    await act(async () => {
      swap(false)
    })
    await settle()
    expect(document.body.textContent).not.contains('Second overlay')
  })

  it('closes when another overlay takes its place, and stays closed', async () => {
    const events: boolean[] = []
    let arrive: (next: boolean) => void = () => undefined
    function Arriving(): React.ReactElement {
      const [other, setOther] = useState(false)
      arrive = setOther
      return (
        <ChatOverlayHost>
          <HeaderMenu
            label={LABEL}
            align="right"
            items={[{ label: 'First', icon: null, onPress: () => undefined }]}
            onOpenChange={open => events.push(open)}
          >
            <></>
          </HeaderMenu>
          {other && (
            <ChatOverlayPortal>
              <span>A picker</span>
            </ChatOverlayPortal>
          )}
        </ChatOverlayHost>
      )
    }
    await render(<Arriving />)
    await openMenu()
    expect(panel()).not.equals(null)
    await act(async () => {
      arrive(true)
    })
    await settle()
    expect(panel()).equals(null)
    expect(document.body.textContent).contains('A picker')
    expect(byLabel(LABEL).getAttribute('aria-expanded')).equals('false')
    expect(events).deep.equals([true, false])
    await act(async () => {
      arrive(false)
    })
    await settle()
    expect(panel()).equals(null)
  })

  it('fits a short window, with its rows scrolling', async () => {
    const restore = keepSizes()
    const setHeight = (value: number): void => {
      Object.defineProperty(window, 'innerHeight', {
        value,
        configurable: true,
        writable: true
      })
      Object.defineProperty(document.documentElement, 'clientHeight', {
        value,
        configurable: true
      })
    }
    setHeight(200)
    window.dispatchEvent(new window.Event('resize'))
    try {
      await render(menu())
      await openMenu()
      expect(panel()!.style.maxHeight).matches(/^\d+px$/)
      expect(parseInt(panel()!.style.maxHeight, 10)).lessThan(200)
    } finally {
      restore()
    }
  })

  it('puts its test id on its button, and none without one', async () => {
    await render(menu({ testID: 'menu-trigger' }))
    expect(byTestId('menu-trigger')).equals(byLabel(LABEL))
    await unmount()
    document.body.replaceChildren()
    await render(menu())
    expect(byLabel(LABEL).getAttribute('data-testid')).equals(null)
  })

  it('marks a selected row with a radio mark and draws a destructive row in the danger colour, plain rows as before', async () => {
    await render(
      menu({
        items: [
          {
            label: 'Chosen',
            icon: null,
            selected: true,
            onPress: () => undefined
          },
          {
            label: 'Other',
            icon: null,
            selected: false,
            onPress: () => undefined
          },
          {
            label: 'Remove',
            icon: null,
            destructive: true,
            onPress: () => undefined
          },
          { label: 'Plain', icon: null, onPress: () => undefined }
        ]
      })
    )
    await openMenu()
    const words = (label: string): HTMLElement =>
      [...byLabel(label).querySelectorAll<HTMLElement>('[dir="auto"]')].find(
        node => node.textContent === label
      )!
    // A choice row is a radio that says whether it is the chosen one; a plain
    // row stays a button and says nothing of being chosen.
    expect(byLabel('Chosen').getAttribute('role')).equals('radio')
    expect(byLabel('Chosen').getAttribute('aria-checked')).equals('true')
    expect(byLabel('Other').getAttribute('role')).equals('radio')
    expect(byLabel('Other').getAttribute('aria-checked')).equals('false')
    expect(byLabel('Plain').getAttribute('role')).equals('button')
    expect(byLabel('Plain').getAttribute('aria-checked')).equals(null)
    expect(byLabel('Chosen').getAttribute('aria-selected')).equals(null)
    // At the row's end: a ring on both marked rows, its dot in the selected
    // one's only, and nothing after a plain row's words.
    const mark = (label: string): Element => byLabel(label).lastElementChild!
    expect(mark('Chosen').querySelectorAll('div')).length(2)
    expect(mark('Other').querySelectorAll('div')).length(1)
    expect(mark('Plain').textContent).equals('Plain')
    const danger = hexToRgb(tsBallpark.dangerColor)
    expect(getComputedStyle(words('Remove')).color).equals(danger)
    expect(getComputedStyle(words('Plain')).color).not.equals(danger)
    expect(getComputedStyle(words('Plain')).color).equals(
      getComputedStyle(words('Chosen')).color
    )
  })

  it('draws the panel as glass over a shadow', async () => {
    await render(menu())
    await openMenu()
    expect(byTestId('header-menu-glass')).not.equals(null)
    expect(panel()?.contains(byTestId('header-menu-glass'))).equals(true)
  })
})

describe('headerMenuPosition', () => {
  const anchor = { x: 300, y: 10, width: 40, height: 30 }
  const viewport = { width: 390 }

  it('lines the right edges up, below the button', () => {
    expect(headerMenuPosition(anchor, 'right', viewport)).deep.equals({
      top: 44,
      right: 50,
      maxWidth: 332
    })
  })

  it('lines the left edges up, below the button', () => {
    expect(headerMenuPosition(anchor, 'left', viewport)).deep.equals({
      top: 44,
      left: 300,
      maxWidth: 82
    })
  })

  it('stands off the window when the button does not', () => {
    expect(
      headerMenuPosition({ ...anchor, x: 2 }, 'left', viewport).left
    ).equals(8)
    expect(
      headerMenuPosition({ ...anchor, x: 348 }, 'right', viewport).right
    ).equals(8)
  })
})
