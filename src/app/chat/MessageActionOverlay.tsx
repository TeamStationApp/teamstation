import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Animated,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle
} from 'react-native'

import { GlassView } from '../components/GlassView'
import { useMotionPreference } from '../components/useMotionPreference'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import type { ChatBounds } from './chatInteractionModel'
import { captureMessageBounds, type MessageSource } from './chatMessageSource'
import { ChatOverlayPortal } from './ChatOverlayHost'
import { spotlightLayout } from './chatSpotlightModel'
import { watchReducedTransparency } from './chatTransparency'
import { bindPopupKeys, watchVisualViewport } from './chatWebInteractions'

export interface MessageActionOverlayProps {
  children: React.ReactNode
  selected: React.ReactNode
  reactions?: React.ReactNode
  source?: MessageSource
  mine: boolean
  label: string
  closing: boolean
  focusHandoff?: boolean
  onClose: () => void
  onClosed: () => void
}

/** Message-only motion leaves ordinary menus and pinned lists unchanged. */
export function MessageActionOverlay(
  props: MessageActionOverlayProps
): React.ReactElement {
  return (
    <ChatOverlayPortal modal={!(props.closing && props.focusHandoff === true)}>
      <SpotlightFrame {...props} />
    </ChatOverlayPortal>
  )
}

