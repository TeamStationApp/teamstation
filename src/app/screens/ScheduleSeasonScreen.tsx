import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Switch, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { WindowPeriod } from '../../common/fieldAvailability'
import {
  asWindowPeriods,
  copyWindowPeriods,
  MAX_GAMES,
  type ScheduleSettings,
  type ScheduleSetup,
  type SetupSeason
} from '../../common/seasonScheduling'
import { FIELD_SIZES, fieldSizeLabel } from '../../common/venues'
import {
  Button,
  HandoffView,
  ListCard,
  Screen,
  SectionHeader,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot
} from '../components'
import { ActionList, ActionRow } from '../components/ActionRow'
import { BlackoutDatesEditor } from '../components/BlackoutDatesEditor'
import { CheckRow } from '../components/CheckRow'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { DangerText } from '../components/DangerText'
import { SegmentedPill } from '../components/SegmentedPill'
import { SpreadsheetNumber } from '../components/SpreadsheetNumber'
import { TimeWindowsEditor } from '../components/TimeWindowsEditor'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { setupFieldDetail } from './AutoSchedulerScreen'
import { FieldPickerScene } from './FieldPickerScene'

/** The setup's chosen fields that still exist, as the server accepts them. */
function liveFieldIds(setup: ScheduleSetup): string[] {
  return setup.fieldIds.filter(id =>
    setup.fields.some(field => field.id === id && !field.deleted)
  )
}

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`
}

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
  const [setup, setSetup] = useState<ScheduleSetup>()
  const [picking, setPicking] = useState(false)
  const currentSeason = useRef(season)
  currentSeason.current = season
  const active = useRef(true)
  const screenKey = `${leagueId}:${seasonId}`
  const currentKey = useRef(screenKey)
  currentKey.current = screenKey
  const writes = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [leagueId, seasonId])
  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight)
  const progress = handoff.progress
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            Season Scheduling Constraints
          </Text>
        </HandoffView>
      ),
      [progress, styles.headerTitle]
    )
  )
  const [revision, setRevision] = useState(0)
  // The league's other seasons with game windows, newest first.
  const [sources, setSources] = useState<SetupSeason[]>([])
  const [copying, setCopying] = useState(false)
  const [replacing, setReplacing] = useState<SetupSeason | null>(null)
  const begin = useLatestRequest()
  useEffect(() => {
    const current = begin()
    setError('')
    setSeason(undefined)
    setBusy(false)
    setNotice('')
    client.scheduleSetup(leagueId).then(
      setup => {
        if (!current()) return
        setSetup(setup)
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
      const key = currentKey.current
      const current = (): boolean =>
        active.current && currentKey.current === key
      setBusy(true)
      setError('')
      setNotice('')
      try {
        await work()
        if (current()) setNotice(done)
      } catch (failure) {
        if (current())
          setError(
            failure instanceof Error && failure.message !== ''
              ? failure.message
              : 'That could not be saved. Try again.'
          )
      } finally {
        if (current()) setBusy(false)
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
  const persist = async (changes: Partial<ScheduleSettings>): Promise<void> => {
    const pending = writes.current
      .catch(() => undefined)
      .then(async () => {
        if (!active.current || currentKey.current !== screenKey) return
        const before = currentSeason.current
        if (before?.id !== seasonId) return
        const saved = await client.saveScheduleSettings(before.id, {
          ...before.settings,
          ...changes
        })
        if (active.current && currentKey.current === screenKey) {
          const next = { ...before, saved: true, settings: saved.settings }
          currentSeason.current = next
          setSeason(next)
        }
      })
    writes.current = pending
    await pending
  }
  const save = (changes: Partial<ScheduleSettings>, done: string): void => {
    run(async () => {
      await persist(changes)
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
  const copyFrom = (source: SetupSeason): void => {
    const windows = copyWindowPeriods(source.settings, settings)
    if (windows.length === 0) {
      setNotice('')
      setError(`${source.name}’s windows all fall after this season ends.`)
      return
    }
    setWindows(windows, `Game windows copied from ${source.name}.`)
  }
  return (
    <Screen onScroll={handoff.handleScroll}>
      <View style={styles.page}>
        <View ref={handoff.ref}>
          <Text accessibilityRole="header" style={styles.title}>
            Season Scheduling Constraints
          </Text>
          <Text style={styles.meta}>{season.name}</Text>
        </View>
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
        <ActionList bounded>
          {(
            [
              ['maxGamesOnWeekdays', 'Max games on weekdays'],
              ['maxGamesOnWeekend', 'Max games on weekend']
            ] as const
          ).map(([key, label]) => (
            <ActionRow
              key={key}
              title={label}
              end={
                <SpreadsheetNumber
                  key={`${season.id}:${key}`}
                  label={label}
                  value={settings[key] ?? 1}
                  maximum={MAX_GAMES}
                  disabled={busy}
                  onSave={async value => {
                    setBusy(true)
                    try {
                      await persist({ [key]: value })
                    } finally {
                      if (active.current && currentKey.current === screenKey)
                        setBusy(false)
                    }
                  }}
                />
              }
            />
          ))}
          <ActionRow
            title="Prefer game on:"
            end={
              <View style={styles.preference}>
                <SegmentedPill
                  accessibilityLabel="Prefer game on"
                  options={[
                    { id: 'weekend', label: 'weekend' },
                    { id: 'weekdays', label: 'weekdays' }
                  ]}
                  selected={settings.preferGameOn ?? 'weekend'}
                  disabled={busy}
                  onSelect={preferGameOn => {
                    save({ preferGameOn }, 'Game preference saved.')
                  }}
                />
              </View>
            }
          />
        </ActionList>
        <Text style={styles.meta}>
          Maximums per team each week: Monday–Friday and Saturday–Sunday. Fewer
          games may be scheduled.
        </Text>
        <SectionHeader
          title="Time Windows"
          note={String(settings.windows.length)}
        />
        <Text style={styles.meta}>
          When games may be played each week. A period is in force from its
          start through its end date or, with none, until the next period
          begins. Days no period covers have no games.
        </Text>
        <TimeWindowsEditor
          label="Windows"
          openDefault={{ start: '17:00', end: '21:00' }}
          value={settings.windows}
          today={settings.startsOn}
          endDate={settings.endsOn}
          disabled={busy}
          onChange={windows => {
            setWindows(windows, 'Time windows saved.')
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
        <SectionHeader title="Choose required field size" />
        <ActionList bounded>
          {FIELD_SIZES.map(size => (
            <ActionRow
              key={size}
              title={fieldSizeLabel(size)}
              end={
                <Switch
                  accessibilityLabel={`Required field size ${fieldSizeLabel(size)}`}
                  value={settings.fieldSize === size}
                  disabled={busy}
                  onValueChange={() => {
                    if (settings.fieldSize !== size)
                      save(
                        {
                          fieldSize: size,
                          fieldIds: (settings.fieldIds ?? []).filter(
                            id =>
                              setup?.fields.some(
                                field =>
                                  field.id === id &&
                                  !field.deleted &&
                                  field.sizes.includes(size)
                              ) === true
                          )
                        },
                        'Field size saved.'
                      )
                  }}
                />
              }
            />
          ))}
        </ActionList>
        <SectionHeader
          title="Select fields to use"
          actions={[
            {
              label: 'Add field',
              accessibilityLabel: 'Add a field from the registry',
              onPress: () => {
                setPicking(true)
              }
            }
          ]}
        />
        <ListCard>
          {setup?.fields.map(field => {
            const compatible =
              !field.deleted && field.sizes.includes(settings.fieldSize)
            return (
              <View
                key={field.id}
                style={!compatible ? styles.unavailable : undefined}
              >
                <CheckRow
                  label={`${field.name}, ${field.venueName}`}
                  detail={setupFieldDetail(field)}
                  checked={settings.fieldIds?.includes(field.id) ?? false}
                  disabled={busy || !compatible}
                  onToggle={() => {
                    save(
                      {
                        fieldIds:
                          settings.fieldIds?.includes(field.id) === true
                            ? settings.fieldIds.filter(id => id !== field.id)
                            : [...(settings.fieldIds ?? []), field.id]
                      },
                      'Fields saved.'
                    )
                  }}
                />
                {!compatible &&
                  settings.fieldIds?.includes(field.id) === true && (
                    <DangerText
                      label="Remove selection"
                      accessibilityLabel={`Remove unavailable selection ${field.name}`}
                      disabled={busy}
                      onPress={() => {
                        save(
                          {
                            fieldIds: settings.fieldIds!.filter(id =>
                              setup.fields.some(
                                available =>
                                  available.id === id &&
                                  !available.deleted &&
                                  available.sizes.includes(settings.fieldSize)
                              )
                            )
                          },
                          'Fields saved.'
                        )
                      }}
                    />
                  )}
                {!field.ours && setup.addedFieldIds.includes(field.id) && (
                  <DangerText
                    label="Remove"
                    accessibilityLabel={`Remove ${field.name}, ${field.venueName} from the list`}
                    disabled={busy}
                    onPress={() => {
                      run(async () => {
                        await persist({
                          fieldIds: (
                            currentSeason.current?.settings.fieldIds ?? []
                          ).filter(id => id !== field.id)
                        })
                        const next = await client.saveScheduleSetup(leagueId, {
                          seasonIds: setup.seasonIds,
                          fieldIds: liveFieldIds(setup).filter(
                            id => id !== field.id
                          ),
                          addedFieldIds: setup.addedFieldIds.filter(
                            id => id !== field.id
                          )
                        })
                        if (active.current && currentKey.current === screenKey)
                          setSetup(next)
                      }, 'Field removed.').catch(() => undefined)
                    }}
                  />
                )}
              </View>
            )
          })}
        </ListCard>
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
                    if (!active.current || currentKey.current !== screenKey)
                      return
                    setSeason({
                      ...currentSeason.current!,
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
      {picking && setup != null && (
        <FieldPickerScene
          client={client}
          onClose={() => {
            setPicking(false)
          }}
          onChooseField={chosen => {
            setPicking(false)
            run(async () => {
              const next = await client.saveScheduleSetup(leagueId, {
                seasonIds: setup.seasonIds,
                fieldIds: liveFieldIds(setup),
                addedFieldIds: [...new Set([...setup.addedFieldIds, chosen.id])]
              })
              if (active.current && currentKey.current === screenKey)
                setSetup(next)
              if (chosen.sizes.includes(settings.fieldSize))
                await persist({
                  fieldIds: [
                    ...new Set([...(settings.fieldIds ?? []), chosen.id])
                  ]
                })
            }, 'Field added.').catch(() => undefined)
          }}
        />
      )}
      {/*
        Picking a source over windows the season has turns this same sheet
        into the confirmation, rather than closing it and opening another:
        iOS presents one modal at a time, and won't present a second while
        the first is still sliding away.
      */}
      {(copying || replacing != null) && (
        <ChoiceSheet
          {...(replacing == null
            ? {
                title: 'Copy game windows from',
                choices: sources.map(source => ({
                  label: source.name,
                  detail: `${source.year} · ${plural(source.settings.windows.length, 'period')}`,
                  onPress: () => {
                    if (settings.windows.length > 0) setReplacing(source)
                    else copyFrom(source)
                  }
                }))
              }
            : {
                title: 'Replace this season’s game windows?',
                choices: [
                  {
                    label: 'Replace game windows',
                    detail: `${replacing.name}’s windows take the place of this season’s ${plural(settings.windows.length, 'period')}.`,
                    destructive: true,
                    onPress: () => {
                      copyFrom(replacing)
                    }
                  }
                ]
              })}
          onClose={() => {
            setCopying(false)
            setReplacing(null)
          }}
        />
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  headerTitle: {
    fontSize: theme.rem(1),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  unavailable: { opacity: 0.4 },
  preference: { width: 212 },
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
  }
}))
