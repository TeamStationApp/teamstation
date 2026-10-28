import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  type BoardPlacement,
  defaultNodeSettings,
  type NodeSettings
} from '../../common/nodeSettings'
import { Button, Card, ListCard, SectionHeader } from '../components'
import { CancelAction } from '../components/CancelAction'
import { CalendarPicker } from '../components/EventScheduleFields'
import { PickerDialog } from '../components/PickerDialog'
import { Wheel } from '../components/Wheel'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

const range = (from: number, to: number, step = 1): number[] =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) =>
    Math.round(from + i * step)
  )

/** A board's top or left, in whole percent of the video. */
const POSITIONS = range(0, 30)
/** A board's height, in percent of the video, in steps of five. */
const HEIGHTS = range(5, 100, 5)
/** How long a radar speed stays on the board, in seconds. */
const HOLDS = range(1, 20)
/** How long a replay holds each pitch, in whole seconds. */
const PITCH_DELAYS = range(1, 20)
/** A highlight's timing, in seconds. */
const SECONDS = range(0, 60)
/** On a play type's wheel, before 0: the default rewind length. */
const DEFAULT = -1
const PLAY_TYPE_SECONDS = [DEFAULT, ...SECONDS]

/** The play types the card offers a rewind length of their own. */
const PLAY_TYPES = [
  { type: 'strikeout', label: 'Strikeout' },
  { type: 'walk', label: 'Walk' }
] as const

/**
 * The option nearest `value`, a stored value the wheel has no stop for; the
 * higher of two as near, so 0.5% shows as 1%.
 */
function nearest(options: readonly number[], value: number): number {
  return options.reduce((best, option) =>
    Math.abs(option - value) <= Math.abs(best - value) ? option : best
  )
}

const percent = (option: number): string => `${option}%`
const seconds = (option: number): string =>
  option === DEFAULT ? 'Default' : `${option} s`

/** A placement as the wheels show it: each value at its nearest stop. */
function shownPlacement(placement: BoardPlacement): BoardPlacement {
  return {
    x: nearest(POSITIONS, placement.x * 100) / 100,
    y: nearest(POSITIONS, placement.y * 100) / 100,
    height: nearest(HEIGHTS, placement.height * 100) / 100
  }
}

/**
 * The settings as the card shows them, which is what Save stores: every
 * value at its nearest stop on its wheel, so a stored 0.5% shows, and saves,
 * as 1%.
 */
export function shownSettings(settings: NodeSettings): NodeSettings {
  const { scoreboard: s, highlights: h } = settings
  return {
    radar: { ...settings.radar },
    replay: { pitchSec: nearest(PITCH_DELAYS, settings.replay.pitchSec) },
    scoreboard: {
      ...s,
      single: shownPlacement(s.single),
      landscape: shownPlacement(s.landscape),
      portraitHeight: nearest(HEIGHTS, s.portraitHeight * 100) / 100,
      speedHoldSec: nearest(HOLDS, s.speedHoldSec)
    },
    highlights: {
      ...h,
      lagSec: nearest(SECONDS, h.lagSec),
      leadSec: nearest(SECONDS, h.leadSec),
      // Only the play types the card has a row for; any other a node holds
      // is not shown here, and Save keeps it exactly as stored.
      leadSecByEventType: Object.fromEntries(
        Object.entries(h.leadSecByEventType).map(([type, sec]) => [
          type,
          PLAY_TYPES.some(shown => shown.type === type)
            ? nearest(SECONDS, sec)
            : sec
        ])
      )
    }
  }
}

type Picker =
  | {
      kind: 'wheel'
      title: string
      label: string
      options: number[]
      format: (option: number) => string
      value: number
      choose: (option: number) => NodeSettings
    }
  | { kind: 'date' }

