import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { RosterCandidate } from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  candidate,
  FakeCandidateClient,
  page
} from '../../test/fakeCandidateClient'
import { heldTimers } from '../../test/fakeScreenScope'
import { measureBoxes } from '../../test/measureBoxes'
import { ThemeProvider } from '../theme/ThemeContext'
import { ExistingPlayerSheet } from './ExistingPlayerSheet'
import { ScoringCandidateCard } from './ScoringCandidateCard'

let root: Root | undefined
let timers: ReturnType<typeof heldTimers> | undefined
let restoreRects: (() => void) | undefined

const node = (label: string): HTMLElement | null =>
  document.querySelector(`[aria-label="${label}"]`)
const text = (): string => document.body.textContent ?? ''

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
interface Fiber {
  child: Fiber | null
  sibling: Fiber | null
  memoizedProps?: Record<string, unknown>
}
/** The props the sheet hands LegendList, read off React's tree. */
function listProps(): {
  recycleItems: boolean
  estimatedItemSize: number
  onEndReachedThreshold: number
  keyExtractor: (row: RosterCandidate) => string
  onEndReached: () => void
} {
  const host = document.querySelector('[data-testid="Candidate list"]')!
  const key = Object.keys(host).find(one => one.startsWith('__reactFiber'))!
  const found: Fiber[] = []
  const visit = (one: Fiber | null): void => {
    for (let child = one; child != null; child = child.sibling) {
      if (child.memoizedProps?.estimatedItemSize != null) found.push(child)
      visit(child.child)
    }
  }
  visit((host as unknown as Record<string, Fiber>)[key].child)
  return found[0].memoizedProps as unknown as ReturnType<typeof listProps>
}
async function mount(
  fake = new FakeCandidateClient(),
  chosen: RosterCandidate[] = [],
  closed: string[] = []
): Promise<FakeCandidateClient> {
  timers = heldTimers(500)
  restoreRects = measureBoxes()
  await render(
    <ExistingPlayerSheet
      client={fake.client}
      teamId="tem_falcons"
      gameId="gam_one"
      onChoose={choice => chosen.push(choice)}
      onClose={() => closed.push('closed')}
    />
  )
  return fake
}
async function type(value: string): Promise<void> {
  const input = node('Search players') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function answer(
  fake: FakeCandidateClient,
  rows: RosterCandidate[]
): Promise<void> {
  await act(async () => {
    fake.last().resolve(rows)
  })
}

/** Makes the window this wide, as react-native-web reads it. */
async function windowWidth(width: number | null): Promise<void> {
  if (width == null)
    delete (document.documentElement as unknown as Record<string, unknown>)
      .clientWidth
  else
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: width
    })
  await act(async () => {
    window.dispatchEvent(new window.Event('resize'))
  })
}

