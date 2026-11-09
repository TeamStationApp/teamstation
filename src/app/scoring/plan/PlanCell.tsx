import React, { useEffect, useRef, useState } from 'react'
import {
  type GestureResponderEvent,
  Pressable,
  Text,
  TextInput,
  View
} from 'react-native'

import {
  type PlanCell as PlanCellValue,
  planCellEntry,
  planCellOf
} from '../../../common/gamePlan'
import { useScoringSheetTheme } from '../scoringSheetTheme'
import { PLAN_CELL_FONT } from './planLayout'

/** How long a refused entry outlines its cell in red. */
export const PLAN_REFUSAL_MS = 600

/** A cell's box, the same on both platforms: one column, one row. */
function useCellStyle(
  selected: boolean,
  refused: boolean
): {
  box: {
    flex: number
    borderWidth: number
    borderRadius: number
    borderColor: string
    backgroundColor: string
  }
  text: {
    color: string
    fontFamily: string
    fontSize: number
    fontWeight: '700'
    textAlign: 'center'
  }
} {
  const { scoringSurface: surface } = useScoringSheetTheme()
  return {
    box: {
      flex: 1,
      borderWidth: 2,
      borderRadius: 4,
      borderColor: refused
        ? surface.danger
        : selected
          ? surface.accent
          : 'transparent',
      backgroundColor: selected ? surface.input : 'transparent'
    },
    text: {
      ...PLAN_CELL_FONT,
      color: surface.text,
      fontWeight: '700',
      textAlign: 'center'
    }
  }
}

/**
 * A plan cell on the web: a two-character field. A click focuses it, which
 * selects its text and opens the field picker. Keys are read as they come:
 * a whole value is written at once, the first letter of a two-letter one
 * waits for the second, and anything else is refused, as is a paste that is
 * not a whole value. A refusal keeps the cell's value and outlines it in red.
 * The bench is blank: the field shows nothing, and emptying it (Delete or
 * Backspace) benches. There is no hover style.
 */
export function WebPlanCell({
  value,
  label,
  selected,
  testID,
  onFocus,
  onBlur,
  onCommit,
  onRefuse,
  onEscape
}: {
  value: PlanCellValue
  label: string
  selected: boolean
  testID: string
  onFocus: () => void
  onBlur: () => void
  onCommit: (value: PlanCellValue) => void
  /** What was typed or pasted, which the cell would not take. */
  onRefuse: (text: string) => void
  onEscape: () => void
}): React.ReactElement {
  const [pending, setPending] = useState<string>()
  const [refused, setRefused] = useState(0)
  const style = useCellStyle(selected, refused > 0)
  const input = useRef<React.ComponentRef<typeof TextInput>>(null)
  const latest = useRef({ onCommit, onRefuse })
  latest.current = { onCommit, onRefuse }
  const refuse = (text: string): void => {
    setPending(undefined)
    setRefused(count => count + 1)
    latest.current.onRefuse(text)
  }
  const refuseRef = useRef(refuse)
  refuseRef.current = refuse
  useEffect(() => {
    if (refused === 0) return
    const timer = setTimeout(() => {
      setRefused(0)
    }, PLAN_REFUSAL_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [refused])
  // A paste is read whole, before the field cuts it to two characters.
  useEffect(() => {
    const node = input.current as unknown as HTMLInputElement | null
    if (node?.addEventListener == null) return
    const paste = (event: ClipboardEvent): void => {
      event.preventDefault()
      const text = event.clipboardData?.getData('text') ?? ''
      const cell = planCellOf(text)
      if (cell == null) refuseRef.current(text)
      else {
        setPending(undefined)
        latest.current.onCommit(cell)
      }
    }
    node.addEventListener('paste', paste)
    return () => {
      node.removeEventListener('paste', paste)
    }
  }, [])
  const shown = pending ?? value
  return (
    <TextInput
      ref={input}
      testID={testID}
      accessibilityLabel={label}
      value={shown}
      maxLength={2}
      autoCapitalize="characters"
      autoCorrect={false}
      spellCheck={false}
      selectTextOnFocus
      onFocus={onFocus}
      onBlur={() => {
        // A first letter never finished is not a value.
        if (pending != null) refuse(pending)
        onBlur()
      }}
      onKeyPress={event => {
        // Left, so the next click opens the picker again.
        if (event.nativeEvent.key !== 'Escape') return
        onEscape()
        input.current?.blur()
      }}
      onChangeText={text => {
        const entry = planCellEntry(shown, text)
        if ('commit' in entry) {
          setPending(undefined)
          onCommit(entry.commit)
        } else if ('pending' in entry) setPending(entry.pending)
        else refuse(text)
      }}
      style={{
        ...style.box,
        ...style.text,
        padding: 0,
        // The cell's own border shows focus; the browser's ring would
        // spill into its neighbours.
        outlineWidth: 0
      }}
    />
  )
}

/**
 * A plan cell on a phone: its value, nothing on the bench, and a tap that
 * opens the field picker for it. A hold opens the picker too and starts a drag onto it, which the
 * tab's root follows once the finger moves.
 */
export function NativePlanCell({
  value,
  label,
  selected,
  testID,
  onPress,
  onLongPress,
  onPressOut
}: {
  value: PlanCellValue
  label: string
  selected: boolean
  testID: string
  onPress: () => void
  onLongPress: (event: GestureResponderEvent) => void
  onPressOut: () => void
}): React.ReactElement {
  const style = useCellStyle(selected, false)
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      // The value is named with the cell, so it is read, and found, with it.
      accessibilityLabel={value === '' ? label : `${label}, ${value}`}
      accessibilityState={{ selected }}
      delayLongPress={300}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressOut={onPressOut}
      style={{ ...style.box, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{ pointerEvents: 'none' }}>
        <Text selectable={false} style={style.text}>
          {value}
        </Text>
      </View>
    </Pressable>
  )
}
