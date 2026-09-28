import { Canvas } from '@react-three/fiber'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { useBreakpoint } from '../components'
import { useTheme } from '../theme/ThemeContext'
import { syncFieldNameplates } from './fieldNameplates'
import { FieldScene } from './FieldScene'
import type { FieldCanvasProps } from './fieldTypes'
import type { NameplatePlacement } from './playerPresentation'

/** R3F's async renderer setup does not always reach a React error boundary. */
function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (gl == null) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}
function Unavailable({ retry }: { retry: () => void }): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        gap: 12
      }}
    >
      <Text
        style={{
          color: theme.primaryTextColor,
          fontSize: 20,
          fontWeight: '700'
        }}
      >
        This browser cannot start 3D
      </Text>
      <Text
        style={{
          color: theme.primaryTextColor,
          textAlign: 'center',
          maxWidth: 360
        }}
      >
        Open this preview in Safari or Chrome with WebGL enabled to explore the
        field.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={retry}
        style={{
          padding: 14,
          borderRadius: 8,
          backgroundColor: theme.primaryButtonColor
        }}
      >
        <Text style={{ color: theme.buttonTextColor }}>Try again</Text>
      </Pressable>
    </View>
  )
}
class RenderBoundary extends React.Component<
  { children: React.ReactNode; onFailure?: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  componentDidCatch(): void {
    this.props.onFailure?.()
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): React.ReactNode {
    if (this.state.failed)
      return (
        <Unavailable
          retry={() => {
            this.setState({ failed: false })
          }}
        />
      )
    return this.props.children
  }
}
export function FieldCanvas(props: FieldCanvasProps): React.ReactElement {
  const phone = useBreakpoint() === 'phone'
  // Retain the event host across asynchronous renderer startup and route exit.
  const [eventHost, setEventHost] = useState<HTMLDivElement | null>(null)
  const [mobileInput] = useState(
    () =>
      typeof navigator !== 'undefined' &&
      navigator.maxTouchPoints > 0 &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches
  )
  const [available, setAvailable] = useState(supportsWebGL)
  const [hidden, setHidden] = useState(() => document.hidden)
  useEffect(() => {
    const change = (): void => {
      setHidden(document.hidden)
    }
    document.addEventListener('visibilitychange', change)
    return () => {
      document.removeEventListener('visibilitychange', change)
    }
  }, [])
  const { presentation, onPresentationDone } = props
  const recover = useCallback((): void => {
    const sequence = presentation
    if (sequence != null)
      onPresentationDone?.(sequence.id, sequence.generation, sequence.stage)
  }, [presentation, onPresentationDone])
  useEffect(() => {
    if (!available) recover()
  }, [available, recover])

  const labelHost = useRef<HTMLDivElement>(null)
  const onNameplates = useCallback((plates: NameplatePlacement[]) => {
    if (labelHost.current != null)
      syncFieldNameplates(labelHost.current, plates)
  }, [])
  const keyboard = useRef<((key: string) => boolean) | null>(null)
  const { registerKeyboard: registerParentKeyboard } = props
  const registerKeyboard = useCallback(
    (handler: ((key: string) => boolean) | null) => {
      keyboard.current = handler
      registerParentKeyboard?.(
        handler == null
          ? null
          : key => {
              const handled = handler(key)
              if (key === 'Enter' || key === 'Escape') eventHost?.focus()
              return handled
            }
      )
    },
    [registerParentKeyboard, eventHost]
  )
  const cancelGesture = useRef<(() => void) | null>(null)
  const registerInterruption = useCallback((cancel: (() => void) | null) => {
    cancelGesture.current = cancel
  }, [])
  const [generation, setGeneration] = useState(0)
  const retry = (): void => {
    setAvailable(supportsWebGL())
    setGeneration(value => value + 1)
  }
  if (!available) return <Unavailable retry={retry} />
  return (
    <div
      onPointerCancelCapture={() => {
        cancelGesture.current?.()
      }}
      onLostPointerCaptureCapture={() => {
        cancelGesture.current?.()
      }}
      tabIndex={0}
      role="application"
      aria-label="Baseball field. Brackets focus a player, Space grabs, arrows move, S or O chooses runner Safe or Out, Enter releases, Escape cancels."
      onKeyDown={event => {
        if (event.key === 'Escape') cancelGesture.current?.()
        if (keyboard.current?.(event.key) === true) event.preventDefault()
      }}
      ref={node => {
        if (node != null) setEventHost(node)
      }}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none'
      }}
    >
      <RenderBoundary key={generation} onFailure={recover}>
        {eventHost != null && (
          <Canvas
            eventSource={eventHost}
            frameloop="demand"
            shadows
            dpr={[1, phone ? 1.25 : 1.5]}
            camera={{ position: [0, 100, 114], fov: 43 }}
            gl={{
              antialias: true,
              alpha: false,
              powerPreference: 'high-performance'
            }}
            onCreated={({ gl }) => {
              gl.domElement.addEventListener(
                'webglcontextlost',
                () => {
                  cancelGesture.current?.()
                  setAvailable(false)
                },
                { once: true }
              )
            }}
            style={{
              touchAction: 'none',
              width: '100%',
              height: '100%',
              cursor: 'grab'
            }}
            fallback={<Unavailable retry={retry} />}
          >
            <FieldScene
              {...props}
              onNameplates={onNameplates}
              presentationPaused={props.presentationPaused === true || hidden}
              registerInterruption={registerInterruption}
              registerKeyboard={registerKeyboard}
              touchPlacement={props.touchPlacement === true || mobileInput}
            />
          </Canvas>
        )}
        <div
          ref={labelHost}
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            pointerEvents: 'none'
          }}
        />
      </RenderBoundary>
    </div>
  )
}
