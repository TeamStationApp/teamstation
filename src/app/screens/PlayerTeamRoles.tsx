import React, { useCallback, useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type { PersonProfile, TeamStationClient } from '../../common/api'
import { SectionHeader } from '../components'
import { type RoleRowKind, RoleRows } from '../components/RoleRows'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PlayerTeamRolesProps {
  client: TeamStationClient
  teamId: string
  userId: number
}

/**
 * A player's roles on the team their page was opened from, at the bottom of
 * its Settings, for the team's administrators, coaches and assistants: the
 * same rows as a person's profile, the team's level alone, Admin for an
 * administrator only, and Member read as Player with no button: taking a
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

  const load = useCallback(async (): Promise<void> => {
    setProfile(await client.personProfile('team', teamId, userId))
  }, [client, teamId, userId])
  useEffect(() => {
    setProfile(undefined)
    load().catch(() => undefined)
  }, [load])

  const section = profile?.sections.find(one => one.level === 'team')
  if (profile == null || section == null || !profile.person.canHoldRoles)
    return null

  const change = (role: RoleRowKind, give: boolean): void => {
    setBusy(true)
    setError(undefined)
    ;(give
      ? client.addRole('team', teamId, userId, role)
      : client.removeRole('team', teamId, userId, role)
    )
      .then(load)
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error ? caught.message : 'Something went wrong'
        )
      })
      .finally(() => {
        setBusy(false)
      })
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
        canHoldRoles={profile.person.canHoldRoles}
        viewer={profile.viewer}
        player
        busy={busy}
        onAdd={role => {
          change(role, true)
        }}
        onRemove={role => {
          change(role, false)
        }}
      />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(theme.spaceMdRem) },
  error: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
