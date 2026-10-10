import { Canvas, useThree } from '@react-three/fiber/native'
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { PanResponder, PixelRatio, StyleSheet, View } from 'react-native'

import { useBreakpoint } from '../components'
import {
  createRelay,
  frameSetter,
  type Relay,
  useRelay
} from './fieldPropsRelay'
import { FieldRenderScale } from './FieldRenderScale'
import { fieldRenderBox } from './fieldResolution'
import { FieldScene } from './FieldScene'
import { fieldTouchHandlers, type FieldTouchTarget } from './fieldTouches'
import type { FieldCanvasProps } from './fieldTypes'
import { FieldNameplates, useFieldNameplates } from './NativeNameplates'
import type { NameplatePlacement } from './playerPresentation'

/**
 * The phone's field: the same `FieldScene` the browser draws, through
 * expo-gl's `GLView` rather than a `<canvas>`. Never a WebView.
 *
 * Touches reach the scene as the DOM pointer events Fiber's web event manager
 * reads, so the raycast hit-testing is the web's own. `fieldTouches.ts` makes
 * them, in place of the Canvas's own responder (it says why).
 * A renderer that fails still ends the presentation it was showing, as the
 * web's error boundary does, so a pitch is never left waiting on the field.
 *
 * expo-gl sizes its drawing buffer once, when the context is made, so a new
 * size — the phone turned — gets a new Canvas rather than a stretched one.
 * It also draws at the screen's full pixel ratio, so the Canvas is laid out
 * smaller and stretched to hold the browser's cap (`fieldRenderBox`), and
 * the scene is kept at the field's own size (`FieldRenderScale`). Its props
 * reach it through a relay, so the Canvas element never changes and Fiber
 * does not resize the scene back on every render, a frame after the render
 * that brought them, so the screen and the scene never share one task.
 *
 * The players' nameplates are views over the canvas, as the browser's are
 * HTML over its canvas, moved each frame without React (`NativeNameplates`).
 */
export function FieldCanvas(props: FieldCanvasProps): React.ReactElement {
  const { presentation, onPresentationDone } = props
  const recover = useCallback((): void => {
    if (presentation != null)
      onPresentationDone?.(
        presentation.id,
        presentation.generation,
        presentation.stage
      )
  }, [presentation, onPresentationDone])
  const phone = useBreakpoint() === 'phone'
  const [layout, setLayout] = useState<{ width: number; height: number }>()
  const [relay] = useState(() => createRelay(props))
  // The scene takes the screen's props on the frame after, not in the task
  // that rendered the screen (`frameSetter`).
  const [setter] = useState(() => frameSetter(relay))
  useLayoutEffect(() => {
    setter.set(props)
  })
  useEffect(
    () => () => {
      setter.cancel()
    },
    [setter]
  )
  const nameplates = useFieldNameplates()
  const { report } = nameplates
  const element = useRef<FieldTouchTarget | null>(null)
  const touches = useMemo(
    () => PanResponder.create(fieldTouchHandlers(() => element.current)),
    []
  )
  const canvas = useMemo(() => {
    if (layout == null) return null
    const box = fieldRenderBox(
      layout.width,
      layout.height,
      PixelRatio.get(),
      phone
    )
    return (
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          transform: [{ scale: box.stretch }]
        }}
      >
        <Canvas
          frameloop="demand"
          camera={{ position: [0, 100, 114], fov: 43 }}
          gl={{ antialias: true, alpha: false }}
          style={{ flex: 1 }}
          pointerEvents="none"
          onCreated={state => {
            // Fiber's native stand-in for the <canvas> dispatches to the
            // listeners its event manager adds, as a browser's would.
            element.current = state.gl.domElement as unknown as FieldTouchTarget
          }}
        >
          <FieldRenderScale
            width={layout.width}
            height={layout.height}
            ratio={box.ratio}
          />
          <RelayedScene relay={relay} onNameplates={report} />
        </Canvas>
      </View>
    )
  }, [layout, phone, relay, report])
  return (
    <View
      style={{ flex: 1 }}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout
        const next = { width: Math.round(width), height: Math.round(height) }
        setLayout(current =>
          current?.width === next.width && current.height === next.height
            ? current
            : next
        )
      }}
    >
      {layout != null && (
        <RenderBoundary
          key={`${layout.width}x${layout.height}`}
          onFailure={recover}
        >
          {canvas}
        </RenderBoundary>
      )}
      <FieldNameplates faces={nameplates.faces} spots={nameplates.spots} />
      <View style={StyleSheet.absoluteFill} {...touches.panHandlers} />
    </View>
  )
}

function RelayedScene({
  relay,
  onNameplates
}: {
  relay: Relay<FieldCanvasProps>
  onNameplates: (plates: NameplatePlacement[]) => void
}): React.ReactElement {
  const relayed = useRelay(relay)
  // A presentation's first frame is drawn in the task that brought it, not
  // in the frame after, when Fiber's own loop would: that frame after was
  // most of a pitch's wait between the tap and the ball leaving the hand.
  const advance = useThree(state => state.advance)
  const invalidate = useThree(state => state.invalidate)
  useEffect(() => {
    invalidate()
  }, [relayed.players, invalidate])
  const starting = relayed.presentation?.id
  useLayoutEffect(() => {
    // React Native has `performance.now()`, but its types leave it out.
    const clock = (globalThis as { performance?: { now: () => number } })
      .performance
    if (starting != null) advance(clock?.now() ?? Date.now())
  }, [starting, advance])
  return <FieldScene {...relayed} onNameplates={onNameplates} touchPlacement />
}

class RenderBoundary extends React.Component<
  { children: React.ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(): void {
    this.props.onFailure()
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
