import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { ManagePage, TeamStationClient } from '../../common/api'
import { ROLE_FLAGS, type RoleFlag } from '../../common/roles'
import {
  adminLabel,
  Button,
  Card,
  flagLabel,
  InvitePanel,
  RolesModal,
  SectionHeader,
  TextField
} from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { calendarDate } from './format'

export interface GroupPeopleSettingsProps {
  client: TeamStationClient
  scopeKind: 'league' | 'season' | 'team'
  scopeId: string
  /** Opens an invitation that was sent, in the inbox. */
  onOpenRequest?: (id: string) => void
  onChanged?: () => void
}

/**
 * The people half of a team's, season's or league's Settings, for its
 * administrators: adding somebody by address, the invitations still waiting
 * for an address nobody has verified, the people with no address on file,
 * and the invite links.
 *
 * Everybody else on the level is managed from its people list, through their
 * profile. Accounts with no address are kept here because nobody can sign in
 * to them: they hold no role, so the one thing to do with one is take it out
 * of the level.
 */
export function GroupPeopleSettings(
  props: GroupPeopleSettingsProps
): React.ReactElement {
  const { client, scopeKind, scopeId, onOpenRequest, onChanged } = props
  const styles = getStyles(useTheme())
  const [page, setPage] = useState<ManagePage | undefined>()
  const [email, setEmail] = useState('')
  const [roles, setRoles] = useState<{ admin: boolean; flags: RoleFlag[] }>({
    admin: false,
    flags: []
  })
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [sentRequest, setSentRequest] = useState<string | undefined>()
  const key = useRef<{ body: string; key: string } | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    setPage(await client.managePage(scopeKind, scopeId))
  }, [client, scopeId, scopeKind])
  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  const run = (work: () => Promise<void>): void => {
    setBusy(true)
    setError(undefined)
    work()
      .then(async () => {
        onChanged?.()
        await load()
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error ? caught.message : 'Something went wrong'
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const add = (): void => {
    const wanted = email.trim()
    run(async () => {
      const body = JSON.stringify({ email: wanted.toLowerCase(), ...roles })
      if (key.current?.body !== body)
        key.current = {
          body,
          key: `person-${Date.now()}-${Math.random().toString(36).slice(2)}`
        }
      const answer = await client.addPerson(scopeKind, scopeId, wanted, {
        ...roles,
        idempotencyKey: key.current.key
      })
      setSentRequest(answer.invited?.requestId)
      setNote(
        answer.added
          ? sprintf(lstrings.manage_added, answer.person?.displayName ?? wanted)
          : answer.invited != null
            ? sprintf(lstrings.manage_invited, wanted)
            : sprintf(lstrings.manage_already, wanted)
      )
      setEmail('')
    })
  }

  if (page == null) return <View />
  const withoutAddress = page.people.filter(
    person => person.emails.length === 0
  )
  return (
    <View style={styles.page}>
      <View style={styles.section}>
        <SectionHeader title={lstrings.manage_add} />
        <Card style={styles.card}>
          <Text style={styles.detail}>
            {sprintf(lstrings.manage_add_detail, page.scope.name)}
          </Text>
          <TextField
            label={lstrings.manage_email}
            value={email}
            onChangeText={setEmail}
            placeholder="parent@example.com"
            keyboardType="email-address"
            autoComplete="email"
            onSubmitEditing={add}
          />
          <Button
            label={lstrings.manage_add_submit}
            busy={busy}
            disabled={!email.includes('@')}
            onPress={add}
          />
          <Button
            label={lstrings.manage_choose_roles}
            kind="secondary"
            onPress={() => {
              setChoosing(true)
            }}
          />
          <Text style={styles.detail}>
            {sprintf(
              lstrings.manage_add_as,
              roles.admin
                ? adminLabel(scopeKind)
                : roles.flags.length === 0
                  ? lstrings.profile_member
                  : roles.flags.map(flagLabel).join(', ')
            )}
          </Text>
          {note != null && <Text style={styles.detail}>{note}</Text>}
          {error != null && (
            <Text accessibilityRole="alert" style={styles.warning}>
              {error}
            </Text>
          )}
          {sentRequest != null && onOpenRequest != null && (
            <Button
              label={lstrings.manage_open_sent}
              kind="secondary"
              onPress={() => {
                onOpenRequest(sentRequest)
              }}
            />
          )}
        </Card>
      </View>

      {page.pending.length > 0 && (
        <View style={styles.section}>
          <SectionHeader
            title={lstrings.manage_pending_header}
            note={String(page.pending.length)}
          />
          <Card style={styles.card}>
            {page.pending.map(pending => (
              <View key={pending.inviteId} style={styles.row}>
                <View style={styles.who}>
                  <Text style={styles.name}>{pending.email}</Text>
                  <Text style={styles.detail}>
                    {sprintf(
                      lstrings.manage_invited_on,
                      calendarDate(pending.invitedAt)
                    )}
                  </Text>
                </View>
                {pending.requestId != null && onOpenRequest != null && (
                  <Button
                    compact
                    kind="text"
                    label={lstrings.manage_open_invitation}
                    onPress={() => {
                      onOpenRequest(pending.requestId!)
                    }}
                  />
                )}
              </View>
            ))}
          </Card>
        </View>
      )}

      {withoutAddress.length > 0 && (
        <View style={styles.section}>
          <SectionHeader
            title={lstrings.manage_no_address_header}
            note={String(withoutAddress.length)}
          />
          <Card style={styles.card}>
            <Text style={styles.detail}>
              {lstrings.manage_no_address_detail}
            </Text>
            {withoutAddress.map(person => {
              const here = (
                scopeKind === 'team'
                  ? person.teams
                  : scopeKind === 'season'
                    ? person.seasons
                    : person.leagues
              ).some(grant => grant.id === scopeId)
              return (
                <View key={person.userId} style={styles.row}>
                  <Text style={[styles.name, styles.who]}>
                    {person.displayName}
                  </Text>
                  {here && (
                    <Button
                      compact
                      kind="text"
                      label={lstrings.manage_remove}
                      accessibilityLabel={`${lstrings.manage_remove} ${person.displayName}`}
                      disabled={busy}
                      onPress={() => {
                        run(async () => {
                          await client.removePerson(
                            scopeKind,
                            scopeId,
                            person.userId
                          )
                        })
                      }}
                    />
                  )}
                </View>
              )
            })}
          </Card>
        </View>
      )}

      <InvitePanel
        client={client}
        scopeType={scopeKind}
        scopeId={scopeId}
        scopeName={page.scope.name}
      />

      {choosing && (
        <RolesModal
          displayName={email.trim() === '' ? lstrings.manage_new_person : email}
          scopeKind={scopeKind}
          scopeName={page.scope.name}
          held={[
            ...(roles.admin ? ['admin' as const] : []),
            ...ROLE_FLAGS.filter(flag => roles.flags.includes(flag))
          ]}
          onClose={() => {
            setChoosing(false)
          }}
          onSave={chosen => {
            setRoles(chosen)
            setChoosing(false)
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1.25) },
  section: { gap: theme.rem(theme.spaceMdRem) },
  card: { gap: theme.rem(theme.spaceMdRem) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  who: { flex: 1, gap: theme.rem(theme.spaceXsRem) },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  warning: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.warningColor
  }
}))
