import React, { useEffect, useRef, useState } from 'react'

import { PitchIcon } from '../field/PitchIcon'
import type { OutcomePickerProps } from './outcomePickerProps'
import type { Outcome } from './scoringContract'
export const PRIMARY_OUTCOMES = [
  'Batter Out',
  'Single',
  'Double',
  'Triple',
  'Home Run',
  "Fielder's Choice",
  'Error',
  'Batter Interference'
] as const
export function OutcomePicker({
  disabled,
  onChoose,
  onActive
}: OutcomePickerProps): React.ReactElement {
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
  }
  useEffect(() => {
    if (disabled) {
      gesture.current = null
      setMode(undefined)
      setSubmenu(false)
    }
  }, [disabled])
  const select = (value: string): void => {
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
    if (active == null) return
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
        Math.min(window.innerHeight - 130, item.getBoundingClientRect().top)
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
    if (active?.drag === true) {
      suppressClick.current = true
      const item = cancel ? undefined : hoverAt(event.clientX, event.clientY)
      const value = item?.dataset.outcome
      close()
      if (value != null && value !== 'Batter Out') onChoose(value as Outcome)
    }
    const capture = event.target as HTMLElement
    if (capture.hasPointerCapture(event.pointerId))
      capture.releasePointerCapture(event.pointerId)
  }
  const buttonStyle: React.CSSProperties = {
    minHeight: 44,
    border: 0,
    borderRadius: 7,
    padding: '9px 12px',
    color: 'white',
    background: '#14382df5',
    font: 'inherit',
    fontSize: 14,
    cursor: 'pointer',
    touchAction: 'none'
  }
  return (
    <div
      style={{ flex: 1, minWidth: 0 }}
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
        aria-label="Ball in Play"
        disabled={disabled}
        style={{
          ...buttonStyle,
          width: '100%',
          height: '100%',
          opacity: disabled ? 0.5 : 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11
        }}
        onPointerDown={event => {
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
      </button>
      {mode != null && (
        <>
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
              gap: 3,
              maxHeight: '75vh',
              overflowY: 'auto'
            }}
          >
            {(mode === 'drag'
              ? [...PRIMARY_OUTCOMES].reverse()
              : PRIMARY_OUTCOMES
            ).map(value => (
              <button
                role="menuitem"
                data-outcome={value}
                key={value}
                aria-label={value}
                style={{
                  ...buttonStyle,
                  background: hover === value ? '#987b32' : '#14382df5'
                }}
                onClick={event => {
                  if (value === 'Batter Out')
                    setSubmenuTop(
                      Math.min(
                        window.innerHeight - 130,
                        event.currentTarget.getBoundingClientRect().top
                      )
                    )
                  select(value)
                }}
              >
                {value}
              </button>
            ))}
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
                width: 'min(230px, 46vw)',
                display: 'flex',
                flexDirection: 'column',
                gap: 3
              }}
            >
              {(['Throw Out', 'Ball Caught'] as const).map(value => (
                <button
                  role="menuitem"
                  key={value}
                  data-outcome={value}
                  aria-label={value}
                  style={{
                    ...buttonStyle,
                    background: hover === value ? '#987b32' : '#14382df5'
                  }}
                  onClick={() => {
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
