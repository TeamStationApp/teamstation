import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { dropRouteSuffix, showRoute } from './useAddressBar'

const frames = [
  { name: 'team', team: { id: 'id' } },
  { name: 'game', gameId: 'id' },
  { name: 'player', userId: 'id' }
]

function showHomeLine(): void {
  showRoute({ name: 'home' })
  showRoute({ name: 'team', teamId: 'id' })
  showRoute({ name: 'team', teamId: 'id', tab: 'schedule' })
  showRoute({ name: 'game', gameId: 'id' })
  showRoute({ name: 'team', teamId: 'id' })
  showRoute({ name: 'team', teamId: 'id', tab: 'team' })
  showRoute({ name: 'player', userId: 'id' })
}

function nextPop(ms = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
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

describe('a navbar clear in the address bar', function () {
  beforeEach(function () {
    window.history.replaceState(null, '', '/')
  })

  it('lands on home, and Back does not reopen the player', async function () {
    showHomeLine()
    expect(window.location.pathname).equals('/players/id')
    const landed = nextPop()
    dropRouteSuffix(frames, '/')
    await landed
    expect(window.location.pathname).equals('/')
    const backed = nextPop(200).catch(() => undefined)
    window.history.back()
    await backed
    expect(window.location.pathname).not.equals('/players/id')
  })

  it('counts the same path once', function () {
    showRoute({ name: 'home' })
    showRoute({ name: 'team', teamId: 'id' })
    const length = window.history.length
    showRoute({ name: 'team', teamId: 'id' })
    expect(window.history.length).equals(length)
  })

  it('lands on a root that carries a query', async function () {
    showRoute({ name: 'schedule', when: 'past' })
    showRoute({ name: 'team', teamId: 'id' })
    const landed = nextPop()
    dropRouteSuffix(
      [{ name: 'team', team: { id: 'id' } }],
      '/schedule?when=past'
    )
    await landed
    expect(window.location.pathname + window.location.search).equals(
      '/schedule?when=past'
    )
  })

  it('drops nothing when the mirror disagrees with the address', function () {
    showHomeLine()
    window.history.pushState({}, '', '/games/other')
    dropRouteSuffix(frames, '/')
    expect(window.location.pathname).equals('/games/other')
  })

  it('does not throw when a reload left holes under the current index', function () {
    showRoute({ name: 'home' })
    showRoute({ name: 'team', teamId: 'tem_demo' })
    showRoute({ name: 'game', gameId: 'gam_demo' })
    expect(window.history.state.tsRouteIndex >= 2).equals(true)
    const addressPath = require.resolve('./useAddressBar.ts')
    delete require.cache[addressPath]
    const fresh = require('./useAddressBar.ts') as typeof import('./useAddressBar')
    fresh.showRoute(fresh.currentRoute(), true)
    expect(() => {
      fresh.dropRouteSuffix([{ name: 'game', gameId: 'gam_demo' }], '/')
    }).not.to.throw()
    expect(window.location.pathname).equals('/games/gam_demo')
  })

  it('does not throw when Forward lands on a slot the mirror truncated', async function () {
    window.history.replaceState(null, '', '/')
    const addressPath = require.resolve('./useAddressBar.ts')
    delete require.cache[addressPath]
    const fresh = require('./useAddressBar.ts') as typeof import('./useAddressBar')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    function Host(): null {
      fresh.useBrowserBack(() => undefined)
      return null
    }
    await act(async () => {
      root.render(React.createElement(Host))
    })
    try {
      fresh.showRoute({ name: 'home' })
      fresh.showRoute({ name: 'team', teamId: 'tem_demo' })
      fresh.showRoute({ name: 'game', gameId: 'gam_demo' })
      const backed = nextPop()
      fresh.dropRouteSuffix(
        [
          { name: 'team', team: { id: 'tem_demo' } },
          { name: 'game', gameId: 'gam_demo' }
        ],
        '/'
      )
      await backed
      expect(window.location.pathname).equals('/')
      const forwarded = nextPop()
      window.history.go(2)
      await forwarded
      expect(window.location.pathname).equals('/games/gam_demo')
      expect(() => {
        fresh.dropRouteSuffix(
          [
            { name: 'team', team: { id: 'tem_demo' } },
            { name: 'game', gameId: 'gam_demo' }
          ],
          '/'
        )
      }).not.to.throw()
      expect(window.location.pathname).equals('/games/gam_demo')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
