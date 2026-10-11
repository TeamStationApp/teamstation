import React from 'react'
import { Text, View } from 'react-native'

import type { PlayerTeam } from '../../common/api'
import { Card, initialsOf, ListRow } from '../components'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PlayerTeamsTabProps {
  /** The player's teams, newest season first, as the server orders them. */
  teams?: PlayerTeam[]
  onOpenTeam?: (teamId: string, name: string) => void
}

/**
 * Every team a player has played for, one row per team and season: the
 * team with its logo, the season, the number they wore there and the positions they
 * played. A number belongs to a player on a team, so it is only ever shown
 * beside the team it was worn on.
 */
export function PlayerTeamsTab(props: PlayerTeamsTabProps): React.ReactElement {
  const { teams, onOpenTeam } = props
  const styles = getStyles(useTheme())

  if (teams == null) {
    return (
      <Card>
        <Text style={styles.muted}>{lstrings.player_loading}</Text>
      </Card>
    )
  }
  if (teams.length === 0) {
    return (
      <Card>
        <Text style={styles.muted}>{lstrings.player_teams_empty}</Text>
      </Card>
    )
  }
  return (
    <Card>
      {teams.map((team, index) => {
        const subtitle = [team.seasonName, ...team.positions]
          .filter(part => part != null && part !== '')
          .join(' · ')
        const jersey = team.jersey?.trim() ?? ''
        return (
          <View key={`${team.teamId} ${team.seasonId ?? ''}`}>
            {index > 0 && <View style={styles.divider} />}
            <ListRow
              title={team.teamName}
              subtitle={subtitle === '' ? undefined : subtitle}
              emblem={initialsOf(team.teamName)}
              emblemUri={team.logoUrl}
              trailing={jersey === '' ? undefined : `#${jersey}`}
              onPress={
                onOpenTeam == null
                  ? undefined
                  : () => {
                      onOpenTeam(team.teamId, team.teamName)
                    }
              }
            />
          </View>
        )
      })}
    </Card>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.defaultBorderColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  }
}))
