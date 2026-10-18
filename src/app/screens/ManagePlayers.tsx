import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type { ManagePage, TeamStationClient } from '../../common/api'
import { DangerText, Emblem, initialsOf, SectionHeader } from '../components'
import { ActionList, ActionRow } from '../components/ActionRow'
import { useConfirmedAction } from '../components/useConfirmedAction'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function ManagePlayers({
  client,
  teamId,
  teamName,
  people,
  onChanged
}: {
  client: TeamStationClient
  teamId: string
  teamName: string
  people: ManagePage['people']
  onChanged: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [notice, setNotice] = useState('')
  const [pictures, setPictures] = useState<Record<string, string | null>>({})
  const players = people
    .filter(person =>
      person.teams.some(team => team.id === teamId && team.isPlayer)
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
  const confirmation = useConfirmedAction(
    client,
    `${teamId}:${teamName}:${players.map(p => p.userId).join(',')}`
  )
  useEffect(() => {
    let live = true
    setPictures({})
    setNotice('')
    client.roster(teamId).then(
      rows => {
        if (live)
          setPictures(
            Object.fromEntries(
              rows.map(row => [String(row.userId), row.avatarUrl])
            )
          )
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [client, teamId])
  return (
    <View style={styles.section}>
      <SectionHeader title="Manage Players" note={String(players.length)} />
      {players.length === 0 && (
        <Text style={styles.hint}>No players on the roster yet.</Text>
      )}
      <ActionList bounded={players.length > 0}>
        {players.map(person => (
          <ActionRow
            key={person.userId}
            title={person.displayName}
            detail={person.emails.join(' · ')}
            leading={
              <Emblem
                uri={pictures[String(person.userId)]}
                fallback={initialsOf(person.displayName)}
                shape="circle"
              />
            }
            end={
              <DangerText
                label="Remove"
                accessibilityLabel={`Remove ${person.displayName}`}
                disabled={confirmation.busy}
                style={{ minWidth: 48, alignItems: 'center' }}
                onPress={() => {
                  confirmation.open({
                    title: `Remove ${person.displayName} from ${teamName}?`,
                    detail:
                      "They come off the roster, and the team's roles they hold here go too.",
                    label: `Remove ${person.displayName}`,
                    fallback: 'Player could not be removed. Try again.',
                    run: async current => {
                      await client.removePerson('team', teamId, person.userId)
                      if (current()) {
                        setNotice(
                          `${person.displayName} was removed from ${teamName}`
                        )
                        onChanged()
                      }
                    }
                  })
                }}
              />
            }
          />
        ))}
      </ActionList>
      {notice !== '' && <Text style={styles.hint}>{notice}</Text>}
      {confirmation.sheet}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  hint: { fontSize: theme.rem(0.875), color: theme.secondaryTextColor }
}))