function SpotlightFrame(props: MessageActionOverlayProps): React.ReactElement {
  const theme = useTheme()
  const handoff = props.closing && props.focusHandoff === true
  const window = useWindowDimensions()
  const insets = useInsets()
  const reduced = useMotionPreference()
  const [opaque, setOpaque] = useState(true)
  const frameRef = useRef<React.ComponentRef<typeof View>>(null)
  const panelRef = useRef<React.ComponentRef<typeof View>>(null)
  const [frame, setFrame] = useState<ChatBounds>()
  const [keyboardTop, setKeyboardTop] = useState<number | undefined>(
    () => Keyboard.metrics?.()?.screenY
  )
  const [visual, setVisual] = useState<{
    bottom: number
    keyboardOpen: boolean
  }>()
  const [preview, setPreview] = useState(
    props.source?.bounds.height ?? theme.rem(8)
  )
  const [panel, setPanel] = useState(theme.rem(12))
  const [reactions, setReactions] = useState(
    props.reactions == null ? 0 : theme.rem(3)
  )
  const [returnSource, setReturnSource] = useState(props.source?.bounds)
  const progress = useRef(new Animated.Value(0)).current
  // iOS re-applies a view's own props opacity and transform whenever its
  // frame changes, and then ignores the prop updates the native driver
  // manages. A layout change after the native fade ended, but before JS heard
  // that it ended, left the view at opacity 0 for good: on a busy device the
  // actions vanished as their measured height arrived. Each animated layer
  // keeps one frame for the whole spotlight, at its plain outer view's
  // origin, and the moving offsets are values set below, not style numbers.
  const sourceX = useRef(new Animated.Value(0)).current
  const sourceY = useRef(new Animated.Value(0)).current
  const lift = useRef(new Animated.Value(0)).current
  const motion = useMemo(() => {
    const away = Animated.subtract(1, progress)
    return {
      fade: { opacity: progress },
      preview: {
        opacity: progress,
        transform: [
          { translateX: Animated.multiply(sourceX, away) },
          { translateY: Animated.multiply(sourceY, away) }
        ]
      },
      panel: {
        opacity: progress,
        transform: [{ translateY: Animated.multiply(lift, away) }]
      }
    }
  }, [progress, sourceX, sourceY, lift])
  const latest = useRef(props)
  latest.current = { ...props, onClosed: props.onClosed }
  const active = useRef(true)
  const epoch = useRef(0)
  const measuring = useRef<(() => void) | undefined>(undefined)
  const measure = useCallback(() => {
    measuring.current?.()
    measuring.current = captureMessageBounds(
      frameRef.current,
      () => active.current,
      bounds => {
        setFrame(
          bounds ?? { x: 0, y: 0, width: window.width, height: window.height }
        )
      }
    )
  }, [window.width, window.height])
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      epoch.current += 1
      measuring.current?.()
      progress.stopAnimation()
    }
  }, [progress])
  useEffect(measure, [measure])
  useEffect(() => watchReducedTransparency(setOpaque), [])
  useEffect(() => watchVisualViewport(setVisual), [])
  useEffect(() => {
    const shown = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      event => {
        setKeyboardTop(event.endCoordinates.screenY)
        measure()
      }
    )
    const hidden = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardTop(undefined)
        measure()
      }
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [measure])
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!latest.current.closing) latest.current.onClose()
      return true
    })
    return () => {
      back.remove()
    }
  }, [])
  const ready = frame != null
  useEffect(() => {
    if (!ready) return
    const version = ++epoch.current
    progress.stopAnimation()
    let cancelSource: (() => void) | undefined
    let animation: ReturnType<typeof Animated.timing> | undefined
    const animate = (): void => {
      if (!active.current || version !== epoch.current) return
      animation = Animated.timing(progress, {
        toValue: props.closing ? 0 : 1,
        duration: reduced ? 80 : 200,
        useNativeDriver: true
      })
      animation.start(({ finished }) => {
        if (
          finished &&
          active.current &&
          version === epoch.current &&
          props.closing
        )
          latest.current.onClosed()
      })
    }
    if (props.closing && props.source != null) {
      cancelSource = props.source.measure(bounds => {
        if (!active.current || version !== epoch.current) return
        setReturnSource(bounds)
        animate()
      })
    } else {
      if (props.closing) setReturnSource(undefined)
      animate()
    }
    return () => {
      epoch.current += 1
      cancelSource?.()
      animation?.stop()
    }
  }, [ready, props.closing, props.source, reduced, progress])
  const surface = frame ?? {
    x: 0,
    y: 0,
    width: window.width,
    height: window.height
  }
  const source = props.closing ? returnSource : props.source?.bounds
  const layout = spotlightLayout({
    frame: surface,
    safe: {
      top: Math.max(0, insets.top - surface.y),
      left: Math.max(0, insets.left - surface.x),
      right: Math.max(
        0,
        surface.x + surface.width - window.width + insets.right
      ),
      bottom: Math.max(
        0,
        surface.y + surface.height - window.height + insets.bottom
      )
    },
    keyboardTop: visual?.keyboardOpen === true ? visual.bottom : keyboardTop,
    source: source ?? props.source?.bounds,
    preview,
    panel,
    reactions: props.reactions == null ? 0 : reactions,
    gap: theme.rem(0.5),
    maxWidth: theme.rem(28),
    mine: props.mine,
    minimumPanel: Math.max(44, theme.rem(3) * window.fontScale)
  })
  const controlsVisible = layout.panel > 0
  useEffect(
    () =>
      bindPopupKeys(
        panelRef.current,
        () => {
          if (!latest.current.closing) latest.current.onClose()
        },
        !handoff
      ),
    [handoff, layout.compact, controlsVisible]
  )
  const moving = !reduced && source != null && layout.animateSource
  const offsetX = moving ? layout.sourceX : 0
  const offsetY = moving ? layout.sourceY : 0
  const panelLift = reduced || layout.compact ? 0 : theme.rem(0.5)
  // Before the entrance, which starts in an effect.
  useLayoutEffect(() => {
    sourceX.setValue(offsetX)
    sourceY.setValue(offsetY)
    lift.setValue(panelLift)
  }, [offsetX, offsetY, panelLift, sourceX, sourceY, lift])
  const previewWidth = Math.min(source?.width ?? layout.width, layout.width)
  // A constant frame: as tall as the window, as wide as its content.
  const layer = (width: number): ViewStyle => ({
    position: 'absolute',
    left: 0,
    top: 0,
    width,
    height: window.height
  })
  return (
    <View
      ref={frameRef}
      testID="chat-message-spotlight"
      onLayout={measure}
      // The animated layers reach below their content; nothing passes the frame.
      style={[
        StyleSheet.absoluteFill,
        { zIndex: 100, elevation: 30, overflow: 'hidden' }
      ]}
      pointerEvents={props.closing ? 'none' : 'auto'}
      accessibilityViewIsModal={!handoff}
      accessibilityElementsHidden={handoff}
      importantForAccessibility={handoff ? 'no-hide-descendants' : 'auto'}
      aria-hidden={handoff}
      onAccessibilityEscape={() => {
        latest.current.onClose()
      }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
        <GlassView
          androidBlur
          backdropBlur
          opaque={opaque}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={props.onClose}
        accessibilityRole="button"
        accessibilityLabel={lstrings.chat_cancel}
      />
      <View
        ref={panelRef}
        testID="chat-message-spotlight-controls"
        accessibilityLabel={props.label}
        // Touch the backdrop through the space the controls leave empty, such
        // as beside a long message, which otherwise left nowhere to close.
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: layout.left,
          top: layout.top,
          width: layout.width,
          height: layout.panelTop + layout.panel
        }}
      >
        {!layout.compact && props.reactions != null && (
          <View
            testID="chat-message-spotlight-reactions"
            style={{ height: layout.reactions, overflow: 'hidden' }}
          >
            <Animated.View
              pointerEvents="box-none"
              style={[layer(layout.width), motion.fade]}
            >
              <ScrollView
                horizontal
                keyboardShouldPersistTaps="handled"
                // A ScrollView grows by default, and its layer is window tall.
                style={{ height: layout.reactions, flexGrow: 0 }}
                onContentSizeChange={(_width, height) => {
                  setReactions(height)
                }}
              >
                {props.reactions}
              </ScrollView>
            </Animated.View>
          </View>
        )}
        {layout.preview > 0 && (
          <View
            testID="chat-message-spotlight-preview"
            style={{
              position: 'absolute',
              top: layout.previewTop,
              alignSelf: props.mine ? 'flex-end' : 'flex-start',
              width: previewWidth,
              height: layout.preview
            }}
          >
            <Animated.View
              pointerEvents="box-none"
              style={[layer(previewWidth), motion.preview]}
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={{ maxHeight: layout.preview }}
                onContentSizeChange={(_width, height) => {
                  setPreview(Math.max(1, height))
                }}
              >
                {props.selected}
              </ScrollView>
            </Animated.View>
          </View>
        )}
        {controlsVisible && (
          <View
            testID="chat-message-spotlight-panel"
            style={{
              position: 'absolute',
              top: layout.panelTop,
              width: '100%',
              height: layout.panel
            }}
          >
            <Animated.View
              pointerEvents="box-none"
              style={[layer(layout.width), motion.panel]}
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={{
                  height: layout.panel,
                  flexGrow: 0,
                  borderRadius: theme.rem(1.25),
                  backgroundColor: theme.cardBackgroundColor,
                  borderColor: theme.defaultBorderColor,
                  borderWidth: 1
                }}
                contentContainerStyle={{
                  padding: theme.rem(0.5),
                  gap: theme.rem(0.25)
                }}
              >
                {layout.compact && props.reactions != null && (
                  <ScrollView
                    horizontal
                    keyboardShouldPersistTaps="handled"
                    onContentSizeChange={(_width, height) => {
                      setReactions(height)
                    }}
                  >
                    {props.reactions}
                  </ScrollView>
                )}
                <View
                  onLayout={event => {
                    setPanel(event.nativeEvent.layout.height + theme.rem(1))
                  }}
                  style={{ gap: theme.rem(0.25) }}
                >
                  {props.children}
                </View>
              </ScrollView>
            </Animated.View>
          </View>
        )}
      </View>
    </View>
  )
}
