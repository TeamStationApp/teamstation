import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  CATCHER_COUNTS_AS_CHOICES,
  CATCHER_INNING_CHOICES,
  type CatcherInnings,
  DEFAULT_PLAYING_TIME_RULES,
  DEFENSIVE_OUTS,
  INNING_DEADLINES,
  type InningDeadline,
  MEASURED_IN_CHOICES,
  PARTIAL_INNING_CHOICES,
  PLAYING_TIME_RANGES,
  PLAYING_TIME_RULE_KEYS,
  type PlayingTimeRowKey,
  type PlayingTimeRowValues,
  type PlayingTimeRules,
  ROTATE_EVERY_CHOICES,
  ruleRowEnabled,
  ruleValue,
  SITTING_ORDER_CHOICES,
  withRuleValue
} from '../../common/playingTimeRules'
import type { GroupDetail } from '../../common/publicGroups'
import { Button, ListCard, Screen, SectionHeader } from '../components'
import { CancelAction } from '../components/CancelAction'
import { DangerText } from '../components/DangerText'
import { SettingChoiceRow } from '../components/settings/SettingChoiceRow'
import { SettingSegmentRow } from '../components/settings/SettingSegmentRow'
import { SettingStepperRow } from '../components/settings/SettingStepperRow'
import { SettingToggleRow } from '../components/settings/SettingToggleRow'
import { useConfirmedAction } from '../components/useConfirmedAction'
import { useTitleHandoff } from '../components/useTitleHandoff'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** The rows whose value is a value of this type. */
type KeysOf<Value> = {
  [Key in PlayingTimeRowKey]: PlayingTimeRowValues[Key] extends Value
    ? Key
    : never
}[PlayingTimeRowKey]

/** Every whole number from `min` to `max`. */
const run = ({ min, max }: { min: number; max: number }): number[] =>
  Array.from({ length: max - min + 1 }, (unused, i) => min + i)

const DEADLINE_LABELS: Record<InningDeadline, string> = {
  3: lstrings.playing_time_inning_3,
  4: lstrings.playing_time_inning_4,
  5: lstrings.playing_time_inning_5,
  none: lstrings.playing_time_no_deadline
}
const DEADLINES = INNING_DEADLINES.map(id => ({
  id,
  label: DEADLINE_LABELS[id]
}))
const OUTS = DEFENSIVE_OUTS.map(id => ({ id, label: String(id) }))
const MEASURED_IN_LABELS: Record<(typeof MEASURED_IN_CHOICES)[number], string> =
  {
    innings: lstrings.playing_time_innings,
    outs: lstrings.playing_time_outs
  }
const PARTIAL_LABELS: Record<(typeof PARTIAL_INNING_CHOICES)[number], string> =
  {
    fullOnly: lstrings.playing_time_full_only,
    anyAppearance: lstrings.playing_time_any_appearance
  }
const CATCHER_COUNTS_AS_LABELS: Record<
  (typeof CATCHER_COUNTS_AS_CHOICES)[number],
  string
> = {
  infield: lstrings.playing_time_infield_choice,
  outfield: lstrings.playing_time_outfield_choice
}
/** 3, 4, 5, and `none` named as the row says. */
const catcherInnings = (
  none: string
): Array<{ id: CatcherInnings; label: string }> =>
  CATCHER_INNING_CHOICES.map(id => ({
    id,
    label: id === 'none' ? none : String(id)
  }))
const SITTING_ORDER_LABELS: Record<
  (typeof SITTING_ORDER_CHOICES)[number],
  string
> = {
  secondAfterAll: lstrings.playing_time_second_after_all,
  thirdAfterAll: lstrings.playing_time_third_after_all,
  off: lstrings.playing_time_off
}
/** What Require Defensive Playing Time requires, in its unit. */
function requirement(rules: PlayingTimeRules): string {
  if (rules.measuredIn === 'outs')
    return sprintf(lstrings.playing_time_require_outs, rules.outs.required)
  const { minimum, completeBy } = rules.innings
  if (completeBy === 'none')
    return minimum === 1
      ? lstrings.playing_time_require_inning
      : sprintf(lstrings.playing_time_require_innings, minimum)
  return minimum === 1
    ? sprintf(
        lstrings.playing_time_require_inning_by,
        DEADLINE_LABELS[completeBy]
      )
    : sprintf(
        lstrings.playing_time_require_innings_by,
        minimum,
        DEADLINE_LABELS[completeBy]
      )
}

const choices = <Id extends string>(
  ids: readonly Id[],
  labels: Record<Id, string>
): Array<{ id: Id; label: string }> =>
  ids.map(id => ({ id, label: labels[id] }))

