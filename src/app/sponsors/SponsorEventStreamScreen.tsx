import React, { useEffect, useState } from 'react'
import { Text, TextInput, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Button, Card, Screen, SectionHeader } from '../components'
import { ScheduleRow } from '../components/ScheduleRow'
import { useConfirmedAction } from '../components/useConfirmedAction'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { DemoDataBar } from './DemoDataBar'
import { SponsoredScheduleRow } from './SponsoredScheduleRow'
import { SponsorFileDrop } from './SponsorFileDrop'
import {
  canEditPlacement,
  characters,
  imageFileProblem,
  MESSAGE_LIMIT,
  placementProblems,
  slotsLeft,
  TITLE_LIMIT
} from './sponsorRules'
import { type SponsorStore, sponsorStoreFor } from './sponsorStore'
import type {
  EventPlacement,
  PickedFile,
  PlacementDraft,
  PlacementField
} from './sponsorTypes'
import { useLeagueAdmin } from './useLeagueAdmin'
import { useSponsorState } from './useSponsorState'

export interface SponsorEventStreamScreenProps {
  client: Pick<TeamStationClient, 'group'>
  /** The league's id. */
  league: string
  /** The league's store; its page-long mock by default. */
  store?: SponsorStore
  /** For a test: the clock the 24-hour window is read against. */
  now?: () => Date
}

const EMPTY_DRAFT: PlacementDraft = {
  logo: null,
  background: null,
  title: '',
  message: '',
  url: '',
  startsAt: ''
}

/** An ISO date-time as a `datetime-local` value in the viewer's zone. */
function localInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

const sampleStart = (days: number, hour: number): string => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(hour, 0, 0, 0)
  return date.toISOString()
}

/**
 * Sponsor in Event Stream: a league's sponsored Schedule rows, the 10-slot
 * balance and the form that adds or edits one. A row can be edited or
 * deleted within 24 hours of being placed, and deleting it then returns its
 * slot; after that it can only be deleted, and its slot stays used.
 */
