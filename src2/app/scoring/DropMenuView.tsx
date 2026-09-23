import React, { useEffect, useRef, useState } from 'react'
import {
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type ViewStyle
} from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'

import { useInsets } from '../platform/safeArea'
import { DRAG_OPEN_PX, type DropMenu, type DropRect } from './dropMenu'
import { MODAL_ORIENTATIONS } from './modalOrientations'
import { SCORING_MENU, ScoringMenuButton } from './ScoringMenuAppearance'

export interface DropRow {
  key: string
  label: string
  disabled?: boolean
  /** The row opens the submenu. */
  submenu?: boolean
}

type ViewRef = React.ComponentRef<typeof View>

const GAP = 8
const HEADER_HEIGHT = 26
const panel: ViewStyle = {
  position: 'absolute',
  backgroundColor: SCORING_MENU.background,
  borderColor: SCORING_MENU.border,
  borderWidth: 1,
  borderRadius: 12,
  overflow: 'hidden',
  shadowColor: '#000000',
  shadowOpacity: 0.4,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 12 },
  elevation: 8
}

async function measure(view: ViewRef | null | undefined): Promise<DropRect> {
  return await new Promise(resolve => {
    if (view == null) return
    view.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height })
    })
  })
}

/**
 * The phone's version of the web's drop menu: the trigger, and above it,
 * anchored to it, the panel of rows and its submenu beside the row that opens
 * it. A tap on the trigger opens it for tapping. A press dragged up opens it
 * under the finger: the gesture is Gesture Handler's, on the trigger, so it
 * keeps the finger while the panel appears, and `useDropMenu` tests each
 * move against where the rows measured themselves on the screen.
 *
 * `side` is where the panel hangs from the trigger: More's opens to the
 * right from its left edge with the submenu to its right; Ball in Play's to
 * the left from its right edge, with the submenu to its left.
 */
