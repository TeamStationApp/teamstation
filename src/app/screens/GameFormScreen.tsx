import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Switch, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { EventType } from '../../common/eventInfo'
import type { PublicGroup } from '../../common/publicGroups'
import {
  resetWarning,
  SWAP_SCORED_ELSEWHERE
} from '../../common/scoring/playsLost'
import { type FieldSize, fieldSizeLabel } from '../../common/venues'
import { Button, Card, Screen, TextField } from '../components'
import { CancelAction } from '../components/CancelAction'
import { EventArrivalField } from '../components/EventArrivalField'
import { EventScheduleFields } from '../components/EventScheduleFields'
import { EventTypeRow } from '../components/EventTypeRow'
import { EventVenueFields } from '../components/EventVenueFields'
import { ListRow } from '../components/ListRow'
import { useTitleHandoff } from '../components/useTitleHandoff'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { offlineCreateFailure } from '../sync/useOffline'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { type EventCreationRetry, EventDetailsForm } from './EventDetailsForm'
import { FieldPickerScene } from './FieldPickerScene'
import {
  choosesExhibition,
  chooseTeam,
  draftProblem,
  editedGame,
  type GameDraft,
  type GameFormMode,
  gameProposalFields,
  type LoadedGame,
  loadedGameDraft,
  newGameDraft,
  replaceableSides,
  selectorAnchor,
  type Side,
  sourceTeamId,
  swapSides,
  TEAM_GAME_NOTE
} from './gameDraft'
import { orderCustodians, type TeamChoice } from './PlaceholderTeamForm'
import { TeamSelectorScene } from './TeamSelectorScene'

export interface GameSettingsResult {
  id: string
  status: string
  gameId: string | null
  notice?: string
}

const retryKey = (): string =>
  `game-${Date.now()}-${Math.random().toString(36).slice(2)}`

const titles: Record<EventType, string> = {
  game: 'Create Game',
  practice: 'Create Practice',
  other: 'Create Event'
}

/**
 * Create Game and Game Settings: one scene whose mode sets the title, the
 * starting values and what Save sends. Teams are chosen in a scene of their
 * own; a placeholder is made only when the game is saved.
 */
