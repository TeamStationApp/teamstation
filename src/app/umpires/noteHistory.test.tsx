import { expect } from 'chai'
import { it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import type { Route } from '../navigation/routes'
import { showRoute, useBrowserBack } from '../navigation/useAddressBar'

it('restores browser history on a rejected note save and leaves only after success', async () => {
  window.history.replaceState({ tsRouteIndex: 0 }, '', '/umpires/demo')
  showRoute({ name: 'umpireSchedule', id: 'demo', days: '0' })
  let accepted = false
  const routes: Route[] = []
  const check = async (): Promise<boolean> => accepted
  const onRoute = (route: Route): void => {
    routes.push(route)
  }
  function Harness({ guarded = true }: { guarded?: boolean }): null {
    useBrowserBack(onRoute, guarded ? check : undefined)
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const back = async (): Promise<void> => {
    await act(async () => {
      window.history.back()
      await new Promise(resolve => setTimeout(resolve, 80))
    })
  }
  try {
    await act(async () => {
      root.render(<Harness />)
    })
    await back()
    expect(window.location.search).equals('?days=0')
    expect(routes).length(0)
    accepted = true
    await back()
    expect(window.location.pathname).equals('/umpires/demo')
    expect(new URLSearchParams(window.location.search).has('days')).equals(
      false
    )
    expect(routes).length(1)
    expect(routes[0]).includes({ name: 'umpireSchedule', id: 'demo' })
    await act(async () => {
      root.render(<Harness guarded={false} />)
    })
    await act(async () => {
      window.history.forward()
      await new Promise(resolve => setTimeout(resolve, 80))
    })
    expect(window.location.search).equals('?days=0')
    expect(routes).length(2)
    expect(routes[1]).includes({ days: '0' })
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    window.history.replaceState(null, '', '/')
  }
})
