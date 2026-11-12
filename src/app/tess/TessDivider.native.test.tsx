import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { responderDrag } from '../../test/responderDrag'
import { byTestId, render, unmount } from '../../test/tessTestKit'
import { TessDivider } from './TessDivider.native'

describe("Tess's native divider", () => {
  afterEach(unmount)

  it('resizes from the left edge, growing left and shrinking right within bounds', async () => {
    const resized: Array<[number, boolean]> = []
    await render(
      <TessDivider
        width={400}
        max={720}
        onResize={(width, done) => resized.push([width, done])}
      />
    )
    const divider = byTestId('Tess divider')!
    expect(getComputedStyle(divider).left).equals('-5px')
    await responderDrag(divider, [
      [500, 100],
      [450, 100],
      [380, 100]
    ])
    expect(resized.at(-1)).deep.equals([520, true])
    await responderDrag(divider, [
      [500, 100],
      [550, 100],
      [1000, 100]
    ])
    expect(resized.at(-1)).deep.equals([320, true])
    await responderDrag(divider, [
      [500, 100],
      [450, 100],
      [-500, 100]
    ])
    expect(resized.at(-1)).deep.equals([720, true])
  })
})
