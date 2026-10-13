import React, { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { arrivalMinutesInput, type EventType } from '../../common/eventInfo'
import {
  eventScheduleValue,
  newEventSchedule
} from '../../common/eventSchedule'
import type { GameIntent } from '../../common/gameApprovals'
import type { GroupRef } from '../../common/groupCreation'
import { localityLabel } from '../../common/locality'
import type { PublicGroup } from '../../common/publicGroups'
import { Button, Card, Screen, TextField } from '../components'
import { EventArrivalField } from '../components/EventArrivalField'
import { EventScheduleFields } from '../components/EventScheduleFields'
import { EventTypeRow } from '../components/EventTypeRow'
import { EventVenueFields } from '../components/EventVenueFields'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { type EventCreationRetry, EventDetailsForm } from './EventDetailsForm'

async function administeredSeasons(
  client: TeamStationClient,
  groups: PublicGroup[]
): Promise<PublicGroup[]> {
  const candidates = [
    ...new Map(
      groups
        .filter(group => group.kind === 'season')
        .map(group => [group.id, group])
    ).values()
  ]
  const details = await Promise.all(
    candidates.map(
      async group => await client.group({ kind: 'season', id: group.id })
    )
  )
  return details
    .filter(detail => detail.canManage && detail.group.kind === 'season')
    .map(detail => detail.group)
}

export function CreateGameScreen({
  client,
  source,
  gameId,
  onSent,
  onEventCreated,
  onCancel
}: {
  client: TeamStationClient
  source: GroupRef
  gameId?: string
  onSent: (id: string) => void
  onEventCreated?: (id: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [eventType, setEventType] = useState<EventType>('game')
  const eventMode = eventType !== 'game'
  const [eventTeam, setEventTeam] = useState<PublicGroup>()
  const styles = getStyles(useTheme())
  const { kind: sourceKind, id: sourceId } = source
  const [home, setHome] = useState<PublicGroup | undefined>()
  const [away, setAway] = useState<PublicGroup | undefined>()
  const [choosing, setChoosing] = useState<'home' | 'away'>('away')
  const [query, setQuery] = useState('')
  const [teams, setTeams] = useState<PublicGroup[]>([])
  const [schedule, setSchedule] = useState(() => newEventSchedule())
  const { date } = schedule
  const [venue, setVenue] = useState('')
  const [address, setAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [arrival, setArrival] = useState(gameId == null ? '45' : '')
  const [eventTitle, setEventTitle] = useState('')
  const arrivalTouched = useRef(false)
  const [exhibition, setExhibition] = useState(false)
  const [outsideTournament, setOutsideTournament] = useState('')
  const [season, setSeason] = useState<PublicGroup | undefined>()
  const [hosts, setHosts] = useState<PublicGroup[]>([])
  const [hostQuery, setHostQuery] = useState('')
  const [choosingHost, setChoosingHost] = useState(false)
  const [expected, setExpected] = useState<string | undefined>()
  const [cancelling, setCancelling] = useState(false)
  const [permitted, setPermitted] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dismissedRange, setDismissedRange] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [eventBusy, setEventBusy] = useState(false)
  const eventRetry = useRef<EventCreationRetry | undefined>(undefined)
  const [retry, setRetry] = useState(0)
  const submitted = useRef<{ body: string; key: string } | undefined>(undefined)
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      client.discoverGroups('team', query).then(
        groups => {
          if (active) setTeams(groups)
        },
        () => {
          if (active) setError('Team lookup could not load. Retry.')
        }
      )
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client, query, retry])
  useEffect(() => {
    let active = true
    setHosts([])
    client
      .ownGroups()
      .then(async groups => {
        const permitted = await administeredSeasons(client, groups)
        if (active) setHosts(permitted)
      })
      .catch(() => {
        if (active) setError('Seasons could not load. Retry.')
      })
    return () => {
      active = false
    }
  }, [client, retry])
  useEffect(() => {
    if (!choosingHost) return
    let active = true
    const timer = setTimeout(() => {
      client
        .discoverGroups('season', hostQuery)
        .then(async groups => await administeredSeasons(client, groups))
        .then(
          groups => {
            if (active)
              setHosts(previous => [
                ...new Map(
                  [
                    ...previous,
                    ...groups.filter(group => group.kind === 'season')
                  ].map(group => [group.id, group])
                ).values()
              ])
          },
          () => {
            if (active)
              setError('Season lookup could not load. Try searching again.')
          }
        )
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client, choosingHost, hostQuery])
  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      setLoading(true)
      setLoadError('')
      setEventType('game')
      setEventTeam(undefined)
      const own = await client.group({ kind: sourceKind, id: sourceId })
      if (!active) return
      setPermitted(own.canManage)
      if (sourceKind === 'team') {
        setHome(own.group)
        if (!own.group.external) setEventTeam(own.group)
      } else {
        setSeason(own.group)
      }
      if (gameId == null) return
      const current = await client.gameScheduling(gameId)
      const [home, away] = await Promise.all([
        client.group({ kind: 'team', id: current.game.homeTeamId }),
        client.group({ kind: 'team', id: current.game.awayTeamId })
      ])
      const hosted =
        current.game.seasonId == null
          ? undefined
          : (await client.group({ kind: 'season', id: current.game.seasonId }))
              .group
      if (!active) return
      setHome(home.group)
      setAway(away.group)
      setSeason(hosted)
      setExpected(current.version)
      setPermitted(current.canPropose)
      setVenue(current.game.venue ?? '')
      setAddress(current.game.address ?? '')
      setNotes(current.game.notes ?? '')
      setArrival(
        current.game.arrivalTimeDelta == null
          ? ''
          : String(current.game.arrivalTimeDelta)
      )
      setSchedule(
        newEventSchedule(
          current.game.startAt,
          current.game.endAt,
          undefined,
          current.game.timezone
        )
      )
      setExhibition(current.game.exhibition ?? false)
      setOutsideTournament(current.game.outsideTournament ?? '')
      setCancelling(current.game.status === 'cancelled')
    }
    load()
      .catch((error: unknown) => {
        if (active) {
          setPermitted(false)
          setLoadError(
            error instanceof Error
              ? error.message
              : 'The game could not load. Retry.'
          )
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, sourceKind, sourceId, gameId, retry])
  const send = async (): Promise<void> => {
    if (home == null || away == null || busy) return
    setBusy(true)
    setError('')
    try {
      if (
        gameId == null &&
        season != null &&
        !(await client.group({ kind: 'season', id: season.id })).canManage
      )
        throw new Error(
          'You need administrator access to host this game in that season.'
        )
      const { startAt, endAt, timezone } = eventScheduleValue(schedule)
      const game: GameIntent = {
        notes: notes.trim() === '' ? null : notes.trim(),
        arrivalTimeDelta: arrivalMinutesInput(arrival),
        ...(address.trim() === '' && gameId == null
          ? {}
          : { address: address.trim() === '' ? null : address.trim() }),
        endAt,
        homeTeamId: home.id,
        awayTeamId: away.id,
        seasonId: season?.id ?? null,
        startAt,
        timezone,
        exhibition,
        venue: venue.trim() === '' ? null : venue,
        outsideTournament:
          season != null || outsideTournament.trim() === ''
            ? null
            : outsideTournament,
        status: cancelling ? 'cancelled' : 'scheduled'
      }
      const sender =
        sourceKind === 'team'
          ? { kind: 'team' as const, id: sourceId }
          : season != null
            ? { kind: 'season' as const, id: season.id }
            : { kind: 'team' as const, id: home.id }
      const fields = {
        sender,
        game,
        ...(sourceKind === 'team' && [home.id, away.id].includes(sourceId)
          ? { initiatingTeamId: sourceId }
          : {}),
        ...(gameId == null ? {} : { gameId, expected })
      }
      const serialized = JSON.stringify(fields)
      if (submitted.current?.body !== serialized)
        submitted.current = {
          body: serialized,
          key: `game-${Date.now()}-${Math.random().toString(36).slice(2)}`
        }
      const result = await client.proposeGame({
        ...fields,
        idempotencyKey: submitted.current.key
      })
      onSent(result.id)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'The game proposal could not be sent. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  const outsideRange =
    season?.startsOn != null &&
    season.endsOn != null &&
    (date < season.startsOn || date > season.endsOn)
  const displayError = loadError !== '' ? loadError : error
  const rangeWarning = JSON.stringify([
    season?.id,
    season?.startsOn,
    season?.endsOn,
    date
  ])
  if (loading)
    return (
      <Screen>
        <Card style={styles.card}>
          <Text style={styles.hint}>Loading game…</Text>
        </Card>
      </Screen>
    )
  return (
    <Screen>
      <View style={styles.eventChoice}>
        <EventTypeRow
          value={eventType}
          disabled={
            sourceKind !== 'team' ||
            gameId != null ||
            !permitted ||
            eventTeam == null ||
            busy ||
            eventBusy
          }
          onChange={type => {
            setEventType(type)
            if (!arrivalTouched.current)
              setArrival(type === 'game' ? '45' : '0')
          }}
        />
      </View>
      {eventMode && eventTeam != null ? (
        <EventDetailsForm
          client={client}
          teamId={eventTeam.id}
          eventType={eventType}
          hideType
          creationRetry={eventRetry}
          onBusyChange={setEventBusy}
          draft={{
            title: eventTitle,
            schedule,
            venue,
            address,
            notes,
            arrival
          }}
          onDraftChange={draft => {
            if (draft.arrival !== arrival) arrivalTouched.current = true
            setEventTitle(draft.title)
            setSchedule(draft.schedule)
            setVenue(draft.venue)
            setAddress(draft.address)
            setNotes(draft.notes)
            setArrival(draft.arrival)
          }}
          onSaved={id => {
            ;(onEventCreated ?? onSent)(id)
          }}
          onCancel={onCancel}
        />
      ) : (
        <Card style={styles.card}>
          <Text style={styles.title}>
            {gameId == null ? 'Create Game' : 'Propose game change'}
          </Text>
          <Text style={styles.hint}>
            {season == null
              ? 'Outside a TeamStation season'
              : `Hosted by ${season.name}`}
            . Every affected team must approve. This creates no parent
            organization or season participation.
          </Text>
          {!permitted && (
            <Text style={styles.error}>
              This game cannot be changed here. A season game needs its
              organizer; a withdrawn game requires a new game.
            </Text>
          )}
          <Button
            label="Choose a different season"
            kind="secondary"
            onPress={() => {
              setChoosingHost(!choosingHost)
            }}
          />
          {choosingHost && (
            <View style={styles.hosts}>
              <Text style={styles.name}>Season</Text>
              <Button
                label="Outside a TeamStation season"
                kind="secondary"
                onPress={() => {
                  setSeason(undefined)
                  setChoosingHost(false)
                }}
              />
              <TextField
                label="Find a season you manage"
                value={hostQuery}
                onChangeText={setHostQuery}
              />
              {hosts
                .filter(host =>
                  host.name
                    .toLocaleLowerCase()
                    .includes(hostQuery.toLocaleLowerCase())
                )
                .map(host => (
                  <Button
                    key={host.id}
                    label={`Host: ${host.name}`}
                    kind={season?.id === host.id ? 'primary' : 'secondary'}
                    onPress={() => {
                      setSeason(host)
                      setChoosingHost(false)
                    }}
                  />
                ))}
            </View>
          )}
          <View style={styles.sideRow}>
            <Button
              label={`Home: ${home?.name ?? 'Choose team'}`}
              kind={choosing === 'home' ? 'primary' : 'secondary'}
              onPress={() => {
                setChoosing('home')
              }}
            />
            <Button
              label={`Away: ${away?.name ?? 'Choose team'}`}
              kind={choosing === 'away' ? 'primary' : 'secondary'}
              onPress={() => {
                setChoosing('away')
              }}
            />
          </View>
          <TextField
            label="Find a team"
            value={query}
            onChangeText={setQuery}
          />
          <ScrollView
            style={styles.teams}
            contentContainerStyle={styles.teamList}
          >
            {teams.map(team => (
              <Pressable
                key={team.id}
                accessibilityRole="button"
                accessibilityLabel={`Choose ${team.name}${teams.filter(other => other.name === team.name).length < 2 ? '' : ', ' + (team.locality == null ? 'Location not set' : localityLabel(team.locality))}`}
                onPress={() => {
                  choosing === 'home' ? setHome(team) : setAway(team)
                }}
                style={styles.team}
              >
                <Text style={styles.name}>{team.name}</Text>
                <Text style={styles.hint}>
                  {team.locality == null
                    ? 'Location not set'
                    : localityLabel(team.locality)}
                  {team.external ? ' · Placeholder' : ''}
                </Text>
                {team.parentNames.length > 0 && (
                  <Text style={styles.hint}>{team.parentNames.join(', ')}</Text>
                )}
              </Pressable>
            ))}
          </ScrollView>
          <EventScheduleFields
            value={schedule}
            onChange={setSchedule}
            disabled={busy}
          />
          <EventArrivalField
            value={arrival}
            disabled={busy}
            onChange={value => {
              arrivalTouched.current = true
              setArrival(value)
            }}
          />
          <EventVenueFields
            client={client}
            value={{ venue, address, notes }}
            disabled={busy}
            onChange={value => {
              setVenue(value.venue)
              setAddress(value.address)
              setNotes(value.notes)
            }}
          />
          <Button
            label={exhibition ? 'Exhibition: On' : 'Exhibition: Off'}
            kind="secondary"
            onPress={() => {
              setExhibition(value => !value)
            }}
          />
          {season == null && (
            <TextField
              label="Outside tournament (optional)"
              value={outsideTournament}
              onChangeText={setOutsideTournament}
            />
          )}
          {outsideRange && dismissedRange !== rangeWarning && (
            <>
              <Text style={styles.hint}>
                This date is outside the season’s reference time frame. You may
                still send and schedule this game.
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
          {gameId != null && (
            <Button
              label={
                cancelling ? 'Cancellation selected' : 'Propose cancellation'
              }
              kind="secondary"
              onPress={() => {
                setCancelling(!cancelling)
              }}
            />
          )}
          {displayError !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {displayError}
            </Text>
          )}
          <Button
            label="Send game proposal"
            busy={busy}
            disabled={
              !permitted || home == null || away == null || home.id === away.id
            }
            onPress={() => {
              send().catch(() => undefined)
            }}
          />
          <Button
            label="Retry teams"
            kind="secondary"
            onPress={() => {
              setRetry(retry + 1)
            }}
          />
          <Button
            label="Cancel"
            kind="secondary"
            disabled={busy}
            onPress={onCancel}
          />
        </Card>
      )}
    </Screen>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  eventChoice: {
    width: '100%',
    flexDirection: 'row',
    gap: theme.rem(0.75),
    marginBottom: theme.rem(1)
  },
  card: { gap: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  name: {
    fontSize: theme.rem(1),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor },
  sideRow: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: theme.rem(0.5)
  },
  teams: { maxHeight: 250 },
  teamList: { gap: theme.rem(0.5) },
  hosts: { gap: theme.rem(0.5) },
  team: {
    padding: theme.rem(0.75),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.cardBackgroundColor
  }
}))
