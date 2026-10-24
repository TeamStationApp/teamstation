import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { zoneLongName } from '../../common/eventTime'
import { addDays, type WindowPeriod } from '../../common/fieldAvailability'
import {
  addWindowPeriod,
  asWindowPeriods,
  copyWindowPeriods,
  type ScheduleSettings,
  seasonZone,
  type SetupSeason
} from '../../common/seasonScheduling'
import { Button, ListCard, Screen, SectionHeader } from '../components'
import { ActionList, ActionRow } from '../components/ActionRow'
import {
  BlackoutDatesEditor,
  dateLabel
} from '../components/BlackoutDatesEditor'
import { CheckRow } from '../components/CheckRow'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { DangerText } from '../components/DangerText'
import { CalendarPicker } from '../components/EventScheduleFields'
import { PickerDialog } from '../components/PickerDialog'
import {
  WeeklyHoursEditor,
  WINDOW_OPEN_DEFAULT
} from '../components/WeeklyHoursEditor'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** "Mar 1", with the year when it isn't the season's first year. */
function shortDate(date: string, year: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(date.startsWith(year) ? {} : { year: 'numeric' })
  }).format(new Date(`${date}T12:00:00Z`))
}

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`
}

/** Which date of a period the calendar is choosing. */
type Choosing = { index: number; end: 'from' | 'until' } | 'add' | null

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
  const [choosing, setChoosing] = useState<Choosing>(null)
  // The league's other seasons with game windows, newest first.
  const [sources, setSources] = useState<SetupSeason[]>([])
  const [copying, setCopying] = useState(false)
  const [replacing, setReplacing] = useState<SetupSeason | null>(null)
  const begin = useLatestRequest()
  useEffect(() => {
    const current = begin()
    setError('')
    client.scheduleSetup(leagueId).then(
      setup => {
        if (!current()) return
        setSeason(setup.seasons.find(item => item.id === seasonId) ?? null)
        setSources(
          setup.seasons
            .filter(
              item => item.id !== seasonId && item.settings.windows.length > 0
            )
            .sort((a, b) =>
              a.settings.startsOn === b.settings.startsOn
                ? a.name.localeCompare(b.name)
                : b.settings.startsOn.localeCompare(a.settings.startsOn)
            )
        )
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
  // A season still at the UTC default is shown in the viewer's zone, which
  // its first save stores on it.
  const zone = seasonZone(season)
  const save = (changes: Partial<ScheduleSettings>, done: string): void => {
    run(async () => {
      const saved = await client.saveScheduleSettings(
        season.id,
        { ...settings, ...changes },
        zone === season.timezone ? {} : { timezone: zone }
      )
      setSeason({
        ...season,
        saved: true,
        timezone: saved.timezone,
        settings: saved.settings
      })
    }, done).catch(() => undefined)
  }
  const setWindows = (windows: WindowPeriod[], done: string): void => {
    // The periods are checked here as the server checks them, so a date
    // that would overlap another period says why without a round trip.
    try {
      asWindowPeriods(windows)
    } catch (failure) {
      setNotice('')
      setError(`${(failure as Error).message}.`)
      return
    }
    save({ windows }, done)
  }
  const year = settings.startsOn.slice(0, 4)
  const copyFrom = (source: SetupSeason): void => {
    const windows = copyWindowPeriods(source.settings, settings)
    if (windows.length === 0) {
      setNotice('')
      setError(`${source.name}’s windows all fall after this season ends.`)
      return
    }
    setWindows(windows, `Game windows copied from ${source.name}.`)
  }
  // The end a period without an end date runs to: the day before the next
  // period, or the season's last day.
  const openEnd = (index: number): string => {
    const next = settings.windows[index + 1]
    return next == null ? settings.endsOn : addDays(next.from, -1)
  }
  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          {season.name}
        </Text>
        <Text style={styles.meta}>Times are in {zoneLongName(zone)}.</Text>
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
          When games may be played each week. A period is in force from its
          start through its end date or, with none, until the next period
          begins. Days no period covers have no games.
        </Text>
        {settings.windows.length === 0 && (
          <Text style={styles.meta}>No game windows yet.</Text>
        )}
        {settings.windows.map((period, index) => {
          const from = dateLabel(period.from)
          const last = index === settings.windows.length - 1
          return (
            <View key={period.from} style={styles.period}>
              <View style={styles.periodHead}>
                <Text style={styles.periodTitle}>
                  {period.until == null
                    ? `From ${shortDate(period.from, year)}`
                    : `${shortDate(period.from, year)} – ${shortDate(period.until, year)}`}
                </Text>
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
              <ActionList bounded>
                <ActionRow
                  title="Starts"
                  detail={from}
                  openLabel={`Change the start of the windows from ${from}`}
                  onOpen={() => {
                    if (!busy) setChoosing({ index, end: 'from' })
                  }}
                />
                <ActionRow
                  title="Ends"
                  detail={
                    period.until != null
                      ? dateLabel(period.until)
                      : last
                        ? 'End of season'
                        : 'When the next period begins'
                  }
                  openLabel={`Change the end of the windows from ${from}`}
                  onOpen={() => {
                    if (!busy) setChoosing({ index, end: 'until' })
                  }}
                />
              </ActionList>
              <WeeklyHoursEditor
                label={`Windows from ${from}`}
                value={period.hours}
                disabled={busy}
                openDefault={WINDOW_OPEN_DEFAULT}
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
            else setChoosing('add')
          }}
        />
        {sources.length > 0 && (
          <Button
            label="Copy from another season"
            kind="secondary"
            disabled={busy}
            onPress={() => {
              setCopying(true)
            }}
          />
        )}
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
      {choosing === 'add' && (
        <PickerDialog
          onClose={() => {
            setChoosing(null)
          }}
        >
          <CalendarPicker
            value={settings.windows[settings.windows.length - 1].from}
            onChoose={date => {
              setChoosing(null)
              if (settings.windows.some(period => period.from === date)) {
                setError('A period already starts on that date.')
                return
              }
              // A new period starts as a copy of the one before it, which
              // it splits when the date falls inside it.
              setWindows(
                addWindowPeriod(settings.windows, date),
                'Period added.'
              )
            }}
            onCancel={() => {
              setChoosing(null)
            }}
          />
        </PickerDialog>
      )}
      {choosing != null && choosing !== 'add' && (
        <PickerDialog
          onClose={() => {
            setChoosing(null)
          }}
        >
          <CalendarPicker
            value={
              choosing.end === 'from'
                ? settings.windows[choosing.index].from
                : (settings.windows[choosing.index].until ??
                  openEnd(choosing.index))
            }
            onChoose={date => {
              const { index, end } = choosing
              setChoosing(null)
              setWindows(
                settings.windows
                  .map((period, i) =>
                    i === index ? { ...period, [end]: date } : period
                  )
                  .sort((a, b) => a.from.localeCompare(b.from)),
                end === 'from' ? 'Start saved.' : 'End date saved.'
              )
            }}
            other={
              choosing.end === 'until'
                ? {
                    label: 'No end date',
                    onPress: () => {
                      const { index } = choosing
                      setChoosing(null)
                      setWindows(
                        settings.windows.map((period, i) =>
                          i === index
                            ? { from: period.from, hours: period.hours }
                            : period
                        ),
                        'End date removed.'
                      )
                    }
                  }
                : undefined
            }
            onCancel={() => {
              setChoosing(null)
            }}
          />
        </PickerDialog>
      )}
      {copying && (
        <ChoiceSheet
          title="Copy game windows from"
          choices={sources.map(source => ({
            label: source.name,
            detail: `${source.year} · ${plural(source.settings.windows.length, 'period')}`,
            onPress: () => {
              if (settings.windows.length > 0) setReplacing(source)
              else copyFrom(source)
            }
          }))}
          onClose={() => {
            setCopying(false)
          }}
        />
      )}
      {replacing != null && (
        <ChoiceSheet
          title="Replace this season’s game windows?"
          choices={[
            {
              label: 'Replace game windows',
              detail: `${replacing.name}’s windows take the place of this season’s ${plural(settings.windows.length, 'period')}.`,
              destructive: true,
              onPress: () => {
                copyFrom(replacing)
              }
            }
          ]}
          onClose={() => {
            setReplacing(null)
          }}
        />
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
