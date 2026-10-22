import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import type { GroupDetail } from '../../common/publicGroups'
import { seasonPeriodLabel } from '../../common/seasonTimeFrames'
import {
  Button,
  HeroCard,
  ListCard,
  ListRow,
  PictureSheet,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import { DateRangePicker } from '../components/DateRangePicker'
import { LocationRow } from '../components/LocationRow'
import { useTitleHandoff } from '../components/useTitleHandoff'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  UmpireSettingsCard,
  type UmpireSettingsDestination
} from '../umpires/UmpireSettingsCard'
import { GroupGameSchedule } from './GroupGameSchedule'
import { InvitationsWaiting } from './InvitationsWaiting'
import { ManagementCard, type ManagementCardProps } from './ManagementCard'
import { ParentOrganizations } from './ParentOrganizations'
import { ParticipationList } from './ParticipationList'
import { SeasonParticipations } from './SeasonParticipations'

export function GroupSettingsScreen({
  client,
  groupRef,
  onChanged,
  onRequest,
  onLocation,
  onAddPeople,
  onInvites,
  onPromote,
  onUmpires
}: {
  client: TeamStationClient
  groupRef: GroupRef
  onChanged?: () => void
  onRequest?: (id: string) => void
  onLocation?: (ref: GroupRef) => void
  onAddPeople?: (ref: GroupRef) => void
  onInvites?: (ref: GroupRef) => void
  onUmpires?: (screen: UmpireSettingsDestination) => void
  onPromote?: ManagementCardProps['onPromote']
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const { kind, id } = groupRef
  const [detail, setDetail] = useState<GroupDetail>()
  const [name, setName] = useState('')
  const [photo, setPhoto] = useState(false)
  const [calendar, setCalendar] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const lastName = useRef<string | undefined>(undefined)
  const lastGroup = useRef<string | undefined>(undefined)
  const working = useRef(false)
  const begin = useLatestRequest()
  const beginSave = useLatestRequest()
  useEffect(() => {
    const identity = `${kind}:${id}`
    if (lastGroup.current !== identity) {
      lastGroup.current = identity
      lastName.current = undefined
      setName('')
      setDetail(undefined)
      working.current = false
      setBusy(false)
    }
    const current = begin()
    beginSave()
    // A relationship refresh can invalidate a save without changing the group.
    // Release its UI lock; the stale completion cannot update this visit.
    working.current = false
    setBusy(false)
    client.group({ kind, id }).then(
      value => {
        if (!current()) return
        setDetail(value)
        const previousName = lastName.current
        setName(current =>
          previousName == null || current === previousName
            ? value.group.name
            : current
        )
        lastName.current = value.group.name
        setError('')
      },
      (error: unknown) => {
        if (current())
          setError(
            error instanceof Error
              ? error.message
              : 'Settings could not load. Retry.'
          )
      }
    )
  }, [client, kind, id, revision, begin, beginSave])
  const update = async (
    fields: Parameters<TeamStationClient['updateGroup']>[1]
  ): Promise<void> => {
    if (working.current || detail == null) return
    working.current = true
    const current = beginSave()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await client.updateGroup(
        { kind: detail.group.kind, id: detail.group.id },
        fields
      )
      if (current()) {
        onChanged?.()
        setRevision(value => value + 1)
        if (fields.name != null) setNotice('Name saved')
      }
    } catch (error) {
      if (current())
        setError(
          error instanceof Error
            ? error.message
            : 'Settings could not be saved. Retry.'
        )
      throw error
    } finally {
      if (current()) {
        working.current = false
        setBusy(false)
      }
    }
  }
  const title = settingsTitle(detail?.group.kind ?? kind)
  const handoff = useTitleHandoff(title)
  const group = detail?.group
  const dates = seasonPeriodLabel(
    group?.startsOn ?? null,
    group?.endsOn ?? null
  )
  return (
    <Screen onScroll={handoff.handleScroll}>
      <View style={styles.page}>
        <View ref={handoff.ref} collapsable={false}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
        </View>
        {detail == null ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : !detail.canManage ? (
          <Text style={styles.hint}>
            Only a current administrator can change these settings.
          </Text>
        ) : (
          <>
            <HeroCard
              team={kind === 'team'}
              name={detail.group.name}
              uri={detail.group.imageUrl}
              secondary={
                kind === 'season'
                  ? dates
                  : detail.group.locality == null
                    ? 'Location not set'
                    : `${detail.group.locality.city}, ${detail.group.locality.region}`
              }
              disabled={busy}
              onEdit={() => {
                setPhoto(true)
              }}
            />
            {photo && (
              <PictureSheet
                fitInitials
                team={kind === 'team'}
                client={client}
                name={detail.group.name}
                onSave={async picture => {
                  await update({ picture })
                }}
                onClose={() => {
                  setPhoto(false)
                }}
              />
            )}
            <View style={styles.section}>
              <SectionHeader
                title={`${detail.group.kind[0].toUpperCase()}${detail.group.kind.slice(1)} Details`}
              />
              <ListCard>
                <View style={styles.nameForm}>
                  <TextField
                    label="Name"
                    value={name}
                    onChangeText={setName}
                    disabled={busy}
                  />
                  <Button
                    label="Save name"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={
                      busy ||
                      name.trim() === '' ||
                      name.trim() === detail.group.name
                    }
                    onPress={() => {
                      update({ name }).catch(() => undefined)
                    }}
                  />
                  {notice !== '' && (
                    <Text accessibilityLiveRegion="polite" style={styles.hint}>
                      {notice}
                    </Text>
                  )}
                </View>
                {kind !== 'season' && (
                  <LocationRow
                    value={detail.group.locality}
                    onPress={
                      onLocation == null
                        ? undefined
                        : () => {
                            onLocation({
                              kind: detail.group.kind,
                              id: detail.group.id
                            })
                          }
                    }
                  />
                )}
                {kind === 'season' && (
                  <>
                    <ListRow
                      title={dates}
                      subtitle="Time frame"
                      onPress={() => {
                        setCalendar(value => !value)
                      }}
                    />
                    {calendar && (
                      <DateRangePicker
                        initial={
                          detail.group.startsOn == null ||
                          detail.group.endsOn == null
                            ? undefined
                            : {
                                startsOn: detail.group.startsOn,
                                endsOn: detail.group.endsOn
                              }
                        }
                        onChoose={range => {
                          update(range)
                            .then(() => {
                              setCalendar(false)
                            })
                            .catch(() => undefined)
                        }}
                        onCancel={() => {
                          setCalendar(false)
                        }}
                      />
                    )}
                    <Text style={styles.hint}>
                      Editing this reference time frame does not move scheduled
                      games.
                    </Text>
                  </>
                )}
              </ListCard>
            </View>
            <ManagementCard
              detail={detail}
              disabled={busy}
              onPromote={onPromote}
              onAddPeople={onAddPeople}
              onInvites={onInvites}
            />
            {!detail.group.external && (
              <InvitationsWaiting
                client={client}
                scopeKind={detail.group.kind}
                scopeId={detail.group.id}
                onChanged={onChanged}
              />
            )}
            {kind === 'league' && onUmpires != null && (
              <UmpireSettingsCard
                client={client}
                league={id}
                onOpen={onUmpires}
                onChanged={onChanged}
              />
            )}
            {detail.group.kind === 'team' && onRequest != null && (
              <GroupGameSchedule
                client={client}
                groupRef={{ kind: 'team', id: detail.group.id }}
                onRequest={onRequest}
                disabled={busy}
              />
            )}
            {detail.group.kind === 'team' && (
              <SeasonParticipations
                key={detail.group.id}
                client={client}
                teamId={detail.group.id}
                seasons={detail.participatingSeasons}
                disabled={busy}
                onLeft={() => {
                  setRevision(value => value + 1)
                  onChanged?.()
                }}
              />
            )}
            {detail.group.kind === 'season' && (
              <View style={styles.section}>
                <ParticipationList
                  client={client}
                  owner={{
                    kind: 'season',
                    id: detail.group.id,
                    name: detail.group.name
                  }}
                  groups={detail.competingTeams}
                  disabled={busy}
                  onLeft={() => {
                    setRevision(value => value + 1)
                    onChanged?.()
                  }}
                />
              </View>
            )}
            {detail.group.kind === 'team' && (
              <ParentOrganizations
                client={client}
                teamId={detail.group.id}
                teamName={detail.group.name}
                parents={detail.parents}
                onLeft={() => {
                  setRevision(value => value + 1)
                  onChanged?.()
                }}
              />
            )}
          </>
        )}
        {error !== '' && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            <Button
              label="Retry settings"
              kind="secondary"
              onPress={() => {
                setRevision(value => value + 1)
              }}
            />
          </>
        )}
      </View>
    </Screen>
  )
}
export function settingsTitle(kind: GroupRef['kind']): string {
  return kind === 'league'
    ? 'League Settings'
    : kind === 'season'
      ? 'Season Settings'
      : 'Team Settings'
}
const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1.25) },
  section: { gap: theme.rem(0.75) },
  card: { gap: theme.rem(0.75) },
  nameForm: { gap: theme.rem(0.75), padding: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  name: {
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    padding: theme.rem(0.5),
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor }
}))
