import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { viewerTimezone } from '../../common/eventTime'
import { isRecord } from '../../common/groupCreation'
import {
  type GameToReschedule,
  type PreviewRequest,
  rescheduleReasonLabel
} from '../../common/schedulePreviews'
import { buildable, schedulingChecks } from '../../common/schedulingChecks'
import {
  DOUBLEHEADERS,
  doubleheadersLabel,
  type ScheduleSettings,
  type ScheduleSetup,
  seasonZone,
  type SetupField,
  type SetupSeason
} from '../../common/seasonScheduling'
import { FIELD_SIZES, fieldSizeLabel } from '../../common/venues'
import { Button, ListCard, ListRow, Screen, SectionHeader } from '../components'
import { CheckRow } from '../components/CheckRow'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { DateRangePicker } from '../components/DateRangePicker'
import { PickerDialog } from '../components/PickerDialog'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { FieldPickerScene } from './FieldPickerScene'
import { gameTimeLabel } from './SchedulePreviewScreen'
import { type GridColumn, SeasonScheduleGrid } from './SeasonScheduleGrid'
import { sizesLabel } from './VenueScreen'

/** The run's chosen seasons, in the league's order. */
export function chosenSeasons(setup: ScheduleSetup): SetupSeason[] {
  return setup.seasons.filter(season => setup.seasonIds.includes(season.id))
}

/**
 * A run field's detail: its sizes, and, for a field of a venue the league
 * doesn't own, the venue and who owns it.
 */
export function setupFieldDetail(field: SetupField): string {
  if (field.deleted) return 'Deleted. Uncheck it to leave it out.'
  const sizes = sizesLabel(field.sizes)
  if (field.ours) return sizes
  const owners =
    field.ownerNames.length === 0
      ? 'unclaimed'
      : `claimed by ${field.ownerNames.join(', ')}`
  return `${sizes} · ${field.venueName} · ${owners}`
}

/**
 * A league's Auto-Scheduler: the venues and fields the league plays on, and
 * the setup of its next schedule. Its admin chooses seasons, sets each one's
 * numbers in a grid, chooses the fields, reads the early warnings, and
 * builds.
 */
