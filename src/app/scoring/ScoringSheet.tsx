import React, { createContext, useMemo, useRef, useState } from 'react'
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView as WebSafeAreaView,
  ScrollView,
  Text,
  View
} from 'react-native'
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView
} from 'react-native-safe-area-context'

import { useTheme } from '../theme/ThemeContext'
import { MODAL_ORIENTATIONS } from './modalOrientations'

export function ScoringButton({
  label,
  text,
  secondaryLabel,
  onPress,
  disabled = false,
  color,
  row = false,
  decision = false,
  menuText = false,
  shape,
  submenu = false
}: {
  label: string
  text?: string
  secondaryLabel?: string
  onPress: () => void
  disabled?: boolean
  color?: string
  row?: boolean
  decision?: boolean
  menuText?: boolean
  shape?: 'pill' | 'circle'
  submenu?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const [active, setActive] = useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onHoverIn={() => {
        setActive(true)
      }}
      onHoverOut={() => {
        setActive(false)
      }}
      onFocus={() => {
        setActive(true)
      }}
      onBlur={() => {
        setActive(false)
      }}
      onPressIn={() => {
        setActive(true)
      }}
      onPressOut={() => {
        setActive(false)
      }}
      style={({ pressed }) => ({
        shadowColor: row ? undefined : theme.buttonShadowColor,
        shadowOpacity: row ? 0 : 1,
        shadowRadius: row ? 0 : pressed ? 4 : 8,
        shadowOffset: { width: 0, height: pressed ? 1 : 3 },
        elevation: row ? 0 : pressed ? 1 : 3,
        minHeight: decision ? 66 : 44,
        padding: 10,
        justifyContent: 'center',
        borderRadius:
          shape != null
            ? theme.radiusPill
            : row
              ? 0
              : theme.rem(theme.radiusRem),
        width: shape === 'circle' ? 44 : undefined,
        borderBottomWidth: row ? 1 : 0,
        borderBottomColor: theme.defaultBorderColor,
        backgroundColor:
          color ??
          (row
            ? (pressed || active) && !disabled
              ? theme.scoringMenuActiveBackground
              : theme.backgroundColor
            : theme.primaryButtonColor),
        opacity: disabled ? 0.4 : 1
      })}
      onPress={onPress}
    >
      <Text
        selectable={false}
        style={{
          fontFamily: theme.semiBoldTextFont,
          fontSize: decision ? 21 : menuText ? 16.8 : undefined,
          fontWeight: decision || menuText ? '700' : undefined,
          color:
            color != null
              ? theme.scoringDecisionText
              : row
                ? active && !disabled
                  ? theme.scoringMenuActiveText
                  : theme.primaryTextColor
                : theme.buttonTextColor,
          textAlign: row ? 'left' : 'center'
        }}
      >
        {submenu ? '‹  ' : ''}
        {text ?? label}
      </Text>
      {secondaryLabel != null && (
        <Text
          selectable={false}
          style={{
            textAlign: 'center',
            fontFamily: theme.semiBoldTextFont,
            fontSize: 10.5,
            lineHeight: 14,
            color: theme.scoringDecisionText
          }}
        >
          {secondaryLabel}
        </Text>
      )}
    </Pressable>
  )
}
export const ScoringSheetHeight = createContext<number | undefined>(undefined)

/** How far, or how fast, a sheet must be pulled down to close. */
const SWIPE_CLOSE_PX = 120
const SWIPE_CLOSE_SPEED = 0.8
/** Whether a pull that ended here closes the sheet. */
export function swipeCloses(dy: number, vy: number): boolean {
  return dy > SWIPE_CLOSE_PX || (dy > 20 && vy > SWIPE_CLOSE_SPEED)
}
// eslint-disable-next-line @typescript-eslint/no-deprecated -- Web implementation uses CSS env() and avoids measuring a sliding portal. Native uses safe-area-context.
const SheetArea = Platform.OS === 'web' ? WebSafeAreaView : SafeAreaView