export function SponsorEventStreamScreen({
  client,
  league,
  store: given,
  now = () => new Date()
}: SponsorEventStreamScreenProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const store = given ?? sponsorStoreFor(league)
  const admin = useLeagueAdmin(client, league)
  const state = useSponsorState(store)
  const [draft, setDraft] = useState<PlacementDraft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<EventPlacement | null>(null)
  const [touched, setTouched] = useState<Set<PlacementField>>(new Set())
  const [pickErrors, setPickErrors] = useState<
    Partial<Record<'logo' | 'background', string>>
  >({})
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  // Re-read the clock each minute so the 24-hour window closes on screen.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      setTick(n => n + 1)
    }, 60_000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  const confirm = useConfirmedAction(store, league)

  if (admin === 'loading')
    return (
      <Screen>
        <Text style={styles.hint}>Loading…</Text>
      </Screen>
    )
  if (admin !== 'admin')
    return (
      <Screen>
        <View style={styles.page}>
          <Text style={styles.text}>
            Only a league administrator can set up sponsor features.
          </Text>
        </View>
      </Screen>
    )

  const at = now()
  const placements = [...(state?.placements ?? [])].sort(
    (a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt)
  )
  const total = state?.totals.eventSlots ?? 0
  const left = state == null ? 0 : slotsLeft(state)
  const problems = placementProblems(draft, editing != null)
  const valid = Object.keys(problems).length === 0
  const canAdd = editing != null || left > 0

  const touch = (field: PlacementField): void => {
    setTouched(prev => new Set(prev).add(field))
  }
  const change = (patch: Partial<PlacementDraft>): void => {
    setSaveError('')
    setDraft(prev => ({ ...prev, ...patch }))
    for (const field of Object.keys(patch)) touch(field as PlacementField)
  }
  const reset = (): void => {
    setDraft(EMPTY_DRAFT)
    setEditing(null)
    setTouched(new Set())
    setPickErrors({})
    setSaveError('')
  }
  const pickImage = (
    field: 'logo' | 'background',
    picked: PickedFile
  ): void => {
    touch(field)
    const refused = imageFileProblem(picked)
    setPickErrors(prev => ({ ...prev, [field]: refused ?? undefined }))
    if (refused == null) change({ [field]: picked })
  }
  const startEdit = (placement: EventPlacement): void => {
    setEditing(placement)
    setDraft({
      logo: null,
      background: null,
      title: placement.title,
      message: placement.message,
      url: placement.url,
      startsAt: localInputValue(placement.startsAt)
    })
    setTouched(new Set())
    setPickErrors({})
    setSaveError('')
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError('')
    try {
      if (editing == null) await store.addPlacement(draft)
      else await store.editPlacement(editing.id, draft)
      reset()
    } catch (caught) {
      setSaveError(
        caught instanceof Error ? caught.message : 'That could not be saved.'
      )
    } finally {
      setSaving(false)
    }
  }
  const shown = (field: PlacementField): string | null =>
    touched.has(field) ? (problems[field] ?? null) : null

  const previewSource: Pick<
    EventPlacement,
    'logoUrl' | 'backgroundUrl' | 'title' | 'message' | 'url'
  > | null =
    draft !== EMPTY_DRAFT || editing != null
      ? {
          logoUrl: draft.logo?.url ?? editing?.logoUrl ?? '',
          backgroundUrl: draft.background?.url ?? editing?.backgroundUrl ?? '',
          title: draft.title,
          message: draft.message,
          url: draft.url
        }
      : (placements[0] ?? null)

  const field = (
    label: string,
    name: PlacementField,
    input: React.ReactNode,
    note?: string
  ): React.ReactElement => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {input}
      {note != null && <Text style={styles.hint}>{note}</Text>}
      {shown(name) != null && (
        <Text accessibilityRole="alert" style={styles.error}>
          {shown(name)}
        </Text>
      )}
    </View>
  )

  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          Sponsor in Event Stream
        </Text>
        <Text style={styles.text}>
          Add sponsored rows to your league's Schedule. Each sponsored row has
          the sponsor's logo, a background image and a message, and opens the
          sponsor's website when tapped. You choose the date and time of each
          row.
        </Text>
        <View>
          <Text style={styles.remaining} testID="sponsor-slots-left">
            {left} of {total} event stream slots left
          </Text>
          <Text style={styles.hint}>Unused slots never expire.</Text>
        </View>

        <SectionHeader title="Placements" />
        {placements.length === 0 ? (
          <Text style={styles.hint}>No sponsored rows yet. Add one below.</Text>
        ) : (
          placements.map(placement => {
            const editable = canEditPlacement(placement, at)
            return (
              <View
                key={placement.id}
                style={styles.placement}
                testID="sponsor-placement"
              >
                <SponsoredScheduleRow {...placement} />
                <Text style={styles.hint}>
                  Placed {when(placement.placedAt)} · Shows{' '}
                  {when(placement.startsAt)}
                </Text>
                <View style={styles.actions}>
                  {editable && (
                    <Button
                      kind="secondary"
                      label="Edit"
                      accessibilityLabel={`Edit ${placement.title}`}
                      onPress={() => {
                        startEdit(placement)
                      }}
                    />
                  )}
                  <Button
                    kind="secondary"
                    label="Delete"
                    accessibilityLabel={`Delete ${placement.title}`}
                    onPress={() => {
                      confirm.open({
                        title: `Delete ${placement.title}?`,
                        detail: canEditPlacement(placement, now())
                          ? 'It was placed less than 24 hours ago, so its slot returns.'
                          : 'It was placed more than 24 hours ago, so its slot stays used.',
                        label: 'Delete',
                        testID: 'sponsor-confirm-delete',
                        sheetLabel: `Delete ${placement.title}`,
                        run: async () => {
                          await store.deletePlacement(placement.id)
                          if (editing?.id === placement.id) reset()
                        }
                      })
                    }}
                  />
                </View>
                <Text style={styles.hint}>
                  {editable
                    ? 'Delete returns the slot'
                    : 'Placed more than 24 hours ago: it can be deleted, but not edited or moved, and its slot stays used.'}
                </Text>
              </View>
            )
          })
        )}

        <SectionHeader
          title={editing == null ? 'Add a sponsored row' : 'Edit sponsored row'}
        />
        {!canAdd ? (
          <Text style={styles.text} testID="sponsor-slots-used">
            All {total} event stream slots are used.
          </Text>
        ) : (
          <View style={styles.form} testID="sponsor-placement-form">
            {field(
              'Logo',
              'logo',
              <SponsorFileDrop
                label={
                  draft.logo?.name ??
                  (editing != null ? 'Logo (keep current)' : 'Logo')
                }
                prompt="Drop a JPEG or PNG here or Choose file"
                accept="image/jpeg,image/png"
                testID="sponsor-logo-drop"
                error={pickErrors.logo}
                onPick={picked => {
                  pickImage('logo', picked)
                }}
              />,
              'Square, 128 × 128. Other sizes are cropped to a square.'
            )}
            {field(
              'Background image',
              'background',
              <SponsorFileDrop
                label={
                  draft.background?.name ??
                  (editing != null
                    ? 'Background (keep current)'
                    : 'Background image')
                }
                prompt="Drop a JPEG or PNG here or Choose file"
                accept="image/jpeg,image/png"
                testID="sponsor-background-drop"
                error={pickErrors.background}
                onPick={picked => {
                  pickImage('background', picked)
                }}
              />,
              'About 1920 × 224. Narrower screens crop it from its upper-right corner.'
            )}
            {field(
              'Title',
              'title',
              <TextInput
                accessibilityLabel="Title"
                value={draft.title}
                style={styles.input}
                onChangeText={title => {
                  change({ title })
                }}
              />,
              `${characters(draft.title)}/${TITLE_LIMIT}`
            )}
            {field(
              'Message',
              'message',
              <TextInput
                accessibilityLabel="Message"
                value={draft.message}
                multiline
                numberOfLines={3}
                style={[styles.input, styles.multiline]}
                onChangeText={message => {
                  change({ message })
                }}
              />,
              `${characters(draft.message)}/${MESSAGE_LIMIT}`
            )}
            {field(
              'Website',
              'url',
              <TextInput
                accessibilityLabel="Website"
                value={draft.url}
                placeholder="https://…"
                inputMode="url"
                autoCapitalize="none"
                style={styles.input}
                onChangeText={url => {
                  change({ url })
                }}
              />
            )}
            {field(
              'Date and time',
              'startsAt',
              <input
                type="datetime-local"
                aria-label="Date and time"
                value={draft.startsAt}
                onChange={event => {
                  change({ startsAt: event.currentTarget.value })
                }}
                style={{
                  minHeight: 48,
                  maxWidth: 280,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: `1px solid ${theme.inputBorderColor}`,
                  background: theme.inputBackgroundColor,
                  color: theme.inputTextColor,
                  fontSize: 16
                }}
              />
            )}
            {saveError !== '' && (
              <Text accessibilityRole="alert" style={styles.error}>
                {saveError}
              </Text>
            )}
            <Button
              label="Save"
              block
              busy={saving}
              disabled={saving || !valid || !canAdd}
              onPress={() => {
                save().catch(() => undefined)
              }}
            />
            {(editing != null || draft !== EMPTY_DRAFT) && (
              <Button kind="text" label="Cancel" onPress={reset} />
            )}
          </View>
        )}

        <SectionHeader title="Preview in a Schedule" />
        <View style={styles.schedule} testID="sponsor-schedule-preview">
          <Card>
            <ScheduleRow
              first="Bay Stars"
              second="@ Cyclones"
              startAt={sampleStart(2, 17)}
              venue="Riverside Park, Field 2"
              status="scheduled"
              awayScore={null}
              homeScore={null}
              videoCount={0}
            />
          </Card>
          {previewSource != null && <SponsoredScheduleRow {...previewSource} />}
          <Card>
            <ScheduleRow
              first="Hawks"
              second="vs Comets"
              startAt={sampleStart(3, 10)}
              venue="Northgate Fields, Diamond 1"
              status="scheduled"
              awayScore={null}
              homeScore={null}
              videoCount={0}
            />
          </Card>
        </View>

        <DemoDataBar store={store} onReset={reset} />
      </View>
      {confirm.sheet}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingVertical: theme.rem(1) },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5)
  },
  text: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    lineHeight: theme.rem(1.4)
  },
  hint: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  remaining: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125)
  },
  placement: {
    gap: theme.rem(0.5),
    padding: theme.rem(0.75),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.containerBackgroundColor
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.rem(0.5) },
  form: {
    gap: theme.rem(1),
    padding: theme.rem(1),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor
  },
  field: { gap: theme.rem(0.375) },
  label: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  },
  input: {
    minHeight: 48,
    paddingHorizontal: theme.rem(0.75),
    borderRadius: theme.rem(0.5),
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  },
  multiline: {
    minHeight: theme.rem(5),
    paddingVertical: theme.rem(0.5),
    textAlignVertical: 'top'
  },
  schedule: { gap: theme.rem(0.75) }
}))
