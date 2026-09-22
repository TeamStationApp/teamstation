import { Canvas } from '@react-three/fiber'
import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { FieldScene } from './FieldScene'
import type { FieldCanvasProps } from './fieldTypes'

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
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
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
  const [available, setAvailable] = useState(supportsWebGL)
  const [generation, setGeneration] = useState(0)
  const retry = (): void => {
    setAvailable(supportsWebGL())
    setGeneration(value => value + 1)
  }
  if (!available) return <Unavailable retry={retry} />
  return (
    <RenderBoundary key={generation}>
      <Canvas
        shadows
        dpr={[1, 1.5]}
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
        <FieldScene {...props} />
      </Canvas>
    </RenderBoundary>
  )
}
