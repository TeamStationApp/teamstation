import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ScreenScope } from '../../common/gameSocket'
import type { ScreenScopeSocket } from '../../common/screenScope'
import { useBackOverride, useHeaderHandoff } from '../components/headerSlot'
import {
  type ScreenScopeValue,
  ScreenScopeValueProvider,
  useScreenScopeContext
} from '../hooks/useScreenScope'
import { type SceneRole, SceneSlot, useSceneActive } from './sceneSlot'

let root: Root | undefined
let host: HTMLDivElement
const handoffs: React.ReactNode[] = []
const overrides: Array<(() => void) | null> = []
const scopesSeen = new Map<string, ScreenScopeValue[]>()
const activeSeen = new Map<string, boolean[]>()

function Writer(props: {
  name: string
  handoff?: string
  back?: boolean
}): React.ReactElement {
  useHeaderHandoff(props.handoff ?? null)
  useBackOverride(props.back === true, () => undefined)
  const scope = useScreenScopeContext()
  const active = useSceneActive()
  scopesSeen.set(props.name, [...(scopesSeen.get(props.name) ?? []), scope])
  activeSeen.set(props.name, [...(activeSeen.get(props.name) ?? []), active])
  return <span>{props.name}</span>
}

interface Slot {
  name: string
  role: SceneRole
  handoff?: string
  back?: boolean
}

async function render(
  slots: Slot[],
  scope: ScreenScopeValue = {}
): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <ScreenScopeValueProvider value={scope}>
        {slots.map(slot => (
          <SceneSlot
            key={slot.name}
            role={slot.role}
            headerHeight={0}
            onHandoff={node => handoffs.push(node)}
            onBackOverride={handler => overrides.push(handler)}
          >
            <Writer name={slot.name} handoff={slot.handoff} back={slot.back} />
          </SceneSlot>
        ))}
      </ScreenScopeValueProvider>
    )
  })
}

describe('scene slot', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    handoffs.length = 0
    overrides.length = 0
    scopesSeen.clear()
    activeSeen.clear()
  })

  describe('scene slot header (U11)', function () {
    it('keeps the new top’s header when the top goes in the same commit', async function () {
      await render([
        { name: 'player', role: 'top', handoff: 'Player', back: true },
        { name: 'team', role: 'beneath', handoff: 'Team' }
      ])
      expect(handoffs.at(-1)).equals('Player')
      // A completed drag back: the player unmounts as the team becomes top.
      await render([{ name: 'team', role: 'top', handoff: 'Team' }])
      expect(handoffs.at(-1)).equals('Team')
      expect(overrides.at(-1)).equals(null)
    })

    it('lets only the top write the header', async function () {
      await render([
        { name: 'team', role: 'outgoing', handoff: 'Team' },
        { name: 'player', role: 'top', handoff: 'Player', back: true }
      ])
      expect(handoffs).not.includes('Team')
      expect(handoffs.at(-1)).equals('Player')
      expect(overrides.at(-1)).not.equals(null)
      expect(activeSeen.get('team')?.at(-1)).equals(false)
      expect(activeSeen.get('player')?.at(-1)).equals(true)
    })

    it('keeps a leaving scene from clearing the next one', async function () {
      await render([{ name: 'team', role: 'top', handoff: 'Team', back: true }])
      await render([
        { name: 'team', role: 'outgoing', handoff: 'Team', back: true },
        { name: 'player', role: 'top', handoff: 'Player' }
      ])
      expect(handoffs.at(-1)).equals('Player')
      expect(overrides.at(-1)).equals(null)
      const written = handoffs.length
      // The leaving scene unmounts at the end of the move.
      await render([{ name: 'player', role: 'top', handoff: 'Player' }])
      expect(handoffs.slice(written)).not.includes(null)
      expect(overrides.at(-1)).equals(null)
    })

    it('forwards what a scene recorded when it becomes the top, nothing included', async function () {
      await render([
        { name: 'team', role: 'beneath' },
        { name: 'player', role: 'top', handoff: 'Player', back: true }
      ])
      expect(handoffs.at(-1)).equals('Player')
      await render([
        { name: 'team', role: 'top' },
        { name: 'player', role: 'outgoing', handoff: 'Player', back: true }
      ])
      expect(handoffs.at(-1)).equals(null)
      expect(overrides.at(-1)).equals(null)
    })
  })

  describe('scene slot screen scope (U11)', function () {
    const socket: ScreenScopeSocket = {
      subscribeScope: () => () => undefined
    }
    const home: ScreenScopeValue = {
      socket,
      scope: { scope: 'home' } satisfies ScreenScope
    }
    const event: ScreenScopeValue = {
      socket,
      scope: { scope: 'event', gameId: 'g1' }
    }

    it('passes the top through, freezes a leaving scene and withholds it beneath', async function () {
      await render([{ name: 'home', role: 'top' }], home)
      expect(scopesSeen.get('home')?.at(-1)).equals(home)
      await render(
        [
          { name: 'home', role: 'outgoing' },
          { name: 'game', role: 'top' }
        ],
        event
      )
      // Frozen: the very value it had as the top, so its loads stay put.
      expect(scopesSeen.get('home')?.at(-1)).equals(home)
      expect(scopesSeen.get('game')?.at(-1)).equals(event)
      await render(
        [
          { name: 'home', role: 'beneath' },
          { name: 'game', role: 'top' }
        ],
        event
      )
      expect(scopesSeen.get('home')?.at(-1)).deep.equals({
        socket: undefined,
        scope: undefined
      })
      await render([{ name: 'home', role: 'top' }], home)
      expect(scopesSeen.get('home')?.at(-1)).equals(home)
    })
  })
})
