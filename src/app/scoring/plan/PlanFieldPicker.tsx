import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { type GestureResponderEvent, Pressable, Text, View } from 'react-native'

import type { PlanCell } from '../../../common/gamePlan'
import { ButtonIcon } from '../../components/ButtonIcon'
import { lstrings } from '../../locales/strings'
import { DEFENSE_LOCATIONS } from '../DefensiveField'
import { DefensiveFieldArt } from '../DefensiveFieldArt'
import { measureRosterView } from '../RosterDragContext'
import { useScoringSheetTheme } from '../scoringSheetTheme'
import { type Position, POSITIONS } from '../scoringTypes'
import {
  enlargedRect,
  type PickerTarget,
  type PlanPoint,
  type PlanRect
} from './planGesture'
import { PLAN_PICKER_HEIGHT, PLAN_PICKER_WIDTH } from './planLayout'

/** The card's border, padding, title row, field and row of DH, EH and Bench. */
const BORDER = 1
const PADDING = 10
const TITLE_HEIGHT = 28
const GAP = 8
const OTHERS_HEIGHT = 30
export const PICKER_FIELD_HEIGHT =
  PLAN_PICKER_HEIGHT - 2 * PADDING - TITLE_HEIGHT - OTHERS_HEIGHT - 2 * GAP
/** The field on a card `width` wide. */
export const pickerFieldWidth = (width: number): number => width - 2 * PADDING
const FIELD_TOP = PADDING + TITLE_HEIGHT + GAP
const OTHERS_TOP = FIELD_TOP + PICKER_FIELD_HEIGHT + GAP
/**
 * A position's chip. Rows are 16% of the field apart and P and C 17%, so at
 * this height no two chips of one column touch.
 */
export const CHIP_WIDTH = 44
export const CHIP_HEIGHT = 26
const BENCH_WIDTH = 64
/** How long a finger rests on a target before its enlarged box shows. */
export const PICKER_HOLD_MS = 300

/**
 * The field art's mound and bases, in percent of its 360 × 240 view box:
 * the mound's circle and the centres of the 1B, 2B and 3B bags.
 */
export const FIELD_ART = {
  mound: [50, 60],
  first: [(269 / 360) * 100, (136 / 240) * 100],
  second: [50, 40],
  third: [(91 / 360) * 100, (136 / 240) * 100]
} as const satisfies Record<string, readonly [number, number]>

/** Half a chip's diagonal: how far the infielders slide along the paths. */
export const CHIP_SLIDE = Math.hypot(CHIP_WIDTH, CHIP_HEIGHT) / 2

/**
 * The picker's own places for the positions, in percent of a field
 * `fieldWidth` by `fieldHeight` points: the Defense tab's, but P on the
 * mound, 1B and 2B slid up and left along the path from first base to
 * second, and 3B and SS up and right along the path from third base to
 * second, each by half a chip's diagonal. The slide is measured in points,
 * so each axis goes back to percent by its own length.
 */
export function pickerLocations(
  fieldWidth: number,
  fieldHeight: number
): Record<Position, readonly [number, number]> {
  const slide = (
    from: readonly [number, number],
    to: readonly [number, number],
    [x, y]: readonly [number, number]
  ): readonly [number, number] => {
    const dx = ((to[0] - from[0]) * fieldWidth) / 100
    const dy = ((to[1] - from[1]) * fieldHeight) / 100
    const length = Math.hypot(dx, dy)
    return [
      x + (((CHIP_SLIDE * dx) / length) * 100) / fieldWidth,
      y + (((CHIP_SLIDE * dy) / length) * 100) / fieldHeight
    ]
  }
  const { mound, first, second, third } = FIELD_ART
  return {
    ...DEFENSE_LOCATIONS,
    P: mound,
    '1B': slide(first, second, DEFENSE_LOCATIONS['1B']),
    '2B': slide(first, second, DEFENSE_LOCATIONS['2B']),
    '3B': slide(third, second, DEFENSE_LOCATIONS['3B']),
    SS: slide(third, second, DEFENSE_LOCATIONS.SS)
  }
}
/** The places on the full-width card. */
export const PICKER_LOCATIONS = pickerLocations(
  pickerFieldWidth(PLAN_PICKER_WIDTH),
  PICKER_FIELD_HEIGHT
)
/** The values that do not field, in the row under the field: Bench is blank. */
const OTHERS: ReadonlyArray<{ value: PlanCell; label: string }> = [
  { value: 'DH', label: 'DH' },
  { value: 'EH', label: 'EH' },
  { value: '', label: lstrings.plan_bench }
]

/**
 * Where a target is drawn on a card whose field is `fieldWidth` wide, inside
 * the card's border: a position at its place on the field, DH and EH at the
 * left of the row under it and Bench at its right.
 */
