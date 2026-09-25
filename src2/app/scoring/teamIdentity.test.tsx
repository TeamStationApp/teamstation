import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import {
  type Mesh,
  type MeshStandardMaterial,
  Texture,
  TextureLoader,
  Vector3
} from 'three'

import { Dugout } from '../field/Dugout'
import { createPlayers } from '../field/fieldModel'
import { Player } from '../field/Player'
import { TEAM_COLORS, uniformColor } from '../field/teamUniform'
import { createDevelopmentSession } from './developmentSession'
import { fieldPlayersFor } from './fieldAdapter'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import { pitchPresentation } from './scoringPresentation'

const jersey = (mesh: Mesh): string =>
  `#${(mesh.material as MeshStandardMaterial).color.getHexString()}`
describe('team identity and dugouts', () => {
  it('keeps team uniforms through half swaps, batter poses, suppression and runner reconstruction', async () => {
    let state = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
    for (const side of ['away', 'home'] as const) {
      const players = fieldPlayersFor(state.session)
      const batter = players.find(p => p.batting === true)!
      expect(batter.uniformSide).equals(side)
      expect(
        players
          .filter(p => p.team === 'defense')
          .every(p => p.uniformSide !== side)
      ).equals(true)
      expect(
        pitchPresentation(state, 'swing').players.find(p => p.batting === true)!
          .uniformSide
      ).equals(side)
      for (const suppressed of [false, true]) {
        const renderer = await create(
          <Player player={{ ...batter, suppressed }} selected={false} />
        )
        expect(
          jersey(
            renderer.scene.findByProps({ name: 'jersey-torso' })
              .instance as Mesh
          )
        ).equals(TEAM_COLORS[side])
        await renderer.unmount()
      }
      const id = batter.playerId!
      const copy = { ...state, homeQueue: [id], motions: [], pendingPlay: null }
      copy.session = structuredClone(state.session)
      copy.session.liveData.linescore.offense.batter = null
      const reconstructed = scoringFieldPlayers(copy).find(
        p => p.playerId === id
      )!
      expect(reconstructed.uniformSide).equals(side)
      expect(uniformColor(reconstructed)).equals(TEAM_COLORS[side])
      state = scoringReducer(state, { type: 'END_HALF' })
    }
    const legacy = createPlayers()
    expect(uniformColor(legacy[0])).equals('#294c78')
    expect(uniformColor(legacy[9])).equals('#e17842')
  })

  it('loads each roof logo independently, faces the stands and survives stale/error/unmounted loads', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the prototype method without invoking it detached.
    const original = TextureLoader.prototype.load
    const requests: Array<{
      texture: Texture
      load: () => void
      fail: () => void
      disposed: number
    }> = []
    TextureLoader.prototype.load = function (_url, onLoad, _progress, onError) {
      const texture = new Texture<HTMLImageElement>(
        document.createElement('img')
      )
      const item = {
        texture,
        load: () => onLoad?.(texture),
        fail: () => onError?.(new Error('missing')),
        disposed: 0
      }
      texture.dispose = () => {
        item.disposed++
      }
      requests.push(item)
      return texture
    }
    const game = {
      ...gameFixture,
      awayLogoUrl: '/away.png',
      homeLogoUrl: '/home.png'
    }
    const teams = createDevelopmentSession(game, [], []).gameData.teams
    const renderer = await create(
      <group>
        <Dugout side="away" team={teams.away} />
        <Dugout side="home" team={teams.home} />
      </group>
    )
    try {
      expect(teams.away.logoUrl).equals('/away.png')
      expect(teams.home.logoUrl).equals('/home.png')
      expect(renderer.scene.findAllByProps({ name: 'dugout-head' })).has.length(
        6
      )
      expect(
        renderer.scene.findAllByProps({ name: 'dugout-shoulders' })
      ).has.length(6)
      expect(
        renderer.scene
          .findAllByProps({ name: 'dugout-roof' })
          .every(n => n.props.position[1] > 6)
      ).equals(true)
      for (const side of ['away', 'home'] as const) {
        const group = renderer.scene.findByProps({ name: `dugout-${side}` })
        for (const name of ['dugout-cap', 'dugout-shoulders'])
          expect(
            group
              .findAllByProps({ name })
              .every(n => jersey(n.instance as Mesh) === TEAM_COLORS[side])
          ).equals(true)
      }
      await act(async () => {
        requests.forEach(r => {
          r.load()
        })
      })
      renderer.scene.instance.updateMatrixWorld(true)
      for (const [index, side] of (['away', 'home'] as const).entries()) {
        const logo = renderer.scene.findByProps({ name: `dugout-logo-${side}` })
          .instance as Mesh
        expect((logo.material as MeshStandardMaterial).map).equals(
          requests[index].texture
        )
        const up = new Vector3(0, 1, 0).transformDirection(logo.matrixWorld)
        expect(up.z).lessThan(0)
        expect(Math.sign(up.x)).equals(side === 'home' ? -1 : 1)
        expect(
          new Vector3(0, 0, 1).transformDirection(logo.matrixWorld).y
        ).closeTo(1, 1e-6)
      }
      await renderer.update(
        <group>
          <Dugout side="away" team={{ name: 'new', logoUrl: '/new.png' }} />
          <Dugout side="home" />
        </group>
      )
      expect(
        renderer.scene.findAllByProps({ name: 'dugout-logo-away' })
      ).has.length(0)
      expect(requests[0].disposed).equals(1)
      expect(requests[1].disposed).equals(1)
      await act(async () => {
        requests[0].load()
        requests[2].fail()
      })
      expect(
        renderer.scene.findAllByProps({ name: 'dugout-logo-away' })
      ).has.length(0)
      await renderer.update(
        <group>
          <Dugout side="away" team={{ name: 'empty', logoUrl: '' }} />
        </group>
      )
      expect(requests[2].disposed).equals(1)
      await renderer.update(
        <Dugout
          side="home"
          team={{ name: 'pending', logoUrl: '/pending.png' }}
        />
      )
      await renderer.unmount()
      await act(async () => {
        requests[3].load()
        requests[3].fail()
      })
      expect(requests[3].disposed).equals(1)
    } finally {
      TextureLoader.prototype.load = original
      await renderer.unmount()
    }
  })
})
