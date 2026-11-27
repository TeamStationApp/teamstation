import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  asDistributionUrl,
  type BoardPlacement,
  defaultDistributionSettings,
  defaultJevSettings,
  defaultNodeSettings,
  defaultSponsorSettings,
  type DistributionSettings,
  LOGO_PLACEMENTS,
  type LogoPlacement,
  type NodeSettings,
  REEL_LAYOUTS,
  type ReelLayout,
  type ReelPlacement,
  sampleUploadedOn,
  type SponsorSettings
} from '../../common/nodeSettings'
import { sampleSizeProblem } from '../../common/sponsors/limits'
import { Button, Card, ListCard, SectionHeader, TextField } from '../components'
import { CancelAction } from '../components/CancelAction'
import { CalendarPicker } from '../components/EventScheduleFields'
import { PickerDialog } from '../components/PickerDialog'
import { Wheel } from '../components/Wheel'
import { SponsorSampleUpload } from '../sponsors/SponsorSampleUpload'
import type { PickedSample } from '../sponsors/sponsorSampleUploadProps'
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

/**
 * A reel's largest width or height, as a fraction of the screen: the
 * heights' stops and the default's exact third, so a stored 1/3 shows, and
 * saves, as itself.
 */
export const REEL_SIZES = [...HEIGHTS.map(height => height / 100), 1 / 3].sort(
  (a, b) => a - b
)

const percent = (option: number): string => `${option}%`
const reelSize = (option: number): string =>
  option === 1 / 3 ? '33⅓%' : `${Math.round(option * 100)}%`

/** The logo groups, as the card names them. */
const LOGO_NAMES: Record<(typeof LOGO_PLACEMENTS)[number], string> = {
  single: 'Logo — single camera',
  grid: 'Logo — four-angle grid',
  tv: 'Logo — Apple TV',
  portrait: 'Logo — portrait'
}

/** The reel groups, as the card names them. */
const REEL_NAMES: Record<ReelLayout, string> = {
  portrait12: 'Reel — portrait, 1 or 2 cameras',
  portrait3: 'Reel — portrait, 3 cameras',
  portrait4: 'Reel — portrait, 4 cameras',
  landscape1: 'Reel — landscape, 1 camera',
  landscape2: 'Reel — landscape, 2 cameras',
  landscape3: 'Reel — landscape, 3 cameras',
  landscape4: 'Reel — landscape, 4 cameras'
}

/** `2026-11-25` as "Nov 25, 2026", read as the UTC day it names. */
function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

