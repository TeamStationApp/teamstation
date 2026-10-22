import React, { useEffect, useRef, useState } from 'react'

import { Checkbox } from '../components/Checkbox'
import { touchedRow, type UmpireSelectorProps } from './umpireSelection'

export function useTouchInterface(): boolean {
  const read = (): boolean =>
    navigator.maxTouchPoints > 0 ||
    Boolean(window.matchMedia?.('(any-pointer: coarse)').matches)
  const [touch, setTouch] = useState(read)
  useEffect(() => {
    const media = window.matchMedia?.('(any-pointer: coarse)')
    const update = (): void => {
      setTouch(read())
    }
    media?.addEventListener('change', update)
    return () => {
      media?.removeEventListener('change', update)
    }
  }, [])
  return touch
}
export function useUnsavedWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      // Older browsers require returnValue as well as preventDefault.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
    }
  }, [dirty])
}
export function UmpireSelector(props: UmpireSelectorProps): React.ReactElement {
  const drag = useRef<
    { pointer: number; top: number; height: number; moved: boolean } | undefined
  >(undefined)
  const suppressClick = useRef(0)
  return (
    <div
      data-testid={props.testID}
      style={{
        width: 48,
        height: 80,
        display: 'flex',
        alignItems: 'center',
        touchAction: 'none',
        userSelect: 'none'
      }}
      onPointerDown={event => {
        suppressClick.current = 0
        if (props.disabled || event.pointerType !== 'touch') return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        drag.current = {
          pointer: event.pointerId,
          top: event.currentTarget.getBoundingClientRect().top,
          height: event.currentTarget.getBoundingClientRect().height,
          moved: false
        }
        props.onRangeStart()
      }}
      onPointerMove={event => {
        const d = drag.current
        if (d?.pointer !== event.pointerId) return
        const last = touchedRow(
          event.clientY,
          d.top,
          d.height,
          props.index,
          props.count
        )
        if (last !== props.index || d.moved) {
          d.moved = true
          props.onRange(last)
        }
      }}
      onPointerUp={event => {
        const d = drag.current
        if (d?.pointer !== event.pointerId) return
        drag.current = undefined
        suppressClick.current = Date.now() + 500
        if (!d.moved) props.onToggle()
      }}
      onPointerCancel={() => {
        drag.current = undefined
      }}
      onClickCapture={event => {
        const touchClick =
          (event.nativeEvent as PointerEvent).pointerType === 'touch'
        if (
          (event.detail !== 0 || touchClick) &&
          Date.now() < suppressClick.current
        ) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
    >
      <Checkbox
        label={props.label}
        checked={props.checked}
        hideLabel
        disabled={props.disabled}
        onPress={props.onToggle}
      />
    </div>
  )
}
