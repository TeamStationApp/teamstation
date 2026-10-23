import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef
} from 'react'

import { HeaderSlotProvider } from '../components/headerSlot'
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
 * - `retained`: kept mounted and hidden under a child (the scorer under a
 *   player's settings).
 */
export type SceneRole = 'top' | 'outgoing' | 'beneath' | 'retained'

const SceneActiveContext = createContext(true)

/** Whether this scene is the top: the one the reader is on. */
export function useSceneActive(): boolean {
  return useContext(SceneActiveContext)
}

export interface SceneSlotProps {
  role: SceneRole
  /** The header and banner's height; 0 for a screen that draws its own. */
  headerHeight: number
  onHandoff: (node: React.ReactNode) => void
  onBackOverride: (handler: (() => void) | null) => void
  children: React.ReactNode
}

/**
 * One scene's share of what the shell holds for whichever screen is on top.
 *
 * With several scenes mounted at once — a push in progress, a drag revealing
 * the screen beneath — only the top may write the header. Each scene records
 * its latest handoff and back override, and forwards them only while it is
 * the top; a scene that becomes the top forwards what it recorded, nothing
 * included. So a screen leaving cannot clear the next one's header when it
 * finally unmounts.
 *
 * The screen scope follows the same rule: the top passes the shell's through,
 * a scene on its way out keeps the one it had (its loads do not start again
 * while it slides off), and a scene drawn beneath a drag gets none, so its
 * loads run at once without taking the socket from the top.
 */
export function SceneSlot(props: SceneSlotProps): React.ReactElement {
  const { role, headerHeight, onHandoff, onBackOverride, children } = props
  const active = role === 'top'
  const activeRef = useRef(active)
  activeRef.current = active
  const forward = useRef({ onHandoff, onBackOverride })
  forward.current = { onHandoff, onBackOverride }
  const recorded = useRef<{
    handoff: React.ReactNode
    back: (() => void) | null
  }>({ handoff: null, back: null })

  const setHandoff = useMemo(
    () => (node: React.ReactNode) => {
      recorded.current.handoff = node
      if (activeRef.current) forward.current.onHandoff(node)
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
    if (!active) return
    forward.current.onHandoff(recorded.current.handoff)
    forward.current.onBackOverride(recorded.current.back)
  }, [active])
  // A top that goes in the commit that reveals the scene beneath it (a drag
  // back that completed) stops forwarding before its screen's cleanups run:
  // they would clear the header the new top has just written.
  useLayoutEffect(
    () => () => {
      activeRef.current = false
    },
    []
  )

  const shared = useScreenScopeContext()
  const kept = useRef<ScreenScopeValue>(shared)
  if (active) kept.current = shared
  // Always the same tree, whatever the role: a provider that came and went
  // would remount the screen inside it.
  const scope =
    role === 'top' ? shared : role === 'beneath' ? WITHHELD : kept.current

  return (
    <ScreenScopeValueProvider value={scope}>
      <SceneActiveContext.Provider value={active}>
        <HeaderSlotProvider
          headerHeight={headerHeight}
          onHandoff={setHandoff}
          onBackOverride={setBackOverride}
        >
          {children}
        </HeaderSlotProvider>
      </SceneActiveContext.Provider>
    </ScreenScopeValueProvider>
  )
}

const WITHHELD: ScreenScopeValue = { socket: undefined, scope: undefined }
