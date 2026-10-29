import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { BackHandler, Linking, Platform } from 'react-native'

import type { Route } from '../navigation/routes'
import {
  currentRoute,
  finishChatChild,
  popRoute,
  scoringOriginHistory,
  seedRoute,
  showRoute,
  stepBackTo,
  useBrowserBack
} from '../navigation/useAddressBar.native'

/**
 * Android's system Back from a chat opened by a link: the chat list, as the
 * header's Back. Links are delivered and Back pressed through stand-ins for
 * React Native's own listeners.
 */
async function androidBack(
  work: (controls: {
    back: () => boolean | null | undefined
    open: (path: string) => void
    routes: Route[]
    decide: (accepted: boolean) => void
    newHistory: number[]
  }) => Promise<void>
): Promise<void> {
  const originalOS = Platform.OS
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored below.
  const originalBack = BackHandler.addEventListener
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored below.
  const originalLink = Linking.addEventListener
  let back: (() => boolean | null | undefined) | undefined
  let opened: ((event: { url: string }) => void) | undefined
  let decision: ((accepted: boolean) => void) | undefined
  const routes: Route[] = []
  const newHistory: number[] = []
  Object.defineProperty(Platform, 'OS', {
    value: 'android',
    configurable: true
  })
  BackHandler.addEventListener = (_event, handler) => {
    back = () => handler({ type: 'hardwareBackPress', timeStamp: 0 })
    return { remove: () => undefined }
  }
  Linking.addEventListener = (
    _event: string,
    handler: (event: { url: string }) => void
  ) => {
    opened = handler
    return { remove: () => undefined }
  }
  const onRoute = (
    route: Route,
    handled?: (accepted: boolean) => void
  ): void => {
    routes.push(route)
    decision = handled
  }
  function Harness(): React.ReactElement | null {
    useBrowserBack(onRoute, undefined, position => newHistory.push(position))
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(<Harness />)
    })
    await work({
      back: () => back?.(),
      open: path => {
        opened?.({ url: 'teamstation:/' + path })
      },
      routes,
      newHistory,
      decide: accepted => {
        decision?.(accepted)
      }
    })
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    BackHandler.addEventListener = originalBack
    Linking.addEventListener = originalLink
    Object.defineProperty(Platform, 'OS', {
      value: originalOS,
      configurable: true
    })
  }
}

describe('Android Back from a chat opened by a link', function () {
  it('lands on the chat list, not where the link was opened from', async function () {
    seedRoute(null)
    await androidBack(async ({ back, open, routes, decide }) => {
      open('/chat/cnv_linked')
      decide(true)
      expect(currentRoute()).deep.equals({
        name: 'conversation',
        conversationId: 'cnv_linked'
      })
      expect(back()).equals(true)
      decide(true)
      expect(routes.at(-1)).deep.equals({ name: 'chat' })
      // And from the list, back where the link was opened.
      expect(back()).equals(true)
      decide(true)
      expect(routes.at(-1)).deep.equals({ name: 'home' })
      expect(back(), 'The bottom closes the app').equals(false)
    })
  })

  it('agrees with the header Back, which pops one step', async function () {
    seedRoute(null)
    await androidBack(async ({ back, open, routes, decide }) => {
      open('/chat/cnv_linked')
      decide(true)
      popRoute()
      expect(currentRoute()).deep.equals({ name: 'chat' })
      expect(back()).equals(true)
      decide(true)
      expect(routes.at(-1)).deep.equals({ name: 'home' })
    })
  })

  it('adds no second list over the chat list it was opened from', async function () {
    seedRoute(null)
    showRoute({ name: 'chat' })
    const depth = scoringOriginHistory()
    await androidBack(async ({ open, decide }) => {
      open('/chat/cnv_linked')
      decide(true)
      expect(scoringOriginHistory()).equals(depth + 1)
    })
  })

  it('leaves no step behind when the shell refuses the link', async function () {
    seedRoute(null)
    showRoute({ name: 'team', teamId: 'tm_1' })
    const depth = scoringOriginHistory()
    await androidBack(async ({ open, decide }) => {
      open('/chat/cnv_linked')
      decide(false)
      expect(scoringOriginHistory()).equals(depth)
      expect(currentRoute()).deep.equals({ name: 'team', teamId: 'tm_1' })
    })
  })

  it('returns an internal entity chat directly to its source, including after a new DM', async function () {
    seedRoute(null)
    const origin: Route = {
      name: 'group',
      kind: 'league',
      id: 'league_demo',
      tab: 'chats'
    }
    showRoute(origin)
    const depth = scoringOriginHistory()
    await androidBack(async ({ back, routes, decide }) => {
      showRoute({ name: 'conversation', conversationId: 'cnv_first' })
      showRoute({ name: 'conversation', conversationId: 'cnv_second' }, true)
      expect(scoringOriginHistory()).equals(depth + 1)
      expect(back()).equals(true)
      decide(true)
      expect(routes.at(-1)).deep.equals(origin)
      showRoute({ name: 'conversation', conversationId: 'cnv_first' })
      showRoute({ name: 'home' })
      showRoute({ name: 'conversation', conversationId: 'cnv_first' })
      stepBackTo(origin, depth)
      expect(scoringOriginHistory()).equals(depth)
      expect(currentRoute()).deep.equals(origin)
      showRoute({ name: 'conversation', conversationId: 'cnv_first' })
      showRoute({ name: 'chatNew' })
      showRoute({ name: 'home' })
      showRoute({ name: 'chatNew' })
      finishChatChild({ name: 'conversation', conversationId: 'cnv_dm' }, depth)
      expect(scoringOriginHistory()).equals(depth + 1)
      expect(back()).equals(true)
      decide(true)
      expect(routes.at(-1)).deep.equals(origin)
    })
  })

  it('invalidates reused embedded chat positions before delivering a new link', async function () {
    seedRoute(null)
    showRoute({
      name: 'group',
      kind: 'league',
      id: 'league_demo',
      tab: 'chats'
    })
    showRoute({ name: 'conversation', conversationId: 'cnv_same' })
    await androidBack(async ({ back, open, decide, newHistory, routes }) => {
      back()
      decide(true)
      back()
      decide(true)
      const retainedDepth = scoringOriginHistory()
      open('/chat/cnv_same')
      expect(newHistory).deep.equals([retainedDepth + 1])
      expect(routes.at(-1)).deep.equals({
        name: 'conversation',
        conversationId: 'cnv_same'
      })
      decide(true)
      back()
      decide(true)
      expect(routes.at(-1)).deep.equals({ name: 'chat' })
    })
  })

  it('opens a cold-started chat link over the chat list', function () {
    seedRoute('teamstation://chat/cnv_cold')
    expect(currentRoute()).deep.equals({
      name: 'conversation',
      conversationId: 'cnv_cold'
    })
    expect(scoringOriginHistory()).equals(2)
    popRoute()
    expect(currentRoute()).deep.equals({ name: 'chat' })
  })
})
