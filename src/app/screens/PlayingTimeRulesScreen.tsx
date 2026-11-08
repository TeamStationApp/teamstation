import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  CATCHER_INFIELD_CHOICES,
  CATCHER_INNING_CHOICES,
  DEFAULT_PLAYING_TIME_RULES,
  DEFENSIVE_OUTS,
  INFIELD_POSITIONS,
  INNING_DEADLINES,
  type InningDeadline,
  PARTIAL_INNING_CHOICES,
  PLAYING_TIME_RANGES,
  PLAYING_TIME_RULE_KEYS,
  type PlayingTimeRuleKey,
  type PlayingTimeRules,
  ROTATE_EVERY_CHOICES,
  ruleRowEnabled,
  SHORTENED_GAME_CHOICES,
  SITTING_ORDER_CHOICES
} from '../../common/playingTimeRules'
import type { GroupDetail } from '../../common/publicGroups'
import { Button, Icon, ListCard, Screen, SectionHeader } from '../components'
import { CancelAction } from '../components/CancelAction'
import { CheckRow } from '../components/CheckRow'
import { DangerText } from '../components/DangerText'
import { SettingChoiceRow } from '../components/settings/SettingChoiceRow'
import { GATED_OPACITY } from '../components/settings/settingRowStyles'
import { SettingSegmentRow } from '../components/settings/SettingSegmentRow'
import { SettingStepperRow } from '../components/settings/SettingStepperRow'
import { SettingToggleRow } from '../components/settings/SettingToggleRow'
import { useConfirmedAction } from '../components/useConfirmedAction'
import { useTitleHandoff } from '../components/useTitleHandoff'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** The rules whose value is a value of this type. */
type KeysOf<Value> = {
  [Key in PlayingTimeRuleKey]: PlayingTimeRules[Key] extends Value ? Key : never
}[PlayingTimeRuleKey]

/** Every whole number from `min` to `max`. */
const run = ({ min, max }: { min: number; max: number }): number[] =>
  Array.from({ length: max - min + 1 }, (unused, i) => min + i)

const deadlineLabel = (deadline: InningDeadline): string =>
  deadline === 'end'
    ? lstrings.playing_time_by_end
    : lstrings[`playing_time_by_${deadline}`]
const DEADLINES = INNING_DEADLINES.map(id => ({ id, label: deadlineLabel(id) }))
const OUTS = DEFENSIVE_OUTS.map(id => ({ id, label: String(id) }))
const SHORTENED_LABELS: Record<
  (typeof SHORTENED_GAME_CHOICES)[number],
  string
> = {
  always: lstrings.playing_time_always,
  localOption: lstrings.playing_time_local_option,
  never: lstrings.playing_time_never
}
const PARTIAL_LABELS: Record<(typeof PARTIAL_INNING_CHOICES)[number], string> =
  {
    fullOnly: lstrings.playing_time_full_only,
    anyAppearance: lstrings.playing_time_any_appearance
  }
const CATCHER_INFIELD_LABELS: Record<
  (typeof CATCHER_INFIELD_CHOICES)[number],
  string
> = {
  off: lstrings.playing_time_off,
  always: lstrings.playing_time_always,
  largeRoster: lstrings.playing_time_large_roster_only
}
const SITTING_ORDER_LABELS: Record<
  (typeof SITTING_ORDER_CHOICES)[number],
  string
