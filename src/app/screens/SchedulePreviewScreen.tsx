import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { FairnessRow, PlannedGame } from '../../common/autoScheduler/types'
import {
  eventLocalRange,
  foreignZoneName,
  viewerTimezone
} from '../../common/eventTime'
import { wallInstant } from '../../common/fieldAvailability'
import { gameCalendarDay } from '../../common/gameTime'
import {
  editedGames,
  type PublishedState,
  type SchedulePreview
} from '../../common/schedulePreviews'
import { type FieldSize, fieldSizeLabel } from '../../common/venues'
import {
  Button,
  CardBand,
  HandoffView,
  ListCard,
  PillBand,
  PillTabs,
  PinnedContent,
  PinnedSpacer,
  Screen,
  SectionHeader,
  useHeaderHandoff,
  usePinnedHandoff,
  usePinnedTabs
} from '../components'
import { CheckRow } from '../components/CheckRow'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { CalendarPicker, TimePicker } from '../components/EventScheduleFields'
import { PickerDialog } from '../components/PickerDialog'
import { useConfirmedAction } from '../components/useConfirmedAction'
import { clockLabel, WEEKDAYS } from '../components/WeeklyHoursEditor'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  ALL_GAMES,
  type CalendarWeek,
  calendarWeeks,
  dayHeader,
  fieldLabels,
  filteredGames,
  normalizeFilter,
  type PreviewFilter,
  sameFilter,
  weekAnchor,
  weekTitle
} from './schedulePreviewCalendar'

type Tab = 'schedule' | 'fairness'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'schedule', label: 'Schedule' },
  { id: 'fairness', label: 'Fairness' }
]

/** The id of each filter row's first pill, which stands for all of them. */
const ALL = '*'

