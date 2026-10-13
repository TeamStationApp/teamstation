import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type {
  GroupKind,
  GroupPicture,
  GroupRef
} from '../../common/groupCreation'
import type { ParentAction } from '../../common/groupLinks'
import type { Locality } from '../../common/locality'
import type { PublicGroup } from '../../common/publicGroups'
import {
  formatDateRange,
  seasonTimeFrames
} from '../../common/seasonTimeFrames'
import { Button, Card, ListCard, Screen, TextField } from '../components'
import { DateRangePicker } from '../components/DateRangePicker'
import { GroupPictureChooser } from '../components/GroupPictureChooser'
import { LocationRow } from '../components/LocationRow'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { LocationScreen } from './LocationScreen'
import { type ParentChoice, ParentChooser } from './ParentChooser'

export interface CreateGroupScreenProps {
  client: TeamStationClient
  kind: GroupKind
  parent?: GroupRef
  custodian?: GroupRef
  initialLocality?: Locality
  onCreated: (group: GroupRef) => void
  onCancel: () => void
}

export function CreateGroupScreen({
  client,
  kind,
  parent,
  custodian,
  initialLocality,
  onCreated,
  onCancel
}: CreateGroupScreenProps): React.ReactElement {
  const styles = getStyles(useTheme())
  // Created from Home, with no parent given, a team or season can still be
  // taken in by the leagues and seasons its creator administers: those are
  // offered as the last step, when there are any.
  const asksParents = kind !== 'league' && parent == null && custodian == null
  const [administered, setAdministered] = useState<PublicGroup[]>([])
  useEffect(() => {
    if (!asksParents) return
    let active = true
    client.ownGroups('admin').then(
      groups => {
        if (active) setAdministered(groups)
      },
      // Without the list the group is simply created without a parent.
      () => undefined
    )
    return () => {
      active = false
    }
  }, [asksParents, client])
  const adminLeagues = administered.filter(group => group.kind === 'league')
  const adminSeasons =
    kind === 'team' ? administered.filter(group => group.kind === 'season') : []
  const [parents, setParents] = useState<ParentChoice>({ seasonIds: [] })
  const steps = [
    ...(kind === 'league'
      ? ['name', 'location', 'photo']
      : kind === 'season'
        ? ['name', 'range', 'photo']
        : ['name', 'location', 'photo']),
    ...(asksParents && adminLeagues.length + adminSeasons.length > 0
      ? ['parents']
      : [])
  ]
  const [position, setPosition] = useState(0)
  const step = steps[position]
  const [name, setName] = useState('')
  const [locality, setLocality] = useState<Locality | undefined>(
    initialLocality
  )
  const [locationOpen, setLocationOpen] = useState(false)
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone
  )
  const [contextPending, setContextPending] = useState(
    parent != null || custodian != null
  )
  const [contextError, setContextError] = useState('')
  const [contextRetry, setContextRetry] = useState(0)
  const context = useMemo(() => parent ?? custodian, [parent, custodian])
  useEffect(() => {
    let active = true
    if (context == null) {
      setContextPending(false)
      return
    }
    setContextPending(true)
    client
      .group(context)
      .then(
        detail => {
          if (!active) return
          const inherited =
            detail.group.locality ??
            detail.parents.find(group => group.kind === 'league')?.locality ??
            undefined
          if (kind === 'team' && inherited != null)
            setLocality(value => value ?? inherited)
          if (kind === 'season' && inherited?.timezone != null)
            setTimezone(inherited.timezone)
          setContextError('')
        },
        (error: unknown) => {
          if (active)
            setContextError(
              error instanceof Error
                ? error.message
                : 'Parent details could not load. Retry.'
            )
        }
      )
      .finally(() => {
        if (active) setContextPending(false)
      })
    return () => {
      active = false
    }
  }, [client, context, kind, contextRetry])
  const [picture, setPicture] = useState<GroupPicture | undefined>()
  const [range, setRange] = useState<
    { startsOn: string; endsOn: string } | undefined
  >()
  const [custom, setCustom] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const submitted = useRef<{ body: string; key: string } | undefined>(undefined)
  const [presets] = useState(() => seasonTimeFrames())
  const valid =
    step === 'name'
      ? name.trim().length > 0 && name.trim().length <= 120
      : step === 'location'
        ? locality != null
        : step === 'photo'
          ? picture != null
          : step === 'parents'
            ? true
            : range != null
  const save = async (): Promise<void> => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    // The first season chosen is the parent the group is created under (its
    // league follows from it); every other choice is linked straight after.
    const chosenParent: GroupRef | undefined =
      parent ??
      (parents.seasonIds[0] != null
        ? { kind: 'season', id: parents.seasonIds[0] }
        : parents.leagueId != null
          ? { kind: 'league', id: parents.leagueId }
          : undefined)
    const fields = {
      kind,
      name,
      locality,
      parent: chosenParent,
      picture,
      startsOn: range?.startsOn,
      endsOn: range?.endsOn,
      timezone,
      ...(custodian == null ? {} : { external: true, custodian })
    }
    const serialized = JSON.stringify(fields)
    if (submitted.current?.body !== serialized)
      submitted.current = {
        body: serialized,
        key: `create-${Date.now()}-${Math.random().toString(36).slice(2)}`
      }
    try {
      const created = await client.createGroup({
        ...fields,
        idempotencyKey: submitted.current.key
      })
      const more: ParentAction[] = parents.seasonIds.slice(1).map(id => ({
        operation: 'attach',
        child: { kind, id: created.id },
        parent: { kind: 'season', id }
      }))
      if (more.length > 0)
        try {
          await client.changeParents(await client.parentPreview(more))
        } catch (error) {
          throw new Error(
            `${name.trim()} was created, but not every season could take it in: ${error instanceof Error ? error.message : 'retry'}. Retry to add the rest.`
          )
        }
      onCreated({ kind, id: created.id })
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'The group could not be created. Retry.'
      )
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const advance = (): void => {
    setError('')
    if (position === steps.length - 1) save().catch(() => undefined)
    else setPosition(position + 1)
  }
  const title =
    step === 'parents'
      ? kind === 'season'
        ? 'Add Season to League'
        : 'Add Team to Season or League'
      : `Create ${custodian == null ? '' : 'Placeholder '}${kind[0].toUpperCase()}${kind.slice(1)}`
  return (
    <Screen>
      <Card style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        {step === 'name' && (
          <>
            <TextField
              label={
                kind === 'season'
                  ? 'Season name'
                  : kind === 'team'
                    ? 'Team name'
                    : 'League name'
              }
              value={name}
              onChangeText={setName}
              placeholder={
                kind === 'league'
                  ? 'North Park Little League, Springfield Little League, or San Diego Blazers'
                  : kind === 'season'
                    ? '2027 Spring Season or Labor Day Classic'
                    : 'Hawks'
              }
            />
            {kind === 'league' && (
              <Text style={styles.hint}>
                Use the name of the organization that organizes seasons and
                teams on a recurring basis. This name should not represent a
                time period for a schedule.
              </Text>
            )}
          </>
        )}
        {step === 'location' && (
          <>
            <Text style={styles.hint}>
              Choose this {kind}’s city and state.
            </Text>
            <ListCard>
              <LocationRow
                value={locality ?? null}
                onPress={() => {
                  setLocationOpen(true)
                }}
              />
            </ListCard>
            {locationOpen && (
              <Modal
                visible
                animationType="slide"
                presentationStyle="fullScreen"
                onRequestClose={() => {
                  setLocationOpen(false)
                }}
              >
                <LocationScreen
                  client={client}
                  current={locality ?? null}
                  onSave={async value => {
                    setLocality(value)
                    setLocationOpen(false)
                  }}
                  onCancel={() => {
                    setLocationOpen(false)
                  }}
                />
              </Modal>
            )}
          </>
        )}
        {step === 'photo' && (
          <GroupPictureChooser
            client={client}
            name={name}
            value={picture}
            onChange={setPicture}
          />
        )}
        {step === 'parents' && (
          <ParentChooser
            kind={kind === 'season' ? 'season' : 'team'}
            leagues={adminLeagues}
            seasons={adminSeasons}
            choice={parents}
            onChange={setParents}
          />
        )}
        {step === 'range' &&
          (custom ? (
            <DateRangePicker
              initial={range}
              onChoose={selected => {
                setRange(selected)
                setCustom(false)
              }}
              onCancel={() => {
                setCustom(false)
              }}
            />
          ) : (
            <View style={styles.options}>
              <Text style={styles.hint}>
                Choose a reference time frame. Games can still be scheduled
                outside it.
              </Text>
              {presets.map(preset => (
                <Button
                  key={preset.label}
                  label={preset.label}
                  kind={
                    range?.startsOn === preset.startsOn &&
                    range?.endsOn === preset.endsOn
                      ? 'primary'
                      : 'secondary'
                  }
                  onPress={() => {
                    setRange({
                      startsOn: preset.startsOn,
                      endsOn: preset.endsOn
                    })
                  }}
                />
              ))}
              <Button
                label="Custom time frame"
                kind="secondary"
                onPress={() => {
                  setCustom(true)
                }}
              />
              {range != null && (
                <Text style={styles.hint}>
                  {formatDateRange(range.startsOn, range.endsOn)}
                </Text>
              )}
            </View>
          ))}
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {!custom && (
          <>
            {contextPending && (
              <Text style={styles.hint}>Loading parent details…</Text>
            )}
            {contextError !== '' && (
              <>
                <Text accessibilityRole="alert" style={styles.error}>
                  {contextError}
                </Text>
                <Button
                  label="Retry parent details"
                  kind="secondary"
                  onPress={() => {
                    setContextRetry(value => value + 1)
                  }}
                />
              </>
            )}
            <Button
              label={
                position === steps.length - 1
                  ? `Create ${kind[0].toUpperCase()}${kind.slice(1)}`
                  : 'Continue'
              }
              disabled={!valid || contextPending || contextError !== ''}
              busy={busy}
              onPress={advance}
            />
            <Button
              label={position === 0 ? 'Cancel' : 'Previous step'}
              kind="secondary"
              disabled={busy}
              onPress={() => {
                setError('')
                position === 0 ? onCancel() : setPosition(position - 1)
              }}
            />
          </>
        )}
      </Card>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: { gap: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  options: { gap: theme.rem(0.75) },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor }
}))
