import React, { useEffect, useRef, useState } from 'react'

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
  const skipClick = useRef(false)
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
      setOpen(false)
      setChild(false)
      setForm(undefined)
      onActive(false)
    }
  }, [disabled, onActive])
  const show = (): void => {
    setOpen(true)
    onActive(true)
  }
  const choose = (key: string): void => {
    const base = Number(key)
    const input: MoreInput = [1, 2, 3].includes(base)
      ? { action: 'Put Batter on Base', base }
      : { action: key as MoreAction }
    if (moreEligibility(state, input.action) != null) return
    if (input.action === 'Put Batter on Base' && input.base == null) {
      setChild(value => !value)
      return
    }
    if (
      input.action === 'Place a Runner (Tiebreaker)' ||
      input.action === 'Put Batter on Base'
    ) {
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
        disabled={reason != null}
        onClick={() => {
          choose(key)
        }}
        style={{
          display: 'block',
          width: '100%',
          minHeight: 44,
          textAlign: 'left',
          border: 0,
          borderBottom: `1px solid ${theme.defaultBorderColor}`,
          padding: '9px 12px',
          background:
            hover === key
              ? theme.inactiveBackgroundColor
              : theme.backgroundColor,
          color: theme.primaryTextColor,
          fontFamily: theme.semiBoldTextFont,
          fontSize: 14,
          opacity: reason == null ? 1 : 0.4
        }}
      >
        {submenu ? '‹  ' : ''}
        {label}
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
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        style={{
          width: '100%',
          minHeight: 52,
          border: 0,
          borderRadius: theme.rem(theme.radiusRem),
          background: theme.primaryButtonColor,
          color: theme.buttonTextColor,
          fontFamily: theme.semiBoldTextFont,
          fontSize: 11,
          fontWeight: 600,
          touchAction: 'none',
          opacity: disabled ? 0.5 : 1
        }}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return
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
          if (active == null) return
          if (active.y - event.clientY > 8) {
            active.dragged = true
            show()
          }
          if (!active.dragged) return
          if (
            event.clientX > (child ? 380 : 308) &&
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
          else if (key != null && ![1, 2, 3].includes(Number(key)))
            setChild(false)
        }}
        onPointerUp={event => {
          const active = gesture.current
          gesture.current = null
          if (active == null) return
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
            style={{
              position: 'fixed',
              left: child ? 190 : 8,
              bottom: 128,
              width: child ? 190 : 300,
              maxWidth: 'calc(100vw - 16px)',
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
                      color: theme.secondaryTextColor,
                      fontSize: 12
                    }}
                  >
                    {group.label}
                  </div>
                  {group.actions
                    .filter(
                      action =>
                        action !== 'Strike Three, Not Caught' ||
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
                style={{
                  position: 'absolute',
                  right: 'calc(100% + 8px)',
                  bottom: 0,
                  width: 174,
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
            close()
            onChoose(input)
          }}
        />
      )}
    </div>
  )
}
