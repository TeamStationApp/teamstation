import React, { useRef, useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { PublicGroup } from '../../common/publicGroups'
import { Button, Card, SectionHeader } from '../components'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { GroupRelationshipRow } from './GroupRelationshipRow'

export const participationExplanation =
  'Ending participation leaves all scheduled games and management parents unchanged.'

/** Competition membership is independent of the team's management parents. */
export function SeasonParticipations({
  client,
  teamId,
  seasons,
  disabled = false,
  onLeft
}: {
  client: TeamStationClient
  teamId: string
  seasons: PublicGroup[]
  disabled?: boolean
  onLeft: () => void
}): React.ReactElement | null {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [selected, setSelected] = useState<PublicGroup>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const working = useRef(false)
  const begin = useLatestRequest()
  const close = (): void => {
    if (working.current) return
    begin()
    setSelected(undefined)
    setError('')
  }
  const leave = async (): Promise<void> => {
    if (working.current || disabled || selected == null) return
    working.current = true
    setBusy(true)
    setError('')
    const current = begin()
    try {
      await client.endParticipation(selected.id, teamId)
      if (!current()) return
      setSelected(undefined)
      onLeft()
    } catch (caught) {
      if (current())
        setError(
          caught instanceof Error
            ? caught.message
            : 'Participation could not end. Retry.'
        )
    } finally {
      if (current()) {
        working.current = false
        setBusy(false)
      }
    }
  }
  if (seasons.length === 0) return null
  return (
    <View style={styles.section} testID="season-participations">
      <SectionHeader title="Season Participations" />
      <Text style={styles.hint}>{participationExplanation}</Text>
      <Card style={styles.card} testID="season-participations-card">
        {seasons.map(season => (
          <GroupRelationshipRow
            key={season.id}
            group={season}
            label={`Leave season ${season.name}`}
            disabled={disabled || busy}
            onLeave={() => {
              setError('')
              setSelected(season)
            }}
          />
        ))}
      </Card>
      {selected != null && (
        <Modal transparent visible animationType="slide" onRequestClose={close}>
          <View style={styles.scrim}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel season departure"
              disabled={busy}
              onPress={close}
              style={styles.behind}
            />
            <View style={styles.sheet} accessibilityLabel="Leave season">
              <View style={styles.grip} />
              <Text style={styles.title}>Leave {selected.name}?</Text>
              <Text style={styles.hint}>{participationExplanation}</Text>
              {error !== '' && (
                <Text accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
              )}
              <Button
                testID="confirm-season-departure"
                label={`Leave ${selected.name}`}
                color={theme.dangerColor}
                busy={busy}
                disabled={disabled}
                onPress={() => {
                  leave().catch(() => undefined)
                }}
              />
              <Button
                label="Cancel"
                kind="text"
                textColor={theme.linkTextColor}
                style={styles.cancel}
                disabled={busy}
                onPress={close}
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
  card: { gap: theme.rem(0.75) },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor
  },
  error: { color: theme.dangerColor },
  cancel: { alignSelf: 'center' as const },
  scrim: { flex: 1, justifyContent: 'flex-end' as const },
  behind: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%' as const,
    maxWidth: theme.rem(36),
    alignSelf: 'center' as const,
    backgroundColor: theme.cardBackgroundColor,
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceLgRem),
    paddingBottom: theme.rem(2),
    gap: theme.rem(theme.spaceSmRem)
  },
  grip: {
    alignSelf: 'center' as const,
    width: theme.rem(2.5),
    height: theme.rem(0.25),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.defaultBorderColor
  }
}))
