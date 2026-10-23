/* eslint-disable @typescript-eslint/unbound-method -- Restored after each case. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BackHandler, Linking, Platform } from 'react-native'

import { type HistoryMove, takeHistoryMove } from './historyMotion'
import type { Route } from './routes'
import * as web from './useAddressBar'
import * as native from './useAddressBar.native'

let root: Root | undefined
let host: HTMLDivElement
const originalOS = Platform.OS
const originalBack = BackHandler.addEventListener
const originalLink = Linking.addEventListener

async function mount(hook: () => void): Promise<void> {
  function Harness(): null {
    hook()
    return null
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<Harness />)
  })
}

async function popped(go: () => void): Promise<void> {
  await act(async () => {
    const done = new Promise(resolve => {
      window.addEventListener('popstate', resolve, { once: true })
    })
    go()
    await done
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('history motion', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    takeHistoryMove()
    Object.defineProperty(Platform, 'OS', {
      value: originalOS,
      configurable: true
    })
    BackHandler.addEventListener = originalBack
    Linking.addEventListener = originalLink
  })

  describe('history motion on the web (U3)', function () {
    it('notes Back and Forward before the route handler runs', async function () {
      const seen: Array<HistoryMove | undefined> = []
      await mount(() => {
        web.useBrowserBack(() => {
          seen.push(takeHistoryMove())
        })
      })
      web.showRoute({ name: 'team', teamId: 't1' })
      web.showRoute({ name: 'player', userId: '7' })
      await popped(() => {
        window.history.back()
      })
      expect(seen.at(-1)).deep.equals({ direction: 'back', drawn: false })
      await popped(() => {
        window.history.forward()
      })
      expect(seen.at(-1)).deep.equals({ direction: 'forward', drawn: false })
    })

    it('notes a move the browser already drew', async function () {
      const seen: Array<HistoryMove | undefined> = []
      await mount(() => {
        web.useBrowserBack(() => {
          seen.push(takeHistoryMove())
        })
      })
      await act(async () => {
        const event = new window.PopStateEvent('popstate', {
          state: window.history.state
        })
        Object.defineProperty(event, 'hasUAVisualTransition', { value: true })
        window.dispatchEvent(event)
      })
      expect(seen.at(-1)?.drawn).equals(true)
    })

    it('notes nothing for a refused guarded pop and back for an accepted one', async function () {
      const routes: Route[] = []
      const noted: Array<HistoryMove | undefined> = []
      let answer: (accepted: boolean) => void = () => undefined
      await mount(() => {
        web.useBrowserBack(route => {
          routes.push(route)
          noted.push(takeHistoryMove())
        })
      })
      web.showRoute({ name: 'game', gameId: 'g1' })
      web.showRoute({ name: 'scoreGame', gameId: 'g1' })
      const release = web.setNavigationGuard(
        async () =>
          await new Promise<boolean>(resolve => {
            answer = resolve
          }),
        { name: 'scoreOptions', gameId: 'g1' }
      )
      try {
        // Back, then the guard restores the entry while it asks.
        await popped(() => {
          window.history.back()
        })
        await popped(() => undefined)
        await act(async () => {
          answer(false)
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        expect(routes).deep.equals([])
        expect(takeHistoryMove()).equals(undefined)
        await popped(() => {
          window.history.back()
        })
        await popped(() => undefined)
        await act(async () => {
          answer(true)
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        await popped(() => undefined)
        expect(routes.at(-1)).deep.equals({
          name: 'scoreOptions',
          gameId: 'g1'
        })
        expect(noted.at(-1)).deep.equals({ direction: 'back', drawn: false })
      } finally {
        release()
      }
    })

    it('never says where Back would land', function () {
      expect(web.previousRoute()).equals(undefined)
    })
  })

  describe('history motion on a phone (U3)', function () {
    it('notes Android Back as back and a link as no move', async function () {
      Object.defineProperty(Platform, 'OS', {
        value: 'android',
        configurable: true
      })
      let back: (() => boolean | null | undefined) | undefined
      let link: ((event: { url: string }) => void) | undefined
      BackHandler.addEventListener = (_event, handler) => {
        back = () => handler({ type: 'hardwareBackPress', timeStamp: 0 })
        return { remove: () => undefined }
      }
      Linking.addEventListener = (
        _event: string,
        handler: (event: { url: string }) => void
      ) => {
        link = handler
        return { remove: () => undefined }
      }
      const seen: Array<HistoryMove | undefined> = []
      native.seedRoute(null)
      native.showRoute({ name: 'team', teamId: 't1' })
      await mount(() => {
        native.useBrowserBack((_route, handled) => {
          seen.push(takeHistoryMove())
          handled?.(true)
        })
      })
      await act(async () => {
        expect(back?.()).equals(true)
      })
      expect(seen.at(-1)).deep.equals({ direction: 'back', drawn: false })
      await act(async () => {
        link?.({ url: 'https://teamstation.app/teams/t2' })
      })
      expect(seen.at(-1)).deep.equals({ direction: 'none', drawn: false })
    })

    it('says where Back would land without going', function () {
      native.seedRoute(null)
      expect(native.previousRoute()).equals(undefined)
      native.showRoute({ name: 'team', teamId: 't1' })
      native.showRoute({ name: 'team', teamId: 't1', tab: 'stats' })
      expect(native.previousRoute()).deep.equals({ name: 'team', teamId: 't1' })
      expect(native.currentRoute()).deep.equals({
        name: 'team',
        teamId: 't1',
        tab: 'stats'
      })
    })
  })
})
