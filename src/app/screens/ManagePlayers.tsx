import React, { useEffect, useState } from 'react'
import { Modal, Text, View } from 'react-native'

import type { ManagePage, TeamStationClient } from '../../common/api'
import {
  Button,
  Card,
  DangerText,
  Emblem,
  initialsOf,
  SectionHeader
} from '../components'
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
  const theme = useTheme()
  const styles = getStyles(theme)
  const [removing, setRemoving] = useState<ManagePage['people'][number]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pictures, setPictures] = useState<Record<string, string | null>>({})
  useEffect(() => {
    let live = true
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
  const players = people
    .filter(person =>
      person.teams.some(team => team.id === teamId && team.isPlayer)
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
  const remove = async (): Promise<void> => {
    if (busy || removing == null) return
    setBusy(true)
    setError('')
    try {
      await client.removePerson('team', teamId, removing.userId)
      setNotice(`${removing.displayName} was removed from ${teamName}`)
      setRemoving(undefined)
      onChanged()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Player could not be removed. Try again.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={styles.section}>
      <SectionHeader title="Manage Players" note={String(players.length)} />
      <Card style={styles.card}>
        {players.length === 0 && (
          <Text style={styles.hint}>No players on the roster yet.</Text>
        )}
        {players.map(person => (
          <View key={person.userId} style={styles.row}>
            <Emblem
              uri={pictures[String(person.userId)]}
              fallback={initialsOf(person.displayName)}
              shape="circle"
            />
            <Text style={styles.name}>{person.displayName}</Text>
            <DangerText
              label="Remove"
              accessibilityLabel={`Remove ${person.displayName}`}
              onPress={() => {
                setError('')
                setRemoving(person)
              }}
            />
          </View>
        ))}
      </Card>
      {notice !== '' && <Text style={styles.hint}>{notice}</Text>}
      {removing != null && (
        <Modal
          transparent
          visible
          animationType="fade"
          onRequestClose={() => {
            if (!busy) setRemoving(undefined)
          }}
        >
          <View style={styles.overlay}>
            <View style={styles.modal}>
              <Text style={styles.title}>
                Remove {removing.displayName} from {teamName}?
              </Text>
              <Text style={styles.hint}>
                They come off the roster, and the team's roles they hold here go
                too.
              </Text>
              {error !== '' && (
                <Text accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
              )}
              <Button
                label={`Remove ${removing.displayName}`}
                color={theme.dangerColor}
                busy={busy}
                onPress={() => {
                  remove().catch(() => undefined)
                }}
              />
              <DangerText
                label="Cancel"
                disabled={busy}
                onPress={() => {
                  setRemoving(undefined)
                }}
              />
            </View>
          </View>
        </Modal>
      )}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  card: { gap: theme.rem(0.5) },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75),
    minHeight: 56
  },
  name: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor
  },
  hint: { fontSize: theme.rem(0.875), color: theme.secondaryTextColor },
  error: { color: theme.dangerColor },
  overlay: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    padding: theme.rem(1),
    backgroundColor: theme.overlayBackgroundColor
  },
  modal: {
    width: '100%' as const,
    maxWidth: theme.rem(26),
    padding: theme.rem(1.25),
    gap: theme.rem(0.75),
    borderRadius: theme.rem(1),
    backgroundColor: theme.cardBackgroundColor
  }
}))
