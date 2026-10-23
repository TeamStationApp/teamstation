import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ScreenScope } from '../../common/gameSocket'
import type { ScreenScopeSocket } from '../../common/screenScope'
import { useBackOverride, useHeaderHandoff } from '../components/headerSlot'
import { useSceneShown } from '../components/sceneShown'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import {
  type ScreenScopeValue,
  ScreenScopeValueProvider,
  useScreenScopeContext
} from '../hooks/useScreenScope'
import { type SceneRole, SceneSlot } from './sceneSlot'

let root: Root | undefined
let host: HTMLDivElement
const handoffs: React.ReactNode[] = []
const overrides: Array<(() => void) | null> = []
const scopesSeen = new Map<string, ScreenScopeValue[]>()

function Writer(props: {
  name: string
  handoff?: string
  back?: boolean
}): React.ReactElement {
  useHeaderHandoff(props.handoff ?? null)
  useBackOverride(props.back === true, () => undefined)
  const scope = useScreenScopeContext()
  scopesSeen.set(props.name, [...(scopesSeen.get(props.name) ?? []), scope])
  return <span>{props.name}</span>
}

interface Slot {
  name: string
  role: SceneRole
  handoff?: string
  back?: boolean
  holds?: boolean
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
            holdsHandoff={slot.holds}
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
    })

    it('leaves the header with the covered scene while a cover rises, and Back with the cover', async function () {
      await render([{ name: 'game', role: 'top', handoff: 'Game 3–2' }])
      expect(handoffs.at(-1)).equals('Game 3–2')
      // The scorer rises over the game: the header still shows the game's.
      await render([
        { name: 'game', role: 'outgoing', handoff: 'Game 3–2', holds: true },
        { name: 'score', role: 'top', back: true, holds: false }
      ])
      expect(handoffs.at(-1)).equals('Game 3–2')
      expect(overrides.at(-1)).not.equals(null)
      // Landed: the scorer's own, which is none.
      await render([{ name: 'score', role: 'top', back: true }])
      expect(handoffs.at(-1)).equals(null)
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

    it('passes the top through, and freezes a scene leaving or covered', async function () {
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
      // Covered once the push lands, and revealed by a drag: still frozen,
      // so it does not load again beneath the top.
      await render(
        [
          { name: 'home', role: 'covered' },
          { name: 'game', role: 'top' }
        ],
        event
      )
      expect(scopesSeen.get('home')?.at(-1)).equals(home)
      await render(
        [
          { name: 'home', role: 'beneath' },
          { name: 'game', role: 'top' }
        ],
        event
      )
      expect(scopesSeen.get('home')?.at(-1)).equals(home)
      await render([{ name: 'home', role: 'top' }], home)
      expect(scopesSeen.get('home')?.at(-1)).equals(home)
    })

    it('withholds the scope from a scene mounted beneath that was never the top', async function () {
      await render(
        [
          { name: 'team', role: 'covered' },
          { name: 'game', role: 'top' }
        ],
        event
      )
      expect(scopesSeen.get('team')?.at(-1)).deep.equals({
        socket: undefined,
        scope: undefined
      })
      expect(scopesSeen.get('game')?.at(-1)).equals(event)
    })
  })

  describe('scene slot on show', function () {
    const shown = new Map<string, boolean>()
    const reads = new Map<string, number>()
    function Showing(props: { name: string }): React.ReactElement {
      shown.set(props.name, useSceneShown())
      useForegroundRefresh(async () => {
        reads.set(props.name, (reads.get(props.name) ?? 0) + 1)
      })
      return <span>{props.name}</span>
    }
    async function place(
      slots: Array<{ name: string; role: SceneRole }>
    ): Promise<void> {
      if (root == null) {
        host = document.createElement('div')
        document.body.append(host)
        root = createRoot(host)
      }
      await act(async () => {
        root!.render(
          <>
            {slots.map(slot => (
              <SceneSlot
                key={slot.name}
                role={slot.role}
                headerHeight={0}
                onHandoff={() => undefined}
                onBackOverride={() => undefined}
              >
                <Showing name={slot.name} />
              </SceneSlot>
            ))}
          </>
        )
      })
    }

    it('shows the top and the retained scorer, and no scene covered, leaving or beneath a drag', async function () {
      await place([
        { name: 'top', role: 'top' },
        { name: 'covered', role: 'covered' },
        { name: 'outgoing', role: 'outgoing' },
        { name: 'beneath', role: 'beneath' },
        { name: 'scorer', role: 'retained' }
      ])
      expect(Object.fromEntries(shown)).deep.equals({
        top: true,
        covered: false,
        outgoing: false,
        beneath: false,
        scorer: true
      })
    })

    it('reads nothing on a covered screen until Back shows it again', async function () {
      await place([{ name: 'game', role: 'top' }])
      expect(reads.get('game')).equals(1)
      await place([
        { name: 'game', role: 'covered' },
        { name: 'player', role: 'top' }
      ])
      // Back to the app: the screen on show reads, the covered one does not.
      await act(async () => {
        window.dispatchEvent(new window.Event('focus'))
      })
      expect(reads.get('player')).equals(2)
      expect(reads.get('game')).equals(1)
      // Shown again, it reads once.
      await place([{ name: 'game', role: 'top' }])
      expect(reads.get('game')).equals(2)
    })

    it('reads once on a screen mounted covered, so Back reveals it loaded', async function () {
      // A pop from depth 3: the new top's screen beneath mounts covered.
      await place([
        { name: 'home', role: 'covered' },
        { name: 'team', role: 'top' }
      ])
      expect(reads.get('home')).equals(1)
      await act(async () => {
        window.dispatchEvent(new window.Event('focus'))
      })
      expect(reads.get('home')).equals(1)
      await place([{ name: 'home', role: 'top' }])
      expect(reads.get('home')).equals(2)
    })
  })
})
