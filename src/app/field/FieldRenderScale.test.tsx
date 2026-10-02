import { type RootState, useThree } from '@react-three/fiber'
import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'

import { FieldRenderScale } from './FieldRenderScale'

describe('the phone field render scale', function () {
  it('holds the scene at the field size and ratio, and puts them back when reset', async function () {
    let state: RootState | undefined
    function Probe(): null {
      state = useThree()
      return null
    }
    const renderer = await create(
      <>
        <FieldRenderScale width={390} height={844} ratio={1.25} />
        <Probe />
      </>
    )
    expect(state?.size.width).equals(390)
    expect(state?.size.height).equals(844)
    expect(state?.viewport.dpr).equals(1.25)
    // What Fiber's native Canvas does whenever it renders.
    await act(async () => {
      state?.setSize(160, 350)
      state?.setDpr(3)
    })
    expect(state?.size.width).equals(390)
    expect(state?.size.height).equals(844)
    expect(state?.viewport.dpr).equals(1.25)
    await renderer.unmount()
  })
})
