import React, { useEffect, useRef, useState } from 'react'
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  type TextInput,
  useWindowDimensions,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { CitySuggestion, Locality } from '../../common/locality'
import { Button, DangerText, Icon, Screen, TextField } from '../components'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function cityListHeight(
  viewport: number,
  fieldBottom: number,
  footer: number
): number {
  return Math.max(56, Math.min(352, viewport - fieldBottom - footer - 16))
}
const newSession = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const value = Math.floor(Math.random() * 16)
    return (c === 'x' ? value : (value & 3) | 8).toString(16)
  })

export function LocationScreen({
  client,
  current,
  onSave,
  onCancel
}: {
  client: TeamStationClient
  current: Locality | null
  onSave: (locality: Locality) => Promise<void>
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const { height } = useWindowDimensions()
  const [viewport, setViewport] = useState(height)
  const [fieldBottom, setFieldBottom] = useState(160)
  const [fieldY, setFieldY] = useState(0)
  const [footer, setFooter] = useState(120)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<CitySuggestion[]>([])
  const [provider, setProvider] = useState<'google' | 'geonames'>('geonames')
  const [attribution, setAttribution] = useState('')
  const [chosen, setChosen] = useState<Locality>()
  const [loading, setLoading] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const session = useRef(newSession())
  const body = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const field = useRef<React.ComponentRef<typeof View>>(null)
  const input = useRef<React.ComponentRef<typeof TextInput>>(null)
  const begin = useLatestRequest()
  const beginSave = useLatestRequest()
  const working = useRef(false)
  const open = query.trim().length >= 2 && chosen == null
  useEffect(() => {
    setViewport(height)
    const show = Keyboard.addListener('keyboardDidShow', event => {
      setViewport(event.endCoordinates.screenY)
    })
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setViewport(height)
    })
    const webViewport = (
      globalThis as unknown as {
        window?: {
          visualViewport?: {
            height: number
            addEventListener: (event: string, listener: () => void) => void
            removeEventListener: (event: string, listener: () => void) => void
          }
        }
      }
    ).window?.visualViewport
    const resize = (): void => {
      setViewport(webViewport?.height ?? height)
    }
    if (Platform.OS === 'web') webViewport?.addEventListener('resize', resize)
    return () => {
      show.remove()
      hide.remove()
      if (Platform.OS === 'web')
        webViewport?.removeEventListener('resize', resize)
    }
  }, [height])
  useEffect(() => {
    const active = begin()
    if (!open) {
      setRows([])
      setLoading(false)
      return
    }
    const timeout = setTimeout(() => {
      setLoading(true)
      client
        .citySuggestions(query.trim(), session.current)
        .then(
          result => {
            if (!active()) return
            setRows(result.suggestions)
            setProvider(result.provider)
            setAttribution(result.attribution)
            setError('')
          },
          () => {
            if (active()) {
              setRows([])
              setError('City lookup is unavailable. Try again.')
            }
          }
        )
        .finally(() => {
          if (active()) setLoading(false)
        })
    }, 250)
    return () => {
      clearTimeout(timeout)
    }
  }, [client, query, open, begin])
  const dismiss = (): void => {
    Keyboard.dismiss()
    input.current?.blur()
  }
  const choose = async (row: CitySuggestion): Promise<void> => {
    if (selecting) return
    const active = begin()
    setSelecting(true)
    setError('')
    try {
      const value = await client.location(row.id, session.current)
      if (!active()) return
      setChosen(value)
      setQuery(`${value.city}, ${value.region}`)
      setRows([])
      session.current = newSession()
      dismiss()
    } catch {
      if (active()) setError('City lookup is unavailable. Try again.')
    } finally {
      if (active()) setSelecting(false)
    }
  }
  const save = async (): Promise<void> => {
    if (chosen == null || working.current) return
    working.current = true
    const active = beginSave()
    setSaving(true)
    setError('')
    try {
      await onSave(chosen)
    } catch (error) {
      if (active())
        setError(
          error instanceof Error
            ? error.message
            : 'Location could not be saved. Try again.'
        )
    } finally {
      working.current = false
      if (active()) setSaving(false)
    }
  }
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen scroll={false} contentStyle={styles.page}>
        <ScrollView
          ref={body}
          contentContainerStyle={{ minHeight: height + fieldY }}
          scrollEnabled={!open}
          keyboardShouldPersistTaps="handled"
          style={styles.body}
        >
          <Text accessibilityRole="header" style={styles.title}>
            Location
          </Text>
          <Text style={styles.hint}>
            {current == null
              ? 'Location not set'
              : `${current.city}, ${current.region}\n${current.country}`}
          </Text>
          <View
            ref={field}
            onLayout={event => {
              setFieldY(event.nativeEvent.layout.y)
            }}
            style={styles.search}
          >
            <TextField
              label="City"
              value={query}
              placeholder="Start typing a city"
              leadingIcon="search"
              inputRef={input}
              disabled={saving || selecting}
              onChangeText={value => {
                begin()
                setChosen(undefined)
                setRows([])
                setError('')
                setQuery(value)
                if (value === '') session.current = newSession()
              }}
              onFocus={() => {
                body.current?.scrollTo({ y: fieldY, animated: false })
                field.current?.measureInWindow((_x, y, _w, h) => {
                  setFieldBottom(y + h)
                })
              }}
            />
          </View>
          {open && (
            <View style={styles.list} testID="city-list-surface">
              {loading && (
                <Text style={styles.message}>Looking for cities…</Text>
              )}
              {!loading && !selecting && rows.length === 0 && error === '' && (
                <Text style={styles.message}>No city matches</Text>
              )}
              {error !== '' && (
                <Text accessibilityRole="alert" style={styles.message}>
                  {error}
                </Text>
              )}
              <FlatList
                data={rows}
                keyExtractor={row => row.id}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                testID="city-suggestions"
                style={{
                  height: cityListHeight(viewport, fieldBottom, footer)
                }}
                onScrollBeginDrag={dismiss}
                onScroll={() => {
                  if (
                    Platform.OS === 'web' &&
                    input.current?.isFocused() === true
                  )
                    dismiss()
                }}
                ItemSeparatorComponent={() => <View style={styles.divider} />}
                renderItem={({ item }) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Choose ${item.primary}, ${item.secondary}`}
                    disabled={selecting}
                    onPress={() => {
                      choose(item).catch(() => undefined)
                    }}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && styles.pressed
                    ]}
                  >
                    <Icon name="place" size={1.25} />
                    <View style={styles.words}>
                      <Text style={styles.primary} numberOfLines={1}>
                        {item.primary}
                      </Text>
                      <Text style={styles.secondary} numberOfLines={1}>
                        {item.secondary}
                      </Text>
                    </View>
                  </Pressable>
                )}
              />
              <Text style={styles.attribution}>
                {provider === 'google' ? 'Powered by Google' : attribution}
              </Text>
            </View>
          )}
          {chosen != null && (
            <Text style={styles.hint}>
              Save to use {chosen.city}, {chosen.region}, {chosen.country}
            </Text>
          )}
          {!open && error !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
        </ScrollView>
        <View
          style={styles.footer}
          onLayout={event => {
            setFooter(event.nativeEvent.layout.height)
          }}
        >
          <Button
            label="Save"
            block
            disabled={chosen == null || selecting}
            busy={saving}
            onPress={() => {
              save().catch(() => undefined)
            }}
          />
          <DangerText
            label="Cancel"
            style={styles.cancel}
            disabled={saving}
            onPress={onCancel}
          />
        </View>
      </Screen>
    </KeyboardAvoidingView>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  cancel: { alignSelf: 'center' as const },
  page: { flex: 1 },
  body: { flex: 1 },
  search: { marginTop: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    fontFamily: theme.semiBoldTextFont,
    color: theme.primaryTextColor
  },
  hint: {
    marginTop: theme.rem(0.5),
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  list: {
    marginTop: theme.rem(0.5),
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(1),
    overflow: 'hidden' as const,
    shadowColor: theme.buttonShadowColor,
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3
  },
  row: {
    minHeight: 56,
    paddingHorizontal: theme.rem(0.875),
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75)
  },
  pressed: { backgroundColor: theme.containerBackgroundColor },
  words: { flex: 1 },
  primary: {
    fontSize: theme.rem(1),
    fontFamily: theme.semiBoldTextFont,
    color: theme.primaryTextColor
  },
  secondary: { fontSize: theme.rem(0.8125), color: theme.secondaryTextColor },
  divider: { height: 1, backgroundColor: theme.defaultBorderColor },
  message: { padding: theme.rem(0.875), color: theme.secondaryTextColor },
  attribution: {
    padding: theme.rem(0.625),
    textAlign: 'right' as const,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  },
  error: { color: theme.dangerColor },
  footer: { paddingTop: theme.rem(0.75), gap: theme.rem(0.5) }
}))
