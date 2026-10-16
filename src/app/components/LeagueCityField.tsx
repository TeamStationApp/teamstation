import React, { useEffect, useRef, useState } from 'react'
import {
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'
import Animated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'

import type { TeamStationClient } from '../../common/api'
import { type Locality, localityLabel } from '../../common/locality'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { TextField } from './TextField'

export interface LeagueCityFieldProps {
  client: TeamStationClient
  value: Locality | null
  onChange: (value: Locality | null) => void
  /** True while a search dropdown is open, so the screen can hide Continue. */
  onBrowsing: (browsing: boolean) => void
}

/**
 * The city field on Create League.
 *
 * The field stays on that screen. Typing opens a dropdown whose height is
 * the room above the keyboard's real frame, and choosing a row writes the
 * full place into the field and lowers the keyboard.
 */
export function LeagueCityField({
  client,
  value,
  onChange,
  onBrowsing
}: LeagueCityFieldProps): React.ReactElement {
  const styles = getStyles(useTheme())
  // The list height has to follow the keyboard on the UI thread. Reanimated's
  // frame does that. keyboard-controller is the suggested replacement and is
  // not a dependency of this app.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const keyboard = useAnimatedKeyboard()
  const windowHeight = useSharedValue(Dimensions.get('window').height)
  const listTop = useSharedValue(0)
  // Web has no Reanimated keyboard frame. The visual viewport is the real
  // one there, including the keyboard on a phone browser.
  const webKeyboard = useSharedValue(0)
  const anchor = useRef<React.ComponentRef<typeof View>>(null)
  // A row press blurs the field first. Closing on that blur would unmount
  // the row before the press landed.
  const suppressBlur = useRef(false)
  const [text, setText] = useState(value == null ? '' : localityLabel(value))
  const [places, setPlaces] = useState<Locality[]>([])
  const [error, setError] = useState('')
  const [focused, setFocused] = useState(false)
  const chosen = value == null ? '' : localityLabel(value)
  const browsing = focused && text.trim().length >= 2 && text !== chosen
  useEffect(() => {
    onBrowsing(browsing)
    return () => {
      onBrowsing(false)
    }
  }, [browsing, onBrowsing])
  useEffect(() => {
    const subscription = Dimensions.addEventListener(
      'change',
      ({ window }: { window: { height: number } }) => {
        windowHeight.value = window.height
      }
    )
    const viewport = globalThis.visualViewport
    const syncWebKeyboard = (): void => {
      if (viewport == null || Platform.OS !== 'web') return
      webKeyboard.value = withTiming(
        Math.max(
          0,
          globalThis.innerHeight - viewport.height - viewport.offsetTop
        ),
        { duration: 220 }
      )
    }
    viewport?.addEventListener('resize', syncWebKeyboard)
    viewport?.addEventListener('scroll', syncWebKeyboard)
    syncWebKeyboard()
    return () => {
      subscription.remove()
      viewport?.removeEventListener('resize', syncWebKeyboard)
      viewport?.removeEventListener('scroll', syncWebKeyboard)
    }
  }, [webKeyboard, windowHeight])
  const placeList = (): void => {
    anchor.current?.measureInWindow((_x, y, _width, height) => {
      listTop.value = y + height
    })
  }
  const listStyle = useAnimatedStyle(() => ({
    maxHeight: Math.max(
      0,
      windowHeight.value -
        listTop.value -
        Math.max(keyboard.height.value, webKeyboard.value)
    )
  }))
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      if (!browsing) {
        setPlaces([])
        setError('')
        return
      }
      client.locations(text.trim()).then(
        found => {
          if (active) {
            setPlaces(found)
            setError('')
          }
        },
        () => {
          if (active) {
            setPlaces([])
            setError('City lookup is unavailable. Try the name again.')
          }
        }
      )
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [browsing, client, text])
  const choose = (place: Locality): void => {
    const label = localityLabel(place)
    setText(label)
    setPlaces([])
    setError('')
    setFocused(false)
    onChange(place)
    Keyboard.dismiss()
  }
  return (
    <View>
      <View ref={anchor} onLayout={placeList}>
        <TextField
          label="City"
          value={text}
          placeholder="City and state"
          autoComplete="off"
          onFocus={() => {
            setFocused(true)
            placeList()
          }}
          onBlur={() => {
            if (suppressBlur.current) return
            setFocused(false)
          }}
          onChangeText={next => {
            setText(next)
            if (value != null && next !== localityLabel(value)) onChange(null)
          }}
        />
      </View>
      {browsing && (
        <Animated.View style={listStyle}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.results}
          >
            {places.map(place => {
              const label = localityLabel(place)
              return (
                <Pressable
                  key={place.placeId ?? label}
                  accessibilityRole="button"
                  accessibilityLabel={`Choose ${label}`}
                  onPressIn={() => {
                    suppressBlur.current = true
                  }}
                  onPress={() => {
                    suppressBlur.current = false
                    choose(place)
                  }}
                  style={styles.option}
                >
                  <Text style={styles.name}>{label}</Text>
                </Pressable>
              )
            })}
            {error !== '' && (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            )}
            {places.length > 0 && (
              <Text style={styles.attribution}>
                City data: GeoNames, CC BY 4.0
              </Text>
            )}
          </ScrollView>
        </Animated.View>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  results: { gap: theme.rem(0.5), paddingTop: theme.rem(0.5) },
  option: {
    minHeight: theme.rem(3),
    justifyContent: 'center',
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.75),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.cardBackgroundColor
  },
  name: {
    fontFamily: theme.semiBoldTextFont,
    color: theme.primaryTextColor,
    fontSize: theme.rem(1)
  },
  error: {
    fontFamily: theme.regularTextFont,
    color: theme.dangerColor,
    fontSize: theme.rem(0.875)
  },
  attribution: {
    fontFamily: theme.regularTextFont,
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.75)
  }
}))
