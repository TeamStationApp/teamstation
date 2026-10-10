import React, { useEffect, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { asLocality, type Locality, localityLabel } from '../../common/locality'
import { getRoughLocation } from '../platform/getRoughLocation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export interface LocalityPickerProps {
  client: TeamStationClient
  value: Locality | null
  suggestion?: Locality
  onChange: (value: Locality) => void
}

export function LocalityPicker({
  client,
  value,
  suggestion,
  onChange
}: LocalityPickerProps): React.ReactElement {
  const styles = getStyles(useTheme())
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<Locality[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(false)
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [country, setCountry] = useState('US')
  useEffect(() => {
    if (value == null && suggestion != null) {
      setQuery(suggestion.city)
      setPlaces([suggestion])
    }
  }, [suggestion, value])
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      if (query.trim().length < 2) {
        setPlaces([])
        return
      }
      if (query === suggestion?.city) {
        setPlaces([suggestion])
        return
      }
      client.locations(query).then(
        found => {
          if (active) setPlaces(found)
        },
        () => {
          if (active)
            setError('City lookup is unavailable. Enter a location manually.')
        }
      )
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client, query, suggestion])
  const requestLocation = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await getRoughLocation()
      if (result.status !== 'success') {
        setError(`Location ${result.status}. Search or enter a city below.`)
        return
      }
      const suggestion = await client.locationSuggestion(
        result.latitude,
        result.longitude
      )
      if (suggestion == null) {
        setError('No nearby city found. Search or enter it below.')
        return
      }
      setPlaces([suggestion])
      setQuery(suggestion.city)
    } catch {
      setError('Location unavailable. Search or enter a city below.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={styles.body}>
      <Text style={styles.text}>
        Choose the city and state or region for this group.
      </Text>
      <Button
        label="Use my location"
        onPress={() => {
          requestLocation().catch(() => undefined)
        }}
        busy={busy}
        kind="secondary"
      />
      <TextInput
        accessibilityLabel="Search city and state"
        placeholder="Search city and state"
        value={query}
        onChangeText={setQuery}
        style={styles.input}
      />
      {places.map(place => (
        <Pressable
          key={place.placeId ?? localityLabel(place)}
          accessibilityRole="button"
          accessibilityLabel={`Choose ${localityLabel(place)}`}
          onPress={() => {
            onChange(place)
            setPlaces([])
          }}
          style={styles.option}
        >
          <Text style={styles.text}>{localityLabel(place)}</Text>
        </Pressable>
      ))}
      {value != null && (
        <Text style={styles.text}>Selected: {localityLabel(value)}</Text>
      )}
      {error !== '' && <Text style={styles.error}>{error}</Text>}
      <Button
        label="Enter location manually"
        kind="text"
        onPress={() => {
          setManual(!manual)
        }}
      />
      {manual && (
        <View style={styles.body}>
          <TextInput
            accessibilityLabel="City"
            testID="manual-locality-city"
            placeholder="City"
            value={city}
            onChangeText={setCity}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="State or region"
            testID="manual-locality-region"
            placeholder="State or region"
            value={region}
            onChangeText={setRegion}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Country"
            testID="manual-locality-country"
            placeholder="Country"
            value={country}
            onChangeText={setCountry}
            style={styles.input}
          />
          <Button
            label="Confirm location"
            onPress={() => {
              try {
                onChange(
                  asLocality({
                    city,
                    region,
                    country,
                    placeId: null,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
                  })
                )
                setError('')
              } catch (error) {
                setError(
                  error instanceof Error
                    ? error.message
                    : 'Enter a valid location'
                )
              }
            }}
          />
        </View>
      )}
      <Text style={styles.attribution}>City data: GeoNames, CC BY 4.0</Text>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  body: { gap: 12 },
  text: { color: theme.primaryTextColor, fontSize: 15 },
  input: {
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor,
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    borderRadius: 10,
    padding: 12,
    fontSize: 16
  },
  option: {
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: 12,
    borderRadius: 10
  },
  error: { color: theme.dangerColor },
  attribution: { color: theme.secondaryTextColor, fontSize: 12 }
}))