function targetRect(
  target: PlanCell,
  fieldWidth: number,
  locations: Record<Position, readonly [number, number]>
): PlanRect {
  if (target === '')
    return {
      x: PADDING + fieldWidth - BENCH_WIDTH,
      y: OTHERS_TOP,
      width: BENCH_WIDTH,
      height: OTHERS_HEIGHT
    }
  if (target === 'DH' || target === 'EH')
    return {
      x: PADDING + (target === 'DH' ? 0 : CHIP_WIDTH + GAP),
      y: OTHERS_TOP,
      width: CHIP_WIDTH,
      height: OTHERS_HEIGHT
    }
  const [x, y] = locations[target]
  return {
    x: PADDING + (fieldWidth * x) / 100 - CHIP_WIDTH / 2,
    y: FIELD_TOP + (PICKER_FIELD_HEIGHT * y) / 100 - CHIP_HEIGHT / 2,
    width: CHIP_WIDTH,
    height: CHIP_HEIGHT
  }
}

const pointOf = (event: GestureResponderEvent): PlanPoint => ({
  x: event.nativeEvent.pageX,
  y: event.nativeEvent.pageY
})

/**
 * The small field the plan assigns from: the nine positions over the Defense
 * tab's field, P on the mound and the infielders slid along their base
 * paths, with DH, EH and Bench in a row beneath. The cell's own value is
 * lit, and so is the target under a finger dragging onto it, which an
 * enlarged box, drawn above it, shows clear of the finger. A tap writes a
 * target; a hold on one shows its enlarged box (`onHold`), and letting go
 * writes it. The targets report where they are in the window, for a
 * phone's hold-and-drag, as they are laid out and whenever `measureRef`
 * asks.
 */
export function PlanFieldPicker({
  title,
  value,
  over,
  width = PLAN_PICKER_WIDTH,
  onPick,
  onClose,
  onHold,
  onHoldEnd,
  onTargets,
  measureRef
}: {
  title: string
  value: PlanCell
  over?: PlanCell | null
  width?: number
  onPick: (value: PlanCell) => void
  onClose: () => void
  /** A finger held on a target, where it is in the window. */
  onHold?: (target: PlanCell, point: PlanPoint) => void
  /** A held target let go of. */
  onHoldEnd?: () => void
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
  const fieldWidth = pickerFieldWidth(width)
  const locations = useMemo(
    () => pickerLocations(fieldWidth, PICKER_FIELD_HEIGHT),
    [fieldWidth]
  )
  const chip = (
    target: PlanCell,
    label: string,
    style: { width: number; height: number }
  ): React.ReactElement => {
    const lit = over === target
    const chosen = value === target
    const bench = target === ''
    return (
      <Pressable
        ref={view => {
          views.current.set(target, view)
        }}
        testID={`Plan pick ${bench ? 'bench' : target}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: chosen }}
        aria-selected={chosen}
        hitSlop={{ top: 2, bottom: 2, left: 4, right: 4 }}
        onLayout={measure}
        delayLongPress={PICKER_HOLD_MS}
        onPress={() => {
          onPick(target)
        }}
        onLongPress={event => {
          onHold?.(target, pointOf(event))
        }}
        onPressOut={() => {
          onHoldEnd?.()
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
  // The held or hovered target, half as large again, above it: only drawn,
  // so it never takes a touch from the targets it covers.
  const enlarged =
    over == null
      ? undefined
      : enlargedRect(targetRect(over, fieldWidth, locations), {
          x: 0,
          y: 0,
          width: width - 2 * BORDER,
          height: PLAN_PICKER_HEIGHT - 2 * BORDER
        })
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
        borderWidth: BORDER,
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
          <ButtonIcon name="close" size={1.25} color={surface.secondaryText} />
        </Pressable>
      </View>
      <View
        style={{
          width: fieldWidth,
          height: PICKER_FIELD_HEIGHT,
          borderRadius: 8,
          overflow: 'hidden',
          backgroundColor: surface.idle
        }}
      >
        <DefensiveFieldArt />
        {POSITIONS.map(position => {
          const [x, y] = locations[position]
          return (
            <View
              key={position}
              style={{
                position: 'absolute',
                left: (fieldWidth * x) / 100 - CHIP_WIDTH / 2,
                top: (PICKER_FIELD_HEIGHT * y) / 100 - CHIP_HEIGHT / 2
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
          gap: GAP
        }}
      >
        {OTHERS.map(({ value: target, label }) => (
          <React.Fragment key={label}>
            {target === '' && <View style={{ flex: 1 }} />}
            {chip(target, label, {
              width: target === '' ? BENCH_WIDTH : CHIP_WIDTH,
              height: OTHERS_HEIGHT
            })}
          </React.Fragment>
        ))}
      </View>
      {over != null && enlarged != null && (
        <View
          testID="Plan pick enlarged"
          style={{
            position: 'absolute',
            left: enlarged.x,
            top: enlarged.y,
            width: enlarged.width,
            height: enlarged.height,
            pointerEvents: 'none',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 9,
            borderWidth: 2,
            borderColor: surface.accent,
            backgroundColor: surface.active,
            shadowColor: '#000000',
            shadowOpacity: 0.45,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
            elevation: 10
          }}
        >
          <Text
            selectable={false}
            numberOfLines={1}
            style={{
              color: surface.activeText,
              fontFamily: theme.semiBoldTextFont,
              fontSize: 20
            }}
          >
            {over === '' ? lstrings.plan_bench : over}
          </Text>
        </View>
      )}
    </View>
  )
}
