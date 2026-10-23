import React, { useEffect, useRef, useState } from 'react'
import { Linking, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  type EventPlace,
  type EventPlaceKind,
  selectedEventPlace
} from '../../common/eventPlaces'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { TextField } from './TextField'

export interface EventVenueDraft {
  venue: string
  address: string
  notes: string
}

export function EventVenueFields({
  client,
  value,
  onChange,
  disabled = false,
  placeLocked = false
}: {
  client: TeamStationClient
  value: EventVenueDraft
  onChange: (value: EventVenueDraft) => void
  disabled?: boolean
  /** The venue and address come from a chosen field; notes stay editable. */
  placeLocked?: boolean
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const placeDisabled = disabled || placeLocked
  const generation = useRef(0)
  const [request, setRequest] = useState<{
    kind: EventPlaceKind
    query: string
  }>()
  const [places, setPlaces] = useState<EventPlace[]>([])
  const [provider, setProvider] = useState<'google' | 'openstreetmap'>('google')
  const [attribution, setAttribution] = useState('')
  const [status, setStatus] = useState('')
  const [retry, setRetry] = useState(0)
  const invalidate = (): void => {
    generation.current++
    setRequest(undefined)
    setPlaces([])
    setAttribution('')
    setStatus('')
  }
  useEffect(() => {
    const current = ++generation.current
    if (
      request == null ||
      placeDisabled ||
      request.query.trim().length < 2 ||
      request.query.length > 120
    )
      return
    const timer = setTimeout(() => {
      setStatus('Finding places…')
      client.eventPlaceSuggestions(request.query, request.kind).then(
        found => {
          if (current !== generation.current) return
          setPlaces(found.places)
          setProvider(found.provider)
          setAttribution(found.attribution)
          setStatus(
            found.places.length === 0
              ? 'No suggestions. You can keep the details you enter.'
              : ''
          )
        },
        () => {
          if (current !== generation.current) return
          setStatus('Suggestions unavailable. Enter details manually or retry.')
        }
      )
    }, 300)
    return () => {
      generation.current++
      clearTimeout(timer)
    }
  }, [client, request, retry, placeDisabled])
  const edit = (kind: EventPlaceKind, text: string): void => {
    invalidate()
    onChange({ ...value, [kind === 'venue' ? 'venue' : 'address']: text })
    setRequest({ kind, query: text })
  }
  const suggestions = (kind: EventPlaceKind): React.ReactNode =>
    request?.kind !== kind ? null : (
      <View style={styles.results}>
        {places.map(place => (
          <Pressable
            key={place.id}
            accessibilityRole="button"
            accessibilityLabel={`Choose ${place.name ?? place.address}`}
            disabled={placeDisabled}
            onPress={() => {
              onChange({
                ...value,
                ...selectedEventPlace(kind, place, value.venue)
              })
              invalidate()
            }}
            style={styles.option}
          >
            <Text style={styles.name}>{place.name ?? place.address}</Text>
            {place.name != null && (
              <Text style={styles.detail}>{place.address}</Text>
            )}
          </Pressable>
        ))}
        {status !== '' && (
          <Text accessibilityLiveRegion="polite" style={styles.detail}>
            {status}
          </Text>
        )}
        {status.startsWith('Suggestions unavailable') && (
          <Button
            label="Retry place suggestions"
            kind="text"
            onPress={() => {
              setRetry(v => v + 1)
            }}
            disabled={placeDisabled}
          />
        )}
        {attribution !== '' && (
          <Text
            accessibilityRole="link"
            style={styles.detail}
            onPress={() => {
              Linking.openURL(
                provider === 'google'
                  ? 'https://maps.google.com/'
                  : 'https://www.openstreetmap.org/copyright'
              ).catch(() => undefined)
            }}
          >
            {attribution}
          </Text>
        )}
      </View>
    )
  return (
    <View style={styles.body}>
      <TextField
        label="Venue name (optional)"
        value={value.venue}
        disabled={disabled}
        locked={placeLocked}
        onChangeText={text => {
          edit('venue', text)
        }}
        onFocus={() => {
          if (request?.kind === 'address') invalidate()
        }}
      />
      {suggestions('venue')}
      <TextField
        label="Venue address (optional)"
        value={value.address}
        disabled={disabled}
        locked={placeLocked}
        onChangeText={text => {
          edit('address', text)
        }}
        onFocus={() => {
          if (request?.kind === 'venue') invalidate()
        }}
      />
      {suggestions('address')}
      {placeLocked && (
        <Text style={styles.lockedNote}>
          The venue and address come from the chosen field.
        </Text>
      )}
      <TextField
        label="Notes (optional)"
        value={value.notes}
        disabled={disabled}
        multiline
        maxLength={2000}
        placeholder="Where to meet, field number…"
        onChangeText={notes => {
          invalidate()
          onChange({ ...value, notes })
        }}
        onFocus={invalidate}
      />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  body: { gap: theme.rem(1) },
  results: { gap: theme.rem(0.5) },
  lockedNote: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  option: {
    padding: theme.rem(0.75),
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
  detail: {
    fontFamily: theme.regularTextFont,
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875)
  }
}))