const STATE_LABELS: Record<PublishedState, string> = {
  scheduled: 'Scheduled',
  awaiting: 'Waiting for approval',
  needsRescheduling: 'Needs rescheduling',
  rejected: 'Rejected',
  resolved: 'Placed again'
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * When a game's field is in another zone than the viewer's, its start
 * there and that zone: "5:30 PM EDT at the field", with the weekday when
 * the field's day is another. Empty in the viewer's own zone.
 */
function atTheField(
  startAt: string,
  fieldZone: string | undefined,
  viewer: string
): string {
  const zone =
    fieldZone == null ? '' : foreignZoneName(startAt, fieldZone, viewer)
  if (zone === '' || fieldZone == null) return ''
  const sameDay =
    gameCalendarDay(startAt, fieldZone) === gameCalendarDay(startAt, viewer)
  const there = new Intl.DateTimeFormat('en', {
    timeZone: fieldZone,
    ...(sameDay ? {} : { weekday: 'short' as const }),
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(startAt))
  return `${there} ${zone} at the field`
}

/**
 * A game's time in the viewer's zone. When its field is in another zone,
 * the label also names that zone, with the start there, the time the game
 * was placed in: "Monday, March 1, 2:30 PM – 4:00 PM · 5:30 PM EST at the
 * field".
 */
export function gameTimeLabel(
  game: { startAt: string; endAt: string | null },
  fieldZone: string | undefined,
  viewer: string = viewerTimezone()
): string {
  const range = eventLocalRange(game.startAt, game.endAt, viewer)
  const there = atTheField(game.startAt, fieldZone, viewer)
  return there === '' ? range : `${range} · ${there}`
}

/**
 * A game box's time, under its day's header: the start in the viewer's
 * zone, and the field's own start and zone when it is in another, as
 * `gameTimeLabel` names them: "2:30 PM · 5:30 PM EDT at the field".
 */
export function boxTimeLabel(
  game: { startAt: string },
  fieldZone: string | undefined,
  viewer: string = viewerTimezone()
): string {
  const start = new Intl.DateTimeFormat('en', {
    timeZone: viewer,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(game.startAt))
  const there = atTheField(game.startAt, fieldZone, viewer)
  return there === '' ? start : `${start} · ${there}`
}

/** A team's fairness line, said plainly. */
export function fairnessLine(row: FairnessRow): string {
  const days = row.weekdays
    .map((count, day) =>
      count > 0 ? `${WEEKDAYS[day].slice(0, 3)} ${count}` : ''
    )
    .filter(part => part !== '')
    .join(', ')
  const games = row.exhibitionTeam
    ? plural(row.exhibitionGames, 'exhibition game')
    : `${plural(row.regularGames, 'regular-season game')}, ${plural(row.exhibitionGames, 'exhibition game')}`
  const gaps =
    row.shortestGapDays == null || row.longestGapDays == null
      ? ''
      : ` · ${row.shortestGapDays}–${row.longestGapDays} days apart`
  return `${games} · ${days === '' ? 'no days' : days} · ${plural(row.mornings, 'morning')}, ${plural(row.afternoons, 'afternoon')}, ${plural(row.evenings, 'evening')}${gaps}${row.doubleheaders > 0 ? ` · ${plural(row.doubleheaders, 'doubleheader')}` : ''}`
}

/**
 * A preview of a league's schedule: up to three options, each with its
 * games week by week, filtered by season, team and field, its fairness by
 * season, what it couldn't meet and why it trails the recommended one.
 * Games can be rejected and added, the option recalculated, and published.
 *
 * The title and Recalculate scroll away under the header, the title handing
 * up into it; the tabs and the filter rows stay pinned under it, with
 * everything else scrolling beneath them.
 */
export function SchedulePreviewScreen({
  client,
  leagueId,
  previewId,
  onOpenPreview
}: {
  client: TeamStationClient
  leagueId: string
  previewId: string
  /** Opens a recalculated preview in this one's place. */
  onOpenPreview: (previewId: string) => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [preview, setPreview] = useState<SchedulePreview>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [option, setOption] = useState(0)
  const [tab, setTab] = useState<Tab>('schedule')
  const [chosen, setChosen] = useState<PreviewFilter>(ALL_GAMES)
  const [fairnessSeason, setFairnessSeason] = useState<string>()
  const [adding, setAdding] = useState(false)
  // The calendar's pane width. In a sideways scroller nothing caps a
  // column, so the calendar is given the pane's width, or the seven
  // narrowest columns' when that is wider, and its columns share it.
  const [paneWidth, setPaneWidth] = useState(0)
  const begin = useLatestRequest()
  const confirmation = useConfirmedAction(client, previewId)
  const published = preview?.status === 'published'
  const title = published ? 'Published schedule' : 'Schedule preview'
  const head = usePinnedHandoff()
  const progress = head.handoff.progress
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress} style={styles.headerHandoff}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
        </HandoffView>
      ),
      [progress, styles.headerHandoff, styles.headerTitle, title]
    )
  )
  const { pinned, selectTab } = usePinnedTabs({
    head,
    ready: preview != null,
    tab,
    anchorOnRow: false
  })
  useEffect(() => {
    const current = begin()
    setError('')
    client.schedulePreview(previewId).then(
      found => {
        if (!current()) return
        setPreview(found)
        setOption(found.publishedOption ?? found.edits.option)
      },
      () => {
        if (current()) setError('The preview could not load. Try again.')
      }
    )
  }, [client, previewId, revision, begin])
  // The option's games, the filter as it can be drawn with its rows, and
  // the weeks: worked out again only when the preview, the option or the
  // chosen filter changes, not on every notice, sheet or layout.
  const games = useMemo<PlannedGame[]>(() => {
    const shown = preview?.options[option]
    return preview == null || shown == null
      ? []
      : editedGames(shown, preview.edits, option)
  }, [preview, option])
  const view = useMemo(() => {
    if (preview == null) return undefined
    // What is drawn and applied: the filter put back to all of a row whose
    // choice the season, the option or a reject no longer offers.
    const { filter, choices } = normalizeFilter(chosen, preview, games)
    const zone = viewerTimezone()
    const shown = filteredGames(games, filter)
    const weeks = calendarWeeks(shown, {
      firstDay: weekAnchor(preview, games, filter.seasonId, zone),
      zone
    })
    // Each drawn game's two times, worked out once rather than per render.
    const fieldZones = new Map(
      preview.fields.map(field => [field.id, field.timezone])
    )
    const times = new Map(
      shown.map(game => {
        const fieldZone = fieldZones.get(game.fieldId)
        return [
          game.key,
          {
            box: boxTimeLabel(game, fieldZone, zone),
            full: gameTimeLabel(game, fieldZone, zone)
          }
        ]
      })
    )
    return {
      filter,
      choices,
      weeks,
      times,
      labels: fieldLabels(preview.fields)
    }
  }, [preview, games, chosen])
  // A choice put back to all stays put back: the field whose last game was
  // rejected does not come back chosen when a game returns to it.
  if (view != null && !sameFilter(view.filter, chosen)) setChosen(view.filter)
  const run = useCallback(async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message !== ''
          ? failure.message
          : 'That didn’t work. Try again.'
      )
    } finally {
      setBusy(false)
    }
  }, [])
  if (preview == null || view == null)
    return (
      <Screen>
        <View style={styles.page}>
          {error === '' ? (
            <ActivityIndicator accessibilityLabel="Loading the preview" />
          ) : (
            <>
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
              <Button
                label="Retry"
                onPress={() => {
                  setRevision(value => value + 1)
                }}
              />
            </>
          )}
        </View>
      </Screen>
    )
  const names = new Map(preview.teams.map(team => [team.id, team.name]))
  const teamName = (id: string): string => names.get(id) ?? 'A team'
  const fields = new Map(preview.fields.map(field => [field.id, field]))
  const seasons = new Map(preview.seasons.map(season => [season.id, season]))
  const open = preview.status === 'open'
  const shownOption = preview.options[option]
  const { filter, choices, weeks, times } = view
  const states = new Map(preview.published.map(game => [game.gameKey, game]))
  // The viewed option's rejected games, still to be placed again.
  const rejectedHere =
    open && preview.edits.option === option
      ? preview.edits.rejectedGameKeys.length
      : 0
  const edited =
    preview.edits.option === option &&
    preview.edits.rejectedGameKeys.length + preview.edits.addedGames.length > 0
  // Only an open preview can be recalculated; a published one lists a
  // rejected game for rescheduling instead.
  const canRecalculate = open && edited && !busy
  const fairnessSeasonId = seasons.has(fairnessSeason ?? '')
    ? fairnessSeason
    : preview.seasons[0]?.id
  const choose = (next: Tab): void => {
    selectTab(next)
    setTab(next)
  }
  const recalculate = (): void => {
    run(async () => {
      const next = await client.buildSchedulePreview(leagueId, {
        mode: 'partial',
        fromPreviewId: preview.id,
        option
      })
      onOpenPreview(next.id)
    }).catch(() => undefined)
  }
  const confirmReject = (game: PlannedGame): void => {
    const field = fields.get(game.fieldId)
    const matchup = `${teamName(game.awayTeamId)} at ${teamName(game.homeTeamId)}`
    confirmation.open({
      title: 'Reject this game?',
      detail: `${matchup}, ${gameTimeLabel(game, field?.timezone)}${field == null ? '' : `, ${field.name}, ${field.venueName}`}. ${published ? 'It is listed for rescheduling.' : 'Recalculate places it again; everything else stays.'}`,
      label: 'Reject',
      sheetLabel: 'Reject this game',
      dismissLabel: 'Keep this game',
      run: async current => {
        const next = await client.editSchedulePreview(preview.id, {
          option,
          rejectedGameKeys: [game.key]
        })
        if (!current()) return
        setPreview(next)
        setError('')
        setNotice(
          published
            ? 'Game rejected. It is listed for rescheduling.'
            : 'Game rejected.'
        )
      }
    })
  }
  const box = (game: PlannedGame): React.ReactElement => {
    const field = fields.get(game.fieldId)
    const state = states.get(game.key)?.state
    const canReject =
      open || (published && (state === 'scheduled' || state === 'awaiting'))
    const matchup = `${teamName(game.awayTeamId)} at ${teamName(game.homeTeamId)}`
    const time = times.get(game.key)
    return (
      <View style={styles.box} testID="preview-game">
        <View style={styles.boxTop}>
          <Text style={styles.boxTime}>{time?.box}</Text>
          {game.exhibition && (
            <View style={styles.exhibition} accessibilityLabel="Exhibition">
              <Text style={styles.exhibitionText}>EXH</Text>
            </View>
          )}
        </View>
        {/* Wrapped, never cut: two fields at one park differ at the end. */}
        <Text style={styles.boxDetail}>
          {field == null ? '' : view.labels.get(field.id)}
          {field == null ? '' : ` · ${fieldSizeLabel(game.size)}`}
        </Text>
        <Text style={styles.boxTeam} numberOfLines={2}>
          Home: {teamName(game.homeTeamId)}
        </Text>
        <Text style={styles.boxTeam} numberOfLines={2}>
          Away: {teamName(game.awayTeamId)}
        </Text>
        {state != null && (
          <Text style={styles.boxDetail}>{STATE_LABELS[state]}</Text>
        )}
        {/*
          Last, so it is drawn over the box: a 44-point target in the box's
          top right corner, wholly inside it, whatever lies beneath.
        */}
        {canReject && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reject ${matchup}, ${time?.full}`}
            // Not while a publish, recalculation or added game is on its
            // way, whose answer would land after this one.
            disabled={busy}
            style={({ pressed }) => [
              styles.reject,
              pressed && styles.rejectPressed,
              busy && styles.rejectBusy
            ]}
            onPress={() => {
              confirmReject(game)
            }}
          >
            <Text style={styles.rejectGlyph}>✕</Text>
          </Pressable>
        )}
      </View>
    )
  }
  const week = (shown: CalendarWeek): React.ReactElement => (
    <View key={shown.number} style={styles.week} testID="preview-week">
      <Text style={styles.weekTitle}>{weekTitle(shown)}</Text>
      <View style={styles.weekRow}>
        {shown.days.map(day => (
          <View key={day} style={styles.cell}>
            <Text style={styles.dayHeader}>{dayHeader(day)}</Text>
          </View>
        ))}
      </View>
      {shown.rows.map((row, index) => (
        <View key={index} style={styles.weekRow}>
          {row.map((game, day) => (
            <View key={day} style={styles.cell}>
              {game == null ? <View style={styles.emptyBox} /> : box(game)}
            </View>
          ))}
        </View>
      ))}
    </View>
  )
  const seasonPills = (all: boolean): Array<{ id: string; label: string }> => [
    ...(all ? [{ id: ALL, label: 'All seasons' }] : []),
    ...preview.seasons.map(season => ({ id: season.id, label: season.name }))
  ]
  return (
    <Screen {...pinned.screen} wide>
      <CardBand part={pinned.cardBand}>
        <View style={styles.titleRow}>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          <Button
            label="Recalculate"
            kind="secondary"
            compact
            disabled={!canRecalculate}
            onPress={recalculate}
          />
        </View>
        <Text style={styles.meta}>
          {preview.mode === 'partial'
            ? 'Some teams placed again'
            : 'Every team'}
          {preview.replacing > 0
            ? ` · replaces ${plural(preview.replacing, 'upcoming game')}`
            : ''}
          {published && preview.publishedAt != null
            ? ` · published ${new Date(preview.publishedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}`
            : ''}
        </Text>
        {preview.status === 'discarded' && (
          <Text style={styles.meta}>
            This preview was replaced by a newer one.
          </Text>
        )}
      </CardBand>

      <PillBand part={pinned.pillBand}>
        <View testID="previewPinnedRows">
          <PillTabs
            accessibilityLabel="Preview sections"
            tabs={TABS}
            selected={tab}
            onSelect={choose}
            size="compact"
          />
          <View style={styles.filterStack}>
            {tab === 'schedule' ? (
              <>
                <PillTabs
                  accessibilityLabel="Seasons"
                  size="small"
                  stacked
                  tabs={seasonPills(true)}
                  selected={filter.seasonId ?? ALL}
                  onSelect={id => {
                    setChosen({ ...filter, seasonId: id === ALL ? null : id })
                  }}
                />
                <PillTabs
                  accessibilityLabel="Teams"
                  size="small"
                  stacked
                  tabs={[{ id: ALL, label: 'All teams' }, ...choices.teams]}
                  selected={filter.teamId ?? ALL}
                  onSelect={id => {
                    setChosen({ ...filter, teamId: id === ALL ? null : id })
                  }}
                />
                <PillTabs
                  accessibilityLabel="Fields"
                  size="small"
                  stacked
                  tabs={[{ id: ALL, label: 'All fields' }, ...choices.fields]}
                  selected={filter.fieldId ?? ALL}
                  onSelect={id => {
                    setChosen({ ...filter, fieldId: id === ALL ? null : id })
                  }}
                />
              </>
            ) : (
              <PillTabs
                accessibilityLabel="Fairness seasons"
                size="small"
                stacked
                tabs={seasonPills(false)}
                selected={fairnessSeasonId ?? ''}
                onSelect={setFairnessSeason}
              />
            )}
          </View>
        </View>
      </PillBand>

      <PinnedContent key={tab} part={pinned.content}>
        <View style={styles.page}>
          {error !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          {notice !== '' && (
            <Text accessibilityLiveRegion="polite" style={styles.notice}>
              {notice}
            </Text>
          )}
          {preview.blocking != null ? (
            <View style={styles.warnings} testID="preview-blocking">
              <Text style={styles.warning}>
                No schedule fits: {preview.blocking}.
              </Text>
            </View>
          ) : (
            <>
              {!published && preview.options.length > 1 && (
                <PillTabs
                  accessibilityLabel="Options"
                  tabs={preview.options.map((_, index) => ({
                    id: String(index),
                    label:
                      index === 0
                        ? 'Option 1 · Recommended'
                        : `Option ${index + 1}`
                  }))}
                  selected={String(option)}
                  onSelect={id => {
                    setOption(Number(id))
                  }}
                />
              )}
              {shownOption != null && shownOption.reasons.length > 0 && (
                <View style={styles.section} testID="preview-reasons">
                  <SectionHeader title="Why not Option 1" />
                  {shownOption.reasons.map(reason => (
                    <Text key={reason} style={styles.body}>
                      {reason}
                    </Text>
                  ))}
                </View>
              )}
              {shownOption != null && shownOption.unmet.length > 0 && (
                <View style={styles.section}>
                  <SectionHeader title="What couldn’t be met" />
                  <View style={styles.warnings} testID="preview-unmet">
                    {shownOption.unmet.map(unmet => (
                      <View key={unmet.message} style={styles.section}>
                        <Text style={styles.warning}>
                          {seasons.get(unmet.seasonId)?.name ?? 'A season'}:{' '}
                          {unmet.message}.
                        </Text>
                        <Text style={styles.warningDetail}>
                          Why: {unmet.cause}.
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
              {tab === 'schedule' ? (
                weeks.length === 0 ? (
                  <Text style={styles.meta}>No games match these filters.</Text>
                ) : (
                  <ScrollView
                    horizontal
                    onLayout={event => {
                      setPaneWidth(event.nativeEvent.layout.width)
                    }}
                  >
                    <View
                      style={[
                        styles.calendar,
                        {
                          width: Math.max(
                            paneWidth,
                            theme.rem(7 * COLUMN_REM + 6 * COLUMN_GAP_REM)
                          )
                        }
                      ]}
                    >
                      {weeks.map(week)}
                    </View>
                  </ScrollView>
                )
              ) : (
                shownOption != null && (
                  <ListCard>
                    {shownOption.fairness
                      .filter(row => row.seasonId === fairnessSeasonId)
                      .map(row => (
                        <View
                          key={`${row.seasonId}:${row.teamId}`}
                          style={styles.row}
                          accessibilityLabel={`${teamName(row.teamId)}: ${fairnessLine(row)}`}
                        >
                          <Text style={styles.rowTitle}>
                            {teamName(row.teamId)}
                          </Text>
                          <Text style={styles.rowDetail}>
                            {fairnessLine(row)}
                          </Text>
                        </View>
                      ))}
                  </ListCard>
                )
              )}
              {tab === 'schedule' && (open || published) && (
                <Button
                  label="Add game"
                  kind="secondary"
                  disabled={busy}
                  onPress={() => {
                    setAdding(true)
                  }}
                />
              )}
              {rejectedHere > 0 && (
                <Text style={styles.meta}>
                  {plural(rejectedHere, 'game')} rejected. Recalculate to place
                  them again; everything else stays.
                </Text>
              )}
              {open && shownOption != null && (
                <Button
                  label={busy ? 'Publishing…' : 'Publish this option'}
                  disabled={busy}
                  onPress={() => {
                    run(async () => {
                      const result = await client.publishSchedulePreview(
                        preview.id,
                        option
                      )
                      setPreview(result.preview)
                      setNotice(
                        [
                          `${plural(result.scheduled, 'game')} scheduled`,
                          result.awaiting > 0
                            ? `${plural(result.awaiting, 'game')} waiting for a team’s approval`
                            : '',
                          result.removed > 0
                            ? `${plural(result.removed, 'game')} replaced`
                            : ''
                        ]
                          .filter(part => part !== '')
                          .join(', ') + '.'
                      )
                    }).catch(() => undefined)
                  }}
                />
              )}
            </>
          )}
        </View>
      </PinnedContent>
      <PinnedSpacer part={pinned.spacer} />
      {confirmation.sheet}
      {adding && (
        <AddGameSheet
          preview={preview}
          busy={busy}
          onCancel={() => {
            setAdding(false)
          }}
          onAdd={game => {
            run(async () => {
              setPreview(
                await client.editSchedulePreview(preview.id, {
                  option,
                  addedGames: [game]
                })
              )
              setAdding(false)
              setNotice(published ? 'Game added and proposed.' : 'Game added.')
            }).catch(() => undefined)
          }}
        />
      )}
    </Screen>
  )
}

type Picking =
  'season' | 'home' | 'away' | 'field' | 'size' | 'date' | 'time' | undefined

/** The form for a game added by hand: teams, field, size, date and time. */
function AddGameSheet({
  preview,
  busy,
  onAdd,
  onCancel
}: {
  preview: SchedulePreview
  busy: boolean
  onAdd: (game: {
    seasonId: string
    homeTeamId: string
    awayTeamId: string
    exhibition: boolean
    fieldId: string
    size: FieldSize
    startAt: string
    endAt: string
  }) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [seasonId, setSeasonId] = useState(preview.seasons[0]?.id)
  const [homeTeamId, setHomeTeamId] = useState<string>()
  const [awayTeamId, setAwayTeamId] = useState<string>()
  const [fieldId, setFieldId] = useState<string>()
  const [size, setSize] = useState<FieldSize>()
  const [date, setDate] = useState<string>()
  const [time, setTime] = useState<string>()
  const [exhibition, setExhibition] = useState(false)
  const [picking, setPicking] = useState<Picking>()
  const season = preview.seasons.find(item => item.id === seasonId)
  const teams =
    season == null ? [] : [...season.participants, ...season.exhibitionTeams]
  const name = (id: string | undefined): string =>
    preview.teams.find(team => team.id === id)?.name ?? 'Choose'
  const field = preview.fields.find(item => item.id === fieldId)
  const ready =
    season != null &&
    homeTeamId != null &&
    awayTeamId != null &&
    homeTeamId !== awayTeamId &&
    field != null &&
    size != null &&
    date != null &&
    time != null
  const row = (
    label: string,
    value: string,
    which: Picking
  ): React.ReactElement => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={styles.formRow}
      onPress={() => {
        setPicking(which)
      }}
    >
      <Text style={styles.rowTitle}>{label}</Text>
      <Text style={styles.rowDetail}>{value}</Text>
    </Pressable>
  )
  return (
    <PickerDialog onClose={onCancel} maxWidthRem={32}>
      <View style={styles.dialog}>
        <Text accessibilityRole="header" style={styles.dialogTitle}>
          Add game
        </Text>
        <ListCard>
          {row('Season', season?.name ?? 'Choose', 'season')}
          {row('Home', name(homeTeamId), 'home')}
          {row('Away', name(awayTeamId), 'away')}
          {row(
            'Field',
            field == null ? 'Choose' : `${field.name}, ${field.venueName}`,
            'field'
          )}
          {row('Size', size == null ? 'Choose' : fieldSizeLabel(size), 'size')}
          {row('Date', date ?? 'Choose', 'date')}
          {row('Start', time == null ? 'Choose' : clockLabel(time), 'time')}
          <Text style={styles.formNote}>
            {field == null
              ? 'The date and start are local to the field you choose.'
              : `The date and start are local to ${field.name} at ${field.venueName}.`}
          </Text>
          <CheckRow
            label="Exhibition game"
            checked={exhibition}
            onToggle={() => {
              setExhibition(value => !value)
            }}
          />
        </ListCard>
        <Button
          label="Add this game"
          disabled={!ready || busy}
          onPress={() => {
            if (!ready) return
            // The field's local time, as the engine places games.
            const start = wallInstant(date, time, field.timezone)
            onAdd({
              seasonId: season.id,
              homeTeamId,
              awayTeamId,
              exhibition,
              fieldId: field.id,
              size,
              startAt: new Date(start).toISOString(),
              endAt: new Date(start + season.gameMinutes * 60000).toISOString()
            })
          }}
        />
        <Button label="Cancel" kind="text" onPress={onCancel} />
      </View>
      {picking === 'season' && (
        <ChoiceSheet
          title="Season"
          choices={preview.seasons.map(item => ({
            label: item.name,
            onPress: () => {
              setSeasonId(item.id)
              setHomeTeamId(undefined)
              setAwayTeamId(undefined)
            }
          }))}
          onClose={() => {
            setPicking(undefined)
          }}
        />
      )}
      {(picking === 'home' || picking === 'away') && (
        <ChoiceSheet
          title={picking === 'home' ? 'Home team' : 'Away team'}
          choices={teams.map(id => ({
            label: name(id),
            onPress: () => {
              if (picking === 'home') setHomeTeamId(id)
              else setAwayTeamId(id)
            }
          }))}
          onClose={() => {
            setPicking(undefined)
          }}
        />
      )}
      {picking === 'field' && (
        <ChoiceSheet
          title="Field"
          choices={preview.fields.map(item => ({
            label: `${item.name}, ${item.venueName}`,
            onPress: () => {
              setFieldId(item.id)
              setSize(item.sizes.length === 1 ? item.sizes[0] : undefined)
            }
          }))}
          onClose={() => {
            setPicking(undefined)
          }}
        />
      )}
      {picking === 'size' && field != null && (
        <ChoiceSheet
          title="Size"
          choices={field.sizes.map(item => ({
            label: fieldSizeLabel(item),
            onPress: () => {
              setSize(item)
            }
          }))}
          onClose={() => {
            setPicking(undefined)
          }}
        />
      )}
      {picking === 'date' && (
        <PickerDialog
          onClose={() => {
            setPicking(undefined)
          }}
        >
          <CalendarPicker
            value={date ?? new Date().toISOString().slice(0, 10)}
            onChoose={chosen => {
              setDate(chosen)
              setPicking(undefined)
            }}
            onCancel={() => {
              setPicking(undefined)
            }}
          />
        </PickerDialog>
      )}
      {picking === 'time' && (
        <PickerDialog
          onClose={() => {
            setPicking(undefined)
          }}
        >
          <TimePicker
            value={time ?? '18:00'}
            onChoose={chosen => {
              setTime(chosen)
              setPicking(undefined)
            }}
            onCancel={() => {
              setPicking(undefined)
            }}
          />
        </PickerDialog>
      )}
    </PickerDialog>
  )
}

/** The narrowest a day's column gets before the weeks scroll sideways. */
const COLUMN_REM = 6.75
const COLUMN_GAP_REM = 0.375

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingBottom: theme.rem(6) },
  section: { gap: theme.rem(0.5) },
  headerHandoff: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const
  },
  headerTitle: {
    color: theme.headerTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700' as const
  },
  titleRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75)
  },
  title: {
    flex: 1,
    fontFamily: theme.primaryTextFont,
    fontSize: theme.rem(1.75),
    color: theme.primaryTextColor
  },
  meta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.dangerColor
  },
  notice: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  // The small rows' targets reach 6 above the first pill and below the
  // last, so those targets are 44 tall too.
  filterStack: {
    paddingVertical: theme.rem(0.375)
  },
  // Solid yellow with dark text in every theme, like the early warnings.
  warnings: {
    backgroundColor: '#FFD54F',
    borderRadius: theme.rem(0.75),
    padding: theme.rem(0.75),
    gap: theme.rem(0.5)
  },
  warning: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: '#211B00'
  },
  warningDetail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: '#211B00'
  },
  row: {
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.625),
    gap: theme.rem(0.25)
  },
  rowTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  rowDetail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  // Every week scrolls sideways together on a phone; on a wide pane the
  // seven columns share its whole width.
  calendar: {
    gap: theme.rem(1.25)
  },
  week: { gap: theme.rem(COLUMN_GAP_REM) },
  weekTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  weekRow: {
    flexDirection: 'row' as const,
    gap: theme.rem(COLUMN_GAP_REM)
  },
  cell: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0
  },
  dayHeader: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    color: theme.secondaryTextColor,
    textAlign: 'center' as const
  },
  emptyBox: {
    flex: 1,
    minHeight: theme.rem(5),
    borderRadius: theme.rem(0.5),
    borderWidth: 1,
    borderStyle: 'dashed' as const,
    borderColor: theme.defaultBorderColor
  },
  box: {
    flex: 1,
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(0.5),
    gap: theme.rem(0.125)
  },
  // Room on the right for the ✕ drawn over the box's corner.
  boxTop: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: theme.rem(0.25),
    paddingRight: theme.rem(1.5)
  },
  boxTime: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.primaryTextColor
  },
  boxDetail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  },
  boxTeam: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.primaryTextColor
  },
  // Black with white letters in every theme, so it reads as a tag.
  exhibition: {
    backgroundColor: '#000000',
    borderRadius: theme.radiusPill,
    paddingHorizontal: theme.rem(0.375),
    paddingVertical: theme.rem(0.0625)
  },
  exhibitionText: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(0.625),
    fontWeight: '700' as const,
    color: '#FFFFFF'
  },
  // A 44-point target around a small glyph, reaching into the box's padding
  // so it does not push the box taller.
  reject: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    width: theme.rem(2.75),
    height: theme.rem(2.75),
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  },
  rejectPressed: { opacity: 0.6 },
  rejectBusy: { opacity: 0.4 },
  rejectGlyph: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    lineHeight: theme.rem(1.25),
    color: theme.dangerColor
  },
  formRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(1)
  },
  dialog: { gap: theme.rem(0.75), padding: theme.rem(1) },
  formNote: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor,
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.5)
  },
  dialogTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor
  }
}))
