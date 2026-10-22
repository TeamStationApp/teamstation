import { mock } from 'node:test'

import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import type { Mesh, MeshBasicMaterial, Texture } from 'three'

import { sameBallpark } from './Ballpark'
import { Scoreboard } from './Scoreboard'
import { DEMO_SCOREBOARD } from './scoreboardModel'

describe('the scoreboard texture', function () {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] })
  })
  afterEach(() => {
    mock.timers.reset()
  })
  it('is drawn again only when what the board says changes, after the render', async function () {
    const renderer = await create(
      React.createElement(Scoreboard, { state: { ...DEMO_SCOREBOARD } })
    )
    const map = (): Texture | null =>
      (
        (
          renderer.scene.findByProps({ name: 'scoreboard-bulbs' })
            .instance as Mesh
        ).material as MeshBasicMaterial
      ).map
    const first = map()
    await renderer.update(
      React.createElement(Scoreboard, { state: { ...DEMO_SCOREBOARD } })
    )
    expect(map()).equals(first)
    await renderer.update(
      React.createElement(Scoreboard, {
        state: { ...DEMO_SCOREBOARD, balls: DEMO_SCOREBOARD.balls + 1 }
      })
    )
    // Drawn in a task of its own: the board keeps what it said until then.
    expect(map()).equals(first)
    await act(async () => {
      mock.timers.tick(0)
    })
    const second = map()
    expect(second).not.equals(first)
    expect(first?.source.data).not.deep.equals(second?.source.data)
    await renderer.unmount()
  })
})

describe('the park', function () {
  it('draws again only when the board or the teams say something new', function () {
    type Park = Parameters<typeof sameBallpark>[0]
    const textures: Park['textures'] = Object.create(null)
    const park = (balls: number): Park => ({
      textures,
      teams: undefined,
      scoreboard: { ...DEMO_SCOREBOARD, balls }
    })
    expect(sameBallpark(park(1), park(1))).equals(true)
    expect(sameBallpark(park(1), park(2))).equals(false)
    const other: Park['textures'] = Object.create(null)
    expect(sameBallpark(park(1), { ...park(1), textures: other })).equals(false)
  })
})
