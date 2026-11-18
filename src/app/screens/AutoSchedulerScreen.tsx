import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  type ScrollView,
  Switch,
  Text,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
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
  liveFieldIds,
  type ScheduleSettings,
  type ScheduleSetup,
  type ScheduleSetupChoice,
  selectedFields,
  type SetupSeason
} from '../../common/seasonScheduling'
import { FIELD_SIZES, fieldSizeLabel } from '../../common/venues'
import {
  Button,
  ListCard,
  ListRow,
  Screen,
  SectionHeader,
  useBreakpoint,
  usePaneWidth
} from '../components'
import { ChoiceSheet } from '../components/ChoiceSheet'
import type { NumberColumn } from '../components/GridNumberCell'
import { useSceneReveals } from '../components/sceneShown'
import { useScheduleBuild } from '../components/ScheduleBuildModal'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { edgeMarginRem } from '../layout/margins'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { gameTimeLabel } from './SchedulePreviewScreen'
import {
  type GridColumn,
  SeasonScheduleGrid,
  type SeasonScheduleGridHandle
} from './SeasonScheduleGrid'

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
  onOpenSeasonPage,
  onOpenPreview
}: {
  client: TeamStationClient
  leagueId: string
  leagueName?: string
  onFieldManager: () => void
  /** Opens a season's other scheduling constraints. */
  onOpenSeason: (seasonId: string) => void
  /** Opens a season's own page. */
  onOpenSeasonPage: (seasonId: string) => void
  onOpenPreview: (previewId: string) => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const breakpoint = useBreakpoint()
  const insets = useInsets()
  // The window's width less any sidebar.
  const paneWidth = usePaneWidth()
  const [setup, setSetup] = useState<ScheduleSetup>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  /** The last read failed, so what the grid shows may be out of date. */
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{
    seasonId: string
    column: GridColumn
  }>()
  const [toReschedule, setToReschedule] = useState<GameToReschedule[]>([])
  const [asking, setAsking] = useState<{ existing: number }>()
  // A build runs in the modal, which shows its log and its time limit.
  const scheduleBuild = useScheduleBuild(client, leagueId)
  // A build being readied (the flush, the pending saves and the checks)
  // before its modal opens; the ref stops a second tap before the render.
  const [readying, setReadying] = useState(false)
  const readyingRef = useRef(false)
  const building = readying || scheduleBuild.running
  // Each season's save in flight, which its next save waits for, and the
  // settings its last save stored, which that next save builds on,
  // so a sheet's save can't send back a number a cell's save just changed.
  const saving = useRef(new Map<string, Promise<unknown>>())
  const stored = useRef(new Map<string, Pick<SetupSeason, 'settings'>>())
  // A save sends a season's whole settings, so it builds on the setup as last
  // read. One made while a read is out waits for it, and one made after a read
  // failed is refused: an old copy would undo what another screen saved.
  const reading = useRef<Promise<boolean>>(Promise.resolve(true))
  const setupNow = useRef(setup)
  setupNow.current = setup
  const grid = useRef<SeasonScheduleGridHandle>(null)
  // The screen's own scroll view, which lifts an open grid cell above the
  // keyboard.
  const page = useRef<React.ComponentRef<typeof ScrollView>>(null)
  /**
   * Saves the grid's open cell, if any. A tap on a native button leaves the
   * cell focused, with no blur to save it, so a build or a move to another
   * screen saves it first, and goes nowhere if the cell refuses its text.
   */
  const flush = async (): Promise<boolean> =>
    (await grid.current?.flush()) ?? true
  const begin = useLatestRequest()
  // A season's or a field's screen, pushed over this one, saves what this
  // holds a copy of, and a save here sends back the whole of it.
  const reveals = useSceneReveals()
  useEffect(() => {
    const current = begin()
    setError('')
    // What was saved before this read is in its answer; a save that lands
    // after it began is not, and is kept over that answer.
    setStale(false)
    stored.current.clear()
    reading.current = Promise.all([
      client.scheduleSetup(leagueId),
      client.gamesToReschedule(leagueId)
    ]).then(
      ([found, listed]) => {
        if (!current()) return true
        const merged = {
          ...found,
          seasons: found.seasons.map(item => {
            const kept = stored.current.get(item.id)
            return kept == null ? item : { ...item, saved: true, ...kept }
          })
        }
        setupNow.current = merged
        setSetup(merged)
        setToReschedule(listed)
        return true
      },
      () => {
        if (current()) {
          setError('The Auto-Scheduler could not load. Try again.')
          setStale(true)
        }
        return false
      }
    )
  }, [client, leagueId, revision, reveals, begin])
  /**
   * Builds a preview in the modal and opens it. A first build of seasons
   * that already have upcoming games asks whether to replace them or work
   * around them.
   */
  const build = async (request: PreviewRequest): Promise<void> => {
    if (readyingRef.current) return
    readyingRef.current = true
    setReadying(true)
    setError('')
    try {
      if (!(await flush())) return
      // A cell's save still on its way, as when Build's tap blurred the
      // cell, lands first, so the build reads the numbers the grid shows.
      for (;;) {
        const pending = [...saving.current.values()]
        if (pending.length === 0) break
        await Promise.allSettled(pending)
      }
      // The checks again, on what those saves stored.
      if (request.mode === 'full' && setup != null) {
        const seasons = chosenSeasons(setup).map(item => ({
          ...item,
          ...stored.current.get(item.id)
        }))
        const fields = selectedFields(setup.fields, seasons)
        if (!buildable(schedulingChecks(seasons, fields))) return
      }
      const run = scheduleBuild.run(request)
      readyingRef.current = false
      setReadying(false)
      const preview = await run
      if (preview != null) onOpenPreview(preview.id)
    } catch (failure) {
      const details =
        failure instanceof HttpError && isRecord(failure.details)
          ? failure.details
          : undefined
      if (details != null && typeof details.existingGames === 'number')
        setAsking({ existing: details.existingGames })
      else failed(failure)
    } finally {
      readyingRef.current = false
      setReadying(false)
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
    async (choice: ScheduleSetupChoice, previousConstraint?: boolean) => {
      const constraint = choice.avoidHeadCoachConflicts
      if (constraint != null)
        setSetup(current =>
          current == null
            ? current
            : { ...current, avoidHeadCoachConflicts: constraint }
        )
      setBusy(true)
      setError('')
      try {
        const answer = await client.saveScheduleSetup(leagueId, choice)
        // A cell's save that answered while this choice was on its way
        // stored newer settings than this answer read: keep them.
        setSetup({
          ...answer,
          seasons: answer.seasons.map(item => {
            const kept = stored.current.get(item.id)
            return kept == null ? item : { ...item, saved: true, ...kept }
          })
        })
      } catch (failure) {
        if (previousConstraint != null)
          setSetup(current =>
            current == null
              ? current
              : { ...current, avoidHeadCoachConflicts: previousConstraint }
          )
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
    // The read to wait for is the last one: Retry may start another meanwhile.
    let waited: Promise<boolean>
    let answered: boolean
    do {
      waited = reading.current
      answered = await waited
    } while (waited !== reading.current)
    if (!answered)
      return 'This season could not be read again. Retry, then save.'
    const latest = setupNow.current?.seasons.find(item => item.id === shown.id)
    const season = { ...(latest ?? shown), ...stored.current.get(shown.id) }
    try {
      const saved = await client.saveScheduleSettings(season.id, {
        ...season.settings,
        ...changes
      })
      stored.current.set(season.id, { settings: saved.settings })
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
      // The same scroll view as the loaded screen's, which holds this ref
      // from its first render: a ref handed to it later never reaches it.
      <Screen scrollRef={page}>
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
  const fields = selectedFields(setup.fields, seasons)
  const checks = schedulingChecks(seasons, fields)
  const editedSeason =
    editing == null
      ? undefined
      : setup.seasons.find(season => season.id === editing.seasonId)
  /**
   * Moves to another screen once the grid's open cell is saved, and nowhere
   * if the cell refuses its text: the keyboard goes as that screen comes on,
   * with no blur to save the cell.
   */
  const leave = (go: () => void): void => {
    flush().then(
      done => {
        if (done) go()
      },
      () => undefined
    )
  }
  const openSeason = (seasonId: string): void => {
    leave(() => {
      onOpenSeason(seasonId)
    })
  }
  const openFieldManager = (): void => {
    leave(onFieldManager)
  }
  const openSeasonPage = (seasonId: string): void => {
    leave(() => {
      onOpenSeasonPage(seasonId)
    })
  }
  const edit = (seasonId: string, column: GridColumn): void => {
    setEditing({ seasonId, column })
  }
  /**
   * A weekly maximum, and with a maximum of 0 the preference moved off the
   * days it leaves no games for, in the same save.
   */
  const saveNumber = async (
    season: SetupSeason,
    column: NumberColumn,
    value: number
  ): Promise<string | null> => {
    const changes: Partial<ScheduleSettings> = { [column]: value }
    const preferred = season.settings.preferGameOn ?? 'weekend'
    if (
      value === 0 &&
      column === 'maxGamesOnWeekdays' &&
      preferred === 'weekdays'
    )
      changes.preferGameOn = 'weekend'
    if (
      value === 0 &&
      column === 'maxGamesOnWeekend' &&
      preferred === 'weekend'
    )
      changes.preferGameOn = 'weekdays'
    return await storeSettings(season, changes)
  }
  const close = (): void => {
    setEditing(undefined)
  }
  // The screen is wide for the season table; the rest keeps the column's
  // width and margins, as on every other screen. Until the column reaches its
  // most width, the table keeps the column's margins and lines up with it;
  // past that, its margins narrow to a phone's as the pane grows.
  const phoneMargin = theme.rem(edgeMarginRem(theme, 'phone'))
  const columnMargin = theme.rem(edgeMarginRem(theme, breakpoint))
  const columnWidth = theme.rem(theme.maxContentWidthRem)
  const tableMargin = Math.max(
    phoneMargin,
    columnMargin - Math.max(0, paneWidth - columnWidth) / 2
  )
  const tableSide = {
    paddingLeft: Math.max(tableMargin, insets.left),
    paddingRight: Math.max(tableMargin, insets.right)
  }
  const narrow = [
    styles.section,
    styles.narrow,
    { maxWidth: columnWidth - 2 * columnMargin }
  ]
  return (
    <Screen scrollRef={page} wide contentStyle={tableSide}>
      <View style={styles.page}>
        <View style={narrow}>
          <Text accessibilityRole="header" style={styles.title}>
            Auto-Scheduler
          </Text>
          {leagueName != null && <Text style={styles.meta}>{leagueName}</Text>}
          <ListCard>
            <ListRow
              title="Field Manager"
              subtitle="Find, claim and set up the venues and fields your league plays on"
              emblemIcon="stadium"
              onPress={openFieldManager}
            />
          </ListCard>
          {error !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          {stale && (
            <Button
              label="Retry"
              onPress={() => {
                setRevision(value => value + 1)
              }}
            />
          )}
        </View>
        {/* The season table alone grows past the column, to the margins a
            phone has, so its columns fit on a wide screen; narrower than
            that, it and its heading sit in the middle. */}
        <View
          style={
            setup.seasons.length === 0
              ? narrow
              : [styles.section, styles.tableSection]
          }
        >
          <SectionHeader title="Select seasons to auto schedule." />
          {setup.seasons.length === 0 ? (
            <Text style={styles.meta}>This league has no seasons yet.</Text>
          ) : (
            <SeasonScheduleGrid
              ref={grid}
              seasons={setup.seasons}
              selectedIds={setup.seasonIds}
              disabled={busy}
              onToggle={seasonId => {
                choose({
                  fieldIds: liveFieldIds(setup),
                  // Adds and removes nothing, whatever this screen last read.
                  addedFieldIds: [],
                  removedFieldIds: [],
                  seasonIds: setup.seasonIds.includes(seasonId)
                    ? setup.seasonIds.filter(id => id !== seasonId)
                    : [...setup.seasonIds, seasonId]
                }).catch(() => undefined)
              }}
              onEdit={edit}
              onSaveNumber={async (seasonId, column, value) =>
                await saveNumber(
                  // The grid shows only the setup's own seasons.
                  setup.seasons.find(item => item.id === seasonId)!,
                  column,
                  value
                )
              }
              onChooseDays={(seasonId, preferGameOn) => {
                storeSettings(
                  setup.seasons.find(item => item.id === seasonId)!,
                  { preferGameOn }
                ).then(
                  message => {
                    if (message != null) setError(message)
                  },
                  () => undefined
                )
              }}
              onOpenSeason={openSeason}
              onOpenSeasonPage={openSeasonPage}
              scrollToKeyboard={(input, gap) => {
                // React Native's sum takes the scroll view to start at the
                // window's top; the measured top keeps it right if not.
                const view = page.current
                view?.measureInWindow((_x, top) => {
                  view.scrollResponderScrollNativeHandleToKeyboard(
                    input,
                    gap + top,
                    true
                  )
                })
              }}
            />
          )}
        </View>
        <View style={narrow}>
          <SectionHeader title="Other Constraints" />
          <ListCard>
            <ListRow
              title="Avoid manager/head coach double bookings"
              titleNumberOfLines={0}
              end={
                <Switch
                  accessibilityLabel="Avoid manager/head coach double bookings"
                  value={setup.avoidHeadCoachConflicts ?? true}
                  disabled={busy}
                  onValueChange={value => {
                    choose(
                      { avoidHeadCoachConflicts: value },
                      setup.avoidHeadCoachConflicts ?? true
                    ).catch(() => undefined)
                  }}
                />
              }
            />
          </ListCard>
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
      </View>
      {scheduleBuild.modal}
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
    </Screen>
  )
}

export const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingBottom: theme.rem(6) },
  section: { gap: theme.rem(1) },
  narrow: { width: '100%' as const, alignSelf: 'center' as const },
  tableSection: { alignSelf: 'center' as const, maxWidth: '100%' as const },
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
