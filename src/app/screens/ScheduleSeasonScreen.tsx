import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { WindowPeriod } from '../../common/fieldAvailability'
import type {
  ScheduleSettings,
  SetupSeason
} from '../../common/seasonScheduling'
import { Button, ListCard, Screen, SectionHeader } from '../components'
import {
  BlackoutDatesEditor,
  dateLabel
} from '../components/BlackoutDatesEditor'
import { CheckRow } from '../components/CheckRow'
import { DangerText } from '../components/DangerText'
import { CalendarPicker } from '../components/EventScheduleFields'
import { PickerDialog } from '../components/PickerDialog'
import { WeeklyHoursEditor } from '../components/WeeklyHoursEditor'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * One season of a league's next schedule: its game windows, which can
 * change on dates during the season, its blackout days, and which of its
 * teams are exhibition teams.
 */
export function ScheduleSeasonScreen({
  client,
  leagueId,
  seasonId
}: {
  client: TeamStationClient
  leagueId: string
  seasonId: string
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [season, setSeason] = useState<SetupSeason | null>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [addingPeriod, setAddingPeriod] = useState(false)
  const begin = useLatestRequest()
  useEffect(() => {
    const current = begin()
    setError('')
    client.scheduleSetup(leagueId).then(
      setup => {
        if (current())
          setSeason(setup.seasons.find(item => item.id === seasonId) ?? null)
      },
      () => {
        if (current()) setError('The season could not load. Try again.')
      }
    )
  }, [client, leagueId, seasonId, revision, begin])
  const run = useCallback(
    async (work: () => Promise<void>, done: string): Promise<void> => {
      setBusy(true)
      setError('')
      setNotice('')
      try {
        await work()
        setNotice(done)
      } catch (failure) {
        setError(
          failure instanceof Error && failure.message !== ''
            ? failure.message
            : 'That could not be saved. Try again.'
        )
      } finally {
        setBusy(false)
      }
    },
    []
  )
  if (season == null)
    return (
      <Screen>
        <View style={styles.page}>
          {season === null ? (
            <Text style={styles.meta}>
              This season is no longer part of the league.
            </Text>
          ) : error === '' ? (
            <ActivityIndicator accessibilityLabel="Loading the season" />
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
  const settings = season.settings
  const save = (changes: Partial<ScheduleSettings>, done: string): void => {
    run(async () => {
      const saved = await client.saveScheduleSettings(season.id, {
        ...settings,
        ...changes
      })
      setSeason({ ...season, saved: true, settings: saved.settings })
    }, done).catch(() => undefined)
  }
  const setWindows = (windows: WindowPeriod[], done: string): void => {
    save({ windows }, done)
  }
  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          {season.name}
        </Text>
        <Text style={styles.meta}>Times are local to each field.</Text>
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
        <SectionHeader
          title="Game windows"
          note={String(settings.windows.length)}
        />
        <Text style={styles.meta}>
          When games may be played each week. A period is in force from its date
          until the next period begins.
        </Text>
        {settings.windows.length === 0 && (
          <Text style={styles.meta}>No game windows yet.</Text>
        )}
        {settings.windows.map((period, index) => {
          const from = dateLabel(period.from)
          return (
            <View key={period.from} style={styles.period}>
              <View style={styles.periodHead}>
                <Text style={styles.periodTitle}>From {from}</Text>
                <DangerText
                  label="Remove"
                  accessibilityLabel={`Remove the windows from ${from}`}
                  onPress={() => {
                    setWindows(
                      settings.windows.filter((_, i) => i !== index),
                      'Period removed.'
                    )
                  }}
                />
              </View>
              <WeeklyHoursEditor
                label={`Windows from ${from}`}
                value={period.hours}
                disabled={busy}
                onChange={hours => {
                  setWindows(
                    settings.windows.map((item, i) =>
                      i === index ? { ...item, hours } : item
                    ),
                    'Windows saved.'
                  )
                }}
              />
            </View>
          )
        })}
        <Button
          label={
            settings.windows.length === 0
              ? 'Add game windows'
              : 'Add a period from a date'
          }
          kind="secondary"
          disabled={busy}
          onPress={() => {
            if (settings.windows.length === 0)
              setWindows(
                [{ from: settings.startsOn, hours: [] }],
                'Period added.'
              )
            else setAddingPeriod(true)
          }}
        />
        <SectionHeader
          title="Blackout days"
          note={String(settings.blackouts.length)}
        />
        <BlackoutDatesEditor
          value={settings.blackouts}
          disabled={busy}
          today={settings.startsOn}
          empty="No blackout days. Games may be played any day of the season."
          onChange={blackouts => {
            save({ blackouts }, 'Blackout days saved.')
          }}
        />
        <SectionHeader
          title="Exhibition teams"
          note={String(season.exhibitionTeams)}
        />
        <Text style={styles.meta}>
          Check the teams that play only exhibition games. Each other team plays
          its exhibition games against them.
        </Text>
        {season.teams.length === 0 ? (
          <Text style={styles.meta}>This season has no teams yet.</Text>
        ) : (
          <ListCard>
            {season.teams.map(team => (
              <CheckRow
                key={team.id}
                label={team.name}
                detail={team.exhibition ? 'Exhibition team' : 'Participant'}
                checked={team.exhibition}
                disabled={busy}
                onToggle={() => {
                  run(async () => {
                    await client.setExhibitionTeam(
                      season.id,
                      team.id,
                      !team.exhibition
                    )
                    const teams = season.teams.map(item =>
                      item.id === team.id
                        ? { ...item, exhibition: !team.exhibition }
                        : item
                    )
                    const flagged = teams.filter(item => item.exhibition).length
                    setSeason({
                      ...season,
                      teams,
                      exhibitionTeams: flagged,
                      participants: teams.length - flagged
                    })
                  }, `${team.name} saved.`).catch(() => undefined)
                }}
              />
            ))}
          </ListCard>
        )}
      </View>
      {addingPeriod && (
        <PickerDialog
          onClose={() => {
            setAddingPeriod(false)
          }}
        >
          <CalendarPicker
            value={settings.windows[settings.windows.length - 1].from}
            onChoose={date => {
              setAddingPeriod(false)
              if (settings.windows.some(period => period.from === date)) {
                setError('A period already starts on that date.')
                return
              }
              // A new period starts as a copy of the one before it.
              const before = [...settings.windows]
                .reverse()
                .find(period => period.from < date)
              setWindows(
                [
                  ...settings.windows,
                  { from: date, hours: before?.hours ?? [] }
                ].sort((a, b) => a.from.localeCompare(b.from)),
                'Period added.'
              )
            }}
            onCancel={() => {
              setAddingPeriod(false)
            }}
          />
        </PickerDialog>
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
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
  notice: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  period: { gap: theme.rem(0.5) },
  periodHead: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const
  },
  periodTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  }
}))
