import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  FIELD_SIZES,
  type FieldSize,
  fieldSizeLabel,
  type VenueClaim,
  type VenueDetail
} from '../../common/venues'
import {
  Badge,
  Button,
  Card,
  Emblem,
  ListCard,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import { ActionList, ActionRow } from '../components/ActionRow'
import { BlackoutDatesEditor } from '../components/BlackoutDatesEditor'
import { CancelAction } from '../components/CancelAction'
import { CheckRow } from '../components/CheckRow'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { DangerText } from '../components/DangerText'
import { PickerDialog } from '../components/PickerDialog'
import { PinMap } from '../components/PinMap'
import { PlacePhoto } from '../components/PlacePhoto'
import { useSceneReveals } from '../components/sceneShown'
import { useConfirmedAction } from '../components/useConfirmedAction'
import {
  VENUE_OPEN_DEFAULT,
  WeeklyHoursEditor
} from '../components/WeeklyHoursEditor'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { openEventDirections } from '../platform/eventDirections'
import { pickAccountPhoto } from '../platform/pickAccountPhoto'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * When a pending claim is approved by itself: its date, which reads the same
 * whatever the viewer's clock says.
 */
export function approvalLabel(approvesAt: string): string {
  return `approved automatically on ${new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(approvesAt))}`
}

/** A field's sizes as a row's detail line. */
export function sizesLabel(sizes: readonly FieldSize[]): string {
  return sizes.map(fieldSizeLabel).join(' · ')
}

/**
 * One venue: its photo, owners and fields, and what the person may do with
 * it. An owner edits it here; anyone else can claim it or ask to co-own it.
 */
export function VenueScreen({
  client,
  venueId,
  placeId,
  onOpenField,
  onClaimed,
  pickPhoto = pickAccountPhoto,
  openDirections = openEventDirections
}: {
  client: TeamStationClient
  venueId?: string
  placeId?: string
  onOpenField: (venueId: string, fieldId: string) => void
  /** A Google place became a registry venue: open it by its own id. */
  onClaimed: (venueId: string) => void
  pickPhoto?: typeof pickAccountPhoto
  openDirections?: typeof openEventDirections
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [detail, setDetail] = useState<VenueDetail>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [choosingLeague, setChoosingLeague] = useState<'claim' | 'request'>()
  const [addingField, setAddingField] = useState(false)
  const [switchTime, setSwitchTime] = useState<string>()
  const begin = useLatestRequest()
  const confirm = useConfirmedAction(client, venueId ?? placeId ?? '')
  // A field's screen, pushed over this one, renames and resizes it.
  const reveals = useSceneReveals()
  useEffect(() => {
    const current = begin()
    setError('')
    const read =
      venueId != null
        ? client.venue(venueId)
        : client.venueForPlace(placeId ?? '')
    read.then(
      found => {
        if (current()) setDetail(found)
      },
      (failure: unknown) => {
        if (current())
          setError(
            failure instanceof Error && failure.message !== ''
              ? failure.message
              : 'The venue could not load. Try again.'
          )
      }
    )
  }, [client, venueId, placeId, revision, reveals, begin])
  const run = useCallback(
    async (
      write: () => Promise<VenueDetail>,
      done?: string
    ): Promise<VenueDetail | undefined> => {
      setBusy(true)
      setError('')
      setNotice('')
      try {
        const next = await write()
        setDetail(next)
        if (done != null) setNotice(done)
        return next
      } catch (failure) {
        setError(
          failure instanceof Error && failure.message !== ''
            ? failure.message
            : 'That could not be saved. Try again.'
        )
        return undefined
      } finally {
        setBusy(false)
      }
    },
    []
  )
  if (detail == null)
    return (
      <Screen>
        {error === '' ? (
          <ActivityIndicator accessibilityLabel="Loading venue" />
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
  const { rights } = detail
  const id = detail.id
  const claim = async (leagueId: string): Promise<void> => {
    const next = await run(
      async () =>
        id == null
          ? await client.claimPlace(detail.placeId, leagueId)
          : await client.claimVenue(id, leagueId),
      rights.canRequest
        ? 'Your request to co-own this venue was sent.'
        : 'Claimed. The claim is approved in 7 days, or sooner by a site administrator.'
    )
    if (id == null && next?.id != null) onClaimed(next.id)
  }
  const startClaim = (kind: 'claim' | 'request'): void => {
    if (rights.claimLeagues.length === 1)
      claim(rights.claimLeagues[0].id).catch(() => undefined)
    else setChoosingLeague(kind)
  }
  const decidable = detail.claims.filter(item =>
    rights.decidableClaimIds.includes(item.id)
  )
  const pendingMine = detail.claims.filter(
    item =>
      item.status === 'pending' &&
      rights.leaveClaimIds.includes(item.id) &&
      !rights.decidableClaimIds.includes(item.id)
  )
  const decide = (item: VenueClaim, decision: 'approve' | 'reject'): void => {
    if (id == null) return
    run(
      async () => await client.decideVenueClaim(id, item.id, decision),
      `${item.leagueName}: ${decision === 'approve' ? 'approved' : item.kind === 'claim' ? 'rejected' : 'declined'}.`
    ).catch(() => undefined)
  }
  const changePhoto = (): void => {
    if (id == null) return
    pickPhoto().then(
      picture => {
        if (picture == null) return
        run(
          async () => await client.updateVenue(id, { photo: picture }),
          'Photo saved.'
        ).catch(() => undefined)
      },
      (failure: unknown) => {
        setError(
          failure instanceof Error
            ? failure.message
            : 'That photo could not be read.'
        )
      }
    )
  }
  return (
    <Screen>
      <View style={styles.page}>
        <Card style={styles.hero}>
          <PlacePhoto uri={detail.photoUrl} label={`${detail.name} photo`} />
          <Text accessibilityRole="header" style={styles.name}>
            {detail.name}
          </Text>
          {detail.address !== '' && (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Directions to ${detail.address}`}
              onPress={() => {
                openDirections(detail.address).catch(() => undefined)
              }}
            >
              <Text style={styles.address}>{detail.address}</Text>
            </Pressable>
          )}
          <View style={styles.pills}>
            {detail.owners.map(owner => (
              <Badge key={owner.claimId} label={owner.name} tone="win" />
            ))}
            {detail.owners.length === 0 &&
              detail.claims.some(item => item.status === 'pending') && (
                <Badge label="Claim pending" tone="honour" />
              )}
            {detail.owners.length === 0 &&
              !detail.claims.some(item => item.status === 'pending') && (
                <Badge label="Unclaimed" />
              )}
          </View>
          {rights.canEdit && (
            <Button
              label={detail.photoUrl == null ? 'Add photo' : 'Change photo'}
              kind="secondary"
              small
              disabled={busy}
              onPress={changePhoto}
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
        {(rights.canClaim || rights.canRequest) && (
          <View style={styles.section}>
            <Text style={styles.sentence}>
              {rights.canClaim
                ? 'Claim this venue for your league to set up its fields and schedule games on it. A site administrator is told, and the claim is approved after 7 days unless they decide sooner.'
                : 'Other leagues own this venue. Ask to co-own it: its owners or a site administrator decide, and the request is approved after 7 days otherwise.'}
            </Text>
            <Button
              label={rights.canClaim ? 'Claim' : 'Request to co-own'}
              busy={busy}
              onPress={() => {
                startClaim(rights.canClaim ? 'claim' : 'request')
              }}
            />
          </View>
        )}
        {rights.claimBlocked != null && (
          <Text style={styles.sentence}>{rights.claimBlocked}</Text>
        )}
        {decidable.length > 0 && (
          <View style={styles.section}>
            <SectionHeader title="Requests" note={String(decidable.length)} />
            <ActionList bounded>
              {decidable.map(item => (
                <ActionRow
                  key={item.id}
                  title={item.leagueName}
                  detail={`${item.kind === 'claim' ? 'Claim' : 'Request to co-own'} · ${approvalLabel(item.approvesAt)}`}
                  end={
                    <View style={styles.decisions}>
                      <Button
                        label="Approve"
                        kind="text"
                        small
                        textColor={theme.successColor}
                        accessibilityLabel={`Approve ${item.leagueName}`}
                        disabled={busy}
                        onPress={() => {
                          decide(item, 'approve')
                        }}
                      />
                      <DangerText
                        label="Decline"
                        accessibilityLabel={`Decline ${item.leagueName}`}
                        disabled={busy}
                        onPress={() => {
                          decide(item, 'reject')
                        }}
                      />
                    </View>
                  }
                />
              ))}
            </ActionList>
          </View>
        )}
        {(detail.owners.length > 0 || pendingMine.length > 0) && id != null && (
          <View style={styles.section}>
            <SectionHeader
              title="Owners"
              note={
                pendingMine.length === 0
                  ? String(detail.owners.length)
                  : `${detail.owners.length} · ${pendingMine.length} pending`
              }
            />
            <ActionList bounded>
              {[
                ...detail.owners.map(owner => ({
                  claimId: owner.claimId,
                  name: owner.name,
                  detail: 'Owner'
                })),
                ...pendingMine.map(item => ({
                  claimId: item.id,
                  name: item.leagueName,
                  detail: `${item.kind === 'claim' ? 'Claim' : 'Request'} pending · ${approvalLabel(item.approvesAt)}`
                }))
              ].map(row => {
                const own = rights.leaveClaimIds.includes(row.claimId)
                const action = own
                  ? row.detail === 'Owner'
                    ? 'Leave'
                    : 'Withdraw'
                  : rights.canRemoveOwners
                    ? 'Remove'
                    : undefined
                return (
                  <ActionRow
                    key={row.claimId}
                    title={row.name}
                    detail={row.detail}
                    end={
                      action == null ? undefined : (
                        <DangerText
                          label={action}
                          accessibilityLabel={`${action} ${row.name}`}
                          disabled={busy || confirm.busy}
                          onPress={() => {
                            confirm.open({
                              title: `${action} ${row.name}?`,
                              detail:
                                action === 'Remove'
                                  ? `${row.name} will no longer own ${detail.name}. Its fields stay.`
                                  : `${row.name} will no longer own ${detail.name}. Its fields stay, and once no league owns it the venue is unclaimed.`,
                              label: action,
                              run: async current => {
                                const next = await client.endVenueClaim(
                                  id,
                                  row.claimId
                                )
                                if (current()) setDetail(next)
                              }
                            })
                          }}
                        />
                      )
                    }
                  />
                )
              })}
            </ActionList>
          </View>
        )}
        {id != null && (
          <View style={styles.section}>
            <SectionHeader
              title="Fields"
              note={String(detail.fields.length)}
              actions={
                // An empty venue's Add is the row below, so it is not twice.
                rights.canEdit && detail.fields.length > 0
                  ? [
                      {
                        label: 'Add',
                        accessibilityLabel: 'Add field',
                        onPress: () => {
                          setAddingField(true)
                        }
                      }
                    ]
                  : undefined
              }
            />
            {detail.fields.length === 0 ? (
              rights.canEdit ? (
                <ActionList bounded>
                  <ActionRow
                    title="Add field"
                    leading={<Emblem fallback="" icon="add" />}
                    onOpen={() => {
                      setAddingField(true)
                    }}
                    openLabel="Add field"
                  />
                </ActionList>
              ) : (
                <Text style={styles.sentence}>
                  No fields have been set up here yet.
                </Text>
              )
            ) : (
              <ActionList bounded>
                {detail.fields.map(field => (
                  <ActionRow
                    key={field.id}
                    title={field.name}
                    detail={sizesLabel(field.sizes)}
                    onOpen={() => {
                      onOpenField(id, field.id)
                    }}
                    openLabel={`Open ${field.name}`}
                    separateEndAction={rights.canEdit}
                    end={
                      rights.canEdit ? (
                        <DangerText
                          label="Delete"
                          accessibilityLabel={`Delete ${field.name}`}
                          disabled={busy || confirm.busy}
                          onPress={() => {
                            confirm.open({
                              title: `Delete ${field.name}?`,
                              detail:
                                'Games already booked on it stay, and upcoming ones show a warning.',
                              label: 'Delete',
                              run: async current => {
                                const next = await client.deleteField(
                                  id,
                                  field.id
                                )
                                if (current()) setDetail(next)
                              }
                            })
                          }}
                        />
                      ) : undefined
                    }
                  />
                ))}
              </ActionList>
            )}
          </View>
        )}
        {id != null && rights.canEdit && (
          <View style={styles.section}>
            <SectionHeader title="Venue settings" />
            <ListCard>
              <ActionRow
                title="Size switch time"
                detail={`${detail.sizeSwitchMinutes} minutes to change a field from one size to another`}
                onOpen={() => {
                  setSwitchTime(String(detail.sizeSwitchMinutes))
                }}
                openLabel="Change size switch time"
              />
            </ListCard>
            <Text style={styles.subhead}>Default hours</Text>
            <Text style={styles.sentence}>
              Fields use these hours unless they set their own.
            </Text>
            <WeeklyHoursEditor
              label="Default hours"
              value={detail.defaultHours.map(entry => ({ ...entry }))}
              disabled={busy}
              openDefault={VENUE_OPEN_DEFAULT}
              onChange={hours => {
                run(
                  async () =>
                    await client.updateVenue(id, { defaultHours: hours }),
                  'Hours saved.'
                ).catch(() => undefined)
              }}
            />
            <Text style={styles.subhead}>Default blackout days</Text>
            <Text style={styles.sentence}>
              Every field here is closed on these days.
            </Text>
            <BlackoutDatesEditor
              value={detail.defaultBlackouts}
              disabled={busy}
              onChange={dates => {
                run(
                  async () =>
                    await client.updateVenue(id, { defaultBlackouts: dates }),
                  'Blackout days saved.'
                ).catch(() => undefined)
              }}
            />
          </View>
        )}
        <View style={styles.section}>
          <SectionHeader title="Map" />
          <PinMap
            settings={{
              latitude: detail.map.latitude,
              longitude: detail.map.longitude,
              googleMapsApiKey: detail.map.googleMapsApiKey,
              editable: false
            }}
          />
        </View>
      </View>
      {confirm.sheet}
      {choosingLeague != null && (
        <ChoiceSheet
          title={choosingLeague === 'claim' ? 'Claim for' : 'Co-own for'}
          choices={rights.claimLeagues.map(league => ({
            label: league.name,
            onPress: () => {
              claim(league.id).catch(() => undefined)
            }
          }))}
          onClose={() => {
            setChoosingLeague(undefined)
          }}
        />
      )}
      {addingField && id != null && (
        <AddFieldSheet
          onCancel={() => {
            setAddingField(false)
          }}
          onAdd={async (name, sizes) => {
            const next = await run(
              async () => await client.createField(id, { name, sizes }),
              `${name} added.`
            )
            if (next != null) setAddingField(false)
          }}
        />
      )}
      {switchTime != null && id != null && (
        <PickerDialog
          onClose={() => {
            setSwitchTime(undefined)
          }}
        >
          <View style={styles.sheet}>
            <Text accessibilityRole="header" style={styles.subhead}>
              Size switch time
            </Text>
            <Text style={styles.sentence}>
              The minutes it takes to change a field here from one size to
              another. They are added to the time between two games of different
              sizes.
            </Text>
            <TextField
              label="Minutes"
              value={switchTime}
              onChangeText={setSwitchTime}
              keyboardType="number-pad"
              maxLength={3}
            />
            <Button
              label="Save"
              busy={busy}
              disabled={!/^\d{1,3}$/.test(switchTime)}
              onPress={() => {
                run(
                  async () =>
                    await client.updateVenue(id, {
                      sizeSwitchMinutes: Number(switchTime)
                    }),
                  'Size switch time saved.'
                ).then(
                  next => {
                    if (next != null) setSwitchTime(undefined)
                  },
                  () => undefined
                )
              }}
            />
            <CancelAction
              onPress={() => {
                setSwitchTime(undefined)
              }}
            />
          </View>
        </PickerDialog>
      )}
    </Screen>
  )
}

/** Names a new field and the sizes it can be set up in. */
function AddFieldSheet({
  onAdd,
  onCancel
}: {
  onAdd: (name: string, sizes: FieldSize[]) => Promise<void>
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [name, setName] = useState('')
  const [sizes, setSizes] = useState<FieldSize[]>([])
  const [saving, setSaving] = useState(false)
  return (
    <PickerDialog onClose={onCancel}>
      <View style={styles.sheet}>
        <Text accessibilityRole="header" style={styles.subhead}>
          Add field
        </Text>
        <TextField
          label="Field name"
          value={name}
          onChangeText={setName}
          placeholder="Field 1"
          maxLength={100}
          autoCapitalize="words"
        />
        <Text style={styles.sentence}>
          The sizes it can be set up in. Choose every one it can take.
        </Text>
        <ListCard>
          {FIELD_SIZES.map(size => (
            <CheckRow
              key={size}
              label={fieldSizeLabel(size)}
              checked={sizes.includes(size)}
              onToggle={() => {
                setSizes(current =>
                  current.includes(size)
                    ? current.filter(item => item !== size)
                    : FIELD_SIZES.filter(
                        item => item === size || current.includes(item)
                      )
                )
              }}
            />
          ))}
        </ListCard>
        <Button
          label="Add field"
          busy={saving}
          disabled={name.trim() === '' || sizes.length === 0}
          onPress={() => {
            setSaving(true)
            onAdd(name.trim(), sizes)
              .catch(() => undefined)
              .finally(() => {
                setSaving(false)
              })
          }}
        />
        <CancelAction onPress={onCancel} />
      </View>
    </PickerDialog>
  )
}

export const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingBottom: theme.rem(6) },
  hero: { gap: theme.rem(0.5) },
  name: {
    fontFamily: theme.primaryTextFont,
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor
  },
  address: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.linkTextColor
  },
  pills: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: theme.rem(0.375)
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
  decisions: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.5)
  },
  sheet: { gap: theme.rem(1) }
}))