export function ScoringSheet({
  title,
  headerless = false,
  textCancel = false,
  fullScreen = false,
  tall = false,
  done = false,
  swipeToDismiss = false,
  scroll = true,
  onShow,
  onClose,
  children
}: {
  title: string
  /** A compact full-screen editor supplies its own bottom close action. */
  headerless?: boolean
  textCancel?: boolean
  fullScreen?: boolean
  /** The whole height of the screen, still a sheet over the game. */
  tall?: boolean
  /** Closed by a Done button at the bottom rather than Cancel at the top. */
  done?: boolean
  /** Pulled down by its handle or its title, it closes. */
  swipeToDismiss?: boolean
  scroll?: boolean
  onShow?: () => void
  onClose: () => void
  children: React.ReactNode
}): React.ReactElement {
  const theme = useTheme()
  const [contentHeight, setContentHeight] = useState<number>()
  const Content = scroll ? ScrollView : View
  const close = useRef(onClose)
  close.current = onClose
  const pulled = useRef(new Animated.Value(0)).current
  const pull = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, move) =>
          move.dy > 4 && Math.abs(move.dy) > Math.abs(move.dx),
        // Once pulling, the pull keeps the gesture.
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_event, move) => {
          pulled.setValue(Math.max(0, move.dy))
        },
        onPanResponderRelease: (_event, move) => {
          if (swipeCloses(move.dy, move.vy)) close.current()
          else
            Animated.spring(pulled, {
              toValue: 0,
              useNativeDriver: false
            }).start()
        },
        onPanResponderTerminate: () => {
          Animated.spring(pulled, {
            toValue: 0,
            useNativeDriver: false
          }).start()
        }
      }),
    [pulled]
  )
  return (
    <Modal
      transparent={!fullScreen}
      animationType="slide"
      supportedOrientations={MODAL_ORIENTATIONS}
      onShow={onShow}
      onRequestClose={onClose}
    >
      <SafeAreaProvider
        initialMetrics={
          initialWindowMetrics ?? {
            frame: { x: 0, y: 0, width: 0, height: 0 },
            insets: { top: 0, bottom: 0, left: 0, right: 0 }
          }
        }
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={
            Platform.OS === 'web'
              ? { height: '100dvh', width: '100%' }
              : { flex: 1 }
          }
        >
          <SheetArea
            edges={
              fullScreen || tall
                ? ['top', 'bottom', 'left', 'right']
                : ['bottom', 'left', 'right']
            }
            style={{
              flex: 1,
              justifyContent: 'flex-end',
              backgroundColor: fullScreen ? theme.backgroundColor : undefined
            }}
          >
            {!fullScreen && (
              <Pressable
                accessibilityLabel="Dismiss sheet"
                onPress={onClose}
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundColor: theme.overlayBackgroundColor
                }}
              />
            )}
            <Animated.View
              accessibilityViewIsModal
              style={{
                transform: [{ translateY: pulled }],
                maxHeight: fullScreen || tall ? undefined : '92%',
                flex: fullScreen || tall ? 1 : undefined,
                marginTop: tall ? 8 : undefined,
                backgroundColor: theme.backgroundColor,
                borderTopLeftRadius: fullScreen
                  ? 0
                  : theme.rem(theme.radiusLargeRem),
                borderTopRightRadius: fullScreen
                  ? 0
                  : theme.rem(theme.radiusLargeRem),
                padding: 16,
                paddingBottom: headerless ? 0 : 16,
                gap: 12
              }}
            >
              {!headerless && (
                <View
                  {...(swipeToDismiss ? pull.panHandlers : {})}
                  style={{ gap: 12 }}
                >
                  {swipeToDismiss && (
                    <View
                      accessibilityLabel="Pull down to close"
                      style={{
                        alignSelf: 'center',
                        width: 40,
                        height: 5,
                        borderRadius: 3,
                        marginTop: -6,
                        backgroundColor: theme.secondaryTextColor
                      }}
                    />
                  )}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12
                    }}
                  >
                    <Text
                      accessibilityRole="header"
                      style={{
                        fontFamily: theme.boldTextFont,
                        fontSize: 22,
                        color: theme.primaryTextColor,
                        flex: 1
                      }}
                    >
                      {title}
                    </Text>
                    {done ? null : textCancel ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Cancel"
                        onPress={onClose}
                        style={{
                          minHeight: 44,
                          paddingHorizontal: 10,
                          justifyContent: 'center'
                        }}
                      >
                        <Text
                          style={{
                            fontFamily: theme.semiBoldTextFont,
                            color: theme.dangerColor
                          }}
                        >
                          Cancel
                        </Text>
                      </Pressable>
                    ) : (
                      <ScoringButton label="Cancel" onPress={onClose} />
                    )}
                  </View>
                </View>
              )}
              <Content
                style={{
                  flex: fullScreen || tall ? 1 : undefined,
                  minHeight: 0
                }}
                onLayout={event => {
                  setContentHeight(event.nativeEvent.layout.height)
                }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ gap: 0 }}
              >
                <ScoringSheetHeight.Provider value={contentHeight}>
                  {children}
                </ScoringSheetHeight.Provider>
              </Content>
              {done && <ScoringButton label="Done" onPress={onClose} />}
            </Animated.View>
          </SheetArea>
        </KeyboardAvoidingView>
      </SafeAreaProvider>
    </Modal>
  )
}
export function ScoringError({
  message
}: {
  message?: string
}): React.ReactElement | null {
  const theme = useTheme()
  return message == null ? null : (
    <Text
      accessibilityRole="alert"
      style={{ color: theme.dangerColor, fontFamily: theme.regularTextFont }}
    >
      {message}
    </Text>
  )
}
