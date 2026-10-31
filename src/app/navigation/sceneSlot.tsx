import React, { useLayoutEffect, useMemo, useRef } from 'react'

import { HeaderSlotProvider } from '../components/headerSlot'
import { SceneShownProvider } from '../components/sceneShown'
import {
  type ScreenScopeValue,
  ScreenScopeValueProvider,
  useScreenScopeContext
} from '../hooks/useScreenScope'

/**
 * What a scene is to the stack right now.
 *
 * - `top`: on show, or coming in.
 * - `outgoing`: leaving during a transition.
 * - `beneath`: drawn under the top while a drag back reveals it.
 * - `covered`: kept mounted and hidden beneath the top, so Back reveals it
 *   as it stood.
 * - `retained`: kept mounted and hidden under a child (the scorer under a
 *   player's settings).
 */
export type SceneRole = 'top' | 'outgoing' | 'beneath' | 'covered' | 'retained'

export interface SceneSlotProps {
  role: SceneRole
  /** The header and banner's height; 0 for a screen that draws its own. */
  headerHeight: number
  /** The floating navbar's height, which a screen keeps clear of. */
  navigationHeight?: number
  onHandoff: (node: React.ReactNode) => void
  /** How much of the header the handoff takes. */
  onHandoffHeight?: (height: number) => void
  /**
   * Whether this scene's handoff is the header's: the top's, except while a
   * screen that draws no header (the scorer) rises over the one whose header
   * still shows beneath it. Back is the top's either way.
   */
  holdsHandoff?: boolean
  onBackOverride: (handler: (() => void) | null) => void
  children: React.ReactNode
}

/**
 * One scene's share of what the shell holds for whichever screen is on top.
 *
 * With several scenes mounted at once — a push in progress, a drag revealing
 * the screen beneath — only the top may write the header. Each scene records
 * its latest handoff, its height and back override, and forwards them only
 * while it is the top; a scene that becomes the top forwards what it
 * recorded, nothing included. So a screen leaving cannot clear the next one's header when it
 * finally unmounts.
 *
 * The screen scope follows the same rule: the top passes the shell's through,
 * and a scene covered or on its way out keeps the one it had (its loads do
 * not start again while it slides off or waits beneath). The socket holds
 * only the newest scope, so the top's subscription supersedes it. A scene
 * mounted beneath that has not been the top gets none, so its loads run at
 * once without taking the socket from the top.
 */
export function SceneSlot(props: SceneSlotProps): React.ReactElement {
  const { role, headerHeight, onHandoff, onBackOverride, children } = props
  const onHandoffHeight = props.onHandoffHeight
  const active = role === 'top'
  const activeRef = useRef(active)
  activeRef.current = active
  const holds = props.holdsHandoff ?? active
  const holdsRef = useRef(holds)
  holdsRef.current = holds
  const forward = useRef({ onHandoff, onHandoffHeight, onBackOverride })
  forward.current = { onHandoff, onHandoffHeight, onBackOverride }
  const recorded = useRef<{
    handoff: React.ReactNode
    height: number
    back: (() => void) | null
  }>({ handoff: null, height: 0, back: null })

  const setHandoff = useMemo(
    () => (node: React.ReactNode) => {
      recorded.current.handoff = node
      if (holdsRef.current) forward.current.onHandoff(node)
    },
    []
  )
  const setHandoffHeight = useMemo(
    () => (height: number) => {
      recorded.current.height = height
      if (holdsRef.current) forward.current.onHandoffHeight?.(height)
    },
    []
  )
  const setBackOverride = useMemo(
    () => (handler: (() => void) | null) => {
      recorded.current.back = handler
      if (activeRef.current) forward.current.onBackOverride(handler)
    },
    []
  )
  useLayoutEffect(() => {
    if (!holds) return
    forward.current.onHandoff(recorded.current.handoff)
    forward.current.onHandoffHeight?.(recorded.current.height)
  }, [holds])
  useLayoutEffect(() => {
    if (!active) return
    forward.current.onBackOverride(recorded.current.back)
  }, [active])
  // A top that goes in the commit that reveals the scene beneath it (a drag
  // back that completed) stops forwarding before its screen's cleanups run:
  // they would clear the header the new top has just written.
  useLayoutEffect(
    () => () => {
      activeRef.current = false
      holdsRef.current = false
    },
    []
  )

  const shared = useScreenScopeContext()
  // A scene keeps the scope it had when it was last the top, so covering it
  // does not reload it. One mounted beneath the top, never the top yet (a
  // drag back's, or the scene kept under the top), has none of its own.
  const kept = useRef<ScreenScopeValue>(active ? shared : WITHHELD)
  if (active) kept.current = shared
  // Always the same tree, whatever the role: a provider that came and went
  // would remount the screen inside it.
  const scope = active ? shared : kept.current

  // On show: the top. The retained scorer stays live beneath its player's
  // settings, as it did before scenes slid.
  const shown = role === 'top' || role === 'retained'

  return (
    <SceneShownProvider value={shown}>
      <ScreenScopeValueProvider value={scope}>
        <HeaderSlotProvider
          headerHeight={headerHeight}
          navigationHeight={props.navigationHeight}
          onHandoff={setHandoff}
          onHandoffHeight={setHandoffHeight}
          onBackOverride={setBackOverride}
        >
          {children}
        </HeaderSlotProvider>
      </ScreenScopeValueProvider>
    </SceneShownProvider>
  )
}

const WITHHELD: ScreenScopeValue = { socket: undefined, scope: undefined }
