import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  BackHandler,
  Platform,
  Pressable,
  type PressableProps,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { ChatOverlayPortal, useChatOverlayBusy } from '../chat/ChatOverlayHost'
import { bindPopupKeys } from '../chat/chatWebInteractions'
import { lstrings } from '../locales/strings'
import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { GlassView } from './GlassView'

export interface HeaderMenuItem {
  label: string
  /** A quieter line beneath the label. */
  detail?: string
  hint?: string
  icon: React.ReactNode
  onPress: () => void
}

export interface HeaderMenuProps {
  /** What the button says to a screen reader. */
  label: string
  /** Which of the button's edges the menu lines up with. */
  align: 'left' | 'right'
  items: HeaderMenuItem[]
  /** A change closes the menu, so a new screen doesn't arrive beneath it. */
  closeKey?: string
  /** For an owner whose Back has to wait until the menu has closed. */
  onOpenChange?: (open: boolean) => void
  style?: PressableProps['style']
  /** The button's own face. */
  children: React.ReactNode
}

interface Anchor {
  x: number
  y: number
  width: number
  height: number
}

/** The window's edge, which a menu stands off even when its button doesn't. */
const MARGIN = 8
/** Between the button and the menu, in points. */
const GAP = 4

export function headerMenuPosition(
  anchor: Anchor,
  align: 'left' | 'right',
  viewport: { width: number }
): { top: number; left?: number; right?: number; maxWidth: number } {
  const top = anchor.y + anchor.height + GAP
  if (align === 'left') {
    const left = Math.max(MARGIN, anchor.x)
    return { top, left, maxWidth: viewport.width - left - MARGIN }
  }
  const right = Math.max(MARGIN, viewport.width - (anchor.x + anchor.width))
  return { top, right, maxWidth: viewport.width - right - MARGIN }
}

/**
 * A button and the small menu it drops down, lined up with the button's edge.
 *
 * Through the chat overlay's host rather than a `Modal`. A `Modal` is a window
 * of its own on Android, where `TSBlurView` records only its own window, so
 * there would be nothing behind the menu to blur. The host is in the app's
 * window, above the header's clipped glass and Tess's column.
 */
export function HeaderMenu(props: HeaderMenuProps): React.ReactElement {
  const { closeKey, onOpenChange } = props
  const [anchor, setAnchor] = useState<Anchor>()
  const trigger = useRef<React.ComponentRef<typeof Pressable>>(null)
  const open = anchor != null
  const close = useCallback(() => {
    setAnchor(undefined)
  }, [])
  // The host has one place. A chat overlay still closing keeps it, and a menu
  // that took it would be overwritten on that overlay's next render, so a press
  // meanwhile waits for the place to come free.
  const overlayBusy = useChatOverlayBusy()
  const pressedWhileBusy = useRef(false)
  const openMenu = (): void => {
    const node = trigger.current as unknown as {
      measureInWindow: (
        read: (x: number, y: number, w: number, h: number) => void
      ) => void
    } | null
    node?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height })
    })
  }
  useEffect(() => {
    if (overlayBusy || !pressedWhileBusy.current) return
    pressedWhileBusy.current = false
    openMenu()
  }, [overlayBusy])
  // Kept in a ref so the report on unmount reaches the latest owner.
  const reportOpen = useRef(onOpenChange)
  reportOpen.current = onOpenChange
  useEffect(() => {
    if (!open) return undefined
    reportOpen.current?.(true)
    return () => {
      reportOpen.current?.(false)
    }
  }, [open])
  useEffect(close, [close, closeKey])
  return (
    <>
      <Pressable
        ref={trigger}
        accessibilityRole="button"
        accessibilityLabel={props.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPress={() => {
          if (overlayBusy) pressedWhileBusy.current = true
          else openMenu()
        }}
        style={props.style}
      >
        {props.children}
      </Pressable>
      {anchor != null && (
        <ChatOverlayPortal>
          <HeaderMenuPanel
            anchor={anchor}
            align={props.align}
            items={props.items}
            trigger={trigger.current}
            onClose={close}
          />
        </ChatOverlayPortal>
      )}
    </>
  )
}

