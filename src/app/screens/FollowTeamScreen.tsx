import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type { FollowableTeam, TeamStationClient } from '../../common/api'
import {
  Button,
  Card,
  initialsOf,
  ListRow,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** The server answers a search only from this many characters. */
export const MIN_SEARCH_LENGTH = 2
/** How long typing has to pause before the search goes out. */
export const SEARCH_PAUSE_MS = 250

export interface FollowTeamScreenProps {
  client: TeamStationClient
  /** A followed team, tapped: open its page. */
  onOpenTeam: (teamId: string) => void
}

/**
 * Following a team: find it by name, and follow it. Nobody has to say yes.
 *
 * A fan sees the team's schedule, roster and staff, and nothing else of it.
 * Until two characters are typed this lists the teams already followed; from
 * two, the teams whose name holds what was typed, at most twenty. Each row
 * has its own Follow / Following toggle, and a followed team opens.
 */
export function FollowTeamScreen(
  props: FollowTeamScreenProps
): React.ReactElement {
  const { client, onOpenTeam } = props
  const styles = getStyles(useTheme())

  const [query, setQuery] = useState('')
  const [teams, setTeams] = useState<FollowableTeam[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const searching = query.trim().length >= MIN_SEARCH_LENGTH

  useEffect(() => {
    let cancelled = false
    const asked = query.trim()
    setLoading(true)
    const timer = setTimeout(
      () => {
        const load = searching ? client.searchTeams(asked) : client.myFollows()
        load
          .then(found => {
            if (cancelled) return
            setTeams(found)
            setError(undefined)
          })
          .catch((caught: unknown) => {
            if (cancelled) return
            setError(caught instanceof Error ? caught.message : 'Cannot search')
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
      },
      searching ? SEARCH_PAUSE_MS : 0
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, query, searching])

  const toggle = (team: FollowableTeam): void => {
    setBusy(team.id)
    setError(undefined)
    const change = team.following
      ? client.unfollowTeam(team.id)
      : client.followTeam(team.id)
    change
      .then(following => {
        setTeams(current =>
          current.map(item =>
            item.id === team.id ? { ...item, following } : item
          )
        )
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Cannot follow')
      })
      .finally(() => {
        setBusy(undefined)
      })
  }

  return (
    <Screen>
      <TextField
        label="Team name"
        value={query}
        onChangeText={setQuery}
        placeholder="Hawks"
        autoFocus
      />
      <Text style={styles.muted}>
        Follow a team to see its schedule, roster and staff. Its games and
        videos stay with the team.
      </Text>
      {error != null && <Text style={styles.error}>{error}</Text>}

      <View style={styles.section}>
        <SectionHeader
          title={searching ? 'Teams' : 'Teams you follow'}
          note={loading ? undefined : String(teams.length)}
        />
        {loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : teams.length === 0 ? (
          <Card>
            <Text style={styles.muted}>
              {searching
                ? 'No team has that in its name.'
                : query.trim() === ''
                  ? 'You follow no teams yet. Type a team’s name to find it.'
                  : 'Type at least two letters of the team’s name.'}
            </Text>
          </Card>
        ) : (
          <Card>
            {teams.map((team, index) => (
              <View key={team.id}>
                {index > 0 && <View style={styles.divider} />}
                {/*
                  The toggle sits beside the row rather than inside it: a
                  button inside the row's own button is two buttons in one,
                  which a browser will not nest.
                */}
                <View style={styles.teamRow}>
                  <View style={styles.teamName}>
                    <ListRow
                      title={team.name}
                      subtitle={
                        team.seasons.length === 0
                          ? undefined
                          : team.seasons.map(season => season.title).join(' · ')
                      }
                      emblem={initialsOf(team.name)}
                      emblemUri={team.logoUrl}
                      onPress={
                        team.following
                          ? () => {
                              onOpenTeam(team.id)
                            }
                          : undefined
                      }
                    />
                  </View>
                  <Button
                    label={team.following ? 'Following' : 'Follow'}
                    kind={team.following ? 'secondary' : 'primary'}
                    compact
                    busy={busy === team.id}
                    disabled={busy === team.id}
                    accessibilityLabel={
                      team.following
                        ? `Following ${team.name}`
                        : `Follow ${team.name}`
                    }
                    onPress={() => {
                      toggle(team)
                    }}
                  />
                </View>
              </View>
            ))}
          </Card>
        )}
      </View>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  teamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  teamName: {
    flex: 1
  },
  divider: {
    height: 1,
    backgroundColor: theme.defaultBorderColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