> = {
  secondAfterAll: lstrings.playing_time_second_after_all,
  thirdAfterAll: lstrings.playing_time_third_after_all,
  off: lstrings.playing_time_off
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
  const [tracking, setTracking] = useState(false)
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
  const enabled = (key: PlayingTimeRuleKey): boolean =>
    editable && ruleRowEnabled(shown, key)
  const set = <Key extends PlayingTimeRuleKey>(
    key: Key,
    value: PlayingTimeRules[Key]
  ): void => {
    setDraft(rules => ({ ...rules, [key]: value }))
  }
  const toggle = (
    key: KeysOf<boolean>,
    label: string,
    subtitle?: string
  ): React.ReactElement => (
    <SettingToggleRow
      key={key}
      label={label}
      subtitle={subtitle}
      value={shown[key]}
      disabled={!enabled(key)}
      onChange={value => {
        set(key, value)
      }}
    />
  )
  const stepper = <Key extends KeysOf<string | number>>(
    key: Key,
    label: string,
    steps: ReadonlyArray<PlayingTimeRules[Key]>,
    format?: (value: PlayingTimeRules[Key]) => string
  ): React.ReactElement => (
    <SettingStepperRow
      key={key}
      label={label}
      steps={steps}
      value={shown[key]}
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
    options: ReadonlyArray<{ id: PlayingTimeRules[Key]; label: string }>
  ): React.ReactElement => (
    <SettingSegmentRow
      key={key}
      label={label}
      options={options}
      selected={shown[key]}
      disabled={!enabled(key)}
      onSelect={value => {
        set(key, value)
      }}
    />
  )
  const choice = <Key extends KeysOf<string | number>>(
    key: Key,
    label: string,
    options: ReadonlyArray<{ id: PlayingTimeRules[Key]; label: string }>
  ): React.ReactElement => (
    <SettingChoiceRow
      key={key}
      label={label}
      options={options}
      selected={shown[key]}
      disabled={!enabled(key)}
      onSelect={value => {
        set(key, value)
      }}
    />
  )
  const group = (
    title: string,
    rows: React.ReactNode,
    note?: string
  ): React.ReactElement => (
    <View style={styles.section}>
      <SectionHeader title={title} />
      {note != null && <Text style={styles.hint}>{note}</Text>}
      <ListCard>{rows}</ListCard>
    </View>
  )
  const infield = enabled('infieldPositions')
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
            {group(lstrings.playing_time_group_mandatory, [
              toggle(
                'mandatoryPlay',
                lstrings.playing_time_mandatory_play,
                lstrings.playing_time_mandatory_play_detail
              ),
              segment(
                'defensiveOutsRequired',
                lstrings.playing_time_outs_required,
                OUTS
              ),
              toggle('mustBeConsecutive', lstrings.playing_time_consecutive),
              toggle(
                'reducedForLargeRosters',
                lstrings.playing_time_large_rosters
              ),
              stepper(
                'largeRosterPlayers',
                sprintf(
                  lstrings.playing_time_large_roster_players,
                  shown.largeRosterPlayers
                ),
                run(PLAYING_TIME_RANGES.largeRosterPlayers)
              ),
              segment(
                'largeRosterOuts',
                sprintf(
                  lstrings.playing_time_large_roster_outs,
                  shown.largeRosterOuts
                ),
                OUTS
              ),
              segment(
                'applyInShortenedGames',
                lstrings.playing_time_shortened,
                choices(SHORTENED_GAME_CHOICES, SHORTENED_LABELS)
              )
            ])}
            {group(lstrings.playing_time_group_total, [
              toggle(
                'stricterMinimumInnings',
                lstrings.playing_time_stricter,
                lstrings.playing_time_stricter_detail
              ),
              stepper(
                'minimumFullInnings',
                lstrings.playing_time_minimum_innings,
                run(PLAYING_TIME_RANGES.minimumFullInnings)
              ),
              choice(
                'minimumInningsBy',
                lstrings.playing_time_minimum_by,
                DEADLINES
              ),
              segment(
                'countPartialInnings',
                lstrings.playing_time_partial,
                choices(PARTIAL_INNING_CHOICES, PARTIAL_LABELS)
              )
            ])}
            {group(lstrings.playing_time_group_fields, [
              toggle('requireMinimumInfield', lstrings.playing_time_infield),
              stepper(
                'infieldInningsRequired',
                lstrings.playing_time_infield_innings,
                run(PLAYING_TIME_RANGES.infieldInningsRequired)
              ),
              <View
                key="infieldPositions"
                accessibilityState={{ disabled: !infield }}
                aria-disabled={!infield}
                style={[styles.positions, !infield && styles.gated]}
              >
                <Text style={[styles.label, styles.inset]}>
                  {lstrings.playing_time_infield_positions}
                </Text>
                {INFIELD_POSITIONS.map(position => {
                  const checked = shown.infieldPositions.includes(position)
                  return (
                    <CheckRow
                      key={position}
                      label={position}
                      checked={checked}
                      disabled={!infield}
                      onToggle={() => {
                        set(
                          'infieldPositions',
                          INFIELD_POSITIONS.filter(one =>
                            one === position
                              ? !checked
                              : shown.infieldPositions.includes(one)
                          )
                        )
                      }}
                    />
                  )
                })}
              </View>,
              choice(
                'catcherCountsAsInfield',
                lstrings.playing_time_catcher_infield,
                choices(CATCHER_INFIELD_CHOICES, CATCHER_INFIELD_LABELS)
              ),
              choice('infieldBy', lstrings.playing_time_infield_by, DEADLINES),
              toggle('requireMinimumOutfield', lstrings.playing_time_outfield),
              stepper(
                'outfieldInningsRequired',
                lstrings.playing_time_outfield_innings,
                run(PLAYING_TIME_RANGES.outfieldInningsRequired)
              ),
              choice('outfieldBy', lstrings.playing_time_outfield_by, DEADLINES)
            ])}
            {group(
              lstrings.playing_time_group_sitting,
              [
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
                  lstrings.playing_time_battery_sitting
                )
              ],
              lstrings.playing_time_bench_note
            )}
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
              toggle(
                'mustPlayInfieldAndOutfield',
                lstrings.playing_time_both_fields
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
              toggle('catcherInningLimit', lstrings.playing_time_catcher_limit),
              stepper(
                'catcherMaxInnings',
                sprintf(
                  lstrings.playing_time_catcher_innings,
                  shown.catcherMaxInnings
                ),
                CATCHER_INNING_CHOICES
              ),
              toggle(
                'catcherBlocksPitching',
                lstrings.playing_time_catcher_pitching,
                lstrings.playing_time_catcher_pitching_detail
              ),
              toggle(
                'catcherBlocksIfCatchesFourth',
                lstrings.playing_time_catcher_fourth
              ),
              toggle(
                'startingBatteryExemptFromMinimums',
                lstrings.playing_time_battery_minimums
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
            <ListCard>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={lstrings.playing_time_group_season}
                accessibilityState={{ expanded: tracking }}
                aria-expanded={tracking}
                onPress={() => {
                  setTracking(open => !open)
                }}
                style={({ pressed }) => [
                  styles.expander,
                  pressed && styles.pressed
                ]}
              >
                <View style={styles.expanderText}>
                  <Text style={styles.label}>
                    {lstrings.playing_time_group_season}
                  </Text>
                  <Text style={styles.subtitle}>
                    {lstrings.playing_time_season_note}
                  </Text>
                </View>
                <View style={tracking && styles.turned}>
                  <Icon name="chevron_right" />
                </View>
              </Pressable>
              {tracking && [
                toggle(
                  'trackSeasonInfieldBalance',
                  lstrings.playing_time_infield_balance
                ),
                toggle('rotateLeadoff', lstrings.playing_time_rotate_leadoff),
                toggle(
                  'mustPlayNextSuggestions',
                  lstrings.playing_time_must_play_next
                )
              ]}
            </ListCard>
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
  label: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600' as const
  },
  positions: {
    paddingTop: theme.rem(0.75),
    paddingBottom: theme.rem(0.25),
    gap: theme.rem(0.25)
  },
  inset: { paddingHorizontal: theme.rem(theme.cardContentInsetRem) },
  gated: { opacity: GATED_OPACITY },
  expander: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(theme.spaceMdRem),
    minHeight: theme.rem(3),
    padding: theme.rem(theme.cardContentInsetRem)
  },
  expanderText: { flex: 1, gap: theme.rem(0.125) },
  turned: { transform: [{ rotate: '90deg' }] },
  pressed: { backgroundColor: theme.highlightRowActiveBackground },
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
