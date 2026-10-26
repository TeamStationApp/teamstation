import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { Text } from 'react-native'

import { render, unmount } from '../../test/tessTestKit'
import { TessOverlayLayer } from './TessOverlayLayer.native'

afterEach(async () => {
  await unmount()
})

describe("the phone's overlay layer", function () {
  it('covers the pane it is drawn in, above its header', async function () {
    await render(
      <TessOverlayLayer>
        <Text>Comets</Text>
      </TessOverlayLayer>
    )
    const layer = document.querySelector<HTMLElement>(
      '[data-testid="Tess overlay"]'
    )!
    expect(layer.textContent).equals('Comets')
    // In the pane's own tree, not portalled out of it.
    expect(layer.parentElement).not.equals(document.body)
    const style = getComputedStyle(layer)
    expect(style.position).equals('absolute')
    expect(style.zIndex).equals('10')
  })
})
