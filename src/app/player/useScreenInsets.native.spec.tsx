import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'

import type { Insets } from '../platform/insets'
import { useScreenInsets } from './useScreenInsets.native'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

function Probe(props: { seen: Insets[] }): null {
  props.seen.push(useScreenInsets())
  return null
}

describe("the full-screen grid's insets on a phone (U33c)", function () {
  it("answers its provider's insets", async function () {
    const insets = { top: 59, right: 0, bottom: 34, left: 0 }
    const seen: Insets[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        // What the grid's own provider hands down. The web build's provider
        // measures `env()` itself, which a test page has none of, so the
        // insets go straight into the context the provider fills.
        <SafeAreaInsetsContext.Provider value={insets}>
          <Probe seen={seen} />
        </SafeAreaInsetsContext.Provider>
      )
    })
    expect(seen.at(-1)).deep.equals(insets)
  })
})
