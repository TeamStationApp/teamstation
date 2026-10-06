import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import { Button, Card, Screen } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { safetyGroups } from './chatModel'
import { getChatStyles } from './chatStyles'
import type { ChatScreenEngine } from './screenEngine'

export interface SafetyNumberScreenProps {
  engine: Pick<ChatScreenEngine, 'safetyNumber'>
  userId: number
  name: string
  onDone: () => void
}

/**
 * The 60-digit safety number the person shares with someone, in 12 groups
 * of five, to read aloud or hold side by side. The same on both phones means
 * nobody has put a key between them.
 */
export function SafetyNumberScreen(
  props: SafetyNumberScreenProps
): React.ReactElement {
  const { engine, userId, name, onDone } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const [digits, setDigits] = useState<string | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    engine
      .safetyNumber(userId)
      .then(found => {
        if (live) setDigits(found ?? null)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [engine, userId])

  return (
    <Screen>
      <Text style={shared.title}>
        {sprintf(lstrings.chat_safety_number_with, name)}
      </Text>
      {failed ? (
        <Text style={shared.error}>{lstrings.chat_cannot_load}</Text>
      ) : digits === undefined ? (
        <Text style={shared.muted}>{lstrings.common_loading}</Text>
      ) : digits === null ? (
        <Text style={shared.muted}>
          {sprintf(lstrings.chat_safety_number_none, name)}
        </Text>
      ) : (
        <>
          <Text style={shared.muted}>
            {sprintf(lstrings.chat_safety_number_detail, name)}
          </Text>
          <Card>
            <View
              style={styles.grid}
              accessibilityLabel={sprintf(
                lstrings.chat_safety_number_with,
                name
              )}
            >
              {safetyGroups(digits).map((group, index) => (
                <Text key={index} style={styles.group}>
                  {group}
                </Text>
              ))}
            </View>
          </Card>
        </>
      )}
      <Button label={lstrings.common_done} kind="secondary" onPress={onDone} />
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    rowGap: theme.rem(theme.spaceSmRem)
  },
  group: {
    width: '33%',
    textAlign: 'center',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '600',
    letterSpacing: theme.rem(0.08),
    color: theme.primaryTextColor
  }
}))
