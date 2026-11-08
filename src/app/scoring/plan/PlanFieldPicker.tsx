import React, { useCallback, useEffect, useRef } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { PlanCell } from '../../../common/gamePlan'
import { Icon } from '../../components/Icon'
import { lstrings } from '../../locales/strings'
import { DEFENSE_LOCATIONS } from '../DefensiveField'
import { DefensiveFieldArt } from '../DefensiveFieldArt'
import { measureRosterView } from '../RosterDragContext'
import { useScoringSheetTheme } from '../scoringSheetTheme'
import { POSITIONS } from '../scoringTypes'
import type { PickerTarget } from './planGesture'
import { PLAN_PICKER_HEIGHT, PLAN_PICKER_WIDTH } from './planLayout'

/** The card's padding, title row, field and the row of DH, EH and Bench. */
const PADDING = 10
const TITLE_HEIGHT = 28
const GAP = 8
const OTHERS_HEIGHT = 30
const FIELD_HEIGHT =
  PLAN_PICKER_HEIGHT - 2 * PADDING - TITLE_HEIGHT - OTHERS_HEIGHT - 2 * GAP
/**
 * A position's chip. Rows are 16% of the field apart and P and C 17%, so at
 * this height no two chips of one column touch.
 */
const CHIP_WIDTH = 44
const CHIP_HEIGHT = 26
/** The values that do not field, in the row under the field. */
const OTHERS: ReadonlyArray<{ value: PlanCell; label: string }> = [
  { value: 'DH', label: 'DH' },
  { value: 'EH', label: 'EH' },
  { value: '-', label: lstrings.plan_bench }
]

/**
 * The small field the plan assigns from: the nine positions where the
 * Defense tab draws them, over the same field, with DH, EH and Bench in a
 * row beneath. The cell's own value is lit, and so is the target under a
 * finger dragging onto it. The targets report where they are in the
 * window, for a phone's hold-and-drag, as they are laid out and whenever
 * `measureRef` asks.
 */
export function PlanFieldPicker({
  title,
  value,
  over,
  width = PLAN_PICKER_WIDTH,
  onPick,
  onClose,
  onTargets,
  measureRef
}: {
  title: string
  value: PlanCell
  over?: PlanCell | null
  width?: number
  onPick: (value: PlanCell) => void
  onClose: () => void
  onTargets?: (targets: PickerTarget[]) => void
  measureRef?: React.RefObject<(() => Promise<PickerTarget[]>) | null>
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const surface = theme.scoringSurface
  const views = useRef(
    new Map<PlanCell, React.ComponentRef<typeof View> | null>()
  )
  const reported = useRef(onTargets)
  reported.current = onTargets
  const targets = useCallback(
    async (): Promise<PickerTarget[]> =>
      await Promise.all(
        [...views.current].map(async ([target, view]) => ({
          value: target,
          rect: await measureRosterView(view)
        }))
      ),
    []
  )
  useEffect(() => {
    if (measureRef == null) return
    measureRef.current = targets
    return () => {
      measureRef.current = null
    }
  }, [measureRef, targets])
  // Every target again whenever any of them, or the card, moves: a target's
  // own layout does not change when the card does.
  const measure = useCallback((): void => {
    const report = reported.current
    if (report == null) return
    targets()
      .then(report)
      .catch(() => undefined)
  }, [targets])
  const chip = (
    target: PlanCell,
    label: string,
    style: { width: number; height: number }
  ): React.ReactElement => {
    const lit = over === target
    const chosen = value === target
    const bench = target === '-'
    return (
      <Pressable
        ref={view => {
          views.current.set(target, view)
        }}
        testID={`Plan pick ${target}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: chosen }}
        aria-selected={chosen}
        hitSlop={{ top: 2, bottom: 2, left: 4, right: 4 }}
        onLayout={measure}
        onPress={() => {
          onPick(target)
        }}
        style={{
          ...style,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          borderWidth: lit ? 2 : 1,
          borderColor: lit
            ? surface.accent
            : chosen
              ? surface.accent
              : bench
                ? surface.badges.red.border
                : surface.inputBorder,
          backgroundColor:
            lit || chosen
              ? surface.active
              : bench
                ? surface.badges.red.background
                : surface.input
        }}
      >
        <Text
          selectable={false}
          numberOfLines={1}
          style={{
            color:
              lit || chosen
                ? surface.activeText
                : bench
                  ? surface.badges.red.text
                  : surface.text,
            fontFamily: theme.semiBoldTextFont,
            fontSize: 13
          }}
        >
          {label}
        </Text>
      </Pressable>
    )
  }
  const fieldWidth = width - 2 * PADDING
  return (
    <View
      testID="Plan field picker"
      onLayout={measure}
      style={{
        width,
        height: PLAN_PICKER_HEIGHT,
        padding: PADDING,
        gap: GAP,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: surface.border,
        backgroundColor: surface.canvas,
        shadowColor: '#000000',
        shadowOpacity: 0.45,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8
      }}
    >
      <View
        style={{
          height: TITLE_HEIGHT,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8
        }}
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: surface.accent
          }}
        />
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            flex: 1,
            color: surface.text,
            fontFamily: theme.semiBoldTextFont,
            fontSize: 14
          }}
        >
          {title}
        </Text>
        <Pressable
          testID="Plan picker close"
          accessibilityRole="button"
          accessibilityLabel={lstrings.plan_close_picker}
          hitSlop={8}
          onPress={onClose}
          style={{
            width: TITLE_HEIGHT,
            height: TITLE_HEIGHT,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Icon name="close" size={1.25} color={surface.secondaryText} />
        </Pressable>
      </View>
      <View
        style={{
          width: fieldWidth,
          height: FIELD_HEIGHT,
          borderRadius: 8,
          overflow: 'hidden',
          backgroundColor: surface.idle
        }}
      >
        <DefensiveFieldArt />
        {POSITIONS.map(position => {
          const [x, y] = DEFENSE_LOCATIONS[position]
          return (
            <View
              key={position}
              style={{
                position: 'absolute',
                left: (fieldWidth * x) / 100 - CHIP_WIDTH / 2,
                top: (FIELD_HEIGHT * y) / 100 - CHIP_HEIGHT / 2
              }}
            >
              {chip(position, position, {
                width: CHIP_WIDTH,
                height: CHIP_HEIGHT
              })}
            </View>
          )
        })}
      </View>
      <View
        style={{
          height: OTHERS_HEIGHT,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8
        }}
      >
        {OTHERS.map(({ value: target, label }) => (
          <React.Fragment key={target}>
            {target === '-' && <View style={{ flex: 1 }} />}
            {chip(target, label, {
              width: target === '-' ? 64 : CHIP_WIDTH,
              height: OTHERS_HEIGHT
            })}
          </React.Fragment>
        ))}
      </View>
    </View>
  )
}
