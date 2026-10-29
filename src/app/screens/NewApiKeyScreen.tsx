import React, { useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  API_KEY_AREA_LABELS,
  API_KEY_AREAS,
  type ApiKeyArea,
  type ApiKeyPermission,
  MAX_API_KEY_NAME,
  normalizePermissions
} from '../../common/apiKeys'
import { Button, ListCard, Screen, TextField } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export type PermissionColumn = 'read' | 'write'

/**
 * The circles after one tap. Write on checks read too; write off leaves
 * read; read off clears write as well.
 */
export function togglePermission(
  held: readonly ApiKeyPermission[],
  area: ApiKeyArea,
  column: PermissionColumn
): ApiKeyPermission[] {
  const read: ApiKeyPermission = `${area}:read`
  const write: ApiKeyPermission = `${area}:write`
  const has = new Set(held)
  if (column === 'write') {
    if (has.has(write)) has.delete(write)
    else {
      has.add(write)
      has.add(read)
    }
  } else if (has.has(read)) {
    has.delete(read)
    has.delete(write)
  } else has.add(read)
  return normalizePermissions([...has])
}

export interface NewApiKeyScreenProps {
  client: TeamStationClient
  /** After the key is made: back to Account, which lists it. */
  onCreated: () => void
}

/**
 * Create API key: a name, and for each family a read and a write circle. The
 * key is made only by the pill; leaving any other way makes nothing.
 */
export function NewApiKeyScreen(
  props: NewApiKeyScreenProps
): React.ReactElement {
  const { client, onCreated } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [name, setName] = useState('')
  const [permissions, setPermissions] = useState<ApiKeyPermission[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const working = useRef(false)
  const ready = name.trim() !== '' && permissions.length > 0 && !busy

  const create = (): void => {
    if (!ready || working.current) return
    working.current = true
    setBusy(true)
    setError('')
    client
      .createApiKey({ name: name.trim(), permissions })
      .then(
        () => {
          onCreated()
        },
        (failure: unknown) => {
          setError(
            failure instanceof Error
              ? failure.message
              : 'The key could not be created. Please try again'
          )
        }
      )
      .finally(() => {
        working.current = false
        setBusy(false)
      })
  }

  const circle = (
    area: ApiKeyArea,
    column: PermissionColumn
  ): React.ReactElement => {
    const checked = permissions.includes(`${area}:${column}`)
    const title = API_KEY_AREA_LABELS[area].title
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: busy }}
        aria-checked={checked}
        accessibilityLabel={sprintf(
          column === 'read'
            ? lstrings.api_key_new_read_label
            : lstrings.api_key_new_write_label,
          title
        )}
        disabled={busy}
        onPress={() => {
          setPermissions(held => togglePermission(held, area, column))
        }}
        style={styles.target}
      >
        <View
          style={[styles.circle, checked ? styles.checked : styles.unchecked]}
        />
      </Pressable>
    )
  }

  return (
    <Screen>
      <TextField
        label={lstrings.api_key_new_name}
        value={name}
        onChangeText={setName}
        maxLength={MAX_API_KEY_NAME}
        disabled={busy}
        autoFocus
        onSubmitEditing={create}
      />
      <ListCard>
        <View style={styles.row} accessibilityElementsHidden>
          <View style={styles.label} />
          <Text style={styles.column}>{lstrings.api_key_new_read}</Text>
          <Text style={styles.column}>{lstrings.api_key_new_write}</Text>
        </View>
        {API_KEY_AREAS.map(area => {
          const { title, subtext } = API_KEY_AREA_LABELS[area]
          return (
            <View key={area} style={styles.row}>
              <View style={styles.label}>
                <Text style={styles.title}>{title}</Text>
                {subtext != null && (
                  <Text style={styles.subtext}>{subtext}</Text>
                )}
              </View>
              {circle(area, 'read')}
              {circle(area, 'write')}
            </View>
          )
        })}
      </ListCard>
      {error !== '' && (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      )}
      <Button
        label={lstrings.api_key_new_create}
        testID="create-api-key"
        block
        disabled={!ready}
        busy={busy}
        onPress={create}
      />
    </Screen>
  )
}

/** One circle's touch target, in points. */
const TARGET = 48

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingLeft: theme.rem(theme.cardContentInsetRem),
    paddingRight: theme.rem(0.25),
    minHeight: TARGET
  },
  label: {
    flex: 1,
    minWidth: 0,
    paddingVertical: theme.rem(0.5),
    gap: theme.rem(0.125)
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  subtext: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875)
  },
  column: {
    width: TARGET,
    textAlign: 'center' as const,
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875)
  },
  target: {
    width: TARGET,
    height: TARGET,
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  },
  circle: {
    width: theme.rem(1.5),
    height: theme.rem(1.5),
    borderRadius: theme.rem(0.75),
    borderWidth: 2
  },
  unchecked: {
    borderColor: theme.secondaryTextColor,
    backgroundColor: 'transparent'
  },
  checked: {
    borderColor: theme.primaryButtonColor,
    backgroundColor: theme.primaryButtonColor
  },
  error: {
    color: theme.dangerColor,
    fontSize: theme.rem(0.875)
  }
}))
