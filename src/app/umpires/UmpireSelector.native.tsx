import React, { useEffect, useRef } from 'react'
import { View } from 'react-native'

import { Checkbox } from '../components/Checkbox'
import { touchedRow, type UmpireSelectorProps } from './umpireSelection'

export function useTouchInterface(): boolean {
  return true
}
export function useUnsavedWarning(_dirty: boolean): void {
  return undefined
}
export function UmpireSelector(props: UmpireSelectorProps): React.ReactElement {
  const row = useRef<React.ComponentRef<typeof View>>(null)
  const latest = useRef(props)
  latest.current = props
  const drag = useRef<
    | {
        top?: number
        y: number
        moved: boolean
        released: boolean
      }
    | undefined
  >(undefined)
  useEffect(
    () => () => {
      drag.current = undefined
    },
    []
  )
  const update = (): void => {
    const d = drag.current
    if (d?.top == null) return
    const current = latest.current
    const last = touchedRow(d.y, d.top, 80, current.index, current.count)
    if (last !== current.index || d.moved) {
      d.moved = true
      current.onRange(last)
    }
    if (d.released) {
      drag.current = undefined
      if (!d.moved) current.onToggle()
    }
  }
  return (
    <View
      ref={row}
      testID={props.testID}
      style={{ width: 48, height: 80, justifyContent: 'center' }}
      onStartShouldSetResponderCapture={() => !props.disabled}
      onResponderGrant={event => {
        const d = { y: event.nativeEvent.pageY, moved: false, released: false }
        drag.current = d
        props.onRangeStart()
        // locationY belongs to the touched child, not necessarily this row.
        row.current?.measure((_x, _y, _width, _height, _pageX, pageY) => {
          if (drag.current !== d) return
          drag.current.top = pageY
          update()
        })
      }}
      onResponderMove={event => {
        const d = drag.current
        if (d == null) return
        d.y = event.nativeEvent.pageY
        update()
      }}
      onResponderRelease={event => {
        const d = drag.current
        if (d == null) return
        d.y = event.nativeEvent.pageY
        d.released = true
        update()
      }}
      onResponderTerminate={() => {
        drag.current = undefined
      }}
    >
      <Checkbox
        label={props.label}
        checked={props.checked}
        hideLabel
        disabled={props.disabled}
        onPress={props.onToggle}
      />
    </View>
  )
}
