import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { PersonProfile, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { Button, SectionHeader } from '../components'
import { type RoleRowKind, RoleRows } from '../components/RoleRows'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PlayerTeamRolesProps {
  client: TeamStationClient
  teamId: string
  userId: string
}

/**
 * A player's roles on the team their page was opened from, at the bottom of
 * its Settings, for the team's administrators, coaches and assistants: the
 * same rows as a person's profile, the team's level alone, Admin for an
 * administrator only, and Member read as Player with no switch: taking a
 * player off the team is the roster's. Nothing for a player whose account
 * cannot sign in, who can hold no role, and nothing when the server will not
 * say.
 */
export function PlayerTeamRoles(
  props: PlayerTeamRolesProps
): React.ReactElement | null {
  const { client, teamId, userId } = props
  const styles = getStyles(useTheme())
  const [profile, setProfile] = useState<PersonProfile | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [readError, setReadError] = useState<string>()
  const [savedUnavailable, setSavedUnavailable] = useState(false)

  const begin = useLatestRequest()
  const beginWrite = useLatestRequest()
  const writing = useRef(false)
  const identity = useRef({ client, teamId, userId })
  identity.current = { client, teamId, userId }
  const load = useCallback(async (): Promise<void> => {
    const current = begin()
    const found = await client.personProfile('team', teamId, userId)
    if (current()) {
      setProfile(found)
      setReadError(undefined)
      setSavedUnavailable(false)
    }
  }, [client, teamId, userId, begin])
  useEffect(() => {
    setProfile(undefined)
    setBusy(false)
    setError(undefined)
    setReadError(undefined)
    setSavedUnavailable(false)
    writing.current = false
    beginWrite()
    load().catch(() => undefined)
  }, [load, beginWrite])

  const refreshSaved = async (current: () => boolean): Promise<void> => {
    try {
      await load()
    } catch (caught) {
      if (!current()) return
      setProfile(undefined)
      if (caught instanceof HttpError && caught.code === 'notFound')
        setSavedUnavailable(true)
      else
        setReadError(
          caught instanceof Error ? caught.message : 'Something went wrong'
        )
    }
  }
  if (readError != null || savedUnavailable)
    return (
      <View style={styles.section}>
        <Text style={styles.muted}>
          Change saved.{' '}
          {savedUnavailable
            ? 'These roles are no longer available.'
            : 'These roles could not be refreshed.'}
        </Text>
        {readError != null && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {readError}
            </Text>
            <Button
              label="Retry"
              onPress={() => {
                const current = beginWrite()
                setReadError(undefined)
                refreshSaved(current).catch(() => undefined)
              }}
            />
          </>
        )}
      </View>
    )

  const section = profile?.sections.find(one => one.level === 'team')
  if (profile == null || section == null || !profile.person.canHoldRoles)
    return null

  const change = async (
    role: RoleRowKind,
    give: boolean,
    active: () => boolean = () => true
  ): Promise<void> => {
    if (writing.current) return
    writing.current = true
    const alive = beginWrite()
    const sameOwner = (): boolean =>
      alive() &&
      identity.current.client === client &&
      identity.current.teamId === teamId &&
      identity.current.userId === userId
    const current = (): boolean => active() && sameOwner()
    setBusy(true)
    setError(undefined)
    try {
      if (give) await client.addRole('team', teamId, userId, role)
      else await client.removeRole('team', teamId, userId, role)
      if (current()) await refreshSaved(sameOwner)
    } catch (caught) {
      if (current())
        setError(
          caught instanceof Error ? caught.message : 'Something went wrong'
        )
      throw caught
    } finally {
      if (sameOwner()) {
        writing.current = false
        setBusy(false)
      }
    }
  }
  return (
    <View style={styles.section} testID="playerTeamRoles">
      <SectionHeader title={lstrings.player_team_roles} />
      {error != null && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <RoleRows
        section={section}
        owner={client}
        ownerLabel={profile.person.fullName ?? profile.person.shortName}
        ownerIdentity={`team:${teamId}:${userId}`}
        canHoldRoles={profile.person.canHoldRoles}
        viewer={profile.viewer}
        player
        busy={busy}
        onAdd={role => {
          change(role, true).catch(() => undefined)
        }}
        onRemove={async (role, current) => {
          await change(role, false, current)
        }}
      />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(theme.spaceMdRem) },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
