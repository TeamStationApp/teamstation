import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

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
  ListCard,
  PillTabs,
  Screen,
  SectionHeader
} from '../components'
import { CheckRow } from '../components/CheckRow'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { DangerText } from '../components/DangerText'
import { CalendarPicker, TimePicker } from '../components/EventScheduleFields'
import { PickerDialog } from '../components/PickerDialog'
import { clockLabel, WEEKDAYS } from '../components/WeeklyHoursEditor'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

type View3 = 'season' | 'team' | 'field'

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
  const zone =
    fieldZone == null ? '' : foreignZoneName(game.startAt, fieldZone, viewer)
  if (zone === '' || fieldZone == null) return range
  const sameDay =
    gameCalendarDay(game.startAt, fieldZone) ===
    gameCalendarDay(game.startAt, viewer)
  const there = new Intl.DateTimeFormat('en', {
    timeZone: fieldZone,
    ...(sameDay ? {} : { weekday: 'short' as const }),
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(game.startAt))
  return `${range} · ${there} ${zone} at the field`
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
 * games by season, team or field, its fairness summary, what it couldn't
 * meet and why it trails the recommended one. Games can be rejected and
 * added, the option recalculated, and published.
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
  const [view, setView] = useState<View3>('season')
  const [adding, setAdding] = useState(false)
  const begin = useLatestRequest()
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
  if (preview == null)
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
  const published = preview.status === 'published'
  const open = preview.status === 'open'
  const chosen = preview.options[option]
  const games: PlannedGame[] =
    chosen == null
      ? []
      : editedGames(
          chosen,
          {
            ...preview.edits,
            addedGames: preview.edits.addedGames
          },
          option
        )
  const states = new Map(preview.published.map(game => [game.gameKey, game]))
  const rejectedHere =
    open && preview.edits.option === option
      ? preview.edits.rejectedGameKeys.length
      : 0
  const groups: Array<{ id: string; title: string; games: PlannedGame[] }> =
    view === 'season'
      ? preview.seasons.map(season => ({
          id: season.id,
          title: season.name,
          games: games.filter(game => game.seasonId === season.id)
        }))
      : view === 'field'
        ? preview.fields.map(field => ({
            id: field.id,
            title: `${field.name}, ${field.venueName}`,
            games: games.filter(game => game.fieldId === field.id)
          }))
        : preview.teams
            .map(team => ({
              id: team.id,
              title: team.name,
              games: games.filter(
                game =>
                  game.homeTeamId === team.id || game.awayTeamId === team.id
              )
            }))
            .filter(group => group.games.length > 0)
  const reject = (key: string): void => {
    run(async () => {
      setPreview(
        await client.editSchedulePreview(preview.id, {
          option,
          rejectedGameKeys: [key]
        })
      )
      setNotice(
        published
          ? 'Game rejected. It is listed for rescheduling.'
          : 'Game rejected.'
      )
    }).catch(() => undefined)
  }
  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          {published ? 'Published schedule' : 'Schedule preview'}
        </Text>
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
            <PillTabs
              accessibilityLabel="Group games"
              size="compact"
              tabs={[
                { id: 'season', label: 'By season' },
                { id: 'team', label: 'By team' },
                { id: 'field', label: 'By field' }
              ]}
              selected={view}
              onSelect={id => {
                setView(id)
              }}
            />
            {chosen != null && chosen.reasons.length > 0 && (
              <View style={styles.section} testID="preview-reasons">
                <SectionHeader title="Why not Option 1" />
                {chosen.reasons.map(reason => (
                  <Text key={reason} style={styles.body}>
                    {reason}
                  </Text>
                ))}
              </View>
            )}
            {chosen != null && chosen.unmet.length > 0 && (
              <View style={styles.section}>
                <SectionHeader title="What couldn’t be met" />
                <View style={styles.warnings} testID="preview-unmet">
                  {chosen.unmet.map(unmet => (
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
            {chosen != null && (
              <>
                <SectionHeader
                  title="Fairness"
                  note={String(chosen.fairness.length)}
                />
                <ListCard>
                  {chosen.fairness.map(row => (
                    <View
                      key={`${row.seasonId}:${row.teamId}`}
                      style={styles.row}
                      accessibilityLabel={`${teamName(row.teamId)}: ${fairnessLine(row)}`}
                    >
                      <Text style={styles.rowTitle}>
                        {teamName(row.teamId)}
                      </Text>
                      <Text style={styles.rowDetail}>{fairnessLine(row)}</Text>
                    </View>
                  ))}
                </ListCard>
              </>
            )}
            {groups.map(group => (
              <View key={group.id} style={styles.section}>
                <SectionHeader
                  title={group.title}
                  note={plural(group.games.length, 'game')}
                />
                {group.games.length > 0 && (
                  <ListCard>
                    {group.games.map(game => {
                      const field = fields.get(game.fieldId)
                      const state = states.get(game.key)?.state
                      const matchup = `${teamName(game.awayTeamId)} at ${teamName(game.homeTeamId)}`
                      const canReject =
                        open ||
                        (published &&
                          (state === 'scheduled' || state === 'awaiting'))
                      return (
                        <View key={game.key} style={styles.gameRow}>
                          <View style={styles.gameText}>
                            <Text style={styles.rowTitle}>
                              {matchup}
                              {game.exhibition ? ' · Exhibition' : ''}
                            </Text>
                            <Text style={styles.rowDetail}>
                              {gameTimeLabel(game, field?.timezone)}
                            </Text>
                            <Text style={styles.rowDetail}>
                              {field == null
                                ? ''
                                : `${field.name}, ${field.venueName} · ${fieldSizeLabel(game.size)}`}
                              {state == null ? '' : ` · ${STATE_LABELS[state]}`}
                            </Text>
                          </View>
                          {canReject && (
                            <View style={styles.rejectCell}>
                              <DangerText
                                label="Reject"
                                accessibilityLabel={`Reject ${matchup}, ${gameTimeLabel(game, field?.timezone)}`}
                                onPress={() => {
                                  reject(game.key)
                                }}
                              />
                            </View>
                          )}
                        </View>
                      )
                    })}
                  </ListCard>
                )}
              </View>
            ))}
            {rejectedHere > 0 && (
              <>
                <Text style={styles.meta}>
                  {plural(rejectedHere, 'game')} rejected. Recalculate to place
                  them again; everything else stays.
                </Text>
                <Button
                  label="Recalculate"
                  kind="secondary"
                  disabled={busy}
                  onPress={() => {
                    run(async () => {
                      const next = await client.buildSchedulePreview(leagueId, {
                        mode: 'partial',
                        fromPreviewId: preview.id,
                        option
                      })
                      onOpenPreview(next.id)
                    }).catch(() => undefined)
                  }}
                />
              </>
            )}
            {(open || published) && (
              <Button
                label="Add game"
                kind="secondary"
                disabled={busy}
                onPress={() => {
                  setAdding(true)
                }}
              />
            )}
            {open && chosen != null && (
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

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingBottom: theme.rem(6) },
  section: { gap: theme.rem(0.5) },
  title: {
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
  gameRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    minHeight: theme.rem(3.5)
  },
  gameText: {
    flex: 1,
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.5),
    gap: theme.rem(0.125)
  },
  rejectCell: {
    alignSelf: 'stretch' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: theme.rem(1),
    borderLeftWidth: 1,
    borderLeftColor: theme.defaultBorderColor
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
