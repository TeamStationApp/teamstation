import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  FIELD_SIZES,
  fieldSizeLabel,
  type VenueDetail,
  type VenueField
} from '../../common/venues'
import {
  Button,
  Card,
  Icon,
  ListCard,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import {
  BlackoutDatesEditor,
  dateLabel
} from '../components/BlackoutDatesEditor'
import { CheckRow } from '../components/CheckRow'
import { DateRangePicker } from '../components/DateRangePicker'
import { PickerDialog } from '../components/PickerDialog'
import { PinMap } from '../components/PinMap'
import { PlacePhoto } from '../components/PlacePhoto'
import { SegmentedPill } from '../components/SegmentedPill'
import { WeeklyHoursEditor } from '../components/WeeklyHoursEditor'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { pickAccountPhoto } from '../platform/pickAccountPhoto'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * One field: its photo, where it is on the map, the sizes it can be set up
 * in, and when it is open. An owner edits each of them in place; the rest
 * read them.
 */
export function FieldScreen({
  client,
  venueId,
  fieldId,
  onGone,
  pickPhoto = pickAccountPhoto
}: {
  client: TeamStationClient
  venueId: string
  fieldId: string
  /** The field is not there any more. */
  onGone?: () => void
  pickPhoto?: typeof pickAccountPhoto
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [venue, setVenue] = useState<VenueDetail>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [name, setName] = useState('')
  const [choosingDates, setChoosingDates] = useState(false)
  const begin = useLatestRequest()
  useEffect(() => {
    const current = begin()
    setError('')
    client.venue(venueId).then(
      found => {
        if (!current()) return
        setVenue(found)
        setName(found.fields.find(field => field.id === fieldId)?.name ?? '')
      },
      () => {
        if (current()) setError('The field could not load. Try again.')
      }
    )
  }, [client, venueId, fieldId, revision, begin])
  const save = useCallback(
    async (changes: Record<string, unknown>, done: string): Promise<void> => {
      setBusy(true)
      setError('')
      setNotice('')
      try {
        const next = await client.updateField(venueId, fieldId, changes)
        setVenue(next)
        setNotice(done)
      } catch (failure) {
        setError(
          failure instanceof Error && failure.message !== ''
            ? failure.message
            : 'That could not be saved. Try again.'
        )
      } finally {
        setBusy(false)
      }
    },
    [client, venueId, fieldId]
  )
  const field: VenueField | undefined = venue?.fields.find(
    item => item.id === fieldId
  )
  if (venue == null || field == null)
    return (
      <Screen>
        {venue != null ? (
          <View style={styles.page}>
            <Text style={styles.sentence}>
              This field has been deleted. Games already booked on it stay.
            </Text>
            {onGone != null && (
              <Button label="Back to venue" onPress={onGone} />
            )}
          </View>
        ) : error === '' ? (
          <ActivityIndicator accessibilityLabel="Loading field" />
        ) : (
          <View style={styles.page}>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            <Button
              label="Retry"
              onPress={() => {
                setRevision(value => value + 1)
              }}
            />
          </View>
        )}
      </Screen>
    )
  const editable = venue.rights.canEdit
  const pin = field.pin ?? {
    latitude: venue.map.latitude,
    longitude: venue.map.longitude
  }
  const ownHours = field.hours != null
  return (
    <Screen>
      <View style={styles.page}>
        <Card style={styles.hero}>
          <PlacePhoto uri={field.photoUrl} label={`${field.name} photo`} />
          <Text accessibilityRole="header" style={styles.name}>
            {field.name}
          </Text>
          <Text style={styles.sentence}>{venue.name}</Text>
          {editable && (
            <Button
              label={field.photoUrl == null ? 'Add photo' : 'Change photo'}
              kind="secondary"
              small
              disabled={busy}
              onPress={() => {
                pickPhoto().then(
                  picture => {
                    if (picture != null)
                      save({ photo: picture }, 'Photo saved.').catch(
                        () => undefined
                      )
                  },
                  (failure: unknown) => {
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : 'That photo could not be read.'
                    )
                  }
                )
              }}
            />
          )}
        </Card>
        {notice !== '' && (
          <Text accessibilityRole="alert" style={styles.notice}>
            {notice}
          </Text>
        )}
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {editable && (
          <View style={styles.section}>
            <TextField
              label="Field name"
              value={name}
              onChangeText={setName}
              maxLength={100}
              autoCapitalize="words"
            />
            {name.trim() !== field.name && name.trim() !== '' && (
              <Button
                label="Save name"
                busy={busy}
                onPress={() => {
                  save({ name: name.trim() }, 'Name saved.').catch(
                    () => undefined
                  )
                }}
              />
            )}
          </View>
        )}
        <View style={styles.section}>
          <SectionHeader title="Where it is" />
          <Text style={styles.sentence}>
            {editable
              ? 'Drag the pin onto the field itself, so teams find the right diamond.'
              : field.pin == null
                ? 'The pin marks the venue.'
                : 'The pin marks the field.'}
          </Text>
          <PinMap
            settings={{
              ...pin,
              tileUrl: venue.map.tileUrl,
              googleMapsApiKey: venue.map.googleMapsApiKey,
              editable
            }}
            onMove={moved => {
              save({ pin: moved }, 'Pin saved.').catch(() => undefined)
            }}
          />
        </View>
        <View style={styles.section}>
          <SectionHeader title="Field sizes" />
          <ListCard>
            {FIELD_SIZES.map(size => (
              <CheckRow
                key={size}
                label={fieldSizeLabel(size)}
                checked={field.sizes.includes(size)}
                disabled={
                  !editable ||
                  busy ||
                  (field.sizes.length === 1 && field.sizes.includes(size))
                }
                onToggle={() => {
                  const next = field.sizes.includes(size)
                    ? field.sizes.filter(item => item !== size)
                    : [...field.sizes, size]
                  save({ sizes: next }, 'Sizes saved.').catch(() => undefined)
                }}
              />
            ))}
          </ListCard>
        </View>
        <View style={styles.section}>
          <SectionHeader title="Availability" />
          <ListCard>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Dates: ${datesLabel(field)}`}
              disabled={!editable || busy}
              onPress={() => {
                setChoosingDates(true)
              }}
              style={styles.row}
            >
              <Text style={styles.rowLabel}>Dates</Text>
              <Text style={styles.rowValue}>{datesLabel(field)}</Text>
              {editable && <Icon name="chevron_right" size={1.25} />}
            </Pressable>
          </ListCard>
          {editable && (field.startsOn != null || field.endsOn != null) && (
            <Button
              label="Open all year"
              kind="text"
              small
              onPress={() => {
                save({ startsOn: null, endsOn: null }, 'Dates cleared.').catch(
                  () => undefined
                )
              }}
            />
          )}
          <Text style={styles.sentence}>
            Dates do not repeat: set them again each year.
          </Text>
          <Text style={styles.subhead}>Hours</Text>
          {editable && (
            <SegmentedPill
              options={[
                { id: 'venue', label: 'Venue hours' },
                { id: 'own', label: 'Its own hours' }
              ]}
              selected={ownHours ? 'own' : 'venue'}
              onSelect={id => {
                if ((id === 'own') === ownHours) return
                save(
                  { hours: id === 'own' ? venue.defaultHours : null },
                  id === 'own'
                    ? 'This field now keeps its own hours.'
                    : 'This field now uses the venue’s hours.'
                ).catch(() => undefined)
              }}
              accessibilityLabel="Venue hours or its own"
            />
          )}
          <WeeklyHoursEditor
            label="Field hours"
            value={(field.hours ?? venue.defaultHours).map(entry => ({
              ...entry
            }))}
            disabled={!editable || !ownHours || busy}
            onChange={hours => {
              save({ hours }, 'Hours saved.').catch(() => undefined)
            }}
          />
          <Text style={styles.subhead}>Blackout days</Text>
          {venue.defaultBlackouts.length > 0 && (
            <Text style={styles.sentence}>
              The venue is also closed on{' '}
              {venue.defaultBlackouts.map(dateLabel).join(', ')}.
            </Text>
          )}
          <BlackoutDatesEditor
            value={field.blackouts}
            disabled={!editable || busy}
            empty="No blackout days for this field."
            onChange={dates => {
              save({ blackouts: dates }, 'Blackout days saved.').catch(
                () => undefined
              )
            }}
          />
        </View>
      </View>
      {choosingDates && (
        <PickerDialog
          onClose={() => {
            setChoosingDates(false)
          }}
        >
          <DateRangePicker
            initial={
              field.startsOn == null || field.endsOn == null
                ? undefined
                : { startsOn: field.startsOn, endsOn: field.endsOn }
            }
            onChoose={range => {
              setChoosingDates(false)
              save(
                { startsOn: range.startsOn, endsOn: range.endsOn },
                'Dates saved.'
              ).catch(() => undefined)
            }}
            onCancel={() => {
              setChoosingDates(false)
            }}
          />
        </PickerDialog>
      )}
    </Screen>
  )
}

/** A field's dates as its row reads them. */
export function datesLabel(field: {
  startsOn: string | null
  endsOn: string | null
}): string {
  if (field.startsOn == null || field.endsOn == null) return 'Open all year'
  const day = (date: string): string =>
    new Intl.DateTimeFormat('en', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date(`${date}T12:00:00Z`))
  return `${day(field.startsOn)} – ${day(field.endsOn)}`
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingBottom: theme.rem(6) },
  hero: { gap: theme.rem(0.5) },
  name: {
    fontFamily: theme.primaryTextFont,
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor
  },
  section: { gap: theme.rem(0.75) },
  subhead: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.0625),
    color: theme.primaryTextColor
  },
  sentence: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  notice: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.successColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.dangerColor
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(1),
    gap: theme.rem(0.5)
  },
  rowLabel: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  rowValue: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  }
}))
