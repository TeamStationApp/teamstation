import React, { useEffect, useId, useRef } from 'react'

import { useTheme } from '../theme/ThemeContext'
import {
  clampPlayerCount,
  COUNT_ROW_HEIGHT,
  countAtOffset,
  PLAYER_COUNTS,
  type PlayerCountPickerProps
} from './playerCount'

export function PlayerCountPicker({
  value,
  onChange
}: PlayerCountPickerProps): React.ReactElement {
  const theme = useTheme()
  const root = useRef<HTMLDivElement>(null)
  const announced = useRef<number | undefined>(undefined)
  const id = useId()
  useEffect(() => {
    if (announced.current !== value) {
      announced.current = value
      if (root.current != null)
        root.current.scrollTop = (value - 1) * COUNT_ROW_HEIGHT
    }
  }, [value])
  const select = (next: number): void => {
    const count = clampPlayerCount(next)
    announced.current = count
    if (root.current != null)
      root.current.scrollTop = (count - 1) * COUNT_ROW_HEIGHT
    onChange(count)
  }
  return (
    <div style={{ position: 'relative', width: 160, alignSelf: 'center' }}>
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 80,
          height: 40,
          left: 0,
          right: 0,
          pointerEvents: 'none',
          borderRadius: 8,
          background: theme.scoringSelectorIdle
        }}
      />
      <div
        ref={root}
        role="listbox"
        aria-label="Number of placeholder players"
        aria-activedescendant={`${id}-${value}`}
        tabIndex={0}
        style={{
          height: 200,
          overflowY: 'auto',
          scrollSnapType: 'y mandatory',
          overscrollBehavior: 'contain',
          padding: '80px 0',
          boxSizing: 'border-box',
          position: 'relative',
          touchAction: 'pan-y'
        }}
        onScroll={event => {
          const next = countAtOffset(event.currentTarget.scrollTop)
          announced.current = next
          onChange(next)
        }}
        onKeyDown={event => {
          const next = {
            ArrowDown: value + 1,
            ArrowUp: value - 1,
            Home: 1,
            End: 16
          }[event.key]
          if (next != null) {
            event.preventDefault()
            select(next)
          }
        }}
      >
        {PLAYER_COUNTS.map(count => (
          <div
            role="option"
            id={`${id}-${count}`}
            key={count}
            aria-selected={value === count}
            aria-label={`Player count ${count}`}
            onClick={() => {
              select(count)
            }}
            style={{
              height: 40,
              minHeight: 40,
              scrollSnapAlign: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: theme.regularTextFont,
              fontSize: 22,
              color: theme.primaryTextColor,
              cursor: 'pointer'
            }}
          >
            {count}
          </div>
        ))}
      </div>
    </div>
  )
}