export function DropMenuView({
  menu,
  label,
  disabled,
  side,
  width,
  rows,
  childKey,
  childRows,
  childHeader,
  panelLabel,
  childLabel,
  dismissLabel,
  triggerStyle,
  children
}: {
  menu: DropMenu
  label: string
  disabled: boolean
  side: 'left' | 'right'
  /** The panel's width: a share of the window's less `less`, and its most. */
  width: { share: number; less: number; most: number }
  rows: DropRow[]
  childKey: string
  childRows: DropRow[]
  childHeader?: React.ReactNode
  panelLabel: string
  childLabel: string
  dismissLabel: string
  triggerStyle: ViewStyle
  children: React.ReactNode
}): React.ReactElement {
  const window = useWindowDimensions()
  const insets = useInsets()
  const trigger = useRef<ViewRef>(null)
  const [anchor, setAnchor] = useState<DropRect>()
  const dragged = useRef(false)
  const views = useRef(new Map<string, ViewRef>())
  const locate = (): void => {
    measure(trigger.current)
      .then(setAnchor)
      .catch(() => undefined)
  }
  const handleClose = (): void => {
    menu.close()
  }
  const measureRows = (): void => {
    for (const [key, view] of views.current)
      measure(view)
        .then(rect => {
          menu.setRow(key, rect)
        })
        .catch(() => undefined)
  }
  const pan = usePanGesture({
    activeOffsetY: -DRAG_OPEN_PX,
    runOnJS: true,
    enabled: !disabled,
    onBegin: event => {
      dragged.current = false
      locate()
      menu.begin(event.absoluteX, event.absoluteY)
    },
    onActivate: event => {
      dragged.current = true
      menu.move(event.absoluteX, event.absoluteY)
    },
    onUpdate: event => {
      menu.move(event.absoluteX, event.absoluteY)
    },
    onFinalize: event => {
      if (event.canceled) menu.cancel()
      else menu.end(event.absoluteX, event.absoluteY)
    }
  })

  const panelWidth = Math.min(
    width.most,
    window.width * width.share - width.less
  )
  const top = Math.max(GAP, insets.top)
  const bottom =
    anchor == null ? SCORING_MENU.bottom : window.height - anchor.y + GAP
  const edge =
    side === 'left'
      ? Math.max(GAP, insets.left, anchor?.x ?? GAP)
      : Math.max(
          GAP,
          insets.right,
          anchor == null ? GAP : window.width - anchor.x - anchor.width
        )
  const childHeight =
    childRows.length * (SCORING_MENU.rowHeight + 1) +
    (childHeader == null ? 0 : HEADER_HEIGHT)
  const childTop = Math.max(
    top,
    Math.min(
      menu.rowRect(childKey)?.y ?? top,
      window.height - bottom - childHeight
    )
  )
  const row = (item: DropRow): React.ReactElement => (
    <MeasuredRow
      key={item.key}
      id={item.key}
      views={views.current}
      onMeasured={rect => {
        menu.setRow(item.key, rect)
      }}
      onGone={() => {
        menu.setRow(item.key, undefined)
      }}
    >
      <ScoringMenuButton
        label={item.label}
        disabled={item.disabled}
        submenuRight={item.submenu === true && side === 'left'}
        submenuLeft={item.submenu === true && side === 'right'}
        highlighted={menu.hover === item.key}
        onPress={() => {
          menu.select(item.key)
        }}
      />
    </MeasuredRow>
  )
  return (
    <>
      <GestureDetector gesture={pan}>
        <Pressable
          ref={trigger}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded: menu.open, disabled }}
          disabled={disabled}
          style={[
            triggerStyle,
            menu.open && { borderColor: SCORING_MENU.accent }
          ]}
          onPress={() => {
            if (disabled || dragged.current) return
            locate()
            menu.toggle()
          }}
        >
          {children}
        </Pressable>
      </GestureDetector>
      {menu.open && (
        <Modal
          visible
          transparent
          animationType="none"
          statusBarTranslucent
          navigationBarTranslucent
          supportedOrientations={MODAL_ORIENTATIONS}
          onRequestClose={handleClose}
        >
          <Pressable
            accessibilityLabel={dismissLabel}
            style={{ position: 'absolute', inset: 0 }}
            onPress={handleClose}
          />
          <MeasuredPanel
            label={panelLabel}
            onMeasured={rect => {
              menu.setPanel('parent', rect)
              measureRows()
            }}
            style={[
              panel,
              side === 'left' ? { left: edge } : { right: edge },
              {
                bottom,
                width: panelWidth,
                maxHeight: window.height - bottom - top
              }
            ]}
          >
            <ScrollView bounces={false} onScrollEndDrag={measureRows}>
              {(menu.mode === 'drag' && side === 'right'
                ? [...rows].reverse()
                : rows
              ).map(row)}
            </ScrollView>
          </MeasuredPanel>
          {menu.child && (
            <MeasuredPanel
              label={childLabel}
              onMeasured={rect => {
                menu.setPanel('child', rect)
              }}
              onGone={() => {
                menu.setPanel('child', undefined)
              }}
              style={[
                panel,
                side === 'left'
                  ? {
                      left: Math.min(
                        edge + panelWidth + GAP,
                        window.width - panelWidth - GAP
                      )
                    }
                  : {
                      right: Math.min(
                        edge + panelWidth + GAP,
                        window.width - panelWidth - GAP
                      )
                    },
                { top: childTop, width: panelWidth }
              ]}
            >
              {childHeader}
              {childRows.map(row)}
            </MeasuredPanel>
          )}
        </Modal>
      )}
    </>
  )
}

function MeasuredPanel({
  label,
  style,
  onMeasured,
  onGone,
  children
}: {
  label: string
  style: React.ComponentProps<typeof View>['style']
  onMeasured: (rect: DropRect) => void
  onGone?: () => void
  children: React.ReactNode
}): React.ReactElement {
  const view = useRef<ViewRef>(null)
  const gone = useRef(onGone)
  gone.current = onGone
  useEffect(
    () => () => {
      gone.current?.()
    },
    []
  )
  return (
    <View
      ref={view}
      accessibilityLabel={label}
      accessibilityRole="menu"
      style={style}
      onLayout={() => {
        measure(view.current)
          .then(onMeasured)
          .catch(() => undefined)
      }}
    >
      {children}
    </View>
  )
}

function MeasuredRow({
  id,
  views,
  onMeasured,
  onGone,
  children
}: {
  id: string
  views: Map<string, ViewRef>
  onMeasured: (rect: DropRect) => void
  onGone: () => void
  children: React.ReactNode
}): React.ReactElement {
  const view = useRef<ViewRef>(null)
  const gone = useRef(onGone)
  gone.current = onGone
  useEffect(() => {
    if (view.current != null) views.set(id, view.current)
    return () => {
      views.delete(id)
      gone.current()
    }
  }, [id, views])
  return (
    <View
      ref={view}
      collapsable={false}
      onLayout={() => {
        measure(view.current)
          .then(onMeasured)
          .catch(() => undefined)
      }}
    >
      {children}
    </View>
  )
}
