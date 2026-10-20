import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import { asRosterEntry, TeamStationClient } from '../../common/api'
import type { TagTarget } from '../../common/eventTags'
import { userIdOfGumbo } from '../../common/userId'
import { EventTagText } from '../components/EventTagText'
import {
  BaseballScreen,
  type BaseballScreenProps
} from '../field/BaseballScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import { EventTagEditor } from './EventTagEditor'
import { gameFixture } from './isUnscoredGame.test'
import { HistoryPopup } from './ScoringHistory'
import { scoringPreferences } from './scoringPreferences'
import { ScoringScreen } from './ScoringScreen'
import { DevelopmentScoringSource } from './scoringSource'
import { useHoldSelection } from './useHoldSelection'

let root: Root | undefined
const targets: TagTarget[] = Array.from({ length: 6 }, (_, at) => ({
  id: `target_${at}`,
  atBatIndex: 0,
  eventIndex: at,
  title: `Event ${at}`,
  description: `Description ${at}`,
  tag: null
}))
async function mount(content: React.ReactNode): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{content}</ThemeProvider>)
  })
}
async function click(label: string): Promise<void> {
  const node = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(node, label).not.equals(null)
  await act(async () => {
    node!.dispatchEvent(
      new window.MouseEvent('mousedown', { bubbles: true, button: 0 })
    )
    document.dispatchEvent(
      new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
    )
    node!.click()
  })
}
async function input(value: string): Promise<void> {
  const node = document.querySelector<HTMLInputElement>(
    '[aria-label="New tag"]'
  )!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node, value)
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