const sameRules = (a: PlayingTimeRules, b: PlayingTimeRules): boolean =>
  PLAYING_TIME_RULE_KEYS.every(
    key => JSON.stringify(a[key]) === JSON.stringify(b[key])
  )

interface Loaded {
  /** The season's or team's name, for the turn-off confirmation. */
  name: string
  /** The group's own stored set, or null for none. */
  own: PlayingTimeRules | null
  /** The managing season's rules a team follows, or null for none. */
  season: GroupDetail['seasonPlayingTimeRules']
  /** The set the draft started from: the own set, the season's, or the defaults. */
  start: PlayingTimeRules
}

/**
 * A season's or a team's Playing Time Rules, from its settings. A team whose
 * season has rules follows them, every row grayed out, until Override season
 * rules is on; turning it on starts the team's own set from the season's.
 * Save, enabled once something differs from what the screen opened with,
 * writes the whole set, or null for a team that follows its season. A group
 * with a stored set and no season above it can turn its rules off, to null.
 */
export function PlayingTimeRulesScreen({
  client,
  kind,
  id,
  onSaved,
  onCancel
}: {
  client: TeamStationClient
  kind: 'season' | 'team'
  id: string
  onSaved: () => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const handoff = useTitleHandoff(lstrings.playing_time_title)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [draft, setDraft] = useState<PlayingTimeRules>(
    DEFAULT_PLAYING_TIME_RULES
  )
  const [override, setOverride] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const confirm = useConfirmedAction(client, `${kind}:${id}`)
  useEffect(() => {
    let live = true
    client.group({ kind, id }).then(
      detail => {
        if (!live) return
        const season = kind === 'team' ? detail.seasonPlayingTimeRules : null
        const own = detail.playingTimeRules
        const start = own ?? season?.rules ?? DEFAULT_PLAYING_TIME_RULES
        setLoaded({ name: detail.group.name, own, season, start })
        setOverride(own != null)
        setDraft(start)
      },
      (caught: unknown) => {
        if (live)
          setError(
            caught instanceof Error
              ? caught.message
              : lstrings.playing_time_cannot_load
          )
      }
    )
    return () => {
      live = false
    }
  }, [client, kind, id])
  const season = loaded?.season ?? null
  const following = season != null && !override
  const shown = following ? season.rules : draft
  const editable = loaded != null && !following
  const changed =
    loaded != null &&
    ((season != null && override !== (loaded.own != null)) ||
      (editable && !sameRules(draft, loaded.start)))
  const enabled = (key: PlayingTimeRowKey): boolean =>
    editable && ruleRowEnabled(shown, key)
  const set = <Key extends PlayingTimeRowKey>(
    key: Key,
    value: PlayingTimeRowValues[Key]
  ): void => {
    setDraft(rules => withRuleValue(rules, key, value))
  }
  const toggle = (
    key: KeysOf<boolean>,
    label: string,
    subtitle?: string,
    accessibilityLabel?: string
  ): React.ReactElement => (
    <SettingToggleRow
      key={key}
      label={label}
      subtitle={subtitle}
      accessibilityLabel={accessibilityLabel}
      value={ruleValue(shown, key)}
      disabled={!enabled(key)}
      onChange={value => {
        set(key, value)
      }}
    />
  )
  const stepper = <Key extends KeysOf<string | number>>(
    key: Key,
    label: string,
    steps: ReadonlyArray<PlayingTimeRowValues[Key]>,
    format?: (value: PlayingTimeRowValues[Key]) => string,
    accessibilityLabel?: string
  ): React.ReactElement => (
    <SettingStepperRow
      key={key}
      label={label}
      accessibilityLabel={accessibilityLabel}
      steps={steps}
      value={ruleValue(shown, key)}
      format={format}
      disabled={!enabled(key)}
      onChange={value => {
        set(key, value)
      }}
    />
  )
  const segment = <Key extends KeysOf<string | number>>(
    key: Key,
    label: string,
    options: ReadonlyArray<{ id: PlayingTimeRowValues[Key]; label: string }>,
    subtitle?: string,
    accessibilityLabel?: string
  ): React.ReactElement => (
    <SettingSegmentRow
      key={key}
      label={label}
      subtitle={subtitle}
      accessibilityLabel={accessibilityLabel}
      options={options}
      selected={ruleValue(shown, key)}
      disabled={!enabled(key)}
      onSelect={value => {
        set(key, value)
      }}
    />
  )
  const choice = <Key extends KeysOf<string | number>>(
    key: Key,
    label: string,
    options: ReadonlyArray<{ id: PlayingTimeRowValues[Key]; label: string }>
  ): React.ReactElement => (
    <SettingChoiceRow
      key={key}
      label={label}
      options={options}
      selected={ruleValue(shown, key)}
      disabled={!enabled(key)}
      onSelect={value => {
        set(key, value)
      }}
    />
  )
  const group = (title: string, rows: React.ReactNode): React.ReactElement => (
    <View style={styles.section}>
      <SectionHeader title={title} />
      <ListCard>{rows}</ListCard>
    </View>
  )
  /**
   * Defensive Playing Time's own rows (`block` '') or a large roster's
   * ('largeRoster.'), in the unit it is measured in: outs, or innings.
   */
  const requirementRows = (
    block: '' | 'largeRoster.'
  ): React.ReactElement[] => {
    const name = (label: string): string | undefined =>
      block === ''
        ? undefined
        : sprintf(lstrings.playing_time_large_roster_row, label)
    return shown.measuredIn === 'outs'
      ? [
          segment(
            `${block}outs.required`,
            lstrings.playing_time_outs_required,
            OUTS,
            undefined,
            name(lstrings.playing_time_outs_required)
          ),
          toggle(
            `${block}outs.consecutive`,
            lstrings.playing_time_consecutive,
            undefined,
            name(lstrings.playing_time_consecutive)
          )
        ]
      : [
          stepper(
            `${block}innings.minimum`,
            lstrings.playing_time_minimum_innings,
            run(PLAYING_TIME_RANGES.minimumInnings),
            undefined,
            name(lstrings.playing_time_minimum_innings)
          ),
          segment(
            `${block}innings.completeBy`,
            lstrings.playing_time_minimum_by,
            DEADLINES,
            undefined,
            name(lstrings.playing_time_minimum_by)
          ),
          segment(
            `${block}innings.countPartial`,
            lstrings.playing_time_partial,
            choices(PARTIAL_INNING_CHOICES, PARTIAL_LABELS),
            undefined,
            name(lstrings.playing_time_partial)
          )
        ]
  }
  const save = async (): Promise<void> => {
    if (loaded == null || saving) return
    setSaving(true)
    setError('')
    try {
      await client.updateGroup(
        { kind, id },
        { playingTimeRules: following ? null : draft }
      )
      onSaved()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : lstrings.playing_time_cannot_save
      )
      setSaving(false)
    }
  }
  const turnOff = (): void => {
    if (loaded == null) return
    confirm.open({
      title: sprintf(lstrings.playing_time_turn_off_title, loaded.name),
      detail: lstrings.playing_time_turn_off_detail,
      label: lstrings.playing_time_turn_off_confirm,
      fallback: lstrings.playing_time_cannot_save,
      testID: 'playing-time-turn-off-confirm',
      run: async current => {
        await client.updateGroup({ kind, id }, { playingTimeRules: null })
        if (current()) onSaved()
      }
    })
  }
  return (
    <Screen onScroll={handoff.handleScroll}>
      <View style={styles.page}>
        <View ref={handoff.ref} collapsable={false} style={styles.heading}>
          <Text style={styles.title} accessibilityRole="header">
            {lstrings.playing_time_title}
          </Text>
          <Text style={styles.subtitle}>
            {kind === 'season'
              ? lstrings.playing_time_subtitle_season
              : lstrings.playing_time_subtitle_team}
          </Text>
        </View>
        {loaded == null ? (
          error === '' && (
            <Text style={styles.hint}>{lstrings.playing_time_loading}</Text>
          )
        ) : (
          <>
            {season != null && (
              <ListCard>
                <SettingToggleRow
                  label={lstrings.playing_time_override}
                  subtitle={
                    override
                      ? undefined
                      : sprintf(
                          lstrings.playing_time_following,
                          season.season.name
                        )
                  }
                  value={override}
                  onChange={on => {
                    // The team's own set starts as the season's.
                    if (on) setDraft(season.rules)
                    setOverride(on)
                  }}
                />
              </ListCard>
            )}
            {group(lstrings.playing_time_group_defensive, [
              toggle(
                'defensivePlayingTime',
                lstrings.playing_time_require,
                requirement(shown)
              ),
              segment(
                'measuredIn',
                lstrings.playing_time_measured_in,
                choices(MEASURED_IN_CHOICES, MEASURED_IN_LABELS)
              ),
              ...requirementRows(''),
              toggle(
                'largeRoster.enabled',
                lstrings.playing_time_large_rosters
              ),
              stepper(
                'largeRoster.players',
                sprintf(
                  lstrings.playing_time_large_roster_players,
                  shown.largeRoster.players
                ),
                run(PLAYING_TIME_RANGES.largeRosterPlayers)
              ),
              ...requirementRows('largeRoster.')
            ])}
            {group(lstrings.playing_time_group_fields, [
              toggle('requireMinimumInfield', lstrings.playing_time_infield),
              stepper(
                'infieldInningsRequired',
                lstrings.playing_time_infield_innings,
                run(PLAYING_TIME_RANGES.infieldInningsRequired)
              ),
              toggle(
                'pitcherCountsAsInfield',
                lstrings.playing_time_pitcher_infield
              ),
              segment(
                'catcherCountsAs',
                lstrings.playing_time_catcher_counts_as,
                choices(CATCHER_COUNTS_AS_CHOICES, CATCHER_COUNTS_AS_LABELS)
              ),
              segment('infieldBy', lstrings.playing_time_infield_by, DEADLINES),
              toggle('requireMinimumOutfield', lstrings.playing_time_outfield),
              stepper(
                'outfieldInningsRequired',
                lstrings.playing_time_outfield_innings,
                run(PLAYING_TIME_RANGES.outfieldInningsRequired)
              ),
              segment(
                'outfieldBy',
                lstrings.playing_time_outfield_by,
                DEADLINES
              ),
              toggle(
                'startingBatteryExemptFromMinimums',
                lstrings.playing_time_battery_minimums
              )
            ])}
            {group(lstrings.playing_time_group_sitting, [
              toggle('enforceSittingLimits', lstrings.playing_time_sitting),
              toggle(
                'noConsecutiveSits',
                lstrings.playing_time_no_consecutive_sits
              ),
              choice(
                'equalSittingOrder',
                lstrings.playing_time_sitting_order,
                choices(SITTING_ORDER_CHOICES, SITTING_ORDER_LABELS)
              ),
              stepper(
                'maxSitsPerGame',
                lstrings.playing_time_max_sits,
                run(PLAYING_TIME_RANGES.maxSitsPerGame)
              ),
              toggle(
                'startingBatteryExemptFromSitting',
                lstrings.playing_time_battery_sitting,
                lstrings.playing_time_battery_sitting_detail
              )
            ])}
            {group(lstrings.playing_time_group_positions, [
              toggle(
                'limitInningsAtPosition',
                lstrings.playing_time_limit_position
              ),
              stepper(
                'maxInningsPerPosition',
                lstrings.playing_time_max_position,
                [
                  ...run(PLAYING_TIME_RANGES.maxInningsPerPosition),
                  'unlimited'
                ],
                value =>
                  value === 'unlimited'
                    ? lstrings.playing_time_unlimited
                    : String(value)
              ),
              stepper(
                'rotateEvery',
                lstrings.playing_time_rotate_every,
                ROTATE_EVERY_CHOICES,
                value =>
                  value === 0 ? lstrings.playing_time_off : String(value)
              )
            ])}
            {group(lstrings.playing_time_group_battery, [
              segment(
                'catcherMaxInnings',
                lstrings.playing_time_catcher_limit,
                catcherInnings(lstrings.playing_time_none)
              ),
              segment(
                'catcherBlocksPitching',
                lstrings.playing_time_catcher_pitching,
                catcherInnings(lstrings.playing_time_disable),
                sprintf(
                  lstrings.playing_time_catcher_pitching_detail,
                  shown.catcherBlocksPitching === 'none'
                    ? lstrings.playing_time_catcher_pitching_n
                    : shown.catcherBlocksPitching
                )
              )
            ])}
            {group(lstrings.playing_time_group_batting, [
              toggle('continuousBatting', lstrings.playing_time_continuous),
              toggle('lateArrivalsToEnd', lstrings.playing_time_late_arrivals),
              toggle(
                'departuresSkipWithoutOut',
                lstrings.playing_time_departures
              )
            ])}
            <Text style={styles.hint}>
              {lstrings.playing_time_future_games}
            </Text>
          </>
        )}
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Button
          label={lstrings.playing_time_save}
          busy={saving}
          disabled={!changed || confirm.busy}
          onPress={() => {
            save().catch(() => undefined)
          }}
        />
        <CancelAction onPress={onCancel} />
        {loaded?.own != null && season == null && (
          <DangerText
            label={lstrings.playing_time_turn_off}
            disabled={saving || confirm.busy}
            style={styles.centered}
            onPress={turnOff}
          />
        )}
        {confirm.sheet}
      </View>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1.25) },
  centered: { alignSelf: 'center' as const },
  heading: { gap: theme.rem(0.25) },
  section: { gap: theme.rem(0.75) },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5)
  },
  subtitle: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  hint: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont
  }
}))
