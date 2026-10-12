import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GameIntent } from '../../common/gameApprovals'
import { gameCalendarDay, gameTime } from '../../common/gameTime'
import type { CreateGroup } from '../../common/groupCreation'
import type { Locality } from '../../common/locality'
import type { GroupDetail, PublicGroup } from '../../common/publicGroups'
import {
  Button,
  Card,
  Emblem,
  Icon,
  initialsOf,
  Screen,
  TextField
} from '../components'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface GameSettingsResult {
  id: string
  status: string
  gameId: string | null
}
interface TeamChoice {
  group: PublicGroup
  canManage: boolean
  placeholder?: CreateGroup
}
type Side = 'away' | 'home'
interface LoadedGame {
  game: GameIntent
  version: string
  withdrawTeamIds: string[]
  canPropose: boolean
}
const retryKey = (): string =>
  `settings-${Date.now()}-${Math.random().toString(36).slice(2)}`

/** Editing stays local until submission, including a newly named placeholder. */
export function GameSettingsScreen({
  client,
  gameId,
  onSaved,
  onCancel
}: {
  client: TeamStationClient
  gameId: string
  onSaved: (result: GameSettingsResult) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [loaded, setLoaded] = useState<LoadedGame>()
  const [home, setHome] = useState<TeamChoice>()
  const [away, setAway] = useState<TeamChoice>()
  const [originalNames, setOriginalNames] = useState<Record<string, string>>({})
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [timezone, setTimezone] = useState('UTC')
  const [venue, setVenue] = useState('')
  const [exhibition, setExhibition] = useState(false)
  const [choosing, setChoosing] = useState<Side>()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<PublicGroup[]>([])
  const [lookupError, setLookupError] = useState('')
  const [placeholderName, setPlaceholderName] = useState<string>()
  const [custodians, setCustodians] = useState<PublicGroup[]>([])
  const [custodian, setCustodian] = useState<PublicGroup>()
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [country, setCountry] = useState('US')
  const [confirmation, setConfirmation] = useState<string>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const begin = useLatestRequest()
  const choosingRequest = useLatestRequest()
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
    setError('')
    const load = async (): Promise<void> => {
      const state = await client.gameScheduling(gameId)
      const [homeDetail, awayDetail] = await Promise.all([
        client.group({ kind: 'team', id: state.game.homeTeamId }),
        client.group({ kind: 'team', id: state.game.awayTeamId })
      ])
      if (!current()) return
      const zone = state.game.timezone ?? 'UTC'
      setLoaded(state)
      setHome({ group: homeDetail.group, canManage: homeDetail.canManage })
      setAway({ group: awayDetail.group, canManage: awayDetail.canManage })
      setOriginalNames({
        [homeDetail.group.id]: homeDetail.group.name,
        [awayDetail.group.id]: awayDetail.group.name
      })
      setDate(gameCalendarDay(state.game.startAt, zone))
      setTime(
        new Intl.DateTimeFormat('en', {
          timeZone: zone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23'
        }).format(new Date(state.game.startAt))
      )
      setTimezone(zone)
      setVenue(state.game.venue ?? '')
      setExhibition(state.game.exhibition ?? false)
      setChoosing(undefined)
      setConfirmation(undefined)
      submitted.current = undefined
    }
    load()
      .catch((caught: unknown) => {
        if (current()) {
          setLoaded(undefined)
          setError(
            caught instanceof Error
              ? caught.message
              : 'Game settings could not load.'
          )
        }
      })
      .finally(() => {
        if (current()) setLoading(false)
      })
  }, [client, gameId, retry, begin])

  useEffect(() => {
    if (choosing == null) return
    let active = true
    const timer = setTimeout(() => {
      setLookupError('')
      client.discoverGroups('team', query).then(
        groups => {
          if (active) setFound(groups)
        },
        () => {
          if (active) {
            setFound([])
            setLookupError('Teams could not load. Try searching again.')
          }
        }
      )
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client, choosing, query])

  const setChoice = (side: Side, choice: TeamChoice): void => {
    side === 'away' ? setAway(choice) : setHome(choice)
    setChoosing(undefined)
    setPlaceholderName(undefined)
    setError('')
  }
  const choose = async (group: PublicGroup, side: Side): Promise<void> => {
    const current = choosingRequest()
    setLookupError('')
    try {
      const detail = await client.group({ kind: 'team', id: group.id })
      if (current())
        setChoice(side, { group: detail.group, canManage: detail.canManage })
    } catch (caught) {
      if (current())
        setLookupError(
          caught instanceof Error ? caught.message : 'Team could not load.'
        )
    }
  }
  const startPlaceholder = async (): Promise<void> => {
    const current = choosingRequest()
    setPlaceholderName('')
    setLookupError('')
    try {
      const groups = await client.ownGroups()
      const details: GroupDetail[] = await Promise.all(
        groups.map(
          async group => await client.group({ kind: group.kind, id: group.id })
        )
      )
      const permitted = details
        .filter(detail => detail.canManage && !detail.group.external)
        .map(detail => detail.group)
      if (!current()) return
      setCustodians(permitted)
      const participating =
        loaded == null ? [] : [loaded.game.homeTeamId, loaded.game.awayTeamId]
      const team = participating
        .map(id =>
          permitted.find(group => group.kind === 'team' && group.id === id)
        )
        .find(group => group != null)
      const season = permitted.find(
        group => group.kind === 'season' && group.id === loaded?.game.seasonId
      )
      setCustodian(team ?? season ?? permitted[0])
    } catch (caught) {
      if (current())
        setLookupError(
          caught instanceof Error
            ? caught.message
            : 'Managing groups could not load.'
        )
    }
  }
  const stagePlaceholder = (): void => {
    if (choosing == null || custodian == null || placeholderName == null) return
    const name = placeholderName.trim()
    if (name.length === 0) {
      setLookupError('Enter a placeholder name.')
      return
    }
    const locality: Locality = custodian.locality ?? {
      city: city.trim(),
      region: region.trim(),
      country: country.trim(),
      placeId: null,
      timezone
    }
    if (locality.city === '' || locality.region === '') {
      setLookupError('Enter a city and state or region.')
      return
    }
    const draft: CreateGroup = {
      kind: 'team',
      name,
      external: true,
      custodian: { kind: custodian.kind, id: custodian.id },
      locality,
      picture: { initials: true },
      idempotencyKey: retryKey()
    }
    setChoice(choosing, {
      canManage: true,
      placeholder: draft,
      group: {
        id: `draft-${draft.idempotencyKey}`,
        kind: 'team',
        name,
        imageUrl: null,
        locality,
        startsOn: null,
        endsOn: null,
        timezone,
        external: true,
        parentNames: [],
        leagueId: null
      }
    })
  }
  const createSelectedPlaceholder = async (
    choice: TeamChoice
  ): Promise<TeamChoice> => {
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
  const send = async (): Promise<void> => {
    if (loaded == null || home == null || away == null || sending.current)
      return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      if (home.group.id === away.group.id)
        throw new Error('Choose two different teams.')
      // Validate the date before committing even an explicitly submitted placeholder.
      const startAt = gameTime(date, time, timezone)
      const resolvedHome = await createSelectedPlaceholder(home)
      const resolvedAway = await createSelectedPlaceholder(away)
      setHome(resolvedHome)
      setAway(resolvedAway)
      const senderId = loaded.withdrawTeamIds[0]
      if (senderId == null)
        throw new Error(
          'You need administrator access to a participating team.'
        )
      const fields = {
        sender: { kind: 'team' as const, id: senderId },
        initiatingTeamId: senderId,
        gameId,
        expected: loaded.version,
        game: {
          ...loaded.game,
          homeTeamId: resolvedHome.group.id,
          awayTeamId: resolvedAway.group.id,
          startAt,
          timezone,
          exhibition,
          venue: venue.trim() === '' ? null : venue.trim()
        }
      }
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
      if (mounted.current) onSaved(result)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Game changes could not be submitted. Retry.'
      )
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  const withdraw = useCallback(async (): Promise<void> => {
    if (confirmation == null || sending.current) return
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

  if (loading)
    return (
      <Screen>
        <Text style={styles.hint}>Loading game settings…</Text>
      </Screen>
    )
  const canSave = home?.canManage === true && away?.canManage === true
  const missing = [away, home]
    .filter(choice => choice != null && !choice.canManage)
    .map(choice => choice!.group.name)
  const preview = (
    side: Side,
    team: TeamChoice | undefined
  ): React.ReactNode => (
    <View style={styles.previewRow}>
      <Emblem
        uri={team?.group.imageUrl}
        fallback={initialsOf(team?.group.name ?? '')}
        size={2.5}
      />
      <View style={styles.previewText}>
        <Text style={styles.teamName}>{team?.group.name ?? 'Choose team'}</Text>
        <Text style={styles.hint}>
          {side === 'away' ? 'Away' : 'Home'}
          {team?.group.external === true ? ' · Placeholder' : ''}
        </Text>
      </View>
    </View>
  )
  return (
    <Screen>
      <Card style={styles.card}>
        <Text style={styles.title}>Game Settings</Text>
        {preview('away', away)}
        {preview('home', home)}
        <Button
          label="Swap home and away"
          kind="secondary"
          disabled={busy || loaded?.canPropose !== true}
          onPress={() => {
            setHome(away)
            setAway(home)
          }}
        />
        <Text style={styles.sectionTitle}>Change Teams</Text>
        <View style={styles.changeBox}>
          {(['away', 'home'] as const).map((side, index) => (
            <Pressable
              key={side}
              accessibilityRole="button"
              accessibilityLabel={`Change ${(side === 'away' ? away : home)?.group.name ?? (side === 'away' ? 'Away Team' : 'Home Team')}`}
              disabled={busy || loaded?.canPropose !== true}
              onPress={() => {
                choosingRequest()
                setChoosing(side)
                setQuery('')
                setPlaceholderName(undefined)
              }}
              style={[styles.changeRow, index === 1 && styles.divider]}
            >
              <Text style={styles.changeLabel}>
                Change {(side === 'away' ? away : home)?.group.name ?? 'team'}
              </Text>
              <Icon name="chevron_right" />
            </Pressable>
          ))}
        </View>
        {choosing != null && (
          <View style={styles.card}>
            <TextField
              label="Find a team"
              value={query}
              onChangeText={setQuery}
            />
            {found.map(group => (
              <Button
                key={group.id}
                kind="secondary"
                label={`Choose ${group.name}${group.external ? ' (Placeholder)' : ''}`}
                onPress={() => {
                  choose(group, choosing).catch(() => undefined)
                }}
              />
            ))}
            <Button
              label="Create a placeholder"
              kind="secondary"
              onPress={() => {
                startPlaceholder().catch(() => undefined)
              }}
            />
            {placeholderName != null && (
              <View style={styles.card}>
                <TextField
                  label="Placeholder name"
                  value={placeholderName}
                  onChangeText={setPlaceholderName}
                />
                <Text style={styles.hint}>
                  Choose the group that manages this placeholder. It will be
                  created when you submit the game.
                </Text>
                {custodians.map(group => (
                  <Button
                    key={`${group.kind}:${group.id}`}
                    label={`Managed by ${group.name}`}
                    kind={custodian?.id === group.id ? 'primary' : 'secondary'}
                    onPress={() => {
                      setCustodian(group)
                    }}
                  />
                ))}
                {custodian?.locality == null && (
                  <>
                    <TextField
                      label="City"
                      value={city}
                      onChangeText={setCity}
                    />
                    <TextField
                      label="State or region"
                      value={region}
                      onChangeText={setRegion}
                    />
                    <TextField
                      label="Country"
                      value={country}
                      onChangeText={setCountry}
                    />
                  </>
                )}
                <Button
                  label="Use this placeholder"
                  disabled={custodian == null}
                  onPress={stagePlaceholder}
                />
              </View>
            )}
            {lookupError !== '' && (
              <Text accessibilityRole="alert" style={styles.error}>
                {lookupError}
              </Text>
            )}
            <Button
              label="Close team picker"
              kind="secondary"
              onPress={() => {
                choosingRequest()
                setChoosing(undefined)
              }}
            />
          </View>
        )}
        <TextField
          label="Date"
          value={date}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
        />
        <TextField
          label="Time"
          value={time}
          onChangeText={setTime}
          placeholder="18:00"
        />
        <TextField
          label="Time zone"
          value={timezone}
          onChangeText={setTimezone}
        />
        <TextField
          label="Venue (optional)"
          value={venue}
          onChangeText={setVenue}
        />
        <Button
          label={exhibition ? 'Exhibition: On' : 'Exhibition: Off'}
          kind="secondary"
          disabled={busy || loaded?.canPropose !== true}
          onPress={() => {
            setExhibition(value => !value)
          }}
        />
        {error !== '' && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            {loaded != null && (
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
        {loaded == null ? (
          <Button
            label="Retry game settings"
            onPress={() => {
              setRetry(value => value + 1)
            }}
          />
        ) : (
          <>
            {!loaded.canPropose && (
              <Text style={styles.hint}>
                {loaded.game.status === 'cancelled'
                  ? 'This canceled game cannot be changed. Create a new game.'
                  : 'You need administrator access to change this game.'}
              </Text>
            )}
            {!canSave && missing.length > 0 && (
              <Text style={styles.hint}>
                An admin of {missing.join(' and ')} must approve changes.
              </Text>
            )}
            <Button
              label={canSave ? 'Save' : 'Send Game Proposal'}
              busy={busy}
              disabled={
                !loaded.canPropose ||
                home == null ||
                away == null ||
                home.group.id === away.group.id
              }
              onPress={() => {
                send().catch(() => undefined)
              }}
            />
          </>
        )}
        <Button
          label="Cancel"
          kind="secondary"
          disabled={busy}
          onPress={onCancel}
        />
        {loaded?.canPropose === true &&
          loaded.withdrawTeamIds.map(id => (
            <Button
              key={id}
              label={`Withdraw ${originalNames[id] ?? 'team'} from game`}
              kind="secondary"
              disabled={busy}
              onPress={() => {
                setConfirmation(id)
              }}
            />
          ))}
        {confirmation != null && (
          <View style={styles.card}>
            <Text style={styles.hint}>
              Withdraw {originalNames[confirmation] ?? 'this team'}? The game
              stays on the schedule as canceled due to withdrawal.
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
          </View>
        )}
      </Card>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: { gap: theme.rem(0.9) },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor
  },
  sectionTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  hint: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor,
    lineHeight: theme.rem(1.3)
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.75)
  },
  previewText: { flex: 1, gap: theme.rem(0.125) },
  teamName: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor
  },
  changeBox: {
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    borderRadius: theme.rem(theme.radiusRem),
    overflow: 'hidden'
  },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: theme.rem(theme.cardContentInsetRem),
    gap: theme.rem(0.5)
  },
  changeLabel: {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  divider: { borderTopWidth: 1, borderTopColor: theme.defaultBorderColor }
}))
