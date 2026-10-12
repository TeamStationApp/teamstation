import { expect } from 'chai'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { BackHandler, Platform } from 'react-native'

import type { Route } from './routes'
import {
  backFromScoringPlayer,
  currentRoute,
  scoringOriginHistory,
  seedRoute,
  showRoute,
  useBrowserBack
} from './useAddressBar.native'

describe('retained scoring native Back', function () {
  it('restores a cancelled exit and protects the next Back while a decision is pending', async function () {
    const originalOS = Platform.OS
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored below.
    const originalAdd = BackHandler.addEventListener
    let back: (() => boolean | null | undefined) | undefined
    let decision: ((accepted: boolean) => void) | undefined
    const routes: Route[] = []
    Object.defineProperty(Platform, 'OS', {
      value: 'android',
      configurable: true
    })
    BackHandler.addEventListener = (_event, handler) => {
      back = () => handler({ type: 'hardwareBackPress', timeStamp: 0 })
      return { remove: () => undefined }
    }
    seedRoute(null)
    showRoute({ name: 'game', gameId: 'game_fixture' }, true)
    showRoute({ name: 'scoreGame', gameId: 'game_fixture' })
    const origin = scoringOriginHistory()
    showRoute({
      name: 'player',
      userId: '100',
      onTeam: 'away',
      tab: 'settings'
    })
    const onRoute = (
      route: Route,
      handled?: (accepted: boolean) => void
    ): void => {
      routes.push(route)
      decision = handled
    }
    function Harness(): React.ReactElement | null {
      useBrowserBack(onRoute)
      return null
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<Harness />)
      })
      backFromScoringPlayer(origin)
      expect(currentRoute()).includes({ name: 'scoreGame' })
      expect(back?.()).equals(true)
      expect(routes).has.length(1)
      expect(back?.()).equals(true)
      expect(routes).has.length(1)
      decision?.(false)
      expect(currentRoute()).includes({ name: 'scoreGame' })
      expect(scoringOriginHistory()).equals(origin)
      expect(back?.()).equals(true)
      expect(routes).has.length(2)
      decision?.(true)
      expect(currentRoute()).includes({ name: 'game' })
      expect(back?.()).equals(false)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      BackHandler.addEventListener = originalAdd
      Object.defineProperty(Platform, 'OS', {
        value: originalOS,
        configurable: true
      })
      seedRoute(null)
    }
  })
})
