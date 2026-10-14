import React, { createContext, useContext, useEffect, useState } from 'react'
import { Platform, View } from 'react-native'

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
  // iOS ends editing when the focused composer leaves the window or loses
  // interaction, so opening message actions would drop the keyboard. The chat
  // view is never flattened, or the modal props below would re-parent it under
  // a new native view, and 'box-only' swallows touches where 'none' would turn
  // interaction off.
  const hiddenTouches = Platform.OS === 'web' ? 'none' : 'box-only'
  return (
    <OverlayContext.Provider value={setOverlay}>
      <View style={{ flex: 1 }}>
        <View
          aria-hidden={modal}
          collapsable={false}
          style={{ flex: 1 }}
          pointerEvents={modal ? hiddenTouches : 'auto'}
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
  useEffect(() => {
    if (host == null) return
    host({ node: children, modal })
    return () => {
      host(null)
    }
  }, [host, children, modal])
  return host == null ? <>{children}</> : null
}
