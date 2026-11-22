import React, { useState } from 'react'
import { Platform, Text, View } from 'react-native'

import {
  UMPIRE_SORT_KEYS,
  umpireSortField,
  umpireSortGlyph,
  type UmpireSortKey
} from '../../common/umpireSort'
import { Button } from '../components/Button'
import { ButtonIcon } from '../components/ButtonIcon'
import { CancelAction } from '../components/CancelAction'
import { HeaderMenu } from '../components/HeaderMenu'
import { PillButton, PillFace, usePillLabelColor } from '../components/PillTabs'
import { Sheet } from '../components/Sheet'
import { SortIcon } from '../components/SortIcon'
import { Wheel } from '../components/Wheel'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** A compact pill is 36 tall: the target reaches the rest of 48 past it. */
const PILL_SLOP = 6

/** A key's field, as its button reads. */
export function umpireSortFieldName(key: UmpireSortKey): string {
  const field = umpireSortField(key)
  return field === 'date'
    ? lstrings.umpire_sort_date
    : field === 'season'
      ? lstrings.umpire_sort_season
      : lstrings.umpire_sort_certification
}
/** Which way a key runs, in words. */
export function umpireSortOrderName(key: UmpireSortKey): string {
  switch (key) {
    case 'date':
      return lstrings.umpire_sort_oldest
    case '-date':
      return lstrings.umpire_sort_newest
    case 'season':
    case 'certification':
      return lstrings.umpire_sort_a_z
    case '-season':
    case '-certification':
      return lstrings.umpire_sort_z_a
    case 'seasonPriority':
      return lstrings.umpire_sort_league_first
    case '-seasonPriority':
      return lstrings.umpire_sort_league_last
  }
}
/**
 * A wheel row: "Date · oldest to newest". It is short enough to fit a 320
 * point phone, so it leaves out the glyph pair the button shows and words
 * league order briefly; each direction still differs from the other in words.
 */
export function umpireSortWheelLabel(key: UmpireSortKey): string {
  const order =
    key === 'seasonPriority'
      ? lstrings.umpire_sort_wheel_league_first
      : key === '-seasonPriority'
        ? lstrings.umpire_sort_wheel_league_last
        : umpireSortOrderName(key)
  return `${umpireSortFieldName(key)} · ${order}`
}
/** The keys a slot may choose: every one but those of the other slot's field. */
export function umpireSortChoices(other?: UmpireSortKey): UmpireSortKey[] {
  return UMPIRE_SORT_KEYS.filter(
    key => other == null || umpireSortField(key) !== umpireSortField(other)
  )
}
/** The sort after choosing `key` in a slot: the first replaces, the second replaces or adds. */
export function chooseUmpireSort(
  sort: readonly UmpireSortKey[],
  slot: 0 | 1,
  key: UmpireSortKey
): UmpireSortKey[] {
  return slot === 0 ? [key, ...sort.slice(1)] : [sort[0], key]
}
/** The sort after removing a slot's key: removing the first promotes the second. */
export function removeUmpireSort(
  sort: readonly UmpireSortKey[],
  slot: 0 | 1
): UmpireSortKey[] {
  return slot === 0 ? sort.slice(1) : sort.slice(0, 1)
}

/**
 * The umpire schedule's sort buttons, for the filter row: the first sort (⇅
 * Sort with none), then the second, or + Sort when only one is chosen. Each
 * opens its slot's picker: a dropdown on the web and a sheet with a wheel in
 * the app.
 */
export function UmpireSortControls({
  sort,
  onChange,
  os = Platform.OS
}: {
  sort: readonly UmpireSortKey[]
  onChange: (next: UmpireSortKey[]) => void
  /** Which picker to draw; the platform's own by default. */
  os?: typeof Platform.OS
}): React.ReactElement {
  const color = usePillLabelColor(false)
  const [first, second] = sort
  return (
    <>
      <UmpireSortPicker
        os={os}
        slot={0}
        chosen={first}
        other={second}
        testID="umpire-sort-1"
        label={
          first == null ? lstrings.umpire_sort : umpireSortFieldName(first)
        }
        accessibilityLabel={
          first == null
            ? lstrings.umpire_sort
            : sprintf(
                lstrings.umpire_sort_by_named,
                umpireSortFieldName(first),
                umpireSortOrderName(first)
              )
        }
        icon={
          <SortIcon
            glyph={first == null ? 'none' : umpireSortGlyph(first)}
            color={color}
          />
        }
        onChoose={key => {
          onChange(chooseUmpireSort(sort, 0, key))
        }}
        onRemove={() => {
          onChange(removeUmpireSort(sort, 0))
        }}
      />
      {first != null && (
        <UmpireSortPicker
          os={os}
          slot={1}
          chosen={second}
          other={first}
          testID={second == null ? 'umpire-sort-add' : 'umpire-sort-2'}
          label={
            second == null ? lstrings.umpire_sort : umpireSortFieldName(second)
          }
          accessibilityLabel={
            second == null
              ? lstrings.umpire_sort_add_named
              : sprintf(
                  lstrings.umpire_sort_then_named,
                  umpireSortFieldName(second),
                  umpireSortOrderName(second)
                )
          }
          icon={
            second == null ? (
              <ButtonIcon name="add" size={1} color={color} />
            ) : (
              <SortIcon glyph={umpireSortGlyph(second)} color={color} />
            )
          }
          onChoose={key => {
            onChange(chooseUmpireSort(sort, 1, key))
          }}
          onRemove={() => {
            onChange(removeUmpireSort(sort, 1))
          }}
        />
      )}
    </>
  )
}

