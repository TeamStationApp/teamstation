import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import { ChatOverlayPortal } from '../chat/ChatOverlayHost'
import { bindPopupKeys } from '../chat/chatWebInteractions'
import { TextField } from '../components'
import { PersonSearchRow } from '../components/PersonSearchRow'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface SelectedAccount {
  userId: string
  displayName: string
  avatarUrl?: string | null
  affiliations?: string
}
interface Anchor {
  x: number
  y: number
  width: number
  height: number
}

export function PeopleAccountSearch({
  client,
  group,
  selected,
  onChange,
  disabled,
  dismissKey
}: {
  client: TeamStationClient
  group: GroupRef
  selected: SelectedAccount[]
  onChange: (accounts: SelectedAccount[]) => void
  disabled: boolean
  dismissKey: number
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<SelectedAccount[]>([])
  const [status, setStatus] = useState('')
  const [anchor, setAnchor] = useState<Anchor>()
  const [keyboardTop, setKeyboardTop] = useState<number | undefined>(
    () => Keyboard.metrics?.()?.screenY
  )
  const field = useRef<React.ComponentRef<typeof View>>(null)
  const begin = useLatestRequest()
  const viewport = useWindowDimensions()
  const close = useCallback(() => {
    begin()
    setAnchor(undefined)
  }, [begin])
  useEffect(() => {
    close()
    setQuery('')
    setRows([])
  }, [group.kind, group.id, client, close])
  useEffect(() => {
    if (disabled) close()
  }, [disabled, close])
  const isOpen = anchor != null
  useEffect(() => {
    if (!isOpen) return
    const unbind = bindPopupKeys(field.current, close, false)
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      close()
      return true
    })
    return () => {
      unbind()
      back.remove()
    }
  }, [isOpen, close])
  useEffect(() => {
    // The portal is outside keyboard avoidance. Keep its available height even
    // when the keyboard opened before the first query.
    const shown = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow',
      event => {
        setKeyboardTop(event.endCoordinates.screenY)
        close()
      }
    )
    const hidden = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardTop(undefined)
        close()
      }
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [close])
  useEffect(close, [viewport.width, viewport.height, dismissKey, close])
  const search = (value: string): void => {
    setQuery(value)
    const current = begin()
    setRows([])
    setStatus('Searching…')
    if (value.trim() === '' || disabled) {
      setAnchor(undefined)
      return
    }
    field.current?.measureInWindow((x, y, width, height) => {
      if (current()) setAnchor({ x, y, width, height })
    })
    client
      .searchPeopleAccounts(
        group,
        value,
        selected.map(row => row.userId)
      )
      .then(
        result => {
          if (!current()) return
          setRows(
            result.filter(
              row => !selected.some(item => item.userId === row.userId)
            )
          )
          setStatus('')
        },
        () => {
          if (current()) {
            setRows([])
            setStatus('Accounts could not load. Type again to retry.')
          }
        }
      )
  }
  return (
    <>
      <View ref={field} collapsable={false}>
        <TextField
          label="Search users"
          placeholder="Search users."
          leadingIcon="search"
          value={query}
          onChangeText={search}
          onFocus={() => {
            if (query !== '') search(query)
          }}
          disabled={disabled}
          maxLength={100}
        />
      </View>
      {selected.length > 0 && (
        <View style={styles.pills}>
          {selected.map(row => (
            <Pressable
              key={row.userId}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${row.displayName}`}
              disabled={disabled}
              style={styles.pillTarget}
              onPress={() => {
                close()
                onChange(selected.filter(item => item.userId !== row.userId))
              }}
            >
              <View style={styles.pill}>
                <Text style={styles.name}>{row.displayName} ×</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
      {anchor != null && (
        <ChatOverlayPortal modal={false}>
          <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {/* Leave the search field interactive while covering the rest of the page. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close account results"
              style={[styles.backdrop, { top: 0, height: anchor.y }]}
              onPress={close}
            />
            <Pressable
              accessibilityLabel="Close account results"
              style={[
                styles.backdrop,
                { top: anchor.y + anchor.height, bottom: 0 }
              ]}
              onPress={close}
            />
            <Pressable
              style={{
                position: 'absolute',
                top: anchor.y,
                height: anchor.height,
                left: 0,
                width: anchor.x
              }}
              onPress={close}
            />
            <Pressable
              style={{
                position: 'absolute',
                top: anchor.y,
                height: anchor.height,
                left: anchor.x + anchor.width,
                right: 0
              }}
              onPress={close}
            />
            <View
              testID="account-search-results"
              style={[
                styles.results,
                {
                  top: anchor.y + anchor.height,
                  left: anchor.x,
                  width: anchor.width,
                  maxHeight: Math.max(
                    0,
                    Math.min(viewport.height, keyboardTop ?? viewport.height) -
                      anchor.y -
                      anchor.height -
                      12
                  )
                }
              ]}
            >
              <ScrollView keyboardShouldPersistTaps="always">
                {status !== '' ? (
                  <Text style={styles.message}>{status}</Text>
                ) : rows.length === 0 ? (
                  <Text style={styles.message}>No accounts match</Text>
                ) : (
                  rows.map(row => (
                    <PersonSearchRow
                      key={row.userId}
                      name={row.displayName}
                      avatarUrl={row.avatarUrl}
                      affiliations={row.affiliations}
                      accessibilityLabel={`Select ${row.displayName}`}
                      onPress={() => {
                        close()
                        setQuery('')
                        onChange([...selected, row])
                      }}
                    />
                  ))
                )}
              </ScrollView>
            </View>
          </View>
        </ChatOverlayPortal>
      )}
    </>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  pills: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: theme.rem(0.5)
  },
  pillTarget: {
    minHeight: 48,
    justifyContent: 'center' as const,
    maxWidth: '100%' as const
  },
  pill: {
    minHeight: 32,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: theme.pillBackground
  },
  name: { color: theme.primaryTextColor, fontSize: theme.rem(1) },
  backdrop: { position: 'absolute' as const, left: 0, right: 0 },
  results: {
    position: 'absolute' as const,
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.secondaryTextColor,
    borderRadius: 8,
    overflow: 'hidden' as const,
    elevation: 8
  },
  message: { minHeight: 48, padding: 16, color: theme.secondaryTextColor }
}))
