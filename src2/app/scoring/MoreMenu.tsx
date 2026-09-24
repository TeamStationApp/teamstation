import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useTheme } from '../theme/ThemeContext'
import { MoreActionEditor } from './MoreActionEditor'
import {
  MORE_GROUPS,
  type MoreAction,
  moreEligibility,
  type MoreInput
} from './moreActions'
import type { MoreMenuProps } from './moreMenuProps'
import { useMenuEscape } from './useMenuEscape'
export function MoreMenu({
  state,
  disabled,
  onActive,
  onChoose
}: MoreMenuProps): React.ReactElement {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const [child, setChild] = useState(false)
  const [hover, setHover] = useState<string>()
  const [form, setForm] = useState<MoreInput>()
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
    if (!child) return
    const measure = (): void => {
      const parent = primaryPanel.current
        ?.querySelector('[data-more="Put Batter on Base"]')
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
    setChild(false)
    setHover(undefined)
    setForm(undefined)
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
      setChild(false)
      setForm(undefined)
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
    const base = Number(key)
    const input: MoreInput = [1, 2, 3].includes(base)
      ? { action: 'Put Batter on Base', base }
      : { action: key as MoreAction }
    if (moreEligibility(state, input.action) != null) return
    if (input.action === 'Put Batter on Base' && input.base == null) {
      setChild(value => !value)
      return
    }
    if (input.action === 'Place a Runner (Tiebreaker)') {
      setOpen(false)
      setForm(input)
      onActive(true)
    } else {
      close()
      onChoose(input)
    }
  }
  const hit = (x: number, y: number): string | undefined =>
    document
      .elementsFromPoint(x, y)
      .map(node => node.closest<HTMLElement>('[data-more]')?.dataset.more)
      .find(value => value != null)
  const row = (
    label: string,
    key = label,
    submenu = false
  ): React.ReactElement => {
    const action = [1, 2, 3].includes(Number(key))
      ? 'Put Batter on Base'
      : (key as MoreAction)
    const reason = moreEligibility(state, action)
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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          minHeight: 44,
          textAlign: 'left',
          border: 0,
          borderBottom: `1px solid ${theme.defaultBorderColor}`,
          padding: '9px 12px',
          background:
            hover === key && reason == null
              ? theme.scoringMenuActiveBackground
              : theme.backgroundColor,
          color:
            hover === key && reason == null
              ? theme.scoringMenuActiveText
              : theme.primaryTextColor,
          fontFamily: theme.semiBoldTextFont,
          fontSize: 16.8,
          fontWeight: 700,
          opacity: reason == null ? 1 : 0.4
        }}
      >
        <span>{label}</span>
        {submenu && <span aria-hidden="true">›</span>}
      </button>
    )
  }
  return (
    <div
      style={{
        flex: 1,
        maxWidth: '20%',
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
          minHeight: 52,
          border: 0,
          borderRadius: theme.rem(theme.radiusRem),
          background: theme.primaryButtonColor,
          boxShadow: `0 3px 8px ${theme.buttonShadowColor}`,
          color: theme.buttonTextColor,
          fontFamily: theme.semiBoldTextFont,
          fontSize: 11,
          fontWeight: 600,
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
          if (active.y - event.clientY > 8) {
            active.dragged = true
            show()
          }
          if (!active.dragged) return
          const parentBounds = primaryPanel.current?.getBoundingClientRect()
          const childBounds = childPanel.current?.getBoundingClientRect()
          const right = Math.max(
            parentBounds?.right ?? 0,
            childBounds?.right ?? 0
          )
          if (
            right > 0 &&
            event.clientX > right &&
            hit(event.clientX, event.clientY) == null
          ) {
            active.escaped = true
            setHover(undefined)
            return
          }
          if (active.escaped) return
          const key = hit(event.clientX, event.clientY)
          setHover(key)
          if (key === 'Put Batter on Base') setChild(true)
          else if (parentBounds != null && event.clientX <= parentBounds.right)
            setChild(false)
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
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 3,
            top: 4,
            pointerEvents: 'none',
            lineHeight: 0.6,
            fontSize: 15
          }}
        >
          ⌃<br />⌃<br />⌃
        </span>
        <span
          aria-hidden="true"
          style={{ display: 'block', fontSize: 22, lineHeight: '22px' }}
        >
          ⋯
        </span>
        More
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
              position: 'fixed',
              left: 'max(8px, env(safe-area-inset-left))',
              bottom: 128,
              width: 'calc(50vw - 16px)',
              maxWidth: 300,
              zIndex: 20,
              background: theme.backgroundColor,
              borderRadius: theme.rem(theme.radiusRem),
              border: `1px solid ${theme.defaultBorderColor}`
            }}
          >
            <div
              style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}
            >
              {MORE_GROUPS.map(group => (
                <React.Fragment key={group.label}>
                  <div
                    style={{
                      padding: '8px 12px',
                      color: theme.primaryTextColor,
                      fontSize: 14.4,
                      fontWeight: 700
                    }}
                  >
                    {group.label}
                  </div>
                  {group.actions
                    .filter(
                      action =>
                        ![
                          'Strike Three, Not Caught',
                          'Put Batter on Base'
                        ].includes(action) ||
                        moreEligibility(state, action) == null
                    )
                    .map(action =>
                      row(action, action, action === 'Put Batter on Base')
                    )}
                </React.Fragment>
              ))}
            </div>
            {child && (
              <div
                role="menu"
                aria-label="Batter base"
                ref={childPanel}
                style={{
                  position: 'fixed',
                  left: 'calc(50vw + 8px)',
                  maxWidth: 300,
                  top: childTop,
                  width: 'calc(50vw - 16px)',
                  borderRadius: theme.rem(theme.radiusRem),
                  overflow: 'hidden',
                  background: theme.backgroundColor
                }}
              >
                {['First', 'Second', 'Third'].map((label, index) =>
                  row(label, String(index + 1))
                )}
              </div>
            )}
          </div>
        </>
      )}
      {form != null && (
        <MoreActionEditor
          state={state}
          input={form}
          onCancel={close}
          onSave={input => {
            if (disabled) return
            close()
            onChoose(input)
          }}
        />
      )}
    </div>
  )
}
