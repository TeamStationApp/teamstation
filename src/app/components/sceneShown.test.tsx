import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { SceneShownProvider, useSceneReveals } from './sceneShown'

describe('a scene’s reveals', function () {
  let root: Root | undefined
  let reveals = -1
  function Screen(): null {
    reveals = useSceneReveals()
    return null
  }
  const draw = async (shown: boolean): Promise<void> => {
    await act(async () => {
      root!.render(
        <SceneShownProvider value={shown}>
          <Screen />
        </SceneShownProvider>
      )
    })
  }
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('counts each time the screen comes back from under another', async function () {
    root = createRoot(document.createElement('div'))
    await draw(true)
    expect(reveals).equals(0)
    await draw(false)
    expect(reveals).equals(0)
    await draw(false)
    expect(reveals).equals(0)
    await draw(true)
    expect(reveals).equals(1)
    await draw(true)
    expect(reveals).equals(1)
    await draw(false)
    await draw(true)
    expect(reveals).equals(2)
  })
})