/**
 * One slot's button and its picker. The options are every key but those of
 * the other slot's field, the chosen one marked; a chosen slot adds Remove
 * sort.
 */
export function UmpireSortPicker({
  os,
  slot,
  chosen,
  other,
  label,
  accessibilityLabel,
  icon,
  testID,
  onChoose,
  onRemove
}: {
  os: typeof Platform.OS
  slot: 0 | 1
  chosen?: UmpireSortKey
  other?: UmpireSortKey
  label: string
  accessibilityLabel: string
  icon: React.ReactNode
  testID: string
  onChoose: (key: UmpireSortKey) => void
  onRemove: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const color = usePillLabelColor(false)
  const choices = umpireSortChoices(other)
  const [wheel, setWheel] = useState<number>()
  if (os === 'web')
    return (
      <HeaderMenu
        label={accessibilityLabel}
        align="left"
        testID={testID}
        style={({ pressed }) => [pressed && styles.pressed]}
        items={[
          ...choices.map(key => ({
            label: `${umpireSortFieldName(key)}, ${umpireSortOrderName(key)}`,
            icon: <SortIcon glyph={umpireSortGlyph(key)} color={color} />,
            selected: key === chosen,
            onPress: () => {
              if (key !== chosen) onChoose(key)
            }
          })),
          ...(chosen == null
            ? []
            : [
                {
                  label: lstrings.umpire_sort_remove,
                  icon: (
                    <ButtonIcon
                      name="close"
                      size={1}
                      color={theme.dangerColor}
                    />
                  ),
                  destructive: true,
                  onPress: onRemove
                }
              ])
        ]}
      >
        <PillFace label={label} selected={false} icon={icon} />
      </HeaderMenu>
    )
  const close = (): void => {
    setWheel(undefined)
  }
  return (
    <>
      <PillButton
        label={label}
        accessibilityLabel={accessibilityLabel}
        selected={false}
        icon={icon}
        testID={testID}
        hitSlop={PILL_SLOP}
        onPress={() => {
          setWheel(Math.max(0, chosen == null ? 0 : choices.indexOf(chosen)))
        }}
      />
      {wheel != null && (
        <Sheet
          onClose={close}
          closeLabel={lstrings.header_menu_close}
          style={styles.sheet}
          testID="umpire-sort-sheet"
        >
          <Text accessibilityRole="header" style={styles.title}>
            {slot === 0
              ? lstrings.umpire_sort_title_first
              : lstrings.umpire_sort_title_second}
          </Text>
          <View style={styles.wheel}>
            <Wheel
              label={
                slot === 0
                  ? lstrings.umpire_sort_title_first
                  : lstrings.umpire_sort_title_second
              }
              labelHidden
              options={choices.map((_, index) => index)}
              value={wheel}
              onChange={setWheel}
              format={index => umpireSortWheelLabel(choices[index])}
              testID="umpire-sort-wheel"
              width={theme.rem(20)}
            />
          </View>
          <Button
            label={lstrings.umpire_sort_done}
            testID="umpire-sort-done"
            onPress={() => {
              const key = choices[wheel]
              close()
              if (key !== chosen) onChoose(key)
            }}
          />
          {chosen != null && (
            <Button
              kind="text"
              label={lstrings.umpire_sort_remove}
              textColor={theme.dangerColor}
              testID="umpire-sort-remove"
              style={styles.centered}
              onPress={() => {
                close()
                onRemove()
              }}
            />
          )}
          {/* Done above is not destructive, so Cancel keeps its red. */}
          <CancelAction testID="umpire-sort-cancel" onPress={close} />
        </Sheet>
      )}
    </>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  pressed: { opacity: 0.85 },
  sheet: {
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  wheel: { flexDirection: 'row', justifyContent: 'center' },
  centered: { alignSelf: 'center' }
}))
