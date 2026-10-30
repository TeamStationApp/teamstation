import React, { useRef, useState } from 'react'
import { Pressable, Text, type TextInput, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  emptyPlayerForm,
  playerFormError,
  type PlayerFormValue
} from '../../common/playerForm'
import { Button, Card, Screen } from '../components'
import { PlayerForm } from '../components/PlayerForm'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * Team settings' Create Player: a new player on the team's roster, on the
 * app-theme player form. Create Player makes them and returns to team
 * settings; Create Player and Add Another makes them and starts the form
 * again at First name. A refusal stays above the actions, with the form as
 * typed.
 */
export function CreatePlayerScreen({
  client,
  teamId,
  onCreated
}: {
  client: TeamStationClient
  teamId: string
  /** Each player made, by name, and whether the form is staying for another. */
  onCreated: (name: string, another: boolean) => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [value, setValue] = useState(emptyPlayerForm)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const saving = useRef(false)
  const first = useRef<React.ComponentRef<typeof TextInput>>(null)
  const problem = playerFormError(value, { nameRequired: true })

  const create = async (another: boolean): Promise<void> => {
    if (saving.current) return
    setSubmitted(true)
    if (problem != null) return
    saving.current = true
    setBusy(true)
    setError(undefined)
    const body = bodyOf(value)
    try {
      await client.createRosterPlayer(teamId, body)
      const name = [body.firstName, body.lastName].filter(Boolean).join(' ')
      if (another) {
        setValue(emptyPlayerForm())
        setSubmitted(false)
        first.current?.focus()
      }
      onCreated(name, another)
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message !== ''
          ? caught.message
          : 'Unable to create the player. Please try again.'
      )
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const shown = error ?? (submitted ? problem : undefined)
  return (
    <Screen>
      <View style={styles.page}>
        <Text style={styles.title} accessibilityRole="header">
          Create Player
        </Text>
        <Card>
          <PlayerForm
            value={value}
            onChange={setValue}
            disabled={busy}
            firstRef={first}
            fields={{
              name: 'edit',
              hands: 'edit',
              jersey: true,
              positions: true
            }}
          />
        </Card>
        {shown != null && (
          <Text accessibilityRole="alert" style={styles.error}>
            {shown}
          </Text>
        )}
        <Button
          label="Create Player"
          accessibilityLabel="Create Player"
          busy={busy}
          disabled={busy}
          onPress={() => {
            create(false).catch(() => undefined)
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create Player and Add Another"
          disabled={busy}
          onPress={() => {
            create(true).catch(() => undefined)
          }}
          style={styles.another}
        >
          <Text style={styles.anotherText}>Create Player and Add Another</Text>
        </Pressable>
      </View>
    </Screen>
  )
}

/** What `POST /teams/:teamId/roster-players` stores for the form. */
export function bodyOf(value: PlayerFormValue): {
  firstName: string
  lastName: string
  jersey: string | null
  bats: 'left' | 'right' | 'switch'
  throws: 'left' | 'right'
  positions: PlayerFormValue['positions']
} {
  const jersey = value.jersey.trim()
  return {
    firstName: value.firstName.trim(),
    lastName: value.lastName.trim(),
    jersey: jersey === '' ? null : jersey,
    bats: value.bats ?? 'right',
    throws: value.throws ?? 'right',
    positions: value.positions
  }
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1.25) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor },
  another: {
    minHeight: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  },
  anotherText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.linkTextColor
  }
}))
