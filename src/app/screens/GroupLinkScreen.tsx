import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { ParentAction, ParentPreview } from '../../common/groupLinks'
import { localityLabel } from '../../common/locality'
import type { PublicGroup } from '../../common/publicGroups'
import { formatDateRange } from '../../common/seasonTimeFrames'
import { Button, Card, Screen, TextField } from '../components'
import { CancelAction } from '../components/CancelAction'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { GroupLinkChoice } from './GroupScreen'

export function GroupLinkScreen({
  client,
  choice,
  onSent,
  onCancel
}: {
  client: TeamStationClient
  choice: GroupLinkChoice
  onSent: (id: string) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<PublicGroup[]>([])
  const [selected, setSelected] = useState<PublicGroup | undefined>()
  const [preview, setPreview] = useState<ParentPreview | undefined>()
  const [both, setBoth] = useState(false)
  const [mayBoth, setMayBoth] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [actions, setActions] = useState<ParentAction[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [batchStep, setBatchStep] = useState<'child' | 'parent'>()
  const [operation, setOperation] = useState<'attach' | 'detach'>('attach')
  const [childKind, setChildKind] = useState<'team' | 'season'>('team')
  const [parentKind, setParentKind] = useState<'league' | 'season'>('league')
  const [batchChild, setBatchChild] = useState<PublicGroup>()
  const lookupKind =
    batchStep === 'child'
      ? childKind
      : batchStep === 'parent'
        ? parentKind
        : choice.targetKind
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined)
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      const load =
        query.trim() === ''
          ? client.ownGroups()
          : client.discoverGroups(lookupKind, query)
      load.then(
        groups => {
          if (active) {
            setCandidates(
              groups.filter(
                group =>
                  group.kind === lookupKind &&
                  (batchStep != null || group.id !== choice.subject.id) &&
                  !group.external
              )
            )
            setError('')
          }
        },
        (error: unknown) => {
          if (active)
            setError(
              error instanceof Error
                ? error.message
                : 'Candidates could not load. Retry.'
            )
        }
      )
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client, choice.subject.id, lookupKind, batchStep, query, retry])
  const review = async (changes: ParentAction[]): Promise<void> => {
    setPreview(undefined)
    setBoth(false)
    setError('')
    const ordered = [
      ...changes.filter(change => change.operation === 'detach'),
      ...changes.filter(change => change.operation === 'attach')
    ]
    const next = await client.parentPreview(ordered)
    const refs = [
      ...new Map(
        next.effects
          .flatMap(effect => [effect.child, effect.parent])
          .map(ref => [`${ref.kind}:${ref.id}`, ref])
      ).values()
    ]
    const details = await Promise.all(
      refs.map(async ref => await client.group(ref))
    )
    setLabels(previous => ({
      ...previous,
      ...Object.fromEntries(
        details.map(detail => [
          `${detail.group.kind}:${detail.group.id}`,
          detail.group.name
        ])
      )
    }))
    setMayBoth(details.every(detail => detail.canManage))
    setPreview(next)
  }
  const select = async (group: PublicGroup): Promise<void> => {
    setBusy(true)
    setError('')
    setBoth(false)
    setSelected(group)
    setLabels(previous => ({
      ...previous,
      [`${group.kind}:${group.id}`]: group.name
    }))
    try {
      const subject = await client.group(choice.subject)
      setLabels(previous => ({
        ...previous,
        [`${choice.subject.kind}:${choice.subject.id}`]: subject.group.name
      }))
      const detail = await client.group({ kind: group.kind, id: group.id })
      setMayBoth(detail.canManage)
      if (choice.relationship === 'parent') {
        const actions: ParentAction[] = [
          {
            operation: 'attach',
            child:
              choice.direction === 'children'
                ? { kind: group.kind, id: group.id }
                : choice.subject,
            parent:
              choice.direction === 'children'
                ? choice.subject
                : { kind: group.kind, id: group.id }
          }
        ]
        setActions(actions)
        await review(actions)
      }
      setSelected(group)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'These groups could not be linked. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  const send = async (): Promise<void> => {
    if (
      selected == null ||
      busy ||
      (choice.relationship === 'parent' && preview == null)
    )
      return
    setBusy(true)
    setError('')
    const terms =
      choice.relationship === 'parent'
        ? {
            kind: 'parent' as const,
            actions: preview!.actions,
            expected: preview!.expected
          }
        : {
            kind: 'participation' as const,
            seasonId:
              choice.subject.kind === 'season'
                ? choice.subject.id
                : selected.id,
            teamId:
              choice.subject.kind === 'team' ? choice.subject.id : selected.id
          }
    const fields = { ...terms, sender: choice.subject, confirmBoth: both }
    const serialized = JSON.stringify(fields)
    if (attempt.current?.body !== serialized)
      attempt.current = {
        body: serialized,
        key: `link-${Date.now()}-${Math.random().toString(36).slice(2)}`
      }
    try {
      const request = await client.inviteRelationship({
        ...fields,
        idempotencyKey: attempt.current.key
      })
      onSent(request.id)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'The invitation could not be sent. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Screen>
      <View style={styles.page}>
        <Text style={styles.title}>
          {choice.relationship === 'parent'
            ? 'Add a management relationship'
            : 'Join a season'}
        </Text>
        <Text style={styles.hint}>
          {choice.relationship === 'parent'
            ? 'Parent relationships share roles and permissions. Competition memberships and games stay unchanged.'
            : 'Season participation puts the team in the competition. It does not grant permissions on the team or change its parents.'}
        </Text>
        {batchStep != null ? (
          <Card style={styles.card}>
            <Text style={styles.name}>Add an explicit parent change</Text>
            <Button
              label={
                operation === 'attach'
                  ? 'Attach parent selected'
                  : 'Attach parent'
              }
              kind="secondary"
              onPress={() => {
                setOperation('attach')
              }}
            />
            <Button
              label={
                operation === 'detach'
                  ? 'Remove parent selected'
                  : 'Remove parent'
              }
              kind="secondary"
              onPress={() => {
                setOperation('detach')
              }}
            />
            {batchStep === 'child' ? (
              <>
                <Text style={styles.hint}>Choose the child group.</Text>
                <Button
                  label="Find a team"
                  kind="secondary"
                  onPress={() => {
                    setChildKind('team')
                    setQuery('')
                  }}
                />
                <Button
                  label="Find a season"
                  kind="secondary"
                  onPress={() => {
                    setChildKind('season')
                    setQuery('')
                  }}
                />
              </>
            ) : (
              <>
                <Text style={styles.hint}>
                  Choose the parent for {batchChild?.name}.
                </Text>
                <Button
                  label="Find a league parent"
                  kind="secondary"
                  onPress={() => {
                    setParentKind('league')
                    setQuery('')
                  }}
                />
                {batchChild?.kind === 'team' && (
                  <Button
                    label="Find a season parent"
                    kind="secondary"
                    onPress={() => {
                      setParentKind('season')
                      setQuery('')
                    }}
                  />
                )}
              </>
            )}
            <TextField
              label="Search additional group"
              value={query}
              onChangeText={setQuery}
              placeholder="Name or city"
            />
            {candidates.map(group => (
              <Button
                key={group.id}
                label={`Choose change ${group.name}`}
                kind="secondary"
                onPress={() => {
                  setLabels(previous => ({
                    ...previous,
                    [`${group.kind}:${group.id}`]: group.name
                  }))
                  if (batchStep === 'child') {
                    setBatchChild(group)
                    setParentKind('league')
                    setBatchStep('parent')
                    setQuery('')
                  } else if (batchChild != null) {
                    setActions(previous => [
                      ...previous,
                      {
                        operation,
                        child: { kind: batchChild.kind, id: batchChild.id },
                        parent: { kind: group.kind, id: group.id }
                      }
                    ])
                    setPreview(undefined)
                    setBoth(false)
                    setBatchStep(undefined)
                    setQuery('')
                  }
                }}
              />
            ))}
            <Button
              label="Cancel additional change"
              kind="secondary"
              onPress={() => {
                setBatchStep(undefined)
                setQuery('')
              }}
            />
          </Card>
        ) : selected == null ? (
          <>
            <TextField
              label="Search by name or city"
              value={query}
              onChangeText={setQuery}
            />
            <Text style={styles.hint}>
              {query === ''
                ? 'Your groups are shown first. Search to invite a group managed by someone else.'
                : 'Choose the group to invite.'}
            </Text>
            {candidates.map(group => (
              <Pressable
                key={group.id}
                accessibilityRole="button"
                accessibilityLabel={`Choose ${group.name}${candidates.filter(candidate => candidate.name === group.name).length < 2 ? '' : ', ' + (group.locality == null ? 'Location not set' : localityLabel(group.locality))}`}
                disabled={busy}
                onPress={() => {
                  select(group).catch(() => undefined)
                }}
              >
                <Card style={styles.card}>
                  <Text style={styles.name}>{group.name}</Text>
                  <Text style={styles.hint}>
                    {group.kind === 'season'
                      ? formatDateRange(group.startsOn, group.endsOn)
                      : group.locality == null
                        ? 'Location not set'
                        : localityLabel(group.locality)}
                  </Text>
                  {group.parentNames.length > 0 && (
                    <Text style={styles.hint}>
                      Parents: {group.parentNames.join(', ')}
                    </Text>
                  )}
                </Card>
              </Pressable>
            ))}
            <Button
              label="Retry candidates"
              kind="secondary"
              onPress={() => {
                setRetry(retry + 1)
              }}
            />
          </>
        ) : (
          <Card style={styles.card}>
            <Text style={styles.name}>{selected.name}</Text>
            {selected.parentNames.length > 0 && (
              <Text style={styles.hint}>
                Current parents: {selected.parentNames.join(', ')}
              </Text>
            )}
            {preview?.explanation.map((line, index) => (
              <Text key={index} style={styles.hint}>
                {line}
              </Text>
            ))}
            {choice.relationship === 'parent' && (
              <>
                <Text style={styles.hint}>
                  Review every change together. Removals are applied before
                  additions. Each added parent and child must approve this exact
                  batch. Either endpoint may approve a parent removal.
                </Text>
                {actions.map((action, index) => (
                  <View key={index}>
                    <Text style={styles.hint}>
                      {action.operation === 'attach' ? 'Add' : 'Remove'}{' '}
                      {labels[`${action.parent.kind}:${action.parent.id}`] ??
                        action.parent.kind}{' '}
                      as parent of{' '}
                      {labels[`${action.child.kind}:${action.child.id}`] ??
                        action.child.kind}
                    </Text>
                    <Button
                      label={`Remove change ${index + 1}`}
                      kind="secondary"
                      disabled={busy}
                      onPress={() => {
                        setActions(previous =>
                          previous.filter((_, row) => row !== index)
                        )
                        setPreview(undefined)
                        setBoth(false)
                      }}
                    />
                  </View>
                ))}
                <Button
                  label="Add another parent change"
                  kind="secondary"
                  disabled={busy}
                  onPress={() => {
                    setBatchStep('child')
                    setBatchChild(undefined)
                    setQuery('')
                  }}
                />
                <Button
                  label="Review all parent changes"
                  kind="secondary"
                  disabled={busy || actions.length === 0}
                  onPress={() => {
                    setBusy(true)
                    review(actions)
                      .catch((error: unknown) => {
                        setError(
                          error instanceof Error
                            ? error.message
                            : 'These changes are incompatible. Adjust the batch and review again.'
                        )
                      })
                      .finally(() => {
                        setBusy(false)
                      })
                  }}
                />
              </>
            )}
            <Text style={styles.hint}>
              Sending approves for the group you represent. Each other affected
              group has seven days to answer.
            </Text>
            {mayBoth &&
              (choice.relationship !== 'parent' || preview != null) && (
                <Button
                  label={
                    both
                      ? 'All affected groups approved by me ✓'
                      : 'I approve for all affected groups'
                  }
                  kind={both ? 'primary' : 'secondary'}
                  onPress={() => {
                    setBoth(!both)
                  }}
                />
              )}
            <Button
              label={both ? 'Confirm relationship' : 'Send invitation'}
              busy={busy}
              disabled={choice.relationship === 'parent' && preview == null}
              onPress={() => {
                send().catch(() => undefined)
              }}
            />
            <Button
              label="Choose another group"
              kind="secondary"
              disabled={busy}
              onPress={() => {
                setSelected(undefined)
                setPreview(undefined)
                setBoth(false)
              }}
            />
          </Card>
        )}
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <CancelAction label="Cancel" disabled={busy} onPress={onCancel} />
      </View>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  name: {
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor },
  card: { gap: theme.rem(0.75) }
}))
