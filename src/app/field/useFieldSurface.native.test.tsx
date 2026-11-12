import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'

import type { Insets } from '../platform/insets'
import { useFieldInsets, useFieldSurface } from './useFieldSurface.native'

describe('field insets on a phone', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
  })

  it('are the safe area’s own numbers', async function () {
    const phone: Insets = { top: 59, bottom: 34, left: 0, right: 0 }
    let seen: Insets | undefined
    let safe: unknown
    function Probe(): null {
      seen = useFieldInsets()
      safe = useFieldSurface().safe
      return null
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <SafeAreaInsetsContext.Provider value={phone}>
          <Probe />
        </SafeAreaInsetsContext.Provider>
      )
    })
    expect(seen).deep.equals(phone)
    expect(safe).deep.include({ paddingTop: 59, paddingBottom: 42 })
  })
})
