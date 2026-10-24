import React, {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState
} from 'react'
import { StyleSheet, View } from 'react-native'

/**
 * Where a full-size table or chart opens on a wide screen: over the right
 * pane only, so the chat beside it stays usable. Without a provider (a narrow
 * screen) the viewer is a full-screen modal instead.
 */
export interface TessOverlaySlot {
  show: (layer: ReactElement) => void
  hide: (layer: ReactElement) => void
}

const SlotContext = createContext<TessOverlaySlot | null>(null)
const LayerContext = createContext<ReactElement | null>(null)

export function useTessOverlay(): TessOverlaySlot | null {
  return useContext(SlotContext)
}

/**
 * Holds the one open layer for the chat and the pane that shows it. Not
 * `active` (a narrow screen), it offers no place, and the viewer opens as a
 * modal instead; the provider stays in the tree so the pane under it is
 * never remounted when the window crosses the boundary.
 */
export function TessOverlayProvider({
  children,
  active = true
}: {
  children: ReactNode
  active?: boolean
}): React.ReactElement {
  const [layer, setLayer] = useState<ReactElement | null>(null)
  const slot = useMemo<TessOverlaySlot>(
    () => ({
      show: setLayer,
      // Only the layer still showing is taken down: a second viewer opened
      // before the first closed keeps its place.
      hide: closing => {
        setLayer(current => (current === closing ? null : current))
      }
    }),
    []
  )
  return (
    <SlotContext.Provider value={active ? slot : null}>
      <LayerContext.Provider value={active ? layer : null}>
        {children}
      </LayerContext.Provider>
    </SlotContext.Provider>
  )
}

/** Drawn last inside the right pane, covering it while a layer is open. */
export function TessOverlayHost(): React.ReactElement | null {
  const layer = useContext(LayerContext)
  if (layer == null) return null
  return (
    <View testID="Tess overlay" style={[StyleSheet.absoluteFill, LAYER]}>
      {layer}
    </View>
  )
}

/** Above the pane's header and banner, which float over the pane too. */
const LAYER = { zIndex: 10 }
