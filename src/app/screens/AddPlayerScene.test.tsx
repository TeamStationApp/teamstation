import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ExistingPlayerAnswer, RosterEntry } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { ExistingRosterPlayer } from '../../common/playerSettings'
import {
  candidate,
  FakeCandidateClient,
  page
} from '../../test/fakeCandidateClient'
import { heldTimers } from '../../test/fakeScreenScope'
import { measureBoxes } from '../../test/measureBoxes'
import { ThemeProvider } from '../theme/ThemeContext'
import { AddPlayerScene } from './AddPlayerScene'

let root: Root | undefined
let timers: ReturnType<typeof heldTimers> | undefined
let restoreRects: (() => void) | undefined
const node = (label: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const text = (): string => document.body.textContent ?? ''
async function click(label: string): Promise<void> {
  const found = node(label)
  expect(found, label).not.equals(null)
  await act(async () => {
    found!.click()
  })
}
async function input(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node(label), value)
    node(label)!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

const burnes = candidate('Corbin Burnes', {
  userId: 'usr_burnes',
  bats: 'right',
  throws: 'right',
  tier: 'season',
  teams: [{ teamId: 'tem_bears', name: 'Valley Bears' }]
})
const entry = { userId: 'usr_burnes' } as unknown as RosterEntry

async function open({
  answer = async () => ({ entry, noticeId: 'req_1' }),
  offline = false
}: {
  answer?: () => Promise<ExistingPlayerAnswer>
  offline?: boolean
} = {}): Promise<{
  fake: FakeCandidateClient
  sent: Array<{ teamId: string; body: ExistingRosterPlayer }>
  added: string[]
  cancelled: number[]
}> {
  timers = heldTimers(500)
  restoreRects = measureBoxes()
  const fake = new FakeCandidateClient()
  fake.offline = offline
  const sent: Array<{ teamId: string; body: ExistingRosterPlayer }> = []
  const added: string[] = []
  const cancelled: number[] = []
  Object.assign(fake, {
    addExistingRosterPlayer: async (
      teamId: string,
      body: ExistingRosterPlayer
    ) => {
      sent.push({ teamId, body })
      return await answer()
    }
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <AddPlayerScene
          client={fake.client}
          teamId="tem_falcons"
          onAdded={message => added.push(message)}
          onCancel={() => cancelled.push(1)}
        />
      </ThemeProvider>
    )
  })
  return { fake, sent, added, cancelled }
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

describe('team settings Add Player', function () {
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

  it('lists the candidates for the team with no game, and Cancel changes nothing', async () => {
    const { fake, sent, cancelled } = await open()
    expect(text()).includes('Add Player')
    expect(fake.last()).to.include({ teamId: 'tem_falcons' })
    expect(fake.last().gameId).equals(undefined)
    await act(async () => {
      fake.last().resolve([burnes, candidate('Max Fried')])
    })
    expect(node('Choose Corbin B')).not.equals(null)
    expect(text()).includes('Valley Bears')
    await click('Cancel')
    expect(cancelled).has.length(1)
    expect(sent).has.length(0)
  })

  it('is a sheet of the content column’s width on a wide window, and the whole screen on a phone', async () => {
    await windowWidth(1600)
    try {
      const { cancelled } = await open()
      const panel = document.querySelector<HTMLElement>(
        '[data-testid="Add Player panel"]'
      )!
      const width = parseFloat(panel.style.width)
      expect(width).greaterThan(390)
      expect(width).lessThan(1600)
      await click('Dismiss Add Player')
      expect(cancelled).has.length(1)
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
      await open()
      const panel = document.querySelector<HTMLElement>(
        '[data-testid="Add Player panel"]'
      )!
      expect(panel.style.width).equals('')
      expect(node('Dismiss Add Player')).equals(null)
    } finally {
      await windowWidth(null)
    }
  })

  it('shows Add to Roster with the short name and hands greyed, and adds him with the jersey and positions', async () => {
    const { fake, sent, added } = await open()
    await act(async () => {
      fake.last().resolve([burnes])
    })
    await click('Choose Corbin B')
    expect(text()).includes('Add to Roster')
    const first = node('First name') as HTMLInputElement
    expect([first.value, first.readOnly]).deep.equals(['Corbin', true])
    expect(node('Throws Right')!.textContent).equals('LR')
    expect(node('Throws Left')).equals(null)
    // No pool player in team settings.
    expect(node('Add as Pool Player')).equals(null)
    await input('Jersey number', '39')
    await click('Player position P')
    await click('Add to Roster')
    expect(sent).deep.equals([
      {
        teamId: 'tem_falcons',
        body: { userId: 'usr_burnes', jersey: '39', positions: ['P'] }
      }
    ])
    expect(added).deep.equals([
      'Added Corbin B to the roster. Their guardians were notified.'
    ])
  })

  it('says nothing of a notice nobody was sent, and Cancel on Add to Roster goes back to the list', async () => {
    const { fake, added } = await open({
      answer: async () => ({ entry, noticeId: null })
    })
    await act(async () => {
      fake.last().resolve([burnes])
    })
    await click('Choose Corbin B')
    await click('Cancel')
    expect(node('First name')).equals(null)
    expect(node('Choose Corbin B')).not.equals(null)
    await click('Choose Corbin B')
    await click('Add to Roster')
    expect(added).deep.equals(['Added Corbin B to the roster'])
  })

  it("stays over a pending add, and keeps the server's refusal", async () => {
    const pending = await open({
      answer: async () => ({ pendingRequestId: 'req_2' })
    })
    await act(async () => {
      pending.fake.last().resolve([burnes])
    })
    await click('Choose Corbin B')
    await click('Add to Roster')
    expect(text()).includes(
      "This needs a guardian's approval first. We sent the request."
    )
    expect(node('Add to Roster')!.getAttribute('aria-disabled')).equals('true')
    expect(pending.added).has.length(0)
    await act(async () => {
      root!.unmount()
    })
    document.body.innerHTML = ''
    timers?.restore()
    restoreRects?.()
    const refused = await open({
      answer: async () => {
        throw new HttpError('conflict', 'Corbin B is already on this team.')
      }
    })
    await act(async () => {
      refused.fake.last().resolve([burnes])
    })
    await click('Choose Corbin B')
    await input('Jersey number', '3x')
    expect(text()).includes('Use digits for the jersey number.')
    await input('Jersey number', '39')
    await click('Add to Roster')
    expect(text()).includes('Corbin B is already on this team.')
    await act(async () => {
      root!.unmount()
    })
    document.body.innerHTML = ''
    timers?.restore()
    restoreRects?.()
    const failed = await open({
      answer: async () => {
        throw new Error('socket hang up')
      }
    })
    await act(async () => {
      failed.fake.last().resolve([burnes])
    })
    await click('Choose Corbin B')
    await click('Add to Roster')
    expect(text()).includes('Unable to add the player. Please try again.')
  })

  it('says when nobody is near, when nothing matches, when refused and when offline', async () => {
    const nobody = await open()
    await act(async () => {
      nobody.fake.last().resolve([])
    })
    expect(text()).includes('Type three letters to search all players.')
    await input('Search players', 'Zzz')
    await act(async () => {
      timers!.fire()
    })
    await act(async () => {
      nobody.fake.last().resolve([])
    })
    expect(text()).includes('No players match “Zzz”.')
    await click('Clear search')
    await act(async () => {
      timers!.fire()
    })
    await act(async () => {
      nobody.fake.last().reject(new HttpError('forbidden', 'Not found'))
    })
    expect(text()).includes('Not found')
    await click('Retry')
    expect(nobody.fake.asks.length).greaterThan(3)
    await act(async () => {
      nobody.fake.last().resolve(page(30))
    })
    await act(async () => {
      root!.unmount()
    })
    document.body.innerHTML = ''
    timers?.restore()
    restoreRects?.()
    await open({ offline: true })
    expect(text()).includes('Searching needs a connection.')
  })

  it('shows a spinner under the rows while a page loads, and Retry when it fails', async () => {
    const { fake } = await open()
    await act(async () => {
      fake.last().resolve(page(30))
    })
    const host = document.querySelector('[data-testid="Candidate list"]')!
    const key = Object.keys(host).find(one => one.startsWith('__reactFiber'))!
    interface Fiber {
      child: Fiber | null
      sibling: Fiber | null
      memoizedProps?: Record<string, any>
    }
    const found: Fiber[] = []
    const visit = (one: Fiber | null): void => {
      for (let child = one; child != null; child = child.sibling) {
        if (child.memoizedProps?.estimatedItemSize != null) found.push(child)
        visit(child.child)
      }
    }
    visit((host as unknown as Record<string, Fiber>)[key].child)
    const list = (): Record<string, any> => {
      found.length = 0
      visit((host as unknown as Record<string, Fiber>)[key].child)
      return found[0].memoizedProps!
    }
    expect(list().keyExtractor(burnes)).equals('usr_burnes')
    await act(async () => {
      list().onEndReached()
    })
    expect(
      document.querySelector('[data-testid="Candidates loading more"]')
    ).not.equals(null)
    await act(async () => {
      fake.last().reject(new Error('socket hang up'))
    })
    expect(text()).includes('Unable to load players. Please try again.')
    // Reaching the end again over the error asks nothing.
    const asked = fake.asks.length
    await act(async () => {
      list().onEndReached()
    })
    expect(fake.asks.length).equals(asked)
    await click('Retry')
    expect(fake.asks.length).equals(asked + 1)
  })
})
