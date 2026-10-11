import React, { useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Button } from '../components'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PlayerRemoveFromTeamProps {
  client: TeamStationClient
  teamId: string
  teamName: string
  userId: number
  /** The player's short name, as the page shows it. */
  shortName: string
  /**
   * Called once they are off the team, with the words to confirm it; not
   * when the server says there was nothing to take them off.
   */
  onRemoved: (notice: string) => void
}

/**
 * Taking a player off the team their page was opened from, last on its
 * Settings, for the team's administrators only: off the roster and out of
 * every role they hold on the team, after a sheet that says so. Whether or
 * not they can sign in; a role alone is taken away in Team roles above.
 */
export function PlayerRemoveFromTeam(
  props: PlayerRemoveFromTeamProps
): React.ReactElement {
  const { client, teamId, teamName, userId, shortName, onRemoved } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const remove = (): void => {
    setBusy(true)
    setError(undefined)
    client
      .removePerson('team', teamId, userId)
      .then(({ removed }) => {
        if (removed) {
          onRemoved(sprintf(lstrings.player_removed, shortName, teamName))
          return
        }
        // Already off the team (another device, or a page left open): there
        // was nothing to take away, so no confirmation and nowhere to go.
        setBusy(false)
        setError(sprintf(lstrings.player_remove_unchanged, shortName, teamName))
      })
      .catch((caught: unknown) => {
        setBusy(false)
        setError(
          caught instanceof Error ? caught.message : 'Something went wrong'
        )
      })
  }

  return (
    <View style={styles.section} testID="playerRemoveFromTeam">
      <Button
        label={sprintf(lstrings.player_remove_from_team, teamName)}
        color={theme.dangerColor}
        textColor={theme.buttonTextColor}
        busy={busy}
        onPress={() => {
          setAsking(true)
        }}
      />
      {error != null && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {asking && (
        <ChoiceSheet
          title={sprintf(lstrings.player_remove_title, shortName, teamName)}
          choices={[
            {
              label: sprintf(lstrings.player_remove_confirm, shortName),
              detail: sprintf(
                lstrings.player_remove_detail,
                shortName,
                teamName
              ),
              destructive: true,
              onPress: remove
            }
          ]}
          onClose={() => {
            setAsking(false)
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceSmRem),
    marginTop: theme.rem(theme.spaceLgRem)
  },
  error: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
