import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  formatDateRange,
  presetFrame,
  presetOf,
  type SeasonName
} from '../../common/seasonTimeFrames'
import { Button, ListCard, ListRow, Screen } from '../components'
import { DateRangePicker } from '../components/DateRangePicker'
import { PickerDialog } from '../components/PickerDialog'
import { PillButton } from '../components/PillTabs'
import { useTitleHandoff } from '../components/useTitleHandoff'
import { Wheel } from '../components/Wheel'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** How far either side of the years in play the year wheel reaches. */
export const YEAR_REACH = 50

/**
 * The years the year wheel offers: `YEAR_REACH` either side of the years in
 * play (the one on the pill, this one), inside the calendar's own year
 * field's bounds, 1900 to 9999. A window, so the wheel mounts a hundred-odd
 * rows rather than eight thousand.
 */
export function timeFrameYears(...years: number[]): number[] {
  const first = Math.max(1900, Math.min(...years) - YEAR_REACH)
  const last = Math.min(9999, Math.max(...years) + YEAR_REACH)
  return Array.from({ length: last - first + 1 }, (unused, i) => first + i)
}

interface Range {
  startsOn: string
  endsOn: string
}

/**
 * A season's date range, from its settings' Time frame row: a year over a two
 * by two of seasons, or Custom dates. Save writes the range and goes back.
 */
export function SeasonTimeFrameScreen({
  client,
  id,
  onSaved,
  now = () => new Date()
}: {
  client: TeamStationClient
  id: string
  onSaved: () => void
  /** The clock the year opens on when the stored dates are no one season. */
  now?: () => Date
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const handoff = useTitleHandoff('Set date range')
  const [year, setYear] = useState(() => now().getFullYear())
  const [season, setSeason] = useState<SeasonName | null>(null)
  const [draft, setDraft] = useState<Range | null>(null)
  const [wheelYear, setWheelYear] = useState<number | null>(null)
  const [custom, setCustom] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** The person chose something: the stored range, arriving late, is not put back. */
  const touched = useRef(false)
  useEffect(() => {
    let live = true
    client.group({ kind: 'season', id }).then(
      detail => {
        if (!live) return
        const { startsOn, endsOn } = detail.group
        if (startsOn == null || endsOn == null || touched.current) return
        setDraft({ startsOn, endsOn })
        const preset = presetOf(startsOn, endsOn)
        if (preset != null) {
          setYear(preset.year)
          setSeason(preset.season)
        }
      },
      (caught: unknown) => {
        if (live)
          setError(
            caught instanceof Error
              ? caught.message
              : 'The season did not load.'
          )
      }
    )
    return () => {
      live = false
    }
  }, [client, id])
  const choose = (name: SeasonName): void => {
    touched.current = true
    setSeason(name)
    setDraft(presetFrame(year, name))
  }
  /** A season pill's pressed state, selection and accessible name. */
  const seasonProps = (
    name: SeasonName
  ): Pick<
    React.ComponentProps<typeof PillButton>,
    'accessibilityLabel' | 'selected' | 'onPress' | 'role'
  > => ({
    // A tab: the one season chosen reads as selected.
    role: 'tab',
    accessibilityLabel: `${name} ${year}`,
    selected: season === name,
    onPress: () => {
      choose(name)
    }
  })
  const save = async (): Promise<void> => {
    if (draft == null || saving) return
    setSaving(true)
    setError('')
    try {
      await client.updateGroup({ kind: 'season', id }, draft)
      onSaved()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The dates were not saved.'
      )
      setSaving(false)
    }
  }
  return (
    <Screen onScroll={handoff.handleScroll}>
      <View style={styles.page}>
        <View ref={handoff.ref} collapsable={false}>
          <Text style={styles.title} accessibilityRole="header">
            Set date range
          </Text>
        </View>
        <View testID="time-frame-presets" style={styles.presets}>
          <View style={styles.year}>
            <PillButton
              label={String(year)}
              accessibilityLabel={`Year ${year}`}
              selected={false}
              onPress={() => {
                setWheelYear(year)
              }}
            />
          </View>
          {/* Two by two: Winter and Spring, then Summer and Fall. */}
          <View style={styles.row}>
            <View style={styles.cell}>
              <PillButton label="Winter" {...seasonProps('Winter')} />
            </View>
            <View style={styles.cell}>
              <PillButton label="Spring" {...seasonProps('Spring')} />
            </View>
          </View>
          <View style={styles.row}>
            <View style={styles.cell}>
              <PillButton label="Summer" {...seasonProps('Summer')} />
            </View>
            <View style={styles.cell}>
              <PillButton label="Fall" {...seasonProps('Fall')} />
            </View>
          </View>
        </View>
        <ListCard>
          <ListRow
            title="Custom"
            subtitle={
              draft != null && season == null
                ? formatDateRange(draft.startsOn, draft.endsOn)
                : undefined
            }
            onPress={() => {
              setCustom(open => !open)
            }}
          />
          {custom && (
            <DateRangePicker
              // It reads `initial` when it mounts: a season or a year chosen
              // while it is open shows there too.
              key={draft == null ? 'none' : `${draft.startsOn}:${draft.endsOn}`}
              initial={draft ?? undefined}
              onChoose={range => {
                touched.current = true
                setDraft(range)
                const preset = presetOf(range.startsOn, range.endsOn)
                setSeason(preset?.year === year ? preset.season : null)
              }}
              onCancel={() => {
                setCustom(false)
              }}
            />
          )}
        </ListCard>
        <Text style={styles.hint}>
          Editing this reference time frame does not move scheduled games.
        </Text>
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Button
          label="Save"
          busy={saving}
          disabled={draft == null}
          onPress={() => {
            save().catch(() => undefined)
          }}
        />
      </View>
      {wheelYear != null && (
        <PickerDialog
          onClose={() => {
            setWheelYear(null)
          }}
        >
          <View style={styles.wheel}>
            <Wheel
              label="Year"
              testID="time-frame-year"
              options={timeFrameYears(year, now().getFullYear())}
              value={wheelYear}
              onChange={setWheelYear}
            />
          </View>
          <Button
            label="Done"
            onPress={() => {
              touched.current = true
              setYear(wheelYear)
              if (season != null) setDraft(presetFrame(wheelYear, season))
              setWheelYear(null)
            }}
          />
        </PickerDialog>
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // The screen's own padding is the page's, as on season settings, so the
  // date picker under Custom has the full width for its seven columns.
  page: {
    gap: theme.rem(1)
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5)
  },
  presets: {
    gap: theme.rem(0.25)
  },
  // The year sits centred over the gap between the top two pills.
  year: {
    alignItems: 'center' as const
  },
  row: {
    flexDirection: 'row' as const,
    gap: theme.rem(0.75)
  },
  cell: {
    flex: 1
  },
  wheel: {
    alignItems: 'center' as const,
    marginBottom: theme.rem(1)
  },
  hint: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont
  }
}))