export function GameFormScreen({
  client,
  mode,
  onSaved,
  onEventCreated,
  onCancel
}: {
  client: TeamStationClient
  mode: GameFormMode
  onSaved: (result: GameSettingsResult) => void
  onEventCreated?: (id: string) => void
  onCancel: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const creating = mode.kind === 'create'
  const sourceKind = mode.kind === 'create' ? mode.source.kind : undefined
  const sourceId = mode.kind === 'create' ? mode.source.id : undefined
  const gameId = mode.kind === 'edit' ? mode.gameId : undefined
  const [draft, setDraft] = useState<GameDraft>()
  const [loaded, setLoaded] = useState<LoadedGame>()
  const [sourceName, setSourceName] = useState<string>()
  // The source as the server names it: a merged team's address answers with
  // the team it became, and that is the team that must stay in the game.
  const [sourceGroupId, setSourceGroupId] = useState<string>()
  const [seasonConsentTeams, setSeasonConsentTeams] = useState<string[]>([])
  const formMode: GameFormMode =
    mode.kind === 'create' && sourceGroupId != null
      ? {
          kind: 'create',
          source: { kind: mode.source.kind, id: sourceGroupId }
        }
      : mode
  const [permitted, setPermitted] = useState(true)
  const [originalNames, setOriginalNames] = useState<Record<string, string>>({})
  const [eventType, setEventType] = useState<EventType>('game')
  const [eventTeam, setEventTeam] = useState<PublicGroup>()
  const [eventTitle, setEventTitle] = useState('')
  const [eventBusy, setEventBusy] = useState(false)
  const eventRetry = useRef<EventCreationRetry | undefined>(undefined)
  const arrivalTouched = useRef(false)
  const [choosing, setChoosing] = useState<Side>()
  const [choosingField, setChoosingField] = useState(false)
  // The groups this person administers, once; `failed` when they could not
  // load, which is not the same as having none.
  const [administered, setAdministered] = useState<
    PublicGroup[] | 'loading' | 'failed'
  >('loading')
  const [keepersAsked, setKeepersAsked] = useState(0)
  const [dismissedRange, setDismissedRange] = useState('')
  const [confirmation, setConfirmation] = useState<string>()
  /** The draft as it loaded: a Save that only swaps its sides is a swap. */
  const loadedDraft = useRef<GameDraft | undefined>(undefined)
  /** Reset and Swap is asked for: the game has plays a swap deletes. */
  const [resetAsked, setResetAsked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const begin = useLatestRequest()
  const submitted = useRef<{ body: string; key: string } | undefined>(undefined)
  const createdPlaceholders = useRef(new Map<string, TeamChoice>())
  const sending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const current = begin()
    setLoading(true)
    setLoadError('')
    setError('')
    setSeasonConsentTeams([])
    const load = async (): Promise<void> => {
      if (sourceKind != null && sourceId != null) {
        const own = await client.group({ kind: sourceKind, id: sourceId })
        if (!current()) return
        setEventType('game')
        setPermitted(
          own.canManage ||
            (sourceKind === 'team' && own.canManagePeople === true)
        )
        setSourceName(own.group.name)
        setSourceGroupId(own.group.id)
        if (sourceKind === 'season' && own.canManage)
          setSeasonConsentTeams(own.competingTeams.map(team => team.id))
        setEventTeam(
          sourceKind === 'team' && !own.group.external ? own.group : undefined
        )
        setDraft(
          newGameDraft(
            { kind: 'create', source: { kind: sourceKind, id: own.group.id } },
            {
              group: own.group,
              canManage:
                own.canManage ||
                (sourceKind === 'team' && own.canManagePeople === true)
            }
          )
        )
        return
      }
      const state = await client.gameScheduling(gameId!)
      const [home, away] = await Promise.all([
        client.group({ kind: 'team', id: state.game.homeTeamId }),
        client.group({ kind: 'team', id: state.game.awayTeamId })
      ])
      if (!current()) return
      setLoaded(state)
      if (state.game.seasonId != null) {
        const host = await client
          .group({ kind: 'season', id: state.game.seasonId })
          .catch(() => undefined)
        if (!current()) return
        if (
          host?.canManage === true &&
          host.group.kind === 'season' &&
          host.group.id === state.game.seasonId
        )
          setSeasonConsentTeams(host.competingTeams.map(team => team.id))
      }
      setPermitted(state.canPropose)
      setOriginalNames({
        [home.group.id]: home.group.name,
        [away.group.id]: away.group.name
      })
      const opened = loadedGameDraft(
        state,
        {
          group: home.group,
          canManage: home.canManage || home.canManagePeople === true
        },
        {
          group: away.group,
          canManage: away.canManage || away.canManagePeople === true
        }
      )
      loadedDraft.current = opened
      setDraft(opened)
      setResetAsked(false)
      setConfirmation(undefined)
      submitted.current = undefined
    }
    load()
      .catch((caught: unknown) => {
        if (current()) {
          // A failed reload leaves nothing current to edit: show the error
          // and its retry, not the stale form.
          setDraft(undefined)
          setLoaded(undefined)
          setPermitted(false)
          setLoadError(
            caught instanceof Error
              ? caught.message
              : creating
                ? 'The game could not load. Retry.'
                : 'Game settings could not load.'
          )
        }
      })
      .finally(() => {
        if (current()) setLoading(false)
      })
  }, [client, sourceKind, sourceId, gameId, creating, retry, begin])

  // Who may keep a placeholder made here, best first.
  const homeId = draft?.home?.group.id
  const awayId = draft?.away?.group.id
  const seasonId = draft?.season?.id ?? loaded?.game.seasonId ?? undefined
  useEffect(() => {
    let active = true
    setAdministered('loading')
    client.ownGroups('admin').then(
      groups => {
        if (active) setAdministered(groups)
      },
      () => {
        if (active) setAdministered('failed')
      }
    )
    return () => {
      active = false
    }
  }, [client, retry, keepersAsked])
  const formSource = sourceTeamId(formMode)
  const custodians = useMemo(
    () =>
      typeof administered === 'string'
        ? []
        : orderCustodians(administered, {
            sourceTeamId: formSource,
            participantIds: [homeId, awayId].filter(
              (id): id is string => id != null
            ),
            seasonIds: seasonId == null ? [] : [seasonId]
          }),
    [administered, formSource, homeId, awayId, seasonId]
  )
  const custodianNote =
    administered === 'loading'
      ? 'Finding who may keep a placeholder…'
      : administered === 'failed'
        ? 'Who may keep a placeholder could not load. Cancel and open this again to retry.'
        : undefined

  const change = (fields: Partial<GameDraft>): void => {
    setDraft(previous =>
      previous == null ? previous : { ...previous, ...fields }
    )
  }
  const createPlaceholder = async (choice: TeamChoice): Promise<TeamChoice> => {
    if (choice.placeholder == null) return choice
    const key = choice.placeholder.idempotencyKey
    const held = createdPlaceholders.current.get(key)
    if (held != null) return held
    const created = await client.createGroup(choice.placeholder)
    const resolved: TeamChoice = {
      group: { ...choice.group, id: created.id, imageUrl: created.imageUrl },
      canManage: true
    }
    createdPlaceholders.current.set(key, resolved)
    return resolved
  }
  /**
   * Whether the draft differs from the game as it loaded only by its sides
   * exchanged: what the caller may save as a swap, with no proposal.
   */
  const onlySwapped = (): boolean => {
    const opened = loadedDraft.current
    if (draft == null || opened == null || loaded?.canSwap !== true)
      return false
    if (draft.home == null || draft.away == null) return false
    const fields = (value: GameDraft): string =>
      JSON.stringify(editedGame(value, value.home!, value.away!, loaded))
    return (
      fields(swapSides(draft)) === fields(opened) &&
      fields(draft) !== fields(opened)
    )
  }
  /** Swaps the game's sides, resetting its plays once the scorer confirmed. */
  const swapGame = async (): Promise<void> => {
    if (draft == null || loaded == null || gameId == null) return
    const plays = loaded.plays
    // The server's word on whether this swap resets the game; an older
    // server's, whether it loses any at-bat.
    const resets = plays != null && (plays.resets ?? plays.atBats > 0)
    if (resets && !resetAsked) {
      setResetAsked(true)
      return
    }
    await client.swapGameSides(gameId, {
      homeTeamId: loaded.game.homeTeamId,
      awayTeamId: loaded.game.awayTeamId,
      ...(plays == null
        ? {}
        : { generation: plays.generation, playsDigest: plays.playsDigest })
    })
    if (mounted.current)
      onSaved({
        id: gameId,
        status: 'accepted',
        gameId,
        notice: `Home and away swapped: ${draft.home!.group.name} vs ${draft.away!.group.name}`
      })
  }
  const submitGame = async (): Promise<void> => {
    if (draft == null || sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      const problem = draftProblem(draft, formMode, sourceName)
      if (problem != null) throw new Error(`${problem}.`)
      if (
        creating &&
        draft.season != null &&
        !(await client.group({ kind: 'season', id: draft.season.id })).canManage
      )
        throw new Error(
          'You need administrator access to host this game in that season.'
        )
      if (onlySwapped()) {
        await swapGame()
        return
      }
      // Check the date before making even a placeholder somebody asked for.
      gameProposalFields(draft, formMode, draft.home!, draft.away!, loaded)
      const home = await createPlaceholder(draft.home!)
      const away = await createPlaceholder(draft.away!)
      if (mounted.current) change({ home, away })
      const fields = gameProposalFields(draft, formMode, home, away, loaded)
      const body = JSON.stringify(fields)
      if (submitted.current?.body !== body)
        submitted.current = { body, key: retryKey() }
      const result = await client.proposeGame({
        ...fields,
        idempotencyKey: submitted.current.key
      })
      if (result.status !== 'pending' && result.status !== 'accepted')
        throw new Error(
          'This proposal is closed. Review it in your inbox before sending another proposal.'
        )
      if (mounted.current)
        onSaved({
          ...result,
          notice: `${result.status === 'accepted' ? (creating ? 'Game scheduled' : 'Game changes saved') : 'Game proposal sent'}: ${home.group.name} vs ${away.group.name}${draft.season == null ? '' : ` in ${draft.season.name}`}`
        })
    } catch (caught) {
      if (mounted.current)
        setError(
          offlineCreateFailure(client, caught) ??
            (caught instanceof Error
              ? caught.message
              : creating
                ? 'The game proposal could not be sent. Retry.'
                : 'Game changes could not be submitted. Retry.')
        )
    } finally {
      sending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const withdraw = useCallback(async (): Promise<void> => {
    if (confirmation == null || gameId == null || sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      await client.withdrawFromGame(gameId, confirmation)
      if (mounted.current) onSaved({ id: gameId, status: 'withdrawn', gameId })
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Withdrawal could not be saved. Retry.'
      )
    } finally {
      sending.current = false
      setBusy(false)
    }
  }, [client, gameId, confirmation, onSaved])

  const eventMode = eventType !== 'game'
  const title = creating ? titles[eventType] : 'Game Settings'
  const handoff = useTitleHandoff(title)
  const heading = (
    <View ref={handoff.ref} collapsable={false}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
    </View>
  )
  if (loading || draft == null)
    return (
      <Screen onScroll={handoff.handleScroll}>
        <View style={styles.page}>
          {heading}
          {loading ? (
            <Text style={styles.hint}>
              {creating ? 'Loading game…' : 'Loading game settings…'}
            </Text>
          ) : (
            <>
              <Text accessibilityRole="alert" style={styles.error}>
                {loadError}
              </Text>
              <Button
                label={creating ? 'Retry game' : 'Retry game settings'}
                onPress={() => {
                  setRetry(value => value + 1)
                }}
              />
              <CancelAction label="Cancel" onPress={onCancel} />
            </>
          )}
        </View>
      </Screen>
    )

  const inert = busy || !permitted
  // A scorekeeper who schedules neither team: the swap and Save only.
  const swapOnly =
    loaded != null && !loaded.canPropose && loaded.canSwap === true
  // A game scored outside TeamStation keeps its sides.
  const scoredElsewhere = loaded?.plays?.swap === 'scoredElsewhere'
  const swapInert = busy || scoredElsewhere || (!permitted && !swapOnly)
  // Asked for, and the draft still only swaps the sides: Save resets.
  const resetShown = resetAsked && onlySwapped()
  const replaceable = replaceableSides(draft, formMode, loaded)
  const anchor =
    choosing == null
      ? undefined
      : selectorAnchor(draft, choosing, formMode, seasonId)
  const { season } = draft
  const outsideRange =
    creating &&
    season?.startsOn != null &&
    season.endsOn != null &&
    (draft.schedule.date < season.startsOn ||
      draft.schedule.date > season.endsOn)
  const rangeWarning = JSON.stringify([
    season?.id,
    season?.startsOn,
    season?.endsOn,
    draft.schedule.date
  ])
  const problem = draftProblem(draft, formMode, sourceName)
  const seasonApproves = [draft.away, draft.home].every(
    choice =>
      choice != null &&
      choice.placeholder == null &&
      seasonConsentTeams.includes(choice.group.id)
  )
  const missing = [draft.away, draft.home]
    .filter(choice => choice != null && !choice.canManage && !seasonApproves)
    .map(choice => choice!.group.name)
  const teamRow = (side: Side): React.ReactElement => {
    const choice = draft[side]
    const label = side === 'home' ? 'Home' : 'Away'
    const open =
      replaceable.includes(side) && !inert
        ? () => {
            // Opening the selector again asks again after a failure.
            if (administered === 'failed') setKeepersAsked(value => value + 1)
            setChoosing(side)
          }
        : undefined
    return choice == null ? (
      <ListRow
        title={`Choose ${label} Team`}
        subtitle={label}
        emblemIcon="groups"
        onPress={open}
      />
    ) : (
      <ListRow
        title={choice.group.name}
        subtitle={`${label}${choice.group.external ? ' · Placeholder' : ''}`}
        teamName={choice.group.name}
        emblemUri={choice.group.imageUrl}
        onPress={open}
      />
    )
  }
  return (
    <Screen onScroll={handoff.handleScroll}>
      <View style={styles.page}>
        {heading}
        {creating && sourceKind === 'team' && (
          <EventTypeRow
            value={eventType}
            disabled={inert || eventTeam == null || eventBusy}
            onChange={type => {
              setEventType(type)
              if (!arrivalTouched.current)
                change({ arrival: type === 'game' ? '45' : '0' })
            }}
          />
        )}
        {eventMode && eventTeam != null ? (
          <EventDetailsForm
            client={client}
            teamId={eventTeam.id}
            eventType={eventType}
            hideType
            hideTitle
            creationRetry={eventRetry}
            onBusyChange={setEventBusy}
            draft={{
              title: eventTitle,
              schedule: draft.schedule,
              venue: draft.venue,
              address: draft.address,
              notes: draft.notes,
              arrival: draft.arrival
            }}
            onDraftChange={next => {
              if (next.arrival !== draft.arrival) arrivalTouched.current = true
              setEventTitle(next.title)
              change({
                schedule: next.schedule,
                venue: next.venue,
                address: next.address,
                notes: next.notes,
                arrival: next.arrival
              })
            }}
            onSaved={id => {
              onEventCreated?.(id)
            }}
            onCancel={onCancel}
          />
        ) : (
          <>
            <Card flush>
              {teamRow('home')}
              <View style={styles.divider} />
              {teamRow('away')}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Swap home and away"
                accessibilityState={{ disabled: swapInert }}
                disabled={swapInert}
                onPress={() => {
                  setResetAsked(false)
                  change(swapSides(draft))
                }}
                style={({ pressed }) => [
                  styles.swap,
                  pressed && styles.pressed,
                  swapInert && styles.inert
                ]}
              >
                <Text style={styles.swapLabel}>Swap home and away</Text>
              </Pressable>
            </Card>
            <Card style={styles.card}>
              <Text style={styles.section}>Details</Text>
              <EventScheduleFields
                client={client}
                value={draft.schedule}
                onChange={schedule => {
                  change({ schedule })
                }}
                disabled={inert}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  draft.field == null
                    ? 'Field: none chosen'
                    : `Field: ${draft.field.venueName}, ${draft.field.fieldName}, ${fieldSizeLabel(draft.field.size as FieldSize)}`
                }
                disabled={inert}
                onPress={() => {
                  setChoosingField(true)
                }}
                style={({ pressed }) => [
                  styles.fieldRow,
                  pressed && styles.pressed,
                  inert && styles.inert
                ]}
              >
                <Text style={styles.fieldLabel}>FIELD (OPTIONAL)</Text>
                <Text style={styles.fieldValue}>
                  {draft.field == null
                    ? 'Choose a field from the registry'
                    : `${draft.field.venueName} · ${draft.field.fieldName} · ${fieldSizeLabel(draft.field.size as FieldSize)}`}
                </Text>
              </Pressable>
              {draft.field != null && (
                <Button
                  label="Clear field"
                  kind="text"
                  small
                  disabled={inert}
                  onPress={() => {
                    change({ field: null })
                  }}
                />
              )}
              <EventVenueFields
                client={client}
                value={{
                  venue: draft.venue,
                  address: draft.address,
                  notes: draft.notes
                }}
                disabled={inert}
                placeLocked={draft.field != null}
                onChange={value => {
                  change(value)
                }}
              />
            </Card>
            {choosesExhibition(formMode, loaded) && (
              <Card>
                <View style={styles.switchRow}>
                  <View style={styles.switchText}>
                    <Text style={styles.switchLabel}>Exhibition</Text>
                    <Text style={styles.hint}>Does not count in standings</Text>
                  </View>
                  <Switch
                    accessibilityLabel="Exhibition"
                    value={draft.exhibition}
                    disabled={inert}
                    trackColor={{
                      false: theme.defaultBorderColor,
                      true: theme.successColor
                    }}
                    onValueChange={exhibition => {
                      change({ exhibition })
                    }}
                  />
                </View>
              </Card>
            )}
            <Card style={styles.card}>
              <Text style={styles.section}>More</Text>
              <EventArrivalField
                value={draft.arrival}
                disabled={inert}
                onChange={arrival => {
                  arrivalTouched.current = true
                  change({ arrival })
                }}
              />
              {creating && (
                <>
                  {season != null && (
                    <Text style={styles.hint}>
                      In {season.name}.{' '}
                      {seasonApproves
                        ? 'You can schedule this game for both season participants.'
                        : 'Each team must approve unless you can approve for it.'}
                    </Text>
                  )}
                  {sourceKind === 'team' && (
                    <TextField
                      label="Outside tournament (optional)"
                      disabled={inert}
                      value={draft.outsideTournament}
                      onChangeText={outsideTournament => {
                        change({ outsideTournament })
                      }}
                    />
                  )}
                  {outsideRange && dismissedRange !== rangeWarning && (
                    <>
                      <Text style={styles.hint}>
                        This date is outside the season’s reference time frame.
                        You may still send and schedule this game.
                      </Text>
                      <Button
                        label="Dismiss date warning"
                        kind="secondary"
                        onPress={() => {
                          setDismissedRange(rangeWarning)
                        }}
                      />
                    </>
                  )}
                </>
              )}
            </Card>
            {creating && !permitted && (
              <Text style={styles.hint}>
                You need administrator access to create a game here.
              </Text>
            )}
            {scoredElsewhere && (
              <Text style={styles.hint}>{SWAP_SCORED_ELSEWHERE}</Text>
            )}
            {loaded != null && !loaded.canPropose && (
              <Text style={styles.hint}>
                {swapOnly
                  ? "As this game's scorekeeper you can swap home and away."
                  : loaded.game.status === 'cancelled'
                    ? 'This canceled game cannot be changed. Create a new game.'
                    : 'You need administrator access to change this game.'}
              </Text>
            )}
            {resetShown && loaded?.plays != null && draft.home != null && (
              <Text accessibilityRole="alert" style={styles.hint}>
                {resetWarning(loaded.plays)} {draft.away?.group.name} will bat
                first, and {draft.home.group.name} will be at home. Lineups,
                guests and unavailable players move with their teams. Lineups go
                back to how they were at the first pitch.
              </Text>
            )}
            {problem == null && missing.length > 0 && (
              <Text style={styles.hint}>
                An administrator, coach or assistant of {missing.join(' and ')}{' '}
                must approve
                {creating ? ' this game.' : ' changes.'}
              </Text>
            )}
            {error !== '' && (
              <>
                <Text accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
                {!creating && (
                  <Button
                    label="Reload game settings"
                    kind="secondary"
                    disabled={busy}
                    onPress={() => {
                      setRetry(value => value + 1)
                    }}
                  />
                )}
              </>
            )}
            {creating && sourceKind === 'team' && (
              <Text style={styles.note}>{TEAM_GAME_NOTE}</Text>
            )}
            <Button
              label={resetShown ? 'Reset and Swap' : 'Save'}
              block
              busy={busy}
              color={resetShown ? theme.dangerColor : theme.successColor}
              disabled={
                (!permitted && !(swapOnly && onlySwapped())) || problem != null
              }
              onPress={() => {
                submitGame().catch(() => undefined)
              }}
            />
            <CancelAction label="Cancel" disabled={busy} onPress={onCancel} />
            {loaded?.canPropose === true &&
              loaded.withdrawTeamIds.map(id => (
                <Button
                  key={id}
                  label={`Withdraw ${originalNames[id] ?? 'team'}`}
                  kind="text"
                  small
                  textColor={theme.dangerColor}
                  disabled={busy}
                  onPress={() => {
                    setConfirmation(id)
                  }}
                />
              ))}
            {confirmation != null && (
              <Card style={styles.card}>
                <Text style={styles.hint}>
                  Withdraw {originalNames[confirmation] ?? 'this team'}? The
                  game stays on the schedule as canceled due to withdrawal.
                </Text>
                <Button
                  label="Confirm withdrawal"
                  busy={busy}
                  onPress={() => {
                    withdraw().catch(() => undefined)
                  }}
                />
                <Button
                  label="Keep game"
                  kind="secondary"
                  disabled={busy}
                  onPress={() => {
                    setConfirmation(undefined)
                  }}
                />
              </Card>
            )}
          </>
        )}
      </View>
      {choosingField && (
        <FieldPickerScene
          client={client}
          onChoose={field => {
            setChoosingField(false)
            change({
              field,
              venue: field.venueName,
              address: field.address
            })
          }}
          onClose={() => {
            setChoosingField(false)
          }}
        />
      )}
      {choosing != null && (
        <TeamSelectorScene
          client={client}
          title={`Choose ${choosing === 'home' ? 'Home' : 'Away'} Team`}
          anchor={anchor!}
          excludeIds={[
            draft[choosing === 'home' ? 'away' : 'home']?.group.id,
            anchor?.teamId
          ].filter((id): id is string => id != null)}
          currentId={draft[choosing]?.group.id}
          custodians={custodians}
          custodianNote={custodianNote}
          onChoose={choice => {
            try {
              setDraft(chooseTeam(draft, choosing, choice, formMode))
              setError('')
            } catch (caught) {
              setError(
                caught instanceof Error ? caught.message : String(caught)
              )
            }
            setChoosing(undefined)
          }}
          onClose={() => {
            setChoosing(undefined)
          }}
        />
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1.25) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  card: { gap: theme.rem(1) },
  fieldRow: {
    gap: theme.rem(0.375),
    minHeight: theme.rem(3),
    justifyContent: 'center' as const
  },
  fieldLabel: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(0.75),
    letterSpacing: 0.5,
    color: theme.primaryTextColor
  },
  fieldValue: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.linkTextColor
  },
  section: {
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor },
  divider: {
    height: 1,
    backgroundColor: theme.defaultBorderColor,
    marginHorizontal: theme.rem(theme.cardContentInsetRem)
  },
  swap: {
    minHeight: theme.rem(3),
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  swapLabel: {
    fontSize: theme.rem(1),
    color: theme.activeColor,
    fontFamily: theme.semiBoldTextFont
  },
  pressed: { backgroundColor: theme.highlightRowActiveBackground },
  inert: { opacity: 0.5 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  switchText: { flex: 1, gap: theme.rem(0.125) },
  switchLabel: {
    fontSize: theme.rem(1),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  note: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont
  }
}))
