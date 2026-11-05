import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'

import { Button, Card, Screen } from '../components'
import { ActionList, ActionRow } from '../components/ActionRow'
import { TextWidthButton } from '../components/TextWidthButton'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ChatBlockConfirmation } from './ChatBlockConfirmation'
import { getChatStyles } from './chatStyles'
import { SafetyWordsGrid } from './SafetyWordsGrid'
import type { ChatScreenEngine } from './screenEngine'

export interface SafetyNumberScreenProps {
  engine: Pick<ChatScreenEngine, 'safetyNumber' | 'setBlocked' | 'isBlocked'>
  userId: string
  name: string
  onDone: () => void
}

/**
 * The sixteen safety words the person shares with someone, in four rows, to read aloud or hold side by side. The same on both phones means
 * nobody has put a key between them.
 */
export function SafetyNumberScreen(
  props: SafetyNumberScreenProps
): React.ReactElement {
  const { engine, userId, name, onDone } = props
  const theme = useTheme()
  const shared = getChatStyles(theme)
  const [digits, setDigits] = useState<string | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [confirming, setConfirming] = useState<'block' | 'unblock'>()
  const blocked = engine.isBlocked?.(userId) === true

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
            <SafetyWordsGrid
              words={digits}
              label={sprintf(lstrings.chat_safety_number_with, name)}
            />
          </Card>
        </>
      )}
      {engine.setBlocked != null && (
        <ActionList bounded>
          <ActionRow
            title={name}
            end={
              <TextWidthButton
                label={blocked ? lstrings.chat_unblock : lstrings.chat_block}
                accessibilityLabel={sprintf(
                  blocked
                    ? lstrings.chat_unblock_person
                    : lstrings.chat_block_person,
                  name
                )}
                color={blocked ? undefined : theme.dangerColor}
                onPress={() => {
                  setConfirming(blocked ? 'unblock' : 'block')
                }}
              />
            }
          />
        </ActionList>
      )}
      {confirming != null && (
        <ChatBlockConfirmation
          key={userId}
          name={name}
          action={confirming}
          onClose={() => {
            setConfirming(undefined)
          }}
          onConfirm={async () => {
            await engine.setBlocked?.(userId, confirming === 'block')
          }}
        />
      )}
      <Button label={lstrings.common_done} kind="secondary" onPress={onDone} />
    </Screen>
  )
}
