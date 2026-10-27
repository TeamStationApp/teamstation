import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GameFieldSummary } from '../../common/gameApprovals'
import {
  type FieldSize,
  fieldSizeLabel,
  type VenueDetail,
  type VenueField,
  type VenueSummary
} from '../../common/venues'
import { Button, ListCard, ListRow, TextField } from '../components'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { sizesLabel } from './VenueScreen'

/**
 * What the picker returns. In game mode, the field a game is on, with the
 * size it is set up in, asked for when the field takes more than one. In
 * field mode, the venue's field itself, as soon as it is tapped, with no
 * size step.
 */
export type FieldPickerMode =
  | { onChoose: (field: GameFieldSummary) => void; onChooseField?: never }
  | {
      onChooseField: (field: VenueField, venue: VenueDetail) => void
      onChoose?: never
    }

/**
 * Chooses a registry field: a venue, then one of its fields, and, for a
 * game, the size it is set up in. A long, searchable picker, so it is a
 * scene of its own that slides up.
 */
export function FieldPickerScene(
  props: {
    client: TeamStationClient
    onClose: () => void
  } & FieldPickerMode
): React.ReactElement {
  const { client, onClose } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const [query, setQuery] = useState('')
  const [venues, setVenues] = useState<VenueSummary[]>()
  const [venue, setVenue] = useState<VenueDetail>()
  const [field, setField] = useState<VenueField>()
  const [error, setError] = useState('')
  const begin = useLatestRequest()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () => {
        const current = begin()
        setError('')
        client
          .venues({ query })
          .then(found => {
            // Only venues in the registry have fields.
            if (current()) setVenues(found.filter(item => item.id != null))
          })
          .catch(() => {
            if (current()) setError('Venues could not load. Try again.')
          })
      },
      query === '' ? 0 : 300
    )
    return () => {
      clearTimeout(timer.current)
    }
  }, [client, query, begin])
  const choose = (chosen: VenueField, size: FieldSize): void => {
    if (venue?.id == null || props.onChoose == null) return
    props.onChoose({
      venueId: venue.id,
      venueName: venue.name,
      fieldId: chosen.id,
      fieldName: chosen.name,
      size,
      address: venue.address
    })
  }
  const title =
    field != null ? 'Choose size' : venue != null ? venue.name : 'Choose field'
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.scene,
          { paddingTop: insets.top, paddingBottom: insets.bottom }
        ]}
        testID="field-picker"
      >
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          <Button
            label="Cancel"
            accessibilityLabel="Cancel field picker"
            kind="text"
            textColor={theme.dangerColor}
            style={styles.cancel}
            onPress={onClose}
          />
        </View>
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {error !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          {venue == null ? (
            <>
              <TextField
                label="Search venues"
                value={query}
                onChangeText={setQuery}
                placeholder="A venue in the registry"
                leadingIcon="search"
                autoCapitalize="words"
              />
              {venues == null ? (
                <ActivityIndicator accessibilityLabel="Loading venues" />
              ) : venues.length === 0 ? (
                <Text style={styles.hint}>
                  No venues in the registry match. A league claims a venue in
                  its Auto-Scheduler’s Field Manager.
                </Text>
              ) : (
                <ListCard>
                  {venues.map(item => (
                    <ListRow
                      key={item.id}
                      title={item.name}
                      subtitle={item.address}
                      emblemIcon="stadium"
                      onPress={() => {
                        client.venue(item.id!).then(setVenue, () => {
                          setError('The venue could not load. Try again.')
                        })
                      }}
                    />
                  ))}
                </ListCard>
              )}
            </>
          ) : field == null ? (
            venue.fields.length === 0 ? (
              <Text style={styles.hint}>This venue has no fields yet.</Text>
            ) : (
              <ListCard>
                {venue.fields.map(item => (
                  <ListRow
                    key={item.id}
                    title={item.name}
                    subtitle={sizesLabel(item.sizes)}
                    onPress={() => {
                      if (props.onChooseField != null)
                        props.onChooseField(item, venue)
                      else if (item.sizes.length === 1)
                        choose(item, item.sizes[0])
                      else setField(item)
                    }}
                  />
                ))}
              </ListCard>
            )
          ) : (
            <ListCard>
              {field.sizes.map(size => (
                <ListRow
                  key={size}
                  title={fieldSizeLabel(size)}
                  accessibilityLabel={`Use ${fieldSizeLabel(size)}`}
                  onPress={() => {
                    choose(field, size)
                  }}
                />
              ))}
            </ListCard>
          )}
          {venue != null && (
            <Button
              label="Back"
              kind="text"
              onPress={() => {
                if (field != null) setField(undefined)
                else setVenue(undefined)
              }}
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scene: { flex: 1, backgroundColor: theme.backgroundColor },
  header: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.5),
    borderBottomWidth: 1,
    borderBottomColor: theme.defaultBorderColor
  },
  title: {
    flex: 1,
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  body: { flex: 1 },
  content: {
    width: '100%' as const,
    maxWidth: theme.rem(36),
    alignSelf: 'center' as const,
    padding: theme.rem(1),
    gap: theme.rem(0.75)
  },
  cancel: {
    paddingRight: 0,
    paddingLeft: theme.rem(1),
    minWidth: theme.rem(3),
    alignItems: 'flex-end' as const
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor }
}))
