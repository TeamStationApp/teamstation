import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { DOUBLE_PLAYS, type DoublePlayKind, doublePlayRows } from './doublePlay'
import {
  MORE_GROUPS,
  type MoreAction,
  moreEligibility,
  type MoreInput
} from './moreActions'
import type { MoreMenuProps } from './moreMenuProps'
import {
  CONTROL_COLORS,
  CONTROL_HEIGHT,
  ControlBackdrop,
  ControlFace
} from './ScoringControlAppearance'
import { SCORING_MENU, ScoringMenuLabel } from './ScoringMenuAppearance'
import { scoringMenuPanel, scoringMenuRow } from './scoringMenuWebStyle'
import { useMenuEscape } from './useMenuEscape'

const BASE = 'Put Batter on Base'
const DOUBLE = 'Double Play'
/** The rows that open a submenu to their right. */
const SUBMENUS: readonly string[] = [BASE, DOUBLE]

/**
 * What a More row's key asks for: an action, a base for Put Batter on Base,
 * or a Double Play's kind.
 */
function inputOf(key: string): MoreInput {
  const base = Number(key)
  if ([1, 2, 3].includes(base)) return { action: BASE, base }
  if ((DOUBLE_PLAYS as readonly string[]).includes(key))
    return { action: DOUBLE, doublePlay: key as DoublePlayKind }
  return { action: key as MoreAction }
}

