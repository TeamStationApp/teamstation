import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { buildable, schedulingChecks } from '../../common/schedulingChecks'
import {
  BUFFER_MINUTES,
  DOUBLEHEADERS,
  doubleheadersLabel,
  GAME_MINUTES,
  MAX_GAMES,
  type ScheduleSettings,
  type ScheduleSetup,
  type SetupSeason
} from '../../common/seasonScheduling'
import { FIELD_SIZES, fieldSizeLabel } from '../../common/venues'
import {
  Button,
  ListCard,
  ListRow,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import { CheckRow } from '../components/CheckRow'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { DateRangePicker } from '../components/DateRangePicker'
import { PickerDialog } from '../components/PickerDialog'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { type GridColumn, SeasonScheduleGrid } from './SeasonScheduleGrid'
import { sizesLabel } from './VenueScreen'

type NumberColumn =
  'gameMinutes' | 'bufferMinutes' | 'regularGames' | 'exhibitionGames'

const NUMBERS: Record<
  NumberColumn,
  { label: string; min: number; max: number; step: number }
> = {
  gameMinutes: { label: 'Game length, in minutes', ...GAME_MINUTES, step: 5 },
  bufferMinutes: {
    label: 'Time between games, in minutes',
    ...BUFFER_MINUTES,
    step: 5
  },
  regularGames: {
    label: 'Regular-season games per team',
    min: 0,
    max: MAX_GAMES,
    step: 1
  },
  exhibitionGames: {
    label: 'Exhibition games per team',
    min: 0,
    max: MAX_GAMES,
    step: 1
  }
}

/** The run's chosen seasons, in the league's order. */
export function chosenSeasons(setup: ScheduleSetup): SetupSeason[] {
  return setup.seasons.filter(season => setup.seasonIds.includes(season.id))
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
  onBuild
}: {
  client: TeamStationClient
  leagueId: string
  leagueName?: string
  onFieldManager: () => void
  onOpenSeason: (seasonId: string) => void
  onBuild?: () => void
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
  const [numberText, setNumberText] = useState('')
  const [numberError, setNumberError] = useState('')
  const begin = useLatestRequest()
  useEffect(() => {
    const current = begin()
    setError('')
    client.scheduleSetup(leagueId).then(
      found => {
        if (current()) setSetup(found)
      },
      () => {
        if (current()) setError('The Auto-Scheduler could not load. Try again.')
      }
    )
  }, [client, leagueId, revision, begin])
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
  const saveSettings = async (
    season: SetupSeason,
    changes: Partial<ScheduleSettings>
  ): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const saved = await client.saveScheduleSettings(season.id, {
        ...season.settings,
        ...changes
      })
      setSetup(current =>
        current == null
          ? current
          : {
              ...current,
              seasons: current.seasons.map(item =>
                item.id === season.id
                  ? { ...item, saved: true, settings: saved.settings }
                  : item
              )
            }
      )
      return true
    } catch (failure) {
      failed(failure)
      return false
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
    const season = setup.seasons.find(item => item.id === seasonId)
    if (season != null && column in NUMBERS)
      setNumberText(String(season.settings[column as NumberColumn]))
    setNumberError('')
    setEditing({ seasonId, column })
  }
  const close = (): void => {
    setEditing(undefined)
  }
  const numberColumn =
    editing != null && editing.column in NUMBERS
      ? (editing.column as NumberColumn)
      : undefined
  const saveNumber = (): void => {
    if (editedSeason == null || numberColumn == null) return
    const rule = NUMBERS[numberColumn]
    const value = Number(numberText.trim())
    if (
      numberText.trim() === '' ||
      !Number.isInteger(value) ||
      value < rule.min ||
      value > rule.max ||
      value % rule.step !== 0
    ) {
      setNumberError(
        `Choose ${rule.min} to ${rule.max}${rule.step === 1 ? '' : `, in ${rule.step}-minute steps`}.`
      )
      return
    }
    saveSettings(editedSeason, { [numberColumn]: value })
      .then(ok => {
        if (ok) close()
      })
      .catch(() => undefined)
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
              onOpenSeason={onOpenSeason}
            />
          </>
        )}
        <SectionHeader
          title="Fields for this run"
          note={String(fields.length)}
          actions={[
            {
              label: 'Field Manager',
              accessibilityLabel: 'Open the Field Manager',
              onPress: onFieldManager
            }
          ]}
        />
        {setup.fields.length === 0 ? (
          <Text style={styles.meta}>
            Your league has no fields yet. Claim a venue and add its fields in
            the Field Manager.
          </Text>
        ) : (
          <ListCard>
            {setup.fields.map(field => (
              <CheckRow
                key={field.id}
                label={`${field.name}, ${field.venueName}`}
                detail={
                  field.deleted
                    ? 'Deleted. Uncheck it to leave it out.'
                    : sizesLabel(field.sizes)
                }
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
          label="Build schedule"
          disabled={busy || !buildable(checks)}
          onPress={() => {
            onBuild?.()
          }}
        />
      </View>
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
      {editedSeason != null && numberColumn != null && (
        <PickerDialog onClose={close}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>{editedSeason.name}</Text>
            <TextField
              label={NUMBERS[numberColumn].label}
              value={numberText}
              onChangeText={setNumberText}
              keyboardType="number-pad"
              autoFocus
              error={numberError === '' ? undefined : numberError}
              onSubmitEditing={saveNumber}
            />
            <Button label="Save" disabled={busy} onPress={saveNumber} />
            <Button label="Cancel" kind="text" onPress={close} />
          </View>
        </PickerDialog>
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
  },
  dialog: { gap: theme.rem(0.75), padding: theme.rem(1) },
  dialogTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor
  }
}))
