import React from 'react'
import { type GestureResponderEvent, Pressable, Text, View } from 'react-native'

import type { PlanCell as PlanCellValue } from '../../../common/gamePlan'
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
 * A plan cell on the web: its value, or the letter being typed into it, in
 * a box the sheet outlines while it is highlighted, and in red for a moment
 * when it refuses what was typed or pasted. It is no text field: a click
 * highlights it and opens the field picker, and the sheet, which takes the
 * focus, reads the keys, so no text is ever selected or edited in it. The
 * bench is blank. There is no hover style.
 */
export function WebPlanCell({
  value,
  label,
  highlighted,
  editing,
  refused,
  testID,
  onPress
}: {
  value: PlanCellValue
  label: string
  highlighted: boolean
  /** What is being typed into it, which replaces its value once whole. */
  editing?: string
  refused: boolean
  testID: string
  onPress: () => void
}): React.ReactElement {
  const style = useCellStyle(highlighted, refused)
  const shown = editing ?? value
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={shown === '' ? label : `${label}, ${shown}`}
      accessibilityState={{ selected: highlighted }}
      aria-selected={highlighted}
      // A click leaves the focus to the sheet, which reads the keys; the
      // cell is no tab stop.
      tabIndex={-1}
      onPress={onPress}
      style={{
        ...style.box,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        // The sheet's focus shows as this outline; the browser's ring would
        // spill into its neighbours.
        outlineWidth: 0
      }}
    >
      <Text selectable={false} style={style.text}>
        {shown}
      </Text>
      {editing != null && (
        <View
          testID={`${testID} caret`}
          style={{
            width: 1.5,
            height: PLAN_CELL_FONT.fontSize,
            marginLeft: 1,
            backgroundColor: style.text.color
          }}
        />
      )}
    </Pressable>
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