/** The sponsor settings as the wheels show them: each at its nearest stop. */
function shownSponsors(sponsors: SponsorSettings): SponsorSettings {
  const logo = (placement: LogoPlacement): LogoPlacement => ({
    side: nearest(POSITIONS, placement.side * 100) / 100,
    top: nearest(POSITIONS, placement.top * 100) / 100,
    maxWidth: nearest(HEIGHTS, placement.maxWidth * 100) / 100,
    maxHeight: nearest(HEIGHTS, placement.maxHeight * 100) / 100
  })
  const reel = (placement: ReelPlacement): ReelPlacement => ({
    maxWidth: nearest(REEL_SIZES, placement.maxWidth),
    maxHeight: nearest(REEL_SIZES, placement.maxHeight)
  })
  return {
    logo: Object.fromEntries(
      LOGO_PLACEMENTS.map(name => [name, logo(sponsors.logo[name])])
    ) as SponsorSettings['logo'],
    reel: Object.fromEntries(
      REEL_LAYOUTS.map(layout => [layout, reel(sponsors.reel[layout])])
    ) as SponsorSettings['reel'],
    sampleKey: sponsors.sampleKey
  }
}
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
      tvLandscape: shownPlacement(
        s.tvLandscape ?? defaultNodeSettings.scoreboard.tvLandscape!
      ),
      portraitHeight: nearest(HEIGHTS, s.portraitHeight * 100) / 100,
      speedHoldSec: nearest(HOLDS, s.speedHoldSec)
    },
    distribution: { ...defaultDistributionSettings, ...settings.distribution },
    jev: settings.jev ?? defaultJevSettings,
    sponsors: shownSponsors(settings.sponsors ?? defaultSponsorSettings),
    highlights: {
      ...h,
      lagSec: nearest(SECONDS, h.lagSec),
      leadSec: nearest(SECONDS, h.leadSec),
      tailSec: nearest(SECONDS, h.tailSec),
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
  | {
      kind: 'url'
      key: keyof DistributionSettings
      title: string
      value: string
      choose: (value: string) => NodeSettings
    }

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
  const [jevInput, setJevInput] = useState('')
  const [jevBusy, setJevBusy] = useState(false)
  const [jevProblem, setJevProblem] = useState<string>()
  const [sampleBusy, setSampleBusy] = useState(false)
  const [sampleProblem, setSampleProblem] = useState<string>()
  // Reset to defaults was pressed: the next Save puts the default clip back.
  const [sampleReset, setSampleReset] = useState(false)
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
      // The sample is the upload's: a save sends none, so a card read before
      // somebody else's upload keeps it, but for Reset's default clip.
      const { sampleKey: _shown, ...overlay } = settings.sponsors
      const stored = await client.setNodeSettings({
        ...settings,
        sponsors: sampleReset ? { ...overlay, sampleKey: null } : overlay
      })
      setSettings(shownSettings(stored))
      setSampleReset(false)
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

  /**
   * Set, replace or remove the Jev key, apart from Save: the key is never
   * read back, so the card keeps only whether one is set.
   */
  const changeJevKey = async (apiKey: string | null): Promise<void> => {
    if (jevBusy) return
    setJevBusy(true)
    setJevProblem(undefined)
    try {
      if (apiKey == null) await client.clearJevKey()
      else await client.setJevKey(apiKey)
      setJevInput('')
      setSettings(current =>
        current == null
          ? current
          : { ...current, jev: { configured: apiKey != null } }
      )
    } catch (error) {
      setJevProblem(
        error instanceof Error
          ? error.message
          : 'The Jev key could not be changed. Retry.'
      )
    } finally {
      setJevBusy(false)
    }
  }
  const jevConfigured = settings.jev.configured
  const jevTyped = jevInput.trim()

  /**
   * Upload a sample video, apart from Save: once the server has checked and
   * stored it, it is the node's, and the card shows its day.
   */
  const uploadSample = async (picked: PickedSample): Promise<void> => {
    if (sampleBusy) return
    // The server refuses one past the cap without reading it; this says so
    // before sending it.
    const tooLarge = sampleSizeProblem(picked.size)
    if (tooLarge != null) {
      setSampleProblem(tooLarge)
      return
    }
    setSampleBusy(true)
    setSampleProblem(undefined)
    try {
      const stored = await client.uploadSponsorSample(
        picked.contentType,
        await picked.bytes()
      )
      setSampleReset(false)
      setSettings(current =>
        current == null
          ? current
          : {
              ...current,
              sponsors: { ...current.sponsors, sampleKey: stored.sampleKey }
            }
      )
    } catch (error) {
      setSampleProblem(
        error instanceof Error
          ? error.message
          : 'The sample video could not be uploaded. Retry.'
      )
    } finally {
      setSampleBusy(false)
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
  const links = settings.distribution ?? defaultDistributionSettings
  const urlRow = (
    label: string,
    key: keyof DistributionSettings
  ): React.ReactElement =>
    row(label, links[key] === '' ? 'Not set' : links[key], () => {
      setPicker({
        kind: 'url',
        key,
        title: label,
        value: links[key],
        choose: value => ({
          ...settings,
          distribution: { ...links, [key]: value }
        })
      })
    })
  const placementRows = (
    name: string,
    key: 'single' | 'landscape' | 'tvLandscape'
  ): React.ReactElement => {
    const placement =
      scoreboard[key] ?? defaultNodeSettings.scoreboard.tvLandscape!
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
  const sponsors = settings.sponsors
  const logoRows = (
    name: (typeof LOGO_PLACEMENTS)[number]
  ): React.ReactElement => {
    const title = LOGO_NAMES[name]
    const placement = sponsors.logo[name]
    const set = (part: Partial<LogoPlacement>): NodeSettings => ({
      ...settings,
      sponsors: {
        ...sponsors,
        logo: { ...sponsors.logo, [name]: { ...placement, ...part } }
      }
    })
    return (
      <View key={name} style={styles.group}>
        <Text style={styles.groupTitle}>{title}</Text>
        <ListCard>
          {wheelRow(
            'Side margin',
            `${title}: side margin`,
            POSITIONS,
            percent,
            Math.round(placement.side * 100),
            option => set({ side: option / 100 })
          )}
          {wheelRow(
            'Top margin',
            `${title}: top margin`,
            POSITIONS,
            percent,
            Math.round(placement.top * 100),
            option => set({ top: option / 100 })
          )}
          {wheelRow(
            'Largest width',
            `${title}: largest width`,
            HEIGHTS,
            percent,
            Math.round(placement.maxWidth * 100),
            option => set({ maxWidth: option / 100 })
          )}
          {wheelRow(
            'Largest height',
            `${title}: largest height`,
            HEIGHTS,
            percent,
            Math.round(placement.maxHeight * 100),
            option => set({ maxHeight: option / 100 })
          )}
        </ListCard>
      </View>
    )
  }
  const reelRows = (layout: ReelLayout): React.ReactElement => {
    const title = REEL_NAMES[layout]
    const placement = sponsors.reel[layout]
    const set = (part: Partial<ReelPlacement>): NodeSettings => ({
      ...settings,
      sponsors: {
        ...sponsors,
        reel: { ...sponsors.reel, [layout]: { ...placement, ...part } }
      }
    })
    return (
      <View key={layout} style={styles.group}>
        <Text style={styles.groupTitle}>{title}</Text>
        <ListCard>
          {wheelRow(
            'Largest width',
            `${title}: largest width`,
            REEL_SIZES,
            reelSize,
            placement.maxWidth,
            option => set({ maxWidth: option })
          )}
          {wheelRow(
            'Largest height',
            `${title}: largest height`,
            REEL_SIZES,
            reelSize,
            placement.maxHeight,
            option => set({ maxHeight: option })
          )}
        </ListCard>
      </View>
    )
  }
  const uploadedOn = sampleUploadedOn(sponsors.sampleKey)
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
        {placementRows('Four-angle TV', 'tvLandscape')}
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
        <SectionHeader title="Sponsor settings" />
        <Text style={styles.hint}>
          Where league sponsors&apos; logos and reels sit. A logo&apos;s margins
          and largest size are percentages of the video it is on, from its top
          and from the side it is on. A reel&apos;s largest size is a percentage
          of the screen, in each layout.
        </Text>
        {LOGO_PLACEMENTS.map(logoRows)}
        {REEL_LAYOUTS.map(reelRows)}
        <View style={styles.group}>
          <Text style={styles.groupTitle}>Sample video</Text>
          <Text style={styles.hint}>
            What a league&apos;s sponsor previews play when it has no footage of
            its own: a 1920 × 1080 H.264 or HEVC MP4, at most 2 minutes, 60
            frames a second and 120 MB.
          </Text>
          <ListCard>
            <View style={[styles.settingRow, styles.paddedRow]}>
              <Text style={styles.settingLabel}>Sample video</Text>
              <Text style={styles.sampleValue}>
                {uploadedOn == null
                  ? 'Default clip'
                  : `Uploaded ${dayLabel(uploadedOn)}`}
              </Text>
            </View>
          </ListCard>
          <SponsorSampleUpload
            busy={sampleBusy}
            disabled={busy}
            onPick={picked => {
              uploadSample(picked).catch(() => undefined)
            }}
          />
          {sampleProblem != null && (
            <Text accessibilityRole="alert" style={styles.error}>
              {sampleProblem}
            </Text>
          )}
        </View>
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
          Where each highlight starts and stops in the video, in seconds.
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
        <ListCard>
          {wheelRow(
            'Play past the event',
            'Play past the event',
            SECONDS,
            seconds,
            highlights.tailSec,
            option => setHighlights({ tailSec: option })
          )}
        </ListCard>
      </View>
      <View style={styles.section}>
        <SectionHeader title="App links" />
        <Text style={styles.hint}>
          About shows the beta build and TestFlight links. The iOS App Store
          link offers the published app in Safari on iPhone and iPad. Leave a
          link blank to hide it.
        </Text>
        <ListCard>
          {urlRow('Android/iOS Beta Builds', 'betaBuildsUrl')}
          {urlRow('iOS TestFlight', 'appStoreUrl')}
          {urlRow('iOS App Store link', 'iosAppStoreUrl')}
        </ListCard>
      </View>
      <View style={styles.section}>
        <SectionHeader title="Jev ranking" />
        <Text style={styles.hint}>
          {jevConfigured
            ? 'A key is set. Search re-ranks its results with Jev a moment after typing stops.'
            : 'No key is set. Search ranks its results by how well the names match.'}
        </Text>
        <TextField
          label="Jev API key"
          secure
          value={jevInput}
          placeholder={jevConfigured ? 'A new key' : 'Paste the key'}
          disabled={jevBusy}
          onChangeText={next => {
            setJevInput(next)
            setJevProblem(undefined)
          }}
        />
        {jevProblem != null && (
          <Text accessibilityRole="alert" style={styles.error}>
            {jevProblem}
          </Text>
        )}
        <View style={styles.buttons}>
          <Button
            label={jevConfigured ? 'Replace' : 'Set'}
            busy={jevBusy}
            disabled={jevTyped === ''}
            onPress={() => {
              changeJevKey(jevTyped).catch(() => undefined)
            }}
          />
          {jevConfigured && (
            <Button
              label="Remove"
              kind="secondary"
              disabled={jevBusy}
              onPress={() => {
                changeJevKey(null).catch(() => undefined)
              }}
            />
          )}
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
          // The Jev key is not a setting Reset puts back. The sample video
          // goes back to the default clip once saved.
          change(shownSettings({ ...defaultNodeSettings, jev: settings.jev }))
          setSampleReset(true)
        }}
      />
      {picker != null && (
        <PickerDialog
          maxWidthRem={24}
          onClose={() => {
            setPicker(undefined)
          }}
        >
          {picker.kind === 'url' ? (
            <UrlPicker
              picker={picker}
              onChoose={value => {
                change(picker.choose(value))
                setPicker(undefined)
              }}
              onCancel={() => {
                setPicker(undefined)
              }}
            />
          ) : picker.kind === 'date' ? (
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

/** One about-screen URL, held until Use. Blank clears the button. */
function UrlPicker({
  picker,
  onChoose,
  onCancel
}: {
  picker: Extract<Picker, { kind: 'url' }>
  onChoose: (value: string) => void
  onCancel: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [value, setValue] = useState(picker.value)
  const [problem, setProblem] = useState<string>()
  return (
    <View style={styles.picker}>
      <Text accessibilityRole="header" style={styles.name}>
        {picker.title}
      </Text>
      <TextInput
        accessibilityLabel={picker.title}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://"
        placeholderTextColor={theme.secondaryTextColor}
        value={value}
        onChangeText={next => {
          setValue(next)
          setProblem(undefined)
        }}
        style={styles.urlInput}
      />
      {problem != null && (
        <Text accessibilityRole="alert" style={styles.error}>
          {problem}
        </Text>
      )}
      <Button
        label="Use"
        onPress={() => {
          try {
            onChoose(asDistributionUrl(picker.key, value))
          } catch (error) {
            setProblem(
              error instanceof Error ? error.message : 'Enter an HTTPS URL'
            )
          }
        }}
      />
      <CancelAction onPress={onCancel} />
    </View>
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
  sampleValue: {
    flexShrink: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.secondaryTextColor
  },
  settingValue: {
    flexShrink: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600' as const,
    color: theme.linkTextColor
  },
  urlInput: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    minHeight: 48,
    paddingHorizontal: theme.rem(0.75),
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.cardBackgroundColor
  },
  error: { color: theme.dangerColor, fontSize: theme.rem(0.875) },
  buttons: { flexDirection: 'row' as const, gap: theme.rem(0.5) },
  picker: { gap: theme.rem(0.75), alignItems: 'stretch' as const }
}))