export function MoreMenu({
  state,
  disabled,
  onActive,
  onChoose
}: MoreMenuProps): React.ReactElement {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  /** The row whose submenu is open, if one is. */
  const [child, setChild] = useState<string>()
  const [hover, setHover] = useState<string>()
  const gesture = useRef<{
    x: number
    y: number
    id: number
    dragged: boolean
    escaped: boolean
  } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const skipClick = useRef(false)
  const primaryPanel = useRef<HTMLDivElement>(null)
  const childPanel = useRef<HTMLDivElement>(null)
  const [childTop, setChildTop] = useState(8)
  useLayoutEffect(() => {
    if (child == null) return
    const measure = (): void => {
      const parent = primaryPanel.current
        ?.querySelector(`[data-more="${child}"]`)
        ?.getBoundingClientRect()
      const height = childPanel.current?.getBoundingClientRect().height ?? 132
      if (parent != null)
        setChildTop(
          Math.max(8, Math.min(parent.top, window.innerHeight - height - 8))
        )
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [child])
  const close = (): void => {
    setOpen(false)
    setChild(undefined)
    setHover(undefined)
    onActive(false)
  }
  useMenuEscape(open, close, 'More')
  useEffect(() => {
    if (disabled) {
      const pointer = gesture.current?.id
      if (
        pointer != null &&
        trigger.current?.hasPointerCapture(pointer) === true
      )
        trigger.current.releasePointerCapture(pointer)
      gesture.current = null
      setOpen(false)
      setChild(undefined)
      onActive(false)
    }
  }, [disabled, onActive])
  const show = (): void => {
    if (disabled) return
    setOpen(true)
    onActive(true)
  }
  const choose = (key: string): void => {
    if (disabled) return
    const input = inputOf(key)
    if (moreEligibility(state, input.action) != null) return
    if (SUBMENUS.includes(key)) {
      setChild(value => (value === key ? undefined : key))
      return
    }
    close()
    onChoose(input)
  }
  const hit = (x: number, y: number): string | undefined =>
    document
      .elementsFromPoint(x, y)
      .map(node => node.closest<HTMLElement>('[data-more]')?.dataset.more)
      .find(value => value != null)
  const row = (
    label: string,
    key = label,
    subtext?: string
  ): React.ReactElement => {
    const reason = moreEligibility(state, inputOf(key).action)
    return (
      <button
        key={key}
        data-more={key}
        role="menuitem"
        aria-label={label}
        title={reason}
        onPointerEnter={() => {
          if (reason == null) setHover(key)
        }}
        onPointerLeave={() => {
          setHover(undefined)
        }}
        onFocus={() => {
          if (reason == null) setHover(key)
        }}
        onBlur={() => {
          setHover(undefined)
        }}
        disabled={reason != null}
        onClick={() => {
          choose(key)
        }}
        style={{
          ...scoringMenuRow(hover === key && reason == null),
          fontFamily: theme.regularTextFont,
          opacity: reason == null ? 1 : 0.4
        }}
      >
        <ScoringMenuLabel
          label={label}
          active={hover === key && reason == null}
          chevron={SUBMENUS.includes(key) ? 'right' : undefined}
          subtext={subtext}
        />
      </button>
    )
  }
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        fontFamily: theme.semiBoldTextFont
      }}
      onContextMenu={event => {
        event.preventDefault()
      }}
    >
      <button
        ref={trigger}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        style={{
          width: '100%',
          position: 'relative',
          height: CONTROL_HEIGHT,
          border: `1px solid ${open ? SCORING_MENU.accent : CONTROL_COLORS.more.border}`,
          outline: open ? `1px solid ${SCORING_MENU.accent}` : undefined,
          borderRadius: 12,
          background: CONTROL_COLORS.more.bottom,
          boxShadow: '0 4px 3px rgba(0, 0, 0, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          color: theme.scoringControlText,
          fontFamily: theme.regularTextFont,
          fontSize: 16,
          fontWeight: 400,
          touchAction: 'none',
          opacity: disabled ? 0.5 : 1
        }}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return
          // Safari may omit the compatibility click after a captured drag.
          // A fresh pointer press must not inherit that drag's click guard.
          skipClick.current = false
          gesture.current = {
            x: event.clientX,
            y: event.clientY,
            id: event.pointerId,
            dragged: false,
            escaped: false
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event => {
          const active = gesture.current
          if (disabled || active == null) return
          if (active.escaped) return
          if (!active.dragged && active.y - event.clientY > 8) {
            active.dragged = true
            show()
          }
          if (!active.dragged) return
          const parentBounds = primaryPanel.current?.getBoundingClientRect()
          const childBounds = childPanel.current?.getBoundingClientRect()
          const inRect = (r: DOMRect | undefined): boolean =>
            r != null &&
            event.clientX >= r.left &&
            event.clientX <= r.right &&
            event.clientY >= r.top &&
            event.clientY <= r.bottom
          const keyUnderPointer = hit(event.clientX, event.clientY)
          const bridge =
            parentBounds != null &&
            childBounds != null &&
            event.clientX >= parentBounds.right &&
            event.clientX <= childBounds.left &&
            event.clientY >= childBounds.top &&
            event.clientY <= childBounds.bottom
          const approach =
            parentBounds != null &&
            event.clientX >= parentBounds.left &&
            event.clientX <= parentBounds.right &&
            event.clientY > parentBounds.bottom &&
            event.clientY <= active.y
          if (
            parentBounds != null &&
            parentBounds.width > 0 &&
            keyUnderPointer == null &&
            !inRect(parentBounds) &&
            !inRect(childBounds) &&
            !bridge &&
            !approach
          ) {
            active.escaped = true
            close()
            return
          }
          const key = hit(event.clientX, event.clientY)
          setHover(key)
          if (key != null && SUBMENUS.includes(key)) setChild(key)
          else if (parentBounds != null && event.clientX <= parentBounds.right)
            setChild(undefined)
        }}
        onPointerUp={event => {
          const active = gesture.current
          gesture.current = null
          if (disabled || active == null) return
          event.currentTarget.releasePointerCapture(event.pointerId)
          if (active.dragged) {
            skipClick.current = true
            const key = hit(event.clientX, event.clientY)
            if (!active.escaped && key != null) choose(key)
            else close()
          }
        }}
        onPointerCancel={() => {
          gesture.current = null
          close()
        }}
        onLostPointerCapture={() => {
          if (gesture.current != null) {
            gesture.current = null
            close()
          }
        }}
        onClick={() => {
          if (skipClick.current) {
            skipClick.current = false
            return
          }
          if (open) close()
          else show()
        }}
      >
        <ControlBackdrop kind="more" />
        <ControlFace kind="more" />
      </button>
      {open && (
        <>
          <button
            aria-label="Dismiss More"
            onClick={close}
            style={{
              position: 'fixed',
              inset: 0,
              border: 0,
              background: 'transparent',
              zIndex: 19
            }}
          />
          <div
            role="menu"
            aria-label="More scoring actions"
            ref={primaryPanel}
            style={{
              ...scoringMenuPanel,
              position: 'fixed',
              left: 'max(8px, env(safe-area-inset-left))',
              bottom: SCORING_MENU.bottom,
              width: 'calc(50vw - 16px)',
              maxWidth: 300,
              zIndex: 20
            }}
          >
            <div
              style={{
                maxHeight: `calc(100dvh - ${SCORING_MENU.bottom + 12}px)`,
                overflowY: 'auto'
              }}
            >
              {MORE_GROUPS.map(group => (
                <React.Fragment key={group.label}>
                  {group.actions
                    .filter(
                      action =>
                        ![
                          'Dropped Third Strike',
                          BASE,
                          'Balk',
                          DOUBLE
                        ].includes(action) ||
                        moreEligibility(state, action) == null
                    )
                    .map(action =>
                      row(
                        action === DOUBLE
                          ? lstrings.scoring_double_play
                          : action,
                        action
                      )
                    )}
                </React.Fragment>
              ))}
            </div>
          </div>
          {child != null && (
            <div
              key={child}
              role="menu"
              aria-label={
                child === DOUBLE
                  ? lstrings.scoring_double_play_menu
                  : 'Batter base'
              }
              ref={childPanel}
              style={{
                ...scoringMenuPanel,
                position: 'fixed',
                left: 'calc(50vw + 8px)',
                maxWidth: 300,
                top: childTop,
                zIndex: 20,
                width: 'calc(50vw - 16px)'
              }}
            >
              {child === DOUBLE
                ? doublePlayRows(state).map(item =>
                    row(item.label, item.key, item.subtext)
                  )
                : ['First', 'Second', 'Third'].map((label, index) =>
                    row(label, String(index + 1))
                  )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