/**
 * The node's settings on the node administration screen, in two cards: the
 * scoreboard's (where it sits over each kind of player, from which UTC date
 * games show it, how long a radar speed stays up) and the highlights'
 * timings. Every value is a row with its value at the right in the tappable
 * colour; a tap opens a wheel, or a calendar for the date. One Save below
 * both cards stores them all, and Reset to defaults puts the node's defaults
 * back, to be saved.
 */
export function NodeSettingsCard({
  client,
  onSettled
}: {
  client: TeamStationClient
  /**
   * Told once the first read has come back, with the settings or with its
   * failure, so a screen can hold what sits below the card until then rather
   * than have the card's rows push it down when they arrive.
   */
  onSettled?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [settings, setSettings] = useState<NodeSettings>()
  const [picker, setPicker] = useState<Picker>()
  const [problem, setProblem] = useState<string>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const load = useCallback(async (): Promise<void> => {
    try {
      setSettings(shownSettings(await client.nodeSettings()))
      setProblem(undefined)
      setLoadFailed(false)
    } catch (error) {
      setLoadFailed(true)
      setProblem(
        error instanceof Error
          ? error.message
          : 'The node settings could not load. Retry.'
      )
    }
  }, [client])
  useEffect(() => {
    load().catch(() => undefined)
  }, [load])
  const settled = settings != null || loadFailed
  useEffect(() => {
    if (settled) onSettled?.()
  }, [settled, onSettled])

  if (settings == null) {
    return !loadFailed ? (
      <View style={styles.section}>
        <SectionHeader title="Scoreboard settings" />
        <Text style={styles.hint}>Loading the node's settings…</Text>
      </View>
    ) : (
      <Card style={styles.card}>
        <Text style={styles.name}>Scoreboard settings</Text>
        <Text accessibilityRole="alert" style={styles.error}>
          {problem}
        </Text>
        <View style={styles.buttons}>
          <Button
            label="Retry"
            kind="secondary"
            onPress={() => {
              load().catch(() => undefined)
            }}
          />
        </View>
      </Card>
    )
  }

  const change = (next: NodeSettings): void => {
    setSettings(next)
    setSaved(false)
    setProblem(undefined)
  }
  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    try {
      setSettings(shownSettings(await client.setNodeSettings(settings)))
      setSaved(true)
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'The node settings could not be saved. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }

  const { scoreboard, highlights, radar } = settings
  // The account screen's settings row: the whole row is the target, its
  // value at the right in the colour that says it can be tapped.
  const row = (
    label: string,
    value: string,
    open: () => void,
    /** What a screen reader calls the value: the label and its section. */
    name = label
  ): React.ReactElement => (
    <Pressable
      key={name}
      accessibilityRole="button"
      accessibilityLabel={`${name}: ${value}`}
      // A save in flight would put back what it sent over a newer choice.
      disabled={busy}
      accessibilityState={{ disabled: busy }}
      onPress={open}
      style={({ pressed }) => [
        styles.settingRow,
        styles.paddedRow,
        pressed && styles.pressed
      ]}
    >
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.settingValue}>{value}</Text>
    </Pressable>
  )
  const wheelRow = (
    label: string,
    title: string,
    options: number[],
    format: (option: number) => string,
    value: number,
    choose: (option: number) => NodeSettings
  ): React.ReactElement =>
    row(
      label,
      format(value),
      () => {
        setPicker({
          kind: 'wheel',
          title,
          label,
          options,
          format,
          value,
          choose
        })
      },
      title
    )
  const placementRows = (
    name: string,
    key: 'single' | 'landscape'
  ): React.ReactElement => {
    const placement = scoreboard[key]
    const set = (part: Partial<BoardPlacement>): NodeSettings => ({
      ...settings,
      scoreboard: { ...scoreboard, [key]: { ...placement, ...part } }
    })
    return (
      <View key={key} style={styles.group}>
        <Text style={styles.groupTitle}>{name}</Text>
        <ListCard>
          {wheelRow(
            'Top',
            `${name}: top`,
            POSITIONS,
            percent,
            Math.round(placement.y * 100),
            option => set({ y: option / 100 })
          )}
          {wheelRow(
            'Left',
            `${name}: left`,
            POSITIONS,
            percent,
            Math.round(placement.x * 100),
            option => set({ x: option / 100 })
          )}
          {wheelRow(
            'Height',
            `${name}: height`,
            HEIGHTS,
            percent,
            Math.round(placement.height * 100),
            option => set({ height: option / 100 })
          )}
        </ListCard>
      </View>
    )
  }
  const setHighlights = (
    part: Partial<NodeSettings['highlights']>
  ): NodeSettings => ({ ...settings, highlights: { ...highlights, ...part } })
  const playTypeRows = PLAY_TYPES.map(({ type, label }) =>
    wheelRow(
      label,
      `Rewind length: ${label.toLowerCase()}`,
      PLAY_TYPE_SECONDS,
      seconds,
      highlights.leadSecByEventType[type] ?? DEFAULT,
      option => {
        // Every other play type stored is kept as it is.
        const rest = Object.fromEntries(
          Object.entries(highlights.leadSecByEventType).filter(
            ([other]) => other !== type
          )
        )
        return setHighlights({
          leadSecByEventType:
            option === DEFAULT ? rest : { ...rest, [type]: option }
        })
      }
    )
  )

  return (
    <>
      <View style={styles.section}>
        <SectionHeader title="Scoreboard settings" />
        <Text style={styles.hint}>
          Where the scoreboard sits over video: top, left and height are
          percentages of the video, from its top-left corner. The height is the
          full board&apos;s; its width follows the team names. It shows for
          games starting on or after the date, in UTC.
        </Text>
        <ListCard>
          {row('Show for games from', scoreboard.overlayStartDate, () => {
            setPicker({ kind: 'date' })
          })}
        </ListCard>
        {placementRows('Single camera', 'single')}
        {placementRows('Four-angle landscape', 'landscape')}
        <View style={styles.group}>
          <Text style={styles.groupTitle}>Four-angle portrait</Text>
          <ListCard>
            {wheelRow(
              'Height',
              'Four-angle portrait: height',
              HEIGHTS,
              percent,
              Math.round(scoreboard.portraitHeight * 100),
              option => ({
                ...settings,
                scoreboard: { ...scoreboard, portraitHeight: option / 100 }
              })
            )}
          </ListCard>
        </View>
        <ListCard>
          {wheelRow(
            'Pitch speed display (seconds)',
            'Pitch speed display',
            HOLDS,
            String,
            scoreboard.speedHoldSec,
            option => ({
              ...settings,
              scoreboard: { ...scoreboard, speedHoldSec: option }
            })
          )}
        </ListCard>
      </View>
      <View style={styles.section}>
        <SectionHeader title="Radar matching" />
        <Text style={styles.hint}>
          Match recorded speeds to the scorekeeper’s pitch entry.
        </Text>
        <ListCard>
          {wheelRow(
            'Pitch window (before and after)',
            'Radar pitch window',
            range(1, 60),
            seconds,
            radar.pitchWindowSec,
            option => ({
              ...settings,
              radar: { ...radar, pitchWindowSec: option }
            })
          )}
          {wheelRow(
            'In-play lookback',
            'Radar in-play window',
            range(1, 60),
            seconds,
            radar.inPlayWindowSec,
            option => ({
              ...settings,
              radar: { ...radar, inPlayWindowSec: option }
            })
          )}
        </ListCard>
      </View>
      <View style={styles.section}>
        <SectionHeader title="Replay" />
        <Text style={styles.hint}>
          How long the 3D replay holds each pitch before the next.
        </Text>
        <ListCard>
          {wheelRow(
            'Pitch delay (seconds)',
            'Replay pitch delay',
            PITCH_DELAYS,
            String,
            settings.replay.pitchSec,
            option => ({ ...settings, replay: { pitchSec: option } })
          )}
        </ListCard>
      </View>
      <View style={styles.section}>
        <SectionHeader title="Highlights" />
        <Text style={styles.hint}>
          Where each highlight starts in the video, in seconds.
        </Text>
        <ListCard>
          {wheelRow(
            "Scorekeeper's tap lag",
            "Scorekeeper's tap lag",
            SECONDS,
            seconds,
            highlights.lagSec,
            option => setHighlights({ lagSec: option })
          )}
        </ListCard>
        <View style={styles.group}>
          <Text style={styles.groupTitle}>Rewind length</Text>
          <ListCard>
            {wheelRow(
              'Default',
              'Rewind length: default',
              SECONDS,
              seconds,
              highlights.leadSec,
              option => setHighlights({ leadSec: option })
            )}
            {playTypeRows}
          </ListCard>
        </View>
      </View>
      {problem != null && (
        <Text accessibilityRole="alert" style={styles.error}>
          {problem}
        </Text>
      )}
      {saved && <Text style={styles.hint}>Saved.</Text>}
      <Button
        label="Save"
        busy={busy}
        onPress={() => {
          save().catch(() => undefined)
        }}
      />
      <Button
        label="Reset to defaults"
        kind="text"
        textColor={theme.linkTextColor}
        disabled={busy}
        onPress={() => {
          change(shownSettings(defaultNodeSettings))
        }}
      />
      {picker != null && (
        <PickerDialog
          maxWidthRem={24}
          onClose={() => {
            setPicker(undefined)
          }}
        >
          {picker.kind === 'date' ? (
            <CalendarPicker
              value={scoreboard.overlayStartDate}
              onChoose={date => {
                change({
                  ...settings,
                  scoreboard: { ...scoreboard, overlayStartDate: date }
                })
                setPicker(undefined)
              }}
              onCancel={() => {
                setPicker(undefined)
              }}
            />
          ) : (
            <WheelPicker
              picker={picker}
              onChoose={option => {
                change(picker.choose(option))
                setPicker(undefined)
              }}
              onCancel={() => {
                setPicker(undefined)
              }}
            />
          )}
        </PickerDialog>
      )}
    </>
  )
}

/** One setting's wheel, its value held until Use. */
function WheelPicker({
  picker,
  onChoose,
  onCancel
}: {
  picker: Extract<Picker, { kind: 'wheel' }>
  onChoose: (option: number) => void
  onCancel: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [value, setValue] = useState(picker.value)
  return (
    <View style={styles.picker}>
      <Text accessibilityRole="header" style={styles.name}>
        {picker.title}
      </Text>
      <Wheel
        label={picker.label}
        options={picker.options}
        value={value}
        onChange={setValue}
        format={picker.format}
        testID="node-setting-wheel"
        width={112}
      />
      <Button
        label="Use"
        onPress={() => {
          onChoose(value)
        }}
      />
      <CancelAction onPress={onCancel} />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: { gap: theme.rem(0.5) },
  name: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(1.125),
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.3)
  },
  section: { gap: theme.rem(theme.spaceSmRem) },
  group: { gap: theme.rem(0.375), marginTop: theme.rem(0.25) },
  groupTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600' as const,
    color: theme.secondaryTextColor
  },
  // As `AccountScreen`'s settings rows.
  settingRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(theme.spaceMdRem)
  },
  paddedRow: { padding: theme.rem(theme.cardContentInsetRem) },
  pressed: { opacity: 0.6 },
  settingLabel: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600' as const,
    color: theme.primaryTextColor
  },
  settingValue: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600' as const,
    color: theme.linkTextColor
  },
  error: { color: theme.dangerColor, fontSize: theme.rem(0.875) },
  buttons: { flexDirection: 'row' as const, gap: theme.rem(0.5) },
  picker: { gap: theme.rem(0.75), alignItems: 'stretch' as const }
}))