describe('event tag UI', function () {
  this.timeout(10000)
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('dismisses stale viewport bounds and keeps older rows scrollable in a short native viewport', async () => {
    const os = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    const element = document.documentElement
    const original = ['clientWidth', 'clientHeight'].map(key =>
      Object.getOwnPropertyDescriptor(element, key)
    )
    const resize = async (width: number, height: number): Promise<void> => {
      Object.defineProperty(element, 'clientWidth', {
        configurable: true,
        value: width
      })
      Object.defineProperty(element, 'clientHeight', {
        configurable: true,
        value: height
      })
      await act(async () => {
        window.dispatchEvent(new window.Event('resize'))
      })
    }
    let closed = false
    try {
      await resize(402, 874)
      await mount(
        <HistoryPopup
          viewport={{ width: 402, height: 874 }}
          bounds={{ x: 20, y: 650, width: 220, height: 56 }}
          rows={targets}
          onSelect={() => undefined}
          onClose={() => {
            closed = true
          }}
        />
      )
      expect(closed).equals(false)
      expect(
        Number.parseFloat(
          document.querySelector<HTMLElement>(
            '[data-testid="scoring-history-older-scroll"]'
          )!.style.maxHeight
        )
      ).greaterThan(220)
      await resize(874, 239)
      // Modal/browser metrics alone cannot replace the scoring layout's bounds.
      expect(closed).equals(false)
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <HistoryPopup
              viewport={{ width: 874, height: 239 }}
              bounds={{ x: 20, y: 650, width: 220, height: 56 }}
              rows={targets}
              onSelect={() => undefined}
              onClose={() => {
                closed = true
              }}
            />
          </ThemeProvider>
        )
      })
      expect(closed).equals(true)
      closed = false
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <HistoryPopup
              key="landscape"
              viewport={{ width: 874, height: 239 }}
              bounds={{ x: 20, y: 145, width: 220, height: 56 }}
              rows={targets}
              onSelect={() => undefined}
              onClose={() => {
                closed = true
              }}
            />
          </ThemeProvider>
        )
      })
      const older = document.querySelector<HTMLElement>(
        '[data-testid="scoring-history-older-scroll"]'
      )!
      expect(closed).equals(false)
      expect(Number.parseFloat(older.style.maxHeight)).equals(95)
      expect(
        document.querySelectorAll('[data-testid^="tag-history-"]')
      ).has.length(6)
      expect(['auto', 'scroll']).includes(
        window.getComputedStyle(older).overflowY
      )
    } finally {
      Object.defineProperty(Platform, 'OS', os)
      for (const [at, key] of ['clientWidth', 'clientHeight'].entries()) {
        const descriptor = original[at]
        if (descriptor == null) Reflect.deleteProperty(element, key)
        else Object.defineProperty(element, key, descriptor)
      }
      await act(async () => {
        window.dispatchEvent(new window.Event('resize'))
      })
    }
  })

  it('anchors to the measured modal origin and dismisses a resized native modal', async () => {
    const os = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    let closed = false
    try {
      await mount(
        <HistoryPopup
          viewport={{ width: 812, height: 292 }}
          bounds={{ x: 262, y: 144, width: 410, height: 56 }}
          rows={targets}
          onSelect={() => undefined}
          onClose={() => {
            closed = true
          }}
        />
      )
      const view = document.querySelector<HTMLElement>(
        '[data-testid="scoring-history-viewport"]'
      )! as HTMLElement & { __reactLayoutHandler: () => void }
      let rectangle = new window.DOMRect(62, 0, 874, 292)
      view.getBoundingClientRect = () => rectangle
      const layout = async (): Promise<void> => {
        await act(async () => {
          view.__reactLayoutHandler()
          await new Promise(resolve => setTimeout(resolve, 5))
        })
      }
      await layout()
      const anchor = document.querySelector<HTMLElement>(
        '[data-testid="scoring-history-frame"]'
      )!
      expect(anchor.style.left).equals('12px')
      expect(anchor.style.right).equals('136px')
      expect(anchor.style.bottom).equals('152px')
      // Both edges stay in the visible viewport even when the modal shifts.
      expect(62 + 874 - Number.parseFloat(anchor.style.right)).equals(800)
      rectangle = new window.DOMRect(-62, 0, 874, 292)
      await layout()
      expect(anchor.style.left).equals('74px')
      expect(anchor.style.right).equals('12px')
      expect(-62 + Number.parseFloat(anchor.style.left)).equals(12)
      expect(closed).equals(false)
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: 'ios'
      })
      rectangle = new window.DOMRect(0, 0, 402, 874)
      await layout()
      expect(closed).equals(true)
    } finally {
      Object.defineProperty(Platform, 'OS', os)
    }
  })

  it('shows six chronological pencil rows, selects the specific event and dismisses outside', async () => {
    let selected = ''
    let closed = false
    await mount(
      <HistoryPopup
        viewport={{ width: 402, height: 874 }}
        bounds={{ x: 20, y: 300, width: 220, height: 60 }}
        rows={targets}
        onSelect={target => {
          selected = target.id
        }}
        onClose={() => {
          closed = true
        }}
      />
    )
    expect(document.body.textContent).includes('Tap event to assign a tag.')
    expect(
      [...document.querySelectorAll('[data-testid^="tag-history-"]')].map(
        node => node.getAttribute('data-testid')
      )
    ).deep.equals(targets.map(target => `tag-history-${target.id}`))
    await click('Tag event: Event 1')
    expect(selected).equals('target_1')
    await click('Tag event: Event 5')
    expect(selected).equals('target_5')
    await click('Dismiss scoring history')
    expect(closed).equals(true)
  })

  it('keeps event wording separate from Undo and puts tiny tags beside the title above the description', async () => {
    const row = {
      ...targets[5],
      tag: 'great play',
      display: {
        primary: 'Player 6 reaches on a single',
        secondary: 'Player 7 scores'
      }
    }
    await mount(
      <HistoryPopup
        viewport={{ width: 402, height: 874 }}
        bounds={{ x: 88, y: 650, width: 220, height: 56 }}
        rows={[row]}
        onSelect={() => undefined}
        onClose={() => undefined}
      />
    )
    const event = document.querySelector<HTMLElement>(
      '[data-testid="tag-history-target_5"]'
    )!
    expect(event.textContent).contains(row.display.primary)
    const description = document.querySelector<HTMLElement>(
      '[data-testid="history-description-target_5"]'
    )!
    expect(description.textContent).equals(row.display.secondary)
    const pill = document.querySelector<HTMLElement>(
      '[data-testid="history-tag-target_5"]'
    )!
    expect(pill.textContent).equals('great play')
    expect(pill.parentElement!.textContent).contains(row.display.primary)
    expect(pill.parentElement!.contains(description)).equals(false)
    expect(getComputedStyle(pill.firstElementChild!).fontSize).equals(
      getComputedStyle(description).fontSize
    )
  })

  it('clears the activated gesture selection after release and preserves editable input selection', async () => {
    let hold!: ReturnType<typeof useHoldSelection>
    function Harness(): React.ReactElement {
      hold = useHoldSelection()
      return <span>Gesture selection</span>
    }
    await mount(<Harness />)
    await act(async () => {
      hold.onPressIn()
      hold.onLongPress()
      hold.onPressOut()
      const range = document.createRange()
      range.selectNodeContents(document.body)
      window.getSelection()!.addRange(range)
      document.dispatchEvent(
        new window.Event('selectionchange', { bubbles: true })
      )
      expect(window.getSelection()!.rangeCount).equals(0)
    })
    const input = document.createElement('input')
    input.value = 'great catch'
    document.body.appendChild(input)
    input.select()
    input.dispatchEvent(new window.Event('select', { bubbles: true }))
    const menu = new window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true
    })
    input.dispatchEvent(menu)
    expect(menu.defaultPrevented).equals(false)
    expect(input.selectionStart).equals(0)
    expect(input.selectionEnd).equals(11)
    input.remove()
  })

  it('opens history after a long hold without undoing and retains short press Undo', async () => {
    let undos = 0
    let selected = ''
    const props: BaseballScreenProps = {
      field: {
        players: [],
        selected: '',
        onSelect: () => undefined,
        view: 'home',
        zoom: 1
      },
      onMenu: () => undefined,
      onUndo: () => {
        undos++
      },
      onPitch: () => undefined,
      canPitch: true,
      summary: 'Game',
      historyLabel: 'Ball',
      historyRows: targets,
      onHistoryOpen: () => undefined,
      onTagSelect: target => {
        selected = target.id
      }
    }
    // The field remains the actual shared component; JSDOM has no WebGL host.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const canvas = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof canvas
    try {
      await mount(<BaseballScreen {...props} />)
      await click('Undo Ball')
      expect(undos).equals(1)
      const undo = document.querySelector<HTMLElement>(
        '[aria-label="Undo Ball"]'
      )!
      let selections = 0
      let validSelections = 0
      const selectionChanged = (): void => {
        selections++
        if (window.getSelection()?.isCollapsed === false) validSelections++
      }
      document.addEventListener('selectionchange', selectionChanged)
      await act(async () => {
        undo.dispatchEvent(
          new window.MouseEvent('mousedown', { bubbles: true, button: 0 })
        )
        await new Promise(resolve => setTimeout(resolve, 600))
        const range = document.createRange()
        range.selectNodeContents(undo)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
        document.dispatchEvent(
          new window.Event('selectionchange', { bubbles: true })
        )
        const nativeMenu = new window.MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true
        })
        undo.dispatchEvent(nativeMenu)
        expect(nativeMenu.defaultPrevented).equals(true)
        await new Promise(resolve => setTimeout(resolve, 1100))
      })
      expect(validSelections).equals(0)
      await act(async () => {
        document.dispatchEvent(
          new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
        )
      })
      expect(document.body.textContent).includes('Tap event to assign a tag.')
      expect(undos).equals(1)
      window.getSelection()!.removeAllRanges()
      document.dispatchEvent(
        new window.Event('selectionchange', { bubbles: true })
      )
      expect(selections).greaterThan(0)
      await click('Tag event: Event 0')
      expect(selected).equals('target_0')
      expect(
        document.querySelector('[aria-label="Dismiss scoring history"]')
      ).equals(null)
      await click('Undo Ball')
      expect(undos).equals(2)
      await act(async () => {
        undo.dispatchEvent(
          new window.MouseEvent('mousedown', { bubbles: true, button: 0 })
        )
        root!.unmount()
        root = undefined
      })
      const before = selections
      document.dispatchEvent(
        new window.Event('selectionchange', { bubbles: true })
      )
      expect(selections).equals(before + 1)
      document.removeEventListener('selectionchange', selectionChanged)
    } finally {
      HTMLCanvasElement.prototype.getContext = canvas
    }
  })

  it('assigns through the finished scoring screen without adding an Undo step', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => gameFixture
    client.roster = async team =>
      Array.from({ length: 9 }, (_, at) =>
        asRosterEntry({
          userId: userIdOfGumbo((team === 'away' ? 101 : 201) + at),
          gumboId: (team === 'away' ? 101 : 201) + at,
          shortName: `Player ${at + 1}`,
          jersey: String(at + 1),
          positions: [],
          isPlayer: true,
          role: 'member',
          section: 'player',
          staffRoles: [],
          inheritedFrom: null,
          bats: 'right'
        })
      )
    const source = new DevelopmentScoringSource()
    await scoringPreferences.write('tag-user', {
      help: false,
      shown: 3,
      animations: false,
      sound: false
    })
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const canvas = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof canvas
    try {
      await mount(
        <ScoringScreen
          client={client}
          source={source}
          gameId="g1"
          userId="tag-user"
          onExit={() => undefined}
        />
      )
      await click('Ball')
      const undo = document.querySelector<HTMLElement>(
        '[aria-label="Undo Ball"]'
      )!
      await act(async () => {
        undo.dispatchEvent(
          new window.MouseEvent('mousedown', { bubbles: true, button: 0 })
        )
        await new Promise(resolve => setTimeout(resolve, 1700))
      })
      await act(async () => {
        document.dispatchEvent(
          new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
        )
      })
      await click('Tag event: Ball')
      expect(document.body.textContent).includes('Ball')
      await input('  GREAT  Pitch ')
      await click('Save tag')
      expect((await source.tagChoices('tag-user')).recent).deep.equals([
        'great pitch'
      ])
      expect(document.querySelector('[aria-label="New tag"]')).equals(null)
      await click('Undo Ball')
      expect(document.querySelector('[aria-label="Undo Ball"]')).equals(null)
      expect(
        document.querySelector('[aria-label="Nothing to undo"]')
      ).not.equals(null)
    } finally {
      HTMLCanvasElement.prototype.getContext = canvas
    }
  })

  it('normalizes a typed multiword tag using a single-line field and omits empty recents', async () => {
    const saved: Array<string | null> = []
    let closed = false
    await mount(
      <EventTagEditor
        target={targets[0]}
        loadChoices={async () => ({
          recent: [],
          popular: [{ tag: 'popular label', count: 3 }]
        })}
        saveTag={async tag => {
          saved.push(tag)
        }}
        onClose={() => {
          closed = true
        }}
      />
    )
    expect(document.body.textContent).not.includes('Recent tags')
    expect(document.body.textContent).includes('Popular tags')
    const field = document.querySelector('[aria-label="New tag"]')!
    const popular = [...document.querySelectorAll('div')].find(
      node => node.textContent === 'Popular tags'
    )!
    expect(
      field.compareDocumentPosition(popular) &
        window.Node.DOCUMENT_POSITION_FOLLOWING
    ).greaterThan(0)
    expect(document.querySelector('textarea[aria-label="New tag"]')).equals(
      null
    )
    await input('  GREAT   Catch ')
    await click('Save tag')
    expect(saved).deep.equals(['great catch'])
    expect(closed).equals(true)
  })

  it('saves a pill immediately once, shows failures and preserves input for retry', async () => {
    let calls = 0
    let closed = false
    const saved: Array<string | null> = []
    await mount(
      <EventTagEditor
        target={targets[0]}
        loadChoices={async () => ({ recent: ['great catch'], popular: [] })}
        saveTag={async tag => {
          calls++
          if (calls === 1) throw new Error('Offline. Try again.')
          saved.push(tag)
        }}
        onClose={() => {
          closed = true
        }}
      />
    )
    await input('new label')
    await click('Use tag great catch')
    expect(document.body.textContent).includes('Offline. Try again.')
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="New tag"]')!.value
    ).equals('new label')
    expect(closed).equals(false)
    await click('Use tag great catch')
    expect(saved).deep.equals(['great catch'])
    expect(closed).equals(true)
  })

  it('validates empty input, removes an existing tag and handles non-Error failures', async () => {
    const saved: Array<string | null> = []
    await mount(
      <EventTagEditor
        target={{ ...targets[0], tag: 'old label' }}
        loadChoices={async () => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return await Promise.reject('unavailable')
        }}
        saveTag={async tag => {
          if (tag !== null) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            await Promise.reject('offline')
            return
          }
          saved.push(tag)
        }}
        onClose={() => undefined}
      />
    )
    expect(document.body.textContent).includes(
      'Tags could not be loaded. Try again.'
    )
    await input(' ')
    await click('Save tag')
    expect(document.body.textContent).includes(
      'Use between 1 and 64 characters'
    )
    await input('new label')
    await click('Save tag')
    expect(document.body.textContent).includes(
      'Tag could not be saved. Try again.'
    )
    await click('Remove tag')
    expect(saved).deep.equals([null])
  })

  it('prevents duplicate pill saves while busy and ignores completion after unmount', async () => {
    let finish: (() => void) | undefined
    const pending = new Promise<void>(resolve => {
      finish = resolve
    })
    let calls = 0
    let closed = false
    await mount(
      <EventTagEditor
        target={targets[0]}
        loadChoices={async () => ({ recent: ['great catch'], popular: [] })}
        saveTag={async () => {
          calls++
          await pending
        }}
        onClose={() => {
          closed = true
        }}
      />
    )
    await click('Use tag great catch')
    await click('Use tag great catch')
    expect(calls).equals(1)
    expect(document.querySelector('[aria-label="Saving tag…"]')).not.equals(
      null
    )
    await act(async () => {
      root!.unmount()
      root = undefined
      finish!()
      await pending
    })
    expect(closed).equals(false)
  })

  it('renders a full-size intact inline pill immediately after descriptive words', async () => {
    await mount(
      <EventTagText
        text="A great play."
        tag="great catch"
        fillRow
        style={{ fontSize: 15, flex: 1 }}
      />
    )
    expect(document.body.textContent).includes('A great play. great catch')
    const flow = document.querySelector(
      '[aria-label="A great play. great catch"]'
    )!
    expect(window.getComputedStyle(flow).flexWrap).equals('wrap')
    expect(window.getComputedStyle(flow.firstElementChild!).flexGrow).equals(
      '0'
    )
    expect(window.getComputedStyle(flow.firstElementChild!).flexBasis).equals(
      'auto'
    )
    const pill = flow.lastElementChild!
    expect(pill.textContent).equals('great catch')
    expect(window.getComputedStyle(pill).flexShrink).equals('0')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <EventTagText text="Original description." />
        </ThemeProvider>
      )
    })
    expect(document.body.textContent).includes('Original description.')
  })
})
