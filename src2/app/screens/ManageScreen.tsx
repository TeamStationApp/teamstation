import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'

import type {
  GameStationClient,
  ManagePage,
  ScopePerson
} from '../../common/api'
import {
  adminLabel,
  Button,
  Card,
  InvitePanel,
  RoleModal,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { calendarDate } from './format'

export interface ManageScreenProps {
  client: GameStationClient
  scopeKind: 'league' | 'season' | 'team'
  scopeId: string
  /** Who is looking, so the page does not offer to lock them out. */
  meUserId?: string
  /** Tells the shell what this page is called, once it knows. */
  onTitle?: (title: string) => void
}

/**
 * The page behind the gear.
 *
 * Its centre is the table of people, and the reason it is a table rather than
 * a list is the question it exists to answer: not *who* can see this — that is
 * the easy half — but *how*. Access arrives at three heights, a person often
 * holds two at once, and an administrator who removes the one they can see
 * and finds nothing has changed will conclude the software is lying to them.
 * So every grant gets a tick in the column it came from, and the role box
 * beside it says the same thing in words.
 *
 * What can be changed is only ever what this administrator administers. A
 * team's manager sees the season membership that lets a parent watch and
 * cannot remove it, because it is not theirs and taking it away would drop
 * that parent from four other teams as well — and for the same reason the
 * role a team's page hands out is "team admin" and never anything wider.
 *
 * Accounts with no address are kept in their own group at the bottom.
 * Nobody can sign in to them, so they are a roster rather than a list of
 * people to administer, and they would otherwise be nine rows in ten. The
 * header says what they are and stops there: where a row came from is this
 * system's business and not something to explain on every screen.
 */
export function ManageScreen(props: ManageScreenProps): React.ReactElement {
  const { client, scopeKind, scopeId, meUserId, onTitle } = props
  const styles = getStyles(useTheme())

  const [page, setPage] = useState<ManagePage | undefined>(undefined)
  const [refused, setRefused] = useState(false)
  const [email, setEmail] = useState('')
  const [filter, setFilter] = useState('')
  const [changing, setChanging] = useState<ScopePerson | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    const answer = await client.managePage(scopeKind, scopeId)
    setPage(answer)
    onTitle?.(answer.scope.name)
  }, [client, onTitle, scopeId, scopeKind])

  useEffect(() => {
    load().catch(() => {
      setRefused(true)
    })
  }, [load])

  const run = (work: () => Promise<void>): void => {
    setBusy(true)
    setError(undefined)
    work()
      .then(async () => {
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
      const answer = await client.addPerson(scopeKind, scopeId, wanted)
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

  const people = page?.people ?? []
  const shown = useMemo(() => {
    const wanted = filter.trim().toLowerCase()
    if (wanted === '') return people
    return people.filter(
      person =>
        person.displayName.toLowerCase().includes(wanted) ||
        person.emails.some(address => address.toLowerCase().includes(wanted))
    )
  }, [filter, people])

  // Two groups, not one sort: an account nobody can sign in to is a different
  // kind of row, and a header says so once rather than every line repeating
  // "no address on file" halfway down a list of real people.
  const withAddress = shown.filter(person => person.emails.length > 0)
  const withoutAddress = shown.filter(person => person.emails.length === 0)

  if (refused) {
    return (
      <Screen>
        <Card>
          <Text style={styles.muted}>{lstrings.manage_refused}</Text>
        </Card>
      </Screen>
    )
  }

  if (page == null) {
    return (
      <Screen>
        <Card>
          <Text style={styles.muted}>{lstrings.common_loading}</Text>
        </Card>
      </Screen>
    )
  }

  const { tree } = page
  /** A column is drawn only where this scope's tree has any of that level. */
  const columns: Array<'team' | 'season' | 'league'> = [
    ...(tree.teams.length > 0 ? (['team'] as const) : []),
    ...(tree.seasons.length > 0 ? (['season'] as const) : []),
    ...(tree.leagues.length > 0 ? (['league'] as const) : [])
  ]

  const rowProps = {
    columns,
    scopeKind,
    busy,
    onRemove: (person: ScopePerson) => {
      run(async () => {
        await client.removePerson(scopeKind, scopeId, person.userId)
      })
    },
    onChangeRole: (person: ScopePerson) => {
      setChanging(person)
    }
  }

  return (
    <Screen>
      <View style={styles.section}>
        <SectionHeader
          title={lstrings.manage_people}
          note={
            shown.length === people.length
              ? String(people.length)
              : `${shown.length} of ${people.length}`
          }
        />
        <Card style={styles.card}>
          <Text style={styles.detail}>{lstrings.manage_people_detail}</Text>
          <TextField
            label={lstrings.manage_filter}
            value={filter}
            onChangeText={setFilter}
            placeholder={lstrings.manage_filter_placeholder}
          />
        </Card>

        {/*
          The table is its own block and scrolls sideways. Nine columns do not
          fit a phone, and squeezing them until they do turns a date into two
          characters and a name into an ellipsis: better to keep every column
          its own width and let the table move under the finger.
        */}
        <Card flush>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator
            // The content fills the card when it fits and scrolls when it
            // does not, rather than sitting at its minimum width and leaving
            // the last column half off the edge of a desktop.
            contentContainerStyle={styles.tableScroll}
          >
            <View style={styles.table}>
              <View style={[styles.row, styles.head]}>
                <Text style={[styles.who, styles.headText]}>
                  {lstrings.manage_person}
                </Text>
                <Text style={[styles.roleBox, styles.headText]}>
                  {lstrings.manage_role}
                </Text>
                {columns.map(column => (
                  <Text key={column} style={[styles.cell, styles.headText]}>
                    {labelFor(column)}
                  </Text>
                ))}
                <Text style={[styles.when, styles.headText]}>
                  {lstrings.manage_created}
                </Text>
                <Text style={[styles.when, styles.headText]}>
                  {lstrings.manage_last_login}
                </Text>
                <Text style={[styles.actions, styles.headText]}>
                  {lstrings.role_change}
                </Text>
                <View style={styles.actions} />
              </View>

              {withAddress.map(person => (
                <PersonRow key={person.userId} person={person} {...rowProps} />
              ))}

              {page.pending.map(pending => (
                <View key={pending.inviteId} style={styles.row}>
                  <View style={styles.who}>
                    <Text style={styles.name}>{pending.email}</Text>
                    <Text style={styles.muted}>{lstrings.manage_pending}</Text>
                  </View>
                  <Text style={[styles.roleBox, styles.muted]}>
                    {lstrings.manage_pending}
                  </Text>
                  {columns.map(column => (
                    <Text key={column} style={[styles.cell, styles.muted]}>
                      —
                    </Text>
                  ))}
                  <Text style={[styles.when, styles.muted]}>
                    {calendarDate(pending.invitedAt)}
                  </Text>
                  <Text style={[styles.when, styles.muted]}>
                    {lstrings.manage_never}
                  </Text>
                  <View style={styles.actions} />
                  <View style={styles.actions} />
                </View>
              ))}

              {withoutAddress.length > 0 && (
                <View style={styles.groupHead}>
                  <Text style={styles.groupTitle}>
                    {lstrings.manage_no_address_header}
                  </Text>
                </View>
              )}

              {withoutAddress.map(person => (
                <PersonRow key={person.userId} person={person} {...rowProps} />
              ))}
            </View>
          </ScrollView>
        </Card>
      </View>

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
          {note != null && <Text style={styles.detail}>{note}</Text>}
        </Card>
      </View>

      {error != null && <Text style={styles.warning}>{error}</Text>}

      <InvitePanel
        client={client}
        scopeType={scopeKind}
        scopeId={scopeId}
        scopeName={page.scope.name}
      />

      {changing != null && (
        <RoleModal
          displayName={changing.displayName}
          scopeKind={scopeKind}
          scopeName={page.scope.name}
          role={roleAt(changing, scopeId)}
          busy={busy}
          onClose={() => {
            setChanging(undefined)
          }}
          onSave={role => {
            const who = changing
            setChanging(undefined)
            run(async () => {
              await client.setRole(scopeKind, scopeId, who.userId, role)
            })
          }}
        />
      )}
    </Screen>
  )
}

function labelFor(column: 'team' | 'season' | 'league'): string {
  if (column === 'team') return lstrings.manage_via_team
  if (column === 'season') return lstrings.manage_via_season
  return lstrings.manage_via_league
}

/** What somebody is at this one level, which is all this page may change. */
function roleAt(person: ScopePerson, scopeId: string): 'admin' | 'member' {
  return person.adminOf.some(role => role.id === scopeId) ? 'admin' : 'member'
}

/** One person, with a tick under every level their access comes through. */
function PersonRow(props: {
  person: ScopePerson
  columns: Array<'team' | 'season' | 'league'>
  scopeKind: 'league' | 'season' | 'team'
  busy: boolean
  onRemove: (person: ScopePerson) => void
  onChangeRole: (person: ScopePerson) => void
}): React.ReactElement {
  const { person, columns, scopeKind, busy, onRemove, onChangeRole } = props
  const styles = getStyles(useTheme())

  const grantsFor = (
    column: 'team' | 'season' | 'league'
  ): ScopePerson['teams'] =>
    column === 'team'
      ? person.teams
      : column === 'season'
        ? person.seasons
        : person.leagues
  // Only what this administrator administers is theirs to take away. The rest
  // is shown, ticked, and left alone.
  const holdsHere = grantsFor(scopeKind).length > 0
  // A role belongs to somebody who can sign in. An account with no address
  // cannot, so there is nothing to make an administrator of.
  const canHoldRole = person.emails.length > 0
  const roles = rolesOf(person)

  return (
    <View style={styles.row}>
      <View style={styles.who}>
        <Text style={styles.name}>{person.displayName}</Text>
        <Text style={styles.muted} numberOfLines={2}>
          {person.emails.length === 0
            ? lstrings.manage_no_email
            : person.emails.join(', ')}
        </Text>
      </View>
      <View style={styles.roleBox}>
        {roles.length === 0 ? (
          <Text style={styles.muted}>{lstrings.manage_role_none}</Text>
        ) : (
          roles.map(line => (
            <Text
              key={line.text}
              style={line.isAdmin ? styles.roleAdmin : styles.role}
            >
              {line.text}
            </Text>
          ))
        )}
      </View>
      {columns.map(column => (
        <Text
          key={column}
          style={grantsFor(column).length > 0 ? styles.tick : styles.cellMuted}
        >
          {grantsFor(column).length > 0 ? '✓' : '—'}
        </Text>
      ))}
      <Text style={[styles.when, styles.muted]}>
        {calendarDate(person.createdAt === '' ? null : person.createdAt)}
      </Text>
      <View style={styles.when}>
        <Text style={styles.muted}>
          {person.lastSignInAt == null
            ? lstrings.manage_never
            : calendarDate(person.lastSignInAt)}
        </Text>
        {/* A month-long session means the sign-in can be long past while
            somebody is here every weekend. Said only when it differs. */}
        {person.lastSeenAt != null &&
          person.lastSignInAt != null &&
          calendarDate(person.lastSeenAt) !==
            calendarDate(person.lastSignInAt) && (
            <Text style={styles.seen}>
              {sprintf(lstrings.manage_seen, calendarDate(person.lastSeenAt))}
            </Text>
          )}
      </View>
      <View style={styles.actions}>
        {canHoldRole && (
          <Button
            label={lstrings.role_change}
            kind="text"
            disabled={busy}
            onPress={() => {
              onChangeRole(person)
            }}
          />
        )}
      </View>
      <View style={styles.actions}>
        {holdsHere && (
          <Button
            label={lstrings.manage_remove}
            kind="text"
            disabled={busy}
            onPress={() => {
              onRemove(person)
            }}
          />
        )}
      </View>
    </View>
  )
}

/**
 * Every role this person holds in this tree, in words.
 *
 * Administrators first, then the widest membership down to the narrowest,
 * because "league admin" is the fact that explains all the others. One line
 * each rather than a single strongest role: somebody can be a team's manager
 * and a season's spectator at once, and a box saying only "manager" would
 * hide the half that is not removable from here.
 */
function rolesOf(
  person: ScopePerson
): Array<{ text: string; isAdmin: boolean }> {
  const lines: Array<{ text: string; isAdmin: boolean }> = []
  for (const role of person.adminOf) {
    lines.push({
      text: `${adminLabel(role.kind)} · ${role.name}`,
      isAdmin: true
    })
  }
  for (const grant of person.leagues) {
    lines.push({
      text: sprintf(
        lstrings.manage_role_line,
        lstrings.manage_via_league,
        wordFor(grant.role),
        grant.name
      ),
      isAdmin: false
    })
  }
  for (const grant of person.seasons) {
    lines.push({
      text: sprintf(
        lstrings.manage_role_line,
        lstrings.manage_via_season,
        wordFor(grant.role),
        grant.name
      ),
      isAdmin: false
    })
  }
  for (const grant of person.teams) {
    lines.push({
      text: sprintf(
        lstrings.manage_role_line,
        lstrings.manage_via_team,
        wordFor(grant.role),
        grant.name
      ),
      isAdmin: false
    })
  }
  return lines
}

/** The database's word for a role, in the app's words. */
function wordFor(role: string): string {
  if (role === 'owner') return lstrings.manage_role_owner
  if (role === 'manager') return lstrings.manage_role_manager
  if (role === 'spectator') return lstrings.manage_role_spectator
  return lstrings.manage_role_member
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  card: {
    gap: theme.rem(theme.spaceMdRem)
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  tableScroll: {
    minWidth: '100%'
  },
  table: {
    // Wide enough that every column keeps its own width; narrower screens
    // scroll rather than squeeze, and wider ones let it grow.
    // The padding sits outside this width, so leave room for it: a table
    // that overflows its own card by exactly its padding is the kind of
    // detail that reads as a bug.
    minWidth: theme.rem(54),
    flexGrow: 1,
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingBottom: theme.rem(theme.spaceSmRem)
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceSmRem),
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  head: {
    borderTopWidth: 0,
    paddingTop: theme.rem(theme.spaceMdRem),
    paddingBottom: 0
  },
  headText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    letterSpacing: theme.rem(0.04),
    textTransform: 'uppercase',
    color: theme.secondaryTextColor
  },
  groupHead: {
    gap: theme.rem(theme.spaceXsRem),
    paddingTop: theme.rem(theme.spaceLgRem),
    paddingBottom: theme.rem(theme.spaceSmRem),
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  groupTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    letterSpacing: theme.rem(0.04),
    textTransform: 'uppercase',
    color: theme.secondaryTextColor
  },
  who: {
    flex: 2.6,
    gap: theme.rem(theme.spaceXsRem)
  },
  roleBox: {
    flex: 2.6,
    gap: theme.rem(theme.spaceXsRem)
  },
  role: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.primaryTextColor
  },
  roleAdmin: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '600',
    color: theme.successColor
  },
  when: {
    // Wide enough for `Sep 16, 2026` without the date spilling into the
    // buttons beside it.
    flex: 1.8,
    gap: theme.rem(theme.spaceXsRem)
  },
  seen: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.6875),
    color: theme.secondaryTextColor
  },
  cell: {
    flex: 1,
    textAlign: 'center'
  },
  actions: {
    flex: 1.3,
    alignItems: 'flex-end'
  },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  tick: {
    flex: 1,
    textAlign: 'center',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.successColor
  },
  cellMuted: {
    flex: 1,
    textAlign: 'center',
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  warning: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.warningColor
  }
}))
