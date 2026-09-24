import React, { useEffect, useRef, useState } from 'react'

import { PitchIcon } from '../field/PitchIcon'
import { useTheme } from '../theme/ThemeContext'
import { outcomeAvailable } from './battedBall'
import type { OutcomePickerProps } from './outcomePickerProps'
import type { Outcome } from './scoringContract'
export const PRIMARY_OUTCOMES = [
  'Batter Out',
  'Single',
  'Double',
  'Triple',
  'Home Run',
  "Fielder's Choice",
  'Error'
] as const
export function OutcomePicker({
  disabled,
  hasRunners = true,
  onChoose,
  onActive
}: OutcomePickerProps): React.ReactElement {
  const theme = useTheme()
  const outcomes = PRIMARY_OUTCOMES.filter(value =>
    outcomeAvailable(value, hasRunners)
  )
  const trigger = useRef<HTMLButtonElement>(null)
  const [mode, setMode] = useState<'tap' | 'drag'>()
  const [submenu, setSubmenu] = useState(false)
  const [hover, setHover] = useState('')
  const [submenuTop, setSubmenuTop] = useState(200)
  const gesture = useRef<{ pointer: number; y: number; drag: boolean } | null>(
    null
  )
  const suppressClick = useRef(false)
  const previousX = useRef(0)
  const main = useRef<HTMLDivElement>(null)
  const close = (): void => {
    setMode(undefined)
    setSubmenu(false)
    setHover('')
    onActive(false)
    trigger.current?.focus()
  }
  useEffect(() => {
    if (disabled) {
      const pointer = gesture.current?.pointer
      if (
        pointer != null &&
        trigger.current?.hasPointerCapture(pointer) === true
      )
        trigger.current.releasePointerCapture(pointer)
      gesture.current = null
      setMode(undefined)
      setSubmenu(false)
      setHover('')
      onActive(false)
    }
  }, [disabled, onActive])
  const select = (value: string): void => {
    if (disabled || !outcomeAvailable(value, hasRunners)) return
    if (value === 'Batter Out') {
      setSubmenu(previous => !previous)
      return
    }
    close()
    onChoose(value as Outcome)
  }
  const hoverAt = (x: number, y: number): HTMLElement | undefined => {
    return (
      document
        .elementsFromPoint(x, y)
        .map(node => node.closest<HTMLElement>('[data-outcome]'))
        .find(node => node != null) ?? undefined
    )
  }
  const move = (event: React.PointerEvent): void => {
    const active = gesture.current
    if (disabled || active == null) return
    if (!active.drag && event.clientY < active.y - 8) {
      active.drag = true
      setMode('drag')
      onActive(true)
    }
    if (!active.drag) return
    const movingRight = event.clientX > previousX.current + 1
    previousX.current = event.clientX
    const item = hoverAt(event.clientX, event.clientY)
    const value = item?.dataset.outcome ?? ''
    setHover(value)
    if (value === 'Batter Out' && item != null) {
      setSubmenu(true)
      setSubmenuTop(
        Math.max(
          12,
          Math.min(window.innerHeight - 215, item.getBoundingClientRect().top)
        )
      )
    } else if (
      (item != null && main.current?.contains(item) === true) ||
      (movingRight && event.clientX >= window.innerWidth / 2)
    )
      setSubmenu(false)
  }
  const release = (
    event: React.PointerEvent<HTMLDivElement>,
    cancel: boolean
  ): void => {
    const active = gesture.current
    gesture.current = null
    if (!disabled && active?.drag === true) {
      suppressClick.current = true
      const item = cancel ? undefined : hoverAt(event.clientX, event.clientY)
      const value = item?.dataset.outcome
      close()
      if (
        value != null &&
        value !== 'Batter Out' &&
        outcomeAvailable(value, hasRunners)
      )
        onChoose(value as Outcome)
    }
    const capture = event.target as HTMLElement
    if (capture.hasPointerCapture(event.pointerId))
      capture.releasePointerCapture(event.pointerId)
  }
  const buttonStyle: React.CSSProperties = {
    minHeight: 44,
    border: 0,
    borderRadius: theme.rem(theme.radiusRem),
    padding: '9px 12px',
    color: theme.primaryTextColor,
    background: theme.backgroundColor,
    fontFamily: theme.semiBoldTextFont,
    fontWeight: 700,
    fontSize: 16.8,
    cursor: 'pointer',
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none'
  }
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none'
      }}
      onContextMenu={event => {
        event.preventDefault()
      }}
      onPointerMove={move}
      onPointerUp={event => {
        release(event, false)
      }}
      onPointerCancel={event => {
        release(event, true)
      }}
      onLostPointerCapture={() => {
        if (gesture.current?.drag === true) close()
        gesture.current = null
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') close()
      }}
    >
      <button
        ref={trigger}
        aria-label="Ball in Play"
        title="Tap for outcomes or drag up to choose"
        disabled={disabled}
        style={{
          ...buttonStyle,
          background: theme.primaryButtonColor,
          boxShadow: `0 3px 8px ${theme.buttonShadowColor}`,
          color: theme.buttonTextColor,
          position: 'relative',
          padding: '6px 3px',
          width: '100%',
          height: '100%',
          opacity: disabled ? 0.5 : 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 600
        }}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return
          previousX.current = event.clientX
          suppressClick.current = false
          gesture.current = {
            pointer: event.pointerId,
            y: event.clientY,
            drag: false
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onClick={() => {
          if (disabled) return
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          if (mode != null) close()
          else {
            setMode('tap')
            onActive(true)
          }
        }}
      >
        <PitchIcon kind="play" />
        Ball in Play
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: 3,
            top: 4,
            pointerEvents: 'none',
            lineHeight: 0.6,
            fontSize: 15
          }}
        >
          ⌃<br />⌃<br />⌃
        </span>
      </button>
      {mode != null && (
        <>
          <div
            aria-label="Dismiss outcomes"
            onClick={close}
            style={{ position: 'fixed', inset: 0, zIndex: 19 }}
          />
          <div
            ref={main}
            role="menu"
            aria-label="Ball in Play outcomes"
            style={{
              position: 'fixed',
              zIndex: 20,
              right: 12,
              bottom: 126,
              width: 'min(230px, 46vw)',
              display: 'flex',
              flexDirection: 'column',
              gap: 0,
              borderRadius: theme.rem(theme.radiusRem),
              background: theme.backgroundColor,
              maxHeight: 'calc(100vh - 140px)',
              overflowY: 'auto'
            }}
          >
            {(mode === 'drag' ? [...outcomes].reverse() : outcomes).map(
              value => (
                <button
                  role="menuitem"
                  data-outcome={value}
                  key={value}
                  aria-label={value}
                  onPointerEnter={() => {
                    setHover(value)
                  }}
                  onPointerLeave={() => {
                    setHover('')
                  }}
                  onFocus={() => {
                    setHover(value)
                  }}
                  onBlur={() => {
                    setHover('')
                  }}
                  style={{
                    ...buttonStyle,
                    color:
                      hover === value
                        ? theme.scoringMenuActiveText
                        : theme.primaryTextColor,
                    borderRadius: 0,
                    textAlign: 'left',
                    borderBottom: `1px solid ${theme.defaultBorderColor}`,
                    background:
                      hover === value
                        ? theme.scoringMenuActiveBackground
                        : theme.backgroundColor
                  }}
                  onClick={event => {
                    if (value === 'Batter Out')
                      setSubmenuTop(
                        Math.max(
                          12,
                          Math.min(
                            window.innerHeight - 215,
                            event.currentTarget.getBoundingClientRect().top
                          )
                        )
                      )
                    select(value)
                  }}
                >
                  {value === 'Batter Out' ? '‹  ' : ''}
                  {value}
                </button>
              )
            )}
          </div>
          {submenu && (
            <div
              role="menu"
              aria-label="Batter Out options"
              style={{
                position: 'fixed',
                zIndex: 20,
                left: 12,
                top: submenuTop,
                maxHeight: 'calc(100dvh - 24px)',
                overflowY: 'auto',
                width: 'min(230px, 46vw)',
                display: 'flex',
                flexDirection: 'column',
                gap: 0,
                borderRadius: theme.rem(theme.radiusRem),
                overflow: 'hidden',
                background: theme.backgroundColor
              }}
            >
              {(
                ['Throw Out', 'Ball Caught', 'Batter Interference'] as const
              ).map(value => (
                <button
                  role="menuitem"
                  key={value}
                  data-outcome={value}
                  aria-label={value}
                  onPointerEnter={() => {
                    setHover(value)
                  }}
                  onPointerLeave={() => {
                    setHover('')
                  }}
                  onFocus={() => {
                    setHover(value)
                  }}
                  onBlur={() => {
                    setHover('')
                  }}
                  style={{
                    ...buttonStyle,
                    color:
                      hover === value
                        ? theme.scoringMenuActiveText
                        : theme.primaryTextColor,
                    borderRadius: 0,
                    textAlign: 'left',
                    borderBottom: `1px solid ${theme.defaultBorderColor}`,
                    background:
                      hover === value
                        ? theme.scoringMenuActiveBackground
                        : theme.backgroundColor
                  }}
                  onClick={() => {
                    if (disabled) return
                    select(value)
                  }}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
