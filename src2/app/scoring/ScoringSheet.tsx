import React, { createContext, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
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
// eslint-disable-next-line @typescript-eslint/no-deprecated -- Web implementation uses CSS env() and avoids measuring a sliding portal. Native uses safe-area-context.
const SheetArea = Platform.OS === 'web' ? WebSafeAreaView : SafeAreaView

export function ScoringSheet({
  title,
  textCancel = false,
  fullScreen = false,
  scroll = true,
  onShow,
  onClose,
  children
}: {
  title: string
  textCancel?: boolean
  fullScreen?: boolean
  scroll?: boolean
  onShow?: () => void
  onClose: () => void
  children: React.ReactNode
}): React.ReactElement {
  const theme = useTheme()
  const [contentHeight, setContentHeight] = useState<number>()
  const Content = scroll ? ScrollView : View
  return (
    <Modal
      transparent={!fullScreen}
      animationType="slide"
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
              fullScreen
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
            <View
              accessibilityViewIsModal
              style={{
                maxHeight: fullScreen ? undefined : '92%',
                flex: fullScreen ? 1 : undefined,
                backgroundColor: theme.backgroundColor,
                borderTopLeftRadius: fullScreen
                  ? 0
                  : theme.rem(theme.radiusLargeRem),
                borderTopRightRadius: fullScreen
                  ? 0
                  : theme.rem(theme.radiusLargeRem),
                padding: 16,
                gap: 12
              }}
            >
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
                {textCancel ? (
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
              <Content
                style={{ flex: fullScreen ? 1 : undefined, minHeight: 0 }}
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
            </View>
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