export function AutoSchedulerScreen({
  client,
  leagueId,
  leagueName,
  onFieldManager,
  onOpenSeason,
  onOpenPreview
}: {
  client: TeamStationClient
  leagueId: string
  leagueName?: string
  onFieldManager: () => void
  onOpenSeason: (seasonId: string) => void
  onOpenPreview: (previewId: string) => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [setup, setSetup] = useState<ScheduleSetup>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{
    seasonId: string
    column: GridColumn
  }>()
  const [toReschedule, setToReschedule] = useState<GameToReschedule[]>([])
  const [asking, setAsking] = useState<{ existing: number }>()
  const [building, setBuilding] = useState(false)
  const [picking, setPicking] = useState(false)
  // Each season's save in flight, which its next save waits for, and the
  // settings and zone its last save stored, which that next save builds on,
  // so a sheet's save can't send back a number a cell's save just changed.
  const saving = useRef(new Map<string, Promise<unknown>>())
  const stored = useRef(
    new Map<string, Pick<SetupSeason, 'settings' | 'timezone'>>()
  )
  const begin = useLatestRequest()
  useEffect(() => {
    const current = begin()
    setError('')
    Promise.all([
      client.scheduleSetup(leagueId),
      client.gamesToReschedule(leagueId)
    ]).then(
      ([found, listed]) => {
        if (!current()) return
        stored.current.clear()
        setSetup(found)
        setToReschedule(listed)
      },
      () => {
        if (current()) setError('The Auto-Scheduler could not load. Try again.')
      }
    )
  }, [client, leagueId, revision, begin])
  /**
   * Builds a preview and opens it. A first build of seasons that already
   * have upcoming games asks whether to replace them or work around them.
   */
  const build = async (request: PreviewRequest): Promise<void> => {
    setBuilding(true)
    setError('')
    try {
      // Seasons still at the UTC default are built in the viewer's zone.
      const preview = await client.buildSchedulePreview(leagueId, {
        ...request,
        timezone: viewerTimezone()
      })
      onOpenPreview(preview.id)
    } catch (failure) {
      const details =
        failure instanceof HttpError && isRecord(failure.details)
          ? failure.details
          : undefined
      if (details != null && typeof details.existingGames === 'number')
        setAsking({ existing: details.existingGames })
      else failed(failure)
    } finally {
      setBuilding(false)
    }
  }
  const failed = (failure: unknown): void => {
    setError(
      failure instanceof Error && failure.message !== ''
        ? failure.message
        : 'That could not be saved. Try again.'
    )
  }
  const choose = useCallback(
    async (choice: { seasonIds: string[]; fieldIds: string[] }) => {
      setBusy(true)
      setError('')
      try {
        setSetup(await client.saveScheduleSetup(leagueId, choice))
      } catch (failure) {
        failed(failure)
      } finally {
        setBusy(false)
      }
    },
    [client, leagueId]
  )
  /**
   * Saves a season's settings and merges the answer into the setup. It
   * resolves null, or the message saying why it failed, and leaves the rest
   * of the screen usable, so a grid cell can show its own failure. A
   * season's saves go one at a time, each onto what the one before stored.
   */
  const storeSettings = async (
    season: SetupSeason,
    changes: Partial<ScheduleSettings>
  ): Promise<string | null> => {
    const before = saving.current.get(season.id)
    const next = (async () => {
      await before
      return await sendSettings(season, changes)
    })()
    saving.current.set(season.id, next)
    try {
      return await next
    } finally {
      if (saving.current.get(season.id) === next)
        saving.current.delete(season.id)
    }
  }
  const sendSettings = async (
    shown: SetupSeason,
    changes: Partial<ScheduleSettings>
  ): Promise<string | null> => {
    const season = { ...shown, ...stored.current.get(shown.id) }
    // A season still at the UTC default is set up in the viewer's zone,
    // which the save stores on it.
    const zone = seasonZone(season)
    try {
      const saved = await client.saveScheduleSettings(
        season.id,
        { ...season.settings, ...changes },
        zone === season.timezone ? {} : { timezone: zone }
      )
      stored.current.set(season.id, {
        settings: saved.settings,
        timezone: saved.timezone
      })
      setSetup(current =>
        current == null
          ? current
          : {
              ...current,
              seasons: current.seasons.map(item =>
                item.id === season.id
                  ? {
                      ...item,
                      saved: true,
                      timezone: saved.timezone,
                      settings: saved.settings
                    }
                  : item
              )
            }
      )
      return null
    } catch (failure) {
      return failure instanceof Error && failure.message !== ''
        ? failure.message
        : 'That could not be saved. Try again.'
    }
  }
  /** A sheet's save, whose failure shows at the top of the screen. */
  const saveSettings = async (
    season: SetupSeason,
    changes: Partial<ScheduleSettings>
  ): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const failure = await storeSettings(season, changes)
      if (failure != null) setError(failure)
      return failure == null
    } finally {
      setBusy(false)
    }
  }
  if (setup == null)
    return (
      <Screen>
        <View style={styles.page}>
          <Text accessibilityRole="header" style={styles.title}>
            Auto-Scheduler
          </Text>
          {error === '' ? (
            <ActivityIndicator accessibilityLabel="Loading the Auto-Scheduler" />
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
  const seasons = chosenSeasons(setup)
  const fields = setup.fields.filter(field => setup.fieldIds.includes(field.id))
  const checks = schedulingChecks(seasons, fields)
  // A field deleted since it was chosen can't be chosen again, so any change
  // leaves it out.
  const liveFieldIds = fields
    .filter(field => !field.deleted)
    .map(field => field.id)
  const editedSeason =
    editing == null
      ? undefined
      : setup.seasons.find(season => season.id === editing.seasonId)
  const edit = (seasonId: string, column: GridColumn): void => {
    if (column === 'teams' || column === 'blackouts' || column === 'windows') {
      onOpenSeason(seasonId)
      return
    }
    setEditing({ seasonId, column })
  }
  const close = (): void => {
    setEditing(undefined)
  }
  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          Auto-Scheduler
        </Text>
        {leagueName != null && <Text style={styles.meta}>{leagueName}</Text>}
        <ListCard>
          <ListRow
            title="Field Manager"
            subtitle="Find, claim and set up the venues and fields your league plays on"
            emblemIcon="stadium"
            onPress={onFieldManager}
          />
        </ListCard>
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <SectionHeader title="Seasons" note={String(seasons.length)} />
        {setup.seasons.length === 0 ? (
          <Text style={styles.meta}>
            This league has no seasons yet. A schedule is built for a season of
            the league.
          </Text>
        ) : (
          <ListCard>
            {setup.seasons.map(season => (
              <CheckRow
                key={season.id}
                label={season.name}
                detail={`${season.year} · ${season.participants} teams${season.exhibitionTeams === 0 ? '' : `, ${season.exhibitionTeams} exhibition`}`}
                checked={setup.seasonIds.includes(season.id)}
                disabled={busy}
                onToggle={() => {
                  const on = setup.seasonIds.includes(season.id)
                  choose({
                    seasonIds: setup.seasons
                      .map(item => item.id)
                      .filter(id =>
                        id === season.id ? !on : setup.seasonIds.includes(id)
                      ),
                    fieldIds: liveFieldIds
                  }).catch(() => undefined)
                }}
              />
            ))}
          </ListCard>
        )}
        {seasons.length > 0 && (
          <>
            <SectionHeader title="Schedule settings" />
            <Text style={styles.meta}>
              Tap a setting to change it, or a season for its windows, blackout
              days and exhibition teams.
            </Text>
            <SeasonScheduleGrid
              seasons={seasons}
              onEdit={edit}
              onSaveNumber={async (seasonId, column, value) =>
                await storeSettings(
                  // The grid shows only the setup's own seasons.
                  setup.seasons.find(item => item.id === seasonId)!,
                  { [column]: value }
                )
              }
              onOpenSeason={onOpenSeason}
            />
          </>
        )}
        <SectionHeader
          title="Fields for this run"
          note={String(fields.length)}
          // Beside two actions, a phone wraps the title rather than cut it.
          titleLines={2}
          actions={[
            {
              label: 'Add field',
              accessibilityLabel: 'Add a field to this run',
              onPress: () => {
                setPicking(true)
              }
            },
            {
              label: 'Field Manager',
              accessibilityLabel: 'Open the Field Manager',
              onPress: onFieldManager
            }
          ]}
        />
        {setup.fields.length === 0 ? (
          <Text style={styles.meta}>
            Add any field in the registry, or claim a venue and add its fields
            in the Field Manager.
          </Text>
        ) : (
          <ListCard>
            {setup.fields.map(field => (
              <CheckRow
                key={field.id}
                label={`${field.name}, ${field.venueName}`}
                detail={setupFieldDetail(field)}
                checked={setup.fieldIds.includes(field.id)}
                disabled={busy}
                onToggle={() => {
                  const on = setup.fieldIds.includes(field.id)
                  choose({
                    seasonIds: setup.seasonIds,
                    fieldIds: setup.fields
                      .map(item => item.id)
                      .filter(id =>
                        id === field.id ? !on : liveFieldIds.includes(id)
                      )
                  }).catch(() => undefined)
                }}
              />
            ))}
          </ListCard>
        )}
        <SectionHeader title="Early warnings" note={String(checks.length)} />
        {checks.length === 0 ? (
          <Text style={styles.meta}>No early warnings.</Text>
        ) : (
          <View style={styles.warnings} testID="early-warnings">
            {checks.map(check => (
              <Text
                key={`${check.kind}:${check.message}`}
                style={styles.warning}
              >
                {check.blocking ? 'Must fix: ' : ''}
                {check.message}
              </Text>
            ))}
          </View>
        )}
        <Button
          label={building ? 'Building schedule…' : 'Build schedule'}
          disabled={busy || building || !buildable(checks)}
          onPress={() => {
            build({ mode: 'full' }).catch(() => undefined)
          }}
        />
        {toReschedule.length > 0 && (
          <>
            <SectionHeader
              title="Needs rescheduling"
              note={String(toReschedule.length)}
            />
            <View testID="needs-rescheduling">
              <ListCard>
                {toReschedule.map(game => (
                  <ListRow
                    key={`${game.previewId}:${game.gameKey}`}
                    title={`${game.awayTeamName} at ${game.homeTeamName}`}
                    subtitle={`${rescheduleReasonLabel(game.reason)}\n${gameTimeLabel(game, game.timezone)}`}
                    subtitleNumberOfLines={3}
                  />
                ))}
              </ListCard>
            </View>
            <Button
              label="Recalculate just these teams"
              disabled={busy || building}
              onPress={() => {
                build({
                  mode: 'partial',
                  existing: 'replace',
                  teamIds: [
                    ...new Set(
                      toReschedule.flatMap(game => [
                        game.homeTeamId,
                        game.awayTeamId
                      ])
                    )
                  ]
                }).catch(() => undefined)
              }}
            />
            <Button
              label="Recalculate everything"
              kind="secondary"
              disabled={busy || building || !buildable(checks)}
              onPress={() => {
                build({ mode: 'full' }).catch(() => undefined)
              }}
            />
          </>
        )}
      </View>
      {picking && (
        <FieldPickerScene
          client={client}
          onChooseField={chosen => {
            setPicking(false)
            choose({
              seasonIds: setup.seasonIds,
              fieldIds: [
                ...liveFieldIds.filter(id => id !== chosen.id),
                chosen.id
              ]
            }).catch(() => undefined)
          }}
          onClose={() => {
            setPicking(false)
          }}
        />
      )}
      {asking != null && (
        <ChoiceSheet
          title={`These seasons already have ${asking.existing === 1 ? 'an upcoming game' : `${asking.existing} upcoming games`}`}
          choices={[
            {
              label: 'Replace them',
              detail:
                'Schedule your league’s upcoming games again. Played games, and games a team outside the league agreed to, stay.',
              onPress: () => {
                build({ mode: 'full', existing: 'replace' }).catch(
                  () => undefined
                )
              }
            },
            {
              label: 'Work around them',
              detail: 'Keep every upcoming game and schedule around it.',
              onPress: () => {
                build({ mode: 'full', existing: 'workAround' }).catch(
                  () => undefined
                )
              }
            }
          ]}
          onClose={() => {
            setAsking(undefined)
          }}
        />
      )}
      {editedSeason != null && editing?.column === 'fieldSize' && (
        <ChoiceSheet
          title={`${editedSeason.name}: field size`}
          choices={FIELD_SIZES.map(size => ({
            label: fieldSizeLabel(size),
            detail:
              size === editedSeason.settings.fieldSize ? 'Chosen' : undefined,
            onPress: () => {
              saveSettings(editedSeason, { fieldSize: size }).catch(
                () => undefined
              )
            }
          }))}
          onClose={close}
        />
      )}
      {editedSeason != null && editing?.column === 'doubleheaders' && (
        <ChoiceSheet
          title={`${editedSeason.name}: doubleheaders`}
          choices={DOUBLEHEADERS.map(value => ({
            label: doubleheadersLabel(value),
            detail:
              value === 'never'
                ? 'No team plays twice in a day'
                : value === 'ifNecessary'
                  ? 'Only when the games don’t fit otherwise'
                  : 'Teams may play twice in a day',
            onPress: () => {
              saveSettings(editedSeason, { doubleheaders: value }).catch(
                () => undefined
              )
            }
          }))}
          onClose={close}
        />
      )}
      {editedSeason != null && editing?.column === 'dates' && (
        <PickerDialog onClose={close}>
          <DateRangePicker
            initial={{
              startsOn: editedSeason.settings.startsOn,
              endsOn: editedSeason.settings.endsOn
            }}
            onChoose={range => {
              close()
              saveSettings(editedSeason, range).catch(() => undefined)
            }}
            onCancel={close}
          />
        </PickerDialog>
      )}
    </Screen>
  )
}

export const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingBottom: theme.rem(6) },
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
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.dangerColor
  },
  // Solid yellow with dark text in every theme, like a game's field warnings.
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
  }
}))