describe('ExistingPlayerSheet', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    timers?.restore()
    timers = undefined
    restoreRects?.()
    restoreRects = undefined
    document.body.innerHTML = ''
  })

  it('lists the candidates under its title, Cancel and the search field at the bottom', async () => {
    const chosen: RosterCandidate[] = []
    const closed: string[] = []
    const fake = await mount(undefined, chosen, closed)
    expect(text()).includes('Add Existing Player')
    expect(
      document.querySelector('[data-testid="Candidates loading"]')
    ).not.equals(null)
    const betts = candidate('Mookie Betts', {
      teams: [{ teamId: 'tem_dodgers', name: 'Ridgeview Dodgers' }]
    })
    await answer(fake, [betts, candidate('Mike Trout')])
    expect(node('Choose Mookie B')).not.equals(null)
    expect(node('Choose Mike T')).not.equals(null)
    expect(text()).includes('Ridgeview Dodgers')
    // The field comes after the list, at the bottom.
    const field = document.querySelector('[data-testid="Player search field"]')!
    const list = document.querySelector('[data-testid="Candidate list"]')!
    expect(
      list.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    await act(async () => {
      node('Choose Mookie B')!.click()
    })
    expect(chosen).deep.equals([betts])
    await act(async () => {
      node('Cancel')!.click()
    })
    expect(closed).deep.equals(['closed'])
  })

  it('is a tall sheet of the content column’s width over the game on a wide window, and the whole screen on a phone', async () => {
    await windowWidth(1600)
    try {
      const closed: string[] = []
      await mount(undefined, [], closed)
      const sheet = document.querySelector<HTMLElement>(
        '[data-testid="Scoring sheet"]'
      )!
      const width = parseFloat(sheet.style.maxWidth)
      expect(width).greaterThan(390)
      expect(width).lessThan(1600)
      await act(async () => {
        node('Dismiss sheet')!.click()
      })
      expect(closed).deep.equals(['closed'])
    } finally {
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      timers?.restore()
      restoreRects?.()
      document.body.innerHTML = ''
      await windowWidth(390)
    }
    try {
      await mount()
      expect(node('Dismiss sheet')).equals(null)
      expect(
        document.querySelector('[data-testid="Scoring sheet"]')
      ).not.equals(null)
    } finally {
      await windowWidth(null)
    }
  })

  it('says how to find everybody when nobody is near, and names a search with no match', async () => {
    const fake = await mount()
    await answer(fake, [])
    expect(text()).includes(
      'No players on your teams, season or league yet. Type three letters to search all players.'
    )
    await type('Zzz')
    // The clear button shows while the field holds text.
    expect(node('Clear search')).not.equals(null)
    await act(async () => {
      timers!.fire()
    })
    expect(fake.last().q).equals('Zzz')
    await answer(fake, [])
    expect(text()).includes('No players match “Zzz”.')
    await act(async () => {
      node('Clear search')!.click()
    })
    expect((node('Search players') as HTMLInputElement).value).equals('')
    expect(node('Clear search')).equals(null)
  })

  it("shows the server's message and Retry for a refused list", async () => {
    const fake = await mount()
    await act(async () => {
      fake.last().reject(new HttpError('forbidden', 'Not found'))
    })
    expect(text()).includes('Not found')
    await act(async () => {
      node('Retry')!.click()
    })
    expect(fake.asks).has.length(2)
  })

  it('shows a spinner under the rows while a page loads, and Retry under them when it fails', async () => {
    const fake = await mount()
    await answer(fake, page(30))
    const props = listProps()
    expect(props).to.include({
      recycleItems: true,
      estimatedItemSize: 72,
      onEndReachedThreshold: 0.5
    })
    expect(props.keyExtractor(page(1)[0])).equals(page(1)[0].userId)
    const reachEnd = async (): Promise<void> => {
      await act(async () => {
        listProps().onEndReached()
      })
    }
    await reachEnd()
    expect(fake.asks).has.length(2)
    expect(fake.last().after).equals(page(30)[29].cursor)
    expect(
      document.querySelector('[data-testid="Candidates loading more"]')
    ).not.equals(null)
    await act(async () => {
      fake.last().reject(new Error('socket hang up'))
    })
    expect(text()).includes('Unable to load players. Please try again.')
    expect(node('Retry')).not.equals(null)
    // The rows stay, and reaching the end again does not ask over the error.
    expect(node('Choose Player0 O')).not.equals(null)
    await reachEnd()
    expect(fake.asks).has.length(2)
    await act(async () => {
      node('Retry')!.click()
    })
    expect(fake.asks).has.length(3)
  })

  it('says searching needs a connection, with the field off, while offline', async () => {
    const fake = new FakeCandidateClient()
    fake.offline = true
    await mount(fake)
    expect(text()).includes('Searching needs a connection.')
    expect(
      (node('Search players') as HTMLInputElement).readOnly ||
        (node('Search players') as HTMLInputElement).disabled
    ).equals(true)
    expect(fake.asks).has.length(0)
  })
})

describe('ScoringCandidateCard', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.innerHTML = ''
  })

  it('draws the picture when there is one, a pill per team, and none without teams', async () => {
    await render(
      <>
        <ScoringCandidateCard
          candidate={candidate('Mookie Betts', {
            avatarUrl: 'https://example.test/betts.jpg',
            teams: [
              { teamId: 'tem_a', name: 'Ridgeview Dodgers' },
              { teamId: 'tem_b', name: 'Lakeside Herons' }
            ]
          })}
          onPress={() => undefined}
        />
        <ScoringCandidateCard
          candidate={candidate('Mike Trout')}
          disabled
          onPress={() => undefined}
        />
      </>
    )
    const [betts, trout] = [node('Choose Mookie B')!, node('Choose Mike T')!]
    expect(betts.querySelector('img')).not.equals(null)
    expect(betts.textContent).includes('Ridgeview Dodgers')
    expect(betts.textContent).includes('Lakeside Herons')
    expect(betts.textContent).includes('›')
    expect(trout.querySelector('[data-testid="Candidate teams"]')).equals(null)
    expect(trout.textContent).includes('MT')
    expect(trout.getAttribute('aria-disabled')).equals('true')
  })
})
