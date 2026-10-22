import React, { createContext, useContext, useState } from 'react'
import { View } from 'react-native'

import { useChatOverlayCommit } from './chatWebInteractions'

interface OverlayEntry {
  node: React.ReactNode
  modal: boolean
}

const OverlayContext = createContext<
  React.Dispatch<React.SetStateAction<OverlayEntry | null>> | undefined
>(undefined)

/** A same-window host lets Android's native blur sample the actual chat. */
export function ChatOverlayHost({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  const [overlay, setOverlay] = useState<OverlayEntry | null>(null)
  const modal = overlay?.modal === true
  return (
    <OverlayContext.Provider value={setOverlay}>
      <View style={{ flex: 1 }}>
        <View
          aria-hidden={modal}
          style={{ flex: 1 }}
          pointerEvents={modal ? 'none' : 'auto'}
          accessibilityElementsHidden={modal}
          importantForAccessibility={modal ? 'no-hide-descendants' : 'auto'}
        >
          {children}
        </View>
        {overlay?.node}
      </View>
    </OverlayContext.Provider>
  )
}

export function ChatOverlayPortal({
  children,
  modal = true
}: {
  children: React.ReactNode
  modal?: boolean
}): React.ReactElement | null {
  const host = useContext(OverlayContext)
  // The web twin publishes controls before React restores their DOM values.
  useChatOverlayCommit(() => {
    if (host == null) return
    host({ node: children, modal })
    return () => {
      host(null)
    }
  }, [host, children, modal])
  return host == null ? <>{children}</> : null
}