function HeaderMenuPanel(props: {
  anchor: Anchor
  align: 'left' | 'right'
  items: HeaderMenuItem[]
  trigger: unknown
  onClose: () => void
}): React.ReactElement {
  const { anchor, align, items, trigger, onClose } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const viewport = useWindowDimensions()
  const panel = useRef<React.ComponentRef<typeof View>>(null)
  // Gone while its menu still thinks it is open means another overlay took the
  // host's one place, so the menu closes rather than come back over that one.
  useEffect(() => onClose, [onClose])
  useEffect(
    () =>
      bindPopupKeys(panel.current, onClose, true, false, undefined, trigger),
    [onClose, trigger]
  )
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        onClose()
        return true
      }
    )
    return () => {
      subscription.remove()
    }
  }, [onClose])
  // The button moves with the window's width, and the menu measured it only
  // once. Not its height, which on the web follows the on-screen keyboard, and
  // the first row taking the focus can put that keyboard away.
  const width = useRef(viewport.width)
  useEffect(() => {
    if (width.current !== viewport.width) onClose()
  }, [onClose, viewport.width])
  const position = headerMenuPosition(anchor, align, viewport)
  return (
    <View
      style={[StyleSheet.absoluteFill, styles.overlay]}
      accessibilityViewIsModal
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={lstrings.header_menu_close}
        onPress={onClose}
      />
      <View
        ref={panel}
        testID="header-menu-panel"
        role="dialog"
        aria-label={lstrings.header_menu_panel}
        style={[
          styles.panel,
          position,
          {
            maxHeight: viewport.height - position.top - MARGIN
          }
        ]}
      >
        <GlassView
          testID="header-menu-glass"
          androidBlur
          backdropBlur
          radius={theme.rem(0.875)}
          style={styles.glass}
        >
          {Platform.OS === 'android' && (
            <View style={[StyleSheet.absoluteFill, styles.androidTint]} />
          )}
          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="handled"
            style={styles.rows}
          >
            {items.map((item, index) => (
              <HeaderMenuRow
                key={item.label}
                item={item}
                divided={index > 0}
                onClose={onClose}
              />
            ))}
          </ScrollView>
        </GlassView>
      </View>
    </View>
  )
}

function HeaderMenuRow(props: {
  item: HeaderMenuItem
  divided: boolean
  onClose: () => void
}): React.ReactElement {
  const { item, divided, onClose } = props
  const styles = getStyles(useTheme())
  // `accessibilityHint` is native only, and on the web a label replaces the
  // row's text, so there the detail or hint is tied on by its id.
  const describedBy = useId()
  const described = item.detail ?? item.hint
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityHint={described}
      aria-describedby={described == null ? undefined : describedBy}
      onPress={() => {
        onClose()
        item.onPress()
      }}
      style={({ pressed }) => [
        styles.row,
        divided && styles.divided,
        pressed && styles.pressed
      ]}
    >
      <View style={styles.icon}>{item.icon}</View>
      <View style={styles.words}>
        <Text style={styles.label} numberOfLines={1}>
          {item.label}
        </Text>
        {item.detail != null && (
          <Text id={describedBy} style={styles.detail}>
            {item.detail}
          </Text>
        )}
        {item.detail == null && item.hint != null && Platform.OS === 'web' && (
          <Text id={describedBy} style={styles.unseen}>
            {item.hint}
          </Text>
        )}
      </View>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  overlay: {
    zIndex: 100,
    elevation: 30
  },
  // The shadow is on this view and the glass inside it, because the glass has
  // to clip its rows and a clipped view's shadow is clipped with them.
  panel: {
    position: 'absolute',
    minWidth: theme.rem(14),
    borderRadius: theme.rem(0.875),
    // Android casts elevation from a background's outline, and its blur paints
    // over this. Anywhere else it would hide what the glass has to blur.
    ...(Platform.OS === 'android'
      ? { backgroundColor: theme.glassFallbackColor }
      : {}),
    shadowColor: theme.buttonShadowColor,
    shadowOpacity: 1,
    shadowRadius: theme.rem(1.25),
    shadowOffset: { width: 0, height: theme.rem(0.375) },
    elevation: elevationFor(theme.rem(1.25))
  },
  glass: {
    flexShrink: 1,
    borderRadius: theme.rem(0.875),
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.glassBorderColor
  },
  // Android's blur keeps more of what is behind it than the other platforms'
  // glass does, so a dark picture beneath would show behind a row's label.
  androidTint: {
    backgroundColor: theme.glassFallbackColor,
    opacity: 0.55
  },
  rows: {
    flexGrow: 0
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    gap: theme.rem(0.75),
    paddingVertical: theme.rem(0.5),
    paddingHorizontal: theme.rem(0.875)
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.glassBorderColor
  },
  pressed: {
    opacity: 0.6
  },
  icon: {
    width: theme.rem(2),
    height: theme.rem(2),
    alignItems: 'center',
    justifyContent: 'center'
  },
  words: {
    flexShrink: 1
  },
  label: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.headerTextColor
  },
  unseen: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    opacity: 0
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.headerTextColor,
    opacity: 0.72
  }
}))
