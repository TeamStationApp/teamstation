import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { isChatPath } from '../navigation/routes'
import {
  showRoute,
  undoStep,
  useBrowserBack
} from '../navigation/useAddressBar'

async function nextPop(ms = 1000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('no popstate'))
    }, ms)
    window.addEventListener(
      'popstate',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

// Not Now on the chat age sheet, in a browser: the chat steps go, with the
// shell's own Back listener there to take the landing.
describe('Not Now in the address bar', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined
  function Host(): null {
    useBrowserBack(() => undefined)
    return null
  }
  beforeEach(async () => {
    window.history.replaceState(null, '', '/')
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<Host />)
    })
  })
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
  })
  const index = (): number => window.history.state?.tsRouteIndex as number

  it('steps back over every chat step to the tab beneath them', async () => {
    showRoute({ name: 'home' })
    const home = index()
    showRoute({ name: 'chat' })
    showRoute({ name: 'conversation', conversationId: 'cnv_linked' })
    const landed = nextPop()
    undoStep({ name: 'home' }, isChatPath)
    await landed
    expect(window.location.pathname).equals('/')
    expect(index()).equals(home)
  })

  it('puts the tab in the lowest chat step’s place when another is beneath', async () => {
    showRoute({ name: 'schedule', when: 'upcoming' })
    const schedule = index()
    showRoute({ name: 'chat' })
    showRoute({ name: 'conversation', conversationId: 'cnv_linked' })
    const landed = nextPop()
    undoStep({ name: 'home' }, isChatPath)
    await landed
    expect(window.location.pathname).equals('/')
    expect(index()).equals(schedule + 1)
  })

  it('steps back to the page as it opened when that step has no tab', async () => {
    showRoute({ name: 'season', seasonId: 'season_demo' })
    const season = index()
    showRoute({ name: 'season', seasonId: 'season_demo', tab: 'chats' })
    const landed = nextPop()
    undoStep({ name: 'season', seasonId: 'season_demo', tab: 'standings' })
    await landed
    expect(index()).equals(season)
    expect(window.location.pathname + window.location.search).equals(
      '/seasons/season_demo?tab=standings'
    )
  })

  it('takes the one step’s place when the address is not one it wrote', () => {
    showRoute({ name: 'home' })
    showRoute({ name: 'chat' })
    window.history.pushState(
      { tsRouteIndex: index() + 1 },
      '',
      '/chat/cnv_elsewhere'
    )
    const pushed = index()
    undoStep({ name: 'home' }, isChatPath)
    expect(window.location.pathname).equals('/')
    expect(index()).equals(pushed)
  })

  it('takes the one step’s place when nothing beneath is left or matches', () => {
    showRoute({ name: 'schedule', when: 'upcoming' })
    showRoute({ name: 'chat' })
    const chat = index()
    undoStep({ name: 'home' }, isChatPath)
    expect(window.location.pathname).equals('/')
    expect(index()).equals(chat)
  })
})
