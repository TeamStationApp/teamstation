import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { type ApiKey, secretPreview } from '../../common/apiKeys'
import {
  DangerText,
  Icon,
  ListCard,
  ListRow,
  SectionHeader
} from '../components'
import { useConfirmedAction } from '../components/useConfirmedAction'
import { lstrings, sprintf } from '../locales/strings'
import { copyToClipboard } from '../platform/clipboard'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface ApiKeysSectionProps {
  client: TeamStationClient
  /** Opens Create API key. */
  onCreate?: () => void
  /** Copies a secret; the platform clipboard unless a test says otherwise. */
  copy?: (text: string) => void
}

/**
 * Account's API keys: one card, a row a key and **Create API key** below
 * them. A key's row copies its secret from the icon at its left and is
 * deleted from the red Delete at its right, after the confirmation sheet a
 * field delete uses. The keys are read whenever Account opens, so a key made
 * on Create API key is here when Back returns.
 */
export function ApiKeysSection(props: ApiKeysSectionProps): React.ReactElement {
  const { client, onCreate, copy = copyToClipboard } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [keys, setKeys] = useState<ApiKey[]>()
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const confirm = useConfirmedAction(client, 'apiKeys')
  // Said only while the key copied is still here.
  const copiedKey = keys?.find(key => key.id === copied)

  useEffect(() => {
    let live = true
    client.apiKeys().then(
      value => {
        if (live) setKeys(value)
      },
      (failure: unknown) => {
        if (live)
          setError(
            failure instanceof Error
              ? failure.message
              : lstrings.account_api_keys_load_error
          )
      }
    )
    return () => {
      live = false
    }
  }, [client])

  return (
    <View style={styles.section}>
      <SectionHeader title={lstrings.account_api_keys} />
      <ListCard>
        {(keys ?? []).map(key => (
          <ListRow
            key={key.id}
            title={key.name}
            subtitle={secretPreview(key.secret)}
            leading={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={sprintf(
                  lstrings.account_api_key_copy,
                  key.name
                )}
                disabled={key.secret == null}
                hitSlop={theme.rem(0.25)}
                onPress={() => {
                  if (key.secret == null) return
                  copy(key.secret)
                  setCopied(key.id)
                }}
                style={styles.copy}
              >
                <Icon
                  name="content_copy"
                  size={1.25}
                  color={theme.secondaryTextColor}
                />
              </Pressable>
            }
            end={
              <DangerText
                label={lstrings.account_api_key_delete}
                accessibilityLabel={sprintf(
                  lstrings.account_api_key_delete_named,
                  key.name
                )}
                disabled={confirm.busy}
                onPress={() => {
                  confirm.open({
                    title: sprintf(
                      lstrings.account_api_key_delete_title,
                      key.name
                    ),
                    detail: lstrings.account_api_key_delete_detail,
                    label: lstrings.account_api_key_delete,
                    run: async current => {
                      await client.deleteApiKey(key.id)
                      if (current())
                        setKeys(held =>
                          held?.filter(each => each.id !== key.id)
                        )
                    }
                  })
                }}
              />
            }
          />
        ))}
        <ListRow
          title={lstrings.account_api_key_create}
          emblemIcon="key"
          onPress={onCreate}
        />
      </ListCard>
      {copiedKey != null && (
        <Text accessibilityLiveRegion="polite" style={styles.note}>
          {sprintf(lstrings.account_api_key_copied, copiedKey.name)}
        </Text>
      )}
      {error !== '' && (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      )}
      {confirm.sheet}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  // The size of the emblem tile beside Create API key; `hitSlop` makes the
  // touch target 48 points.
  copy: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.containerBackgroundColor
  },
  note: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875)
  },
  error: {
    color: theme.dangerColor,
    fontSize: theme.rem(0.875)
  }
}))
