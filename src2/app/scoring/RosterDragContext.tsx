import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react'
import { ScrollView, View } from 'react-native'

import {
  RosterGesture,
  type RosterPreview,
  type RosterRect
} from './rosterGesture'
import { ROSTER_CARD_GAP } from './rosterLayout'
export const RosterContext = createContext<RosterGesture | null>(null)
export const RosterClipContext = createContext<
  (() => Promise<RosterRect>) | undefined
>(undefined)
export function useRosterGesture(): RosterGesture {
  const value = useContext(RosterContext)
  if (value == null) throw new Error('RosterDrag requires RosterDragGroup')
  return value
}
export const measureRosterView = async (
  view: React.ComponentRef<typeof View> | null
): Promise<RosterRect> =>
  await new Promise(resolve => {
    if (view == null) resolve({ x: -10000, y: -10000, width: 0, height: 0 })
    else
      view.measureInWindow((x, y, width, height) => {
        resolve({ x, y, width, height })
      })
  })
export function RosterDragGroup({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  const [preview, setPreview] = useState<RosterPreview | null>(null)
  const [engine] = useState(() => new RosterGesture(setPreview))
  const root = useRef<React.ComponentRef<typeof View>>(null)
  const [origin, setOrigin] = useState({ x: 0, y: 0 })
  useEffect(() => {
    const timer = setInterval(() => {
      engine.tick().catch(() => {
        engine.cancel()
      })
    }, 80)
    return () => {
      clearInterval(timer)
      engine.cancel()
    }
  }, [engine])
  useEffect(() => {
    if (preview == null) return
    let current = true
    measureRosterView(root.current)
      .then(position => {
        if (current)
          setOrigin(previous =>
            previous.x === position.x && previous.y === position.y
              ? previous
              : position
          )
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [preview])
  return (
    <RosterContext.Provider value={engine}>
      <View
        ref={root}
        style={{ flex: 1, minHeight: 0 }}
        onLayout={() => {
          measureRosterView(root.current)
            .then(setOrigin)
            .catch(() => undefined)
        }}
      >
        {children}
        {preview != null && (
          <View
            testID="Roster dragged card"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: preview.x - origin.x - (preview.grab?.x ?? 0),
              top: preview.y - origin.y - (preview.grab?.y ?? 0),
              width: preview.cardRect?.width,
              height: preview.cardRect?.height,
              zIndex: 100
            }}
          >
            {preview.source == null
              ? null
              : (engine.sources.get(preview.source)
                  ?.content as React.ReactNode)}
          </View>
        )}
      </View>
    </RosterContext.Provider>
  )
}
export function RosterScrollArea({
  name,
  height,
  children
}: {
  name: string
  height?: number
  children: React.ReactNode
}): React.ReactElement {
  const engine = useRosterGesture()
  const port = useRef<React.ComponentRef<typeof View>>(null)
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const [held, setHeld] = useState(false)
  useEffect(() => {
    engine.heldListeners.add(setHeld)
    return () => {
      engine.heldListeners.delete(setHeld)
    }
  }, [engine])
  const offset = useRef(0)
  const content = useRef(0)
  const visible = useRef(height ?? 0)
  const measure = useRef(
    async () => await measureRosterView(port.current)
  ).current
  useEffect(() => {
    engine.scrolls.set(name, {
      measure,
      offset: () => offset.current,
      scroll: delta => {
        offset.current = Math.max(
          0,
          Math.min(content.current - visible.current, offset.current + delta)
        )
        scroll.current?.scrollTo({ y: offset.current, animated: false })
      }
    })
    return () => {
      engine.scrolls.delete(name)
    }
  }, [engine, name, measure])
  return (
    <View
      ref={port}
      style={height == null ? { flex: 1, minHeight: 0 } : { height }}
      onLayout={event => {
        visible.current = event.nativeEvent.layout.height
      }}
    >
      <RosterClipContext.Provider value={measure}>
        <ScrollView
          ref={scroll}
          scrollEnabled={!held}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          accessibilityLabel={name}
          onContentSizeChange={(_, h) => {
            content.current = h
          }}
          onScroll={event => {
            offset.current = event.nativeEvent.contentOffset.y
          }}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingHorizontal: 8,
            paddingVertical: 8,
            gap: ROSTER_CARD_GAP
          }}
        >
          {children}
        </ScrollView>
      </RosterClipContext.Provider>
    </View>
  )
}
