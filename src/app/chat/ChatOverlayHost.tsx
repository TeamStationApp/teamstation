import React, { createContext, useContext, useEffect, useState } from 'react'
import { View } from 'react-native'

const OverlayContext = createContext<
  React.Dispatch<React.SetStateAction<React.ReactNode>> | undefined
>(undefined)

/** A same-window host lets Android's native blur sample the actual chat. */
export function ChatOverlayHost({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  const [overlay, setOverlay] = useState<React.ReactNode>(null)
  return (
    <OverlayContext.Provider value={setOverlay}>
      <View style={{ flex: 1 }}>
        <View
          aria-hidden={overlay != null}
          style={{ flex: 1 }}
          pointerEvents={overlay == null ? 'auto' : 'none'}
          accessibilityElementsHidden={overlay != null}
          importantForAccessibility={
            overlay == null ? 'auto' : 'no-hide-descendants'
          }
        >
          {children}
        </View>
        {overlay}
      </View>
    </OverlayContext.Provider>
  )
}

export function ChatOverlayPortal({
  children
}: {
  children: React.ReactNode
}): React.ReactElement | null {
  const host = useContext(OverlayContext)
  useEffect(() => {
    if (host == null) return
    host(children)
    return () => {
      host(null)
    }
  }, [host, children])
  return host == null ? <>{children}</> : null
}
