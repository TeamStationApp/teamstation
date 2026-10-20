import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import { userIdOfGumbo } from '../../common/userId'
import {
  backFromScoringPlayer,
  currentRoute,
  scoringOriginHistory,
  seedRoute,
  showRoute
} from '../navigation/useAddressBar.native'
import { ScoringPlayerSettingsFlow } from './ScoringPlayerSettingsFlow'
import { useScoringExit as nativeExit } from './useScoringExit.native'
describe('retained scoring host', function () {
  it('retains one scorer while hiding it and switching the normal child', async function () {
    let mounts = 0
    let unmounts = 0
    const Scorer = (): React.ReactElement => {
      useEffect(() => {
        mounts++
        return () => {
          unmounts++
        }
      }, [])
      return <span>Scorer</span>
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      for (const active of [true, false, true, false])
        await act(async () => {
          root.render(
            <ScoringPlayerSettingsFlow scoring={<Scorer />} active={active}>
              <span>Player Settings</span>
            </ScoringPlayerSettingsFlow>
          )
        })
      expect(mounts).equals(1)
      expect(unmounts).equals(0)
      expect(host.textContent).includes('Player Settings')
      expect(host.querySelector('[aria-hidden="true"]')).not.equals(null)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
    expect(unmounts).equals(1)
  })
  it('returns the native header through all child tab steps and flushes real exits', async function () {
    seedRoute('teamstation://games/game_fixture/score')
    const marker = scoringOriginHistory()
    showRoute({
      name: 'player',
      userId: userIdOfGumbo(100),
      onTeam: 'away',
      tab: 'settings'
    })
    showRoute({
      name: 'player',
      userId: userIdOfGumbo(100),
      onTeam: 'away',
      tab: 'stats'
    })
    expect(backFromScoringPlayer(marker)).equals(true)
    expect(currentRoute()).deep.equals({
      name: 'scoreGame',
      gameId: 'game_fixture'
    })
    let exits = 0
    nativeExit('game_fixture', false, () => {
      exits++
    })()
    expect(exits).equals(1)
    nativeExit(
      'game_fixture',
      true,
      () => {
        exits++
      },
      async () => false
    )()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(exits).equals(1)
    nativeExit(
      'game_fixture',
      true,
      () => {
        exits++
      },
      async () => true
    )()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(exits).equals(2)
    nativeExit(
      'game_fixture',
      true,
      () => {
        exits++
      },
      async () => {
        throw new Error('offline')
      }
    )()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(exits).equals(2)
  })
})
