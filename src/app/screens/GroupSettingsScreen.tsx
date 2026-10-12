import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupPicture, GroupRef } from '../../common/groupCreation'
import type { Locality } from '../../common/locality'
import type { GroupDetail } from '../../common/publicGroups'
import { formatDateRange } from '../../common/seasonTimeFrames'
import { Button, Card, Screen, SectionHeader, TextField } from '../components'
import { DateRangePicker } from '../components/DateRangePicker'
import { GroupPictureChooser } from '../components/GroupPictureChooser'
import { LocalityPicker } from '../components/LocalityPicker'
import { useTitleHandoff } from '../components/useTitleHandoff'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { GroupGameSchedule } from './GroupGameSchedule'
import { GroupPeopleSettings } from './GroupPeopleSettings'
import type { GroupLinkChoice } from './GroupScreen'
import {
  TeamSettingsActions,
  type TeamSettingsActionsProps
} from './TeamSettingsActions'

export function GroupSettingsScreen({
  client,
  groupRef,
  onLink,
  onSaved,
  onChanged,
  onRequest,
  onCancel,
  onCreateGame,
  onCreateExternal,
  onPromote
}: {
  client: TeamStationClient
  groupRef: GroupRef
  onLink: (choice: GroupLinkChoice) => void
  onSaved: () => void
  onChanged?: () => void
  onRequest?: (id: string) => void
  onCancel?: () => void
  onCreateGame?: TeamSettingsActionsProps['onCreateGame']
  onCreateExternal?: TeamSettingsActionsProps['onCreateExternal']
  onPromote?: TeamSettingsActionsProps['onPromote']
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const { kind, id } = groupRef
  const [detail, setDetail] = useState<GroupDetail | undefined>()
  const [name, setName] = useState('')
  const [locality, setLocality] = useState<Locality | null>(null)
  const [range, setRange] = useState<
    { startsOn: string; endsOn: string } | undefined
  >()
  const [picture, setPicture] = useState<GroupPicture | undefined>()
  const [choosingPhoto, setChoosingPhoto] = useState(false)
  const [calendar, setCalendar] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const beginSave = useLatestRequest()
  useEffect(() => {
    beginSave()
    setBusy(false)
  }, [beginSave, client, kind, id])
  useEffect(() => {
    let active = true
    client.group({ kind, id }).then(
      value => {
        if (!active) return
        setDetail(value)
        setName(value.group.name)
        setLocality(value.group.locality)
        if (value.group.startsOn != null && value.group.endsOn != null)
          setRange({
            startsOn: value.group.startsOn,
            endsOn: value.group.endsOn
          })
        setError('')
      },
      (error: unknown) => {
        if (active)
          setError(
            error instanceof Error
              ? error.message
              : 'Settings could not load. Retry.'
          )
      }
    )
    return () => {
      active = false
    }
  }, [client, kind, id, revision])
  const save = async (): Promise<void> => {
    if (busy) return
    const current = beginSave()
    setBusy(true)
    setError('')
    try {
      await client.updateGroup(
        detail == null
          ? { kind, id }
          : { kind: detail.group.kind, id: detail.group.id },
        {
          name,
          ...(kind === 'season' ? range : locality == null ? {} : { locality }),
          picture
        }
      )
      if (current()) onSaved()
    } catch (error) {
      if (!current()) return
      setError(
        error instanceof Error
          ? error.message
          : 'Settings could not be saved. Retry.'
      )
    } finally {
      if (current()) setBusy(false)
    }
  }
  const leave = async (teamId: string, seasonId: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await client.endParticipation(seasonId, teamId)
      onChanged?.()
      setRevision(revision + 1)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Participation could not end. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  const title = settingsTitle(detail?.group.kind ?? kind)
  const handoff = useTitleHandoff(title)
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
            <Card style={styles.card}>
              <TextField label="Name" value={name} onChangeText={setName} />
              {kind !== 'season' && (
                <LocalityPicker
                  client={client}
                  value={locality}
                  onChange={setLocality}
                />
              )}
              {kind === 'season' && (
                <>
                  <Text style={styles.hint}>
                    {formatDateRange(
                      range?.startsOn ?? null,
                      range?.endsOn ?? null
                    )}
                  </Text>
                  <Button
                    label="Change time frame"
                    kind="secondary"
                    onPress={() => {
                      setCalendar(true)
                    }}
                  />
                  {calendar && (
                    <DateRangePicker
                      initial={range}
                      onChoose={value => {
                        setRange(value)
                        setCalendar(false)
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
              <Button
                label="Change picture"
                kind="secondary"
                onPress={() => {
                  setChoosingPhoto(!choosingPhoto)
                }}
              />
              {choosingPhoto && (
                <GroupPictureChooser
                  client={client}
                  name={name}
                  value={picture}
                  onChange={setPicture}
                />
              )}
              <Button
                label="Save settings"
                busy={busy}
                disabled={name.trim() === ''}
                onPress={() => {
                  save().catch(() => undefined)
                }}
              />
            </Card>
            {onCancel != null && (
              <Button
                label="Cancel"
                kind="secondary"
                disabled={busy}
                onPress={onCancel}
              />
            )}
            <TeamSettingsActions
              detail={detail}
              disabled={busy}
              onLink={onLink}
              onCreateGame={onCreateGame}
              onCreateExternal={onCreateExternal}
              onPromote={onPromote}
            />
            {
              // A placeholder team has no people of its own: its custodian
              // keeps it, and promoting it is how somebody is added.
              !detail.group.external && (
                <GroupPeopleSettings
                  client={client}
                  scopeKind={detail.group.kind}
                  scopeId={detail.group.id}
                  onOpenRequest={onRequest}
                  onChanged={onChanged}
                />
              )
            }
            {detail.group.kind === 'team' && onRequest != null && (
              <GroupGameSchedule
                client={client}
                groupRef={{ kind: 'team', id: detail.group.id }}
                onRequest={onRequest}
                disabled={busy}
              />
            )}
            {detail.participatingSeasons.length > 0 && (
              <View style={styles.section}>
                <SectionHeader title="Season participation" />
                {detail.participatingSeasons.map(season => (
                  <Card key={season.id} style={styles.card}>
                    <Text style={styles.name}>{season.name}</Text>
                    <Text style={styles.hint}>
                      Ending participation leaves all scheduled games and
                      management parents unchanged.
                    </Text>
                    <Button
                      label={`End participation in ${season.name}`}
                      kind="secondary"
                      disabled={busy}
                      onPress={() => {
                        leave(detail.group.id, season.id).catch(() => undefined)
                      }}
                    />
                  </Card>
                ))}
              </View>
            )}
            {detail.competingTeams.length > 0 && (
              <View style={styles.section}>
                <SectionHeader title="Participating teams" />
                {detail.competingTeams.map(team => (
                  <Card key={team.id} style={styles.card}>
                    <Text style={styles.name}>{team.name}</Text>
                    <Button
                      label={`End participation for ${team.name}`}
                      kind="secondary"
                      disabled={busy}
                      onPress={() => {
                        leave(team.id, detail.group.id).catch(() => undefined)
                      }}
                    />
                  </Card>
                ))}
              </View>
            )}
          </>
        )}
        {error !== '' && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            {detail == null && (
              <Button
                label="Retry settings"
                kind="secondary"
                onPress={() => {
                  setRevision(revision + 1)
                }}
              />
            )}
          </>
        )}
      </View>
    </Screen>
  )
}

/** `League Settings`, `Season Settings` or `Team Settings`, never "group". */
export function settingsTitle(kind: GroupRef['kind']): string {
  return kind === 'league'
    ? 'League Settings'
    : kind === 'season'
      ? 'Season Settings'
      : 'Team Settings'
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1.25) },
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
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor },
  section: { gap: theme.rem(0.75) },
  card: { gap: theme.rem(0.75) }
}))
