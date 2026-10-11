import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import {
  grantsOf,
  type ManagePage,
  type RoleGrant,
  type ScopePerson,
  type TeamStationClient
} from '../../common/api'
import { type Role, ROLE_FLAGS, type RoleFlag } from '../../common/roles'
import {
  adminLabel,
  Button,
  Card,
  flagLabel,
  InvitePanel,
  RolesModal,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { calendarDate } from './format'

export interface ManageScreenProps {
  client: TeamStationClient
  scopeKind: 'league' | 'season' | 'team'
  scopeId: string
  /** Tells the shell what this page is called, once it knows. */
  onTitle?: (title: string) => void
  onOpenRequest?: (id: string) => void
  onChanged?: () => void
  /**
   * Drawn inside another page — a league's or season's People tab — rather
   * than as a screen of its own, so it brings no scroller of its own.
   */
  embedded?: boolean
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
 * beside it says the same thing in words, with every role somebody holds —
 * administrator, coach, scorekeeper, songkeeper, videographer — and where a
 * role set above this level comes from. Tapping it changes their roles here.
 *
 * What can be changed is only ever what this administrator administers. A
 * team's manager sees the season membership that lets a parent watch and
 * cannot remove it, because it is not theirs and taking it away would drop
 * that parent from four other teams as well — and for the same reason the
 * roles a team's page hands out are the team's and never anything wider.
 *
 * Accounts with no address are kept in their own group at the bottom.
 * Nobody can sign in to them, so they are a roster rather than a list of
 * people to administer, and they would otherwise be nine rows in ten. The
 * header says what they are and stops there: where a row came from is this
 * system's business and not something to explain on every screen.
 */
/**
 * How wide the table wants to be before it would rather scroll than squeeze.
 *
 * Shared by the measured width above and the `minWidth` below so the two
 * cannot drift apart — they are the same number and mean the same thing.
 */
const TABLE_MIN_REM = 58

export function ManageScreen(props: ManageScreenProps): React.ReactElement {
  const {
    client,
    scopeKind,
    scopeId,
    onTitle,
    onOpenRequest,
    onChanged,
    embedded = false
  } = props
  const Wrap = embedded ? EmbeddedPage : Screen
  const theme = useTheme()
  const styles = getStyles(theme)

  const [page, setPage] = useState<ManagePage | undefined>(undefined)
  const [refused, setRefused] = useState(false)
  const [email, setEmail] = useState('')
  const [inviteRoles, setInviteRoles] = useState<{
    admin: boolean
    flags: RoleFlag[]
  }>({ admin: false, flags: [] })
  const [choosingInviteRoles, setChoosingInviteRoles] = useState(false)
  const invitationKey = useRef<{ body: string; key: string } | undefined>(
    undefined
  )
  const [sentRequest, setSentRequest] = useState<string>()
  const [filter, setFilter] = useState('')
  const [changing, setChanging] = useState<ScopePerson | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /**
   * What happened to the last change made from the table, said above the
   * table. The add form's own line is a screen further down, and a phone
   * never shows the two at once.
   */
  const [peopleNote, setPeopleNote] = useState<
    { text: string; warning: boolean; requestId?: string } | undefined
  >(undefined)
  /** Why the roles sheet's last Save failed, said inside the sheet. */
  const [rolesError, setRolesError] = useState<string | undefined>(undefined)
  const rolesInvitationKey = useRef<{ body: string; key: string } | undefined>(
    undefined
  )
  /**
   * How wide the table is allowed to be, measured rather than declared.
   *
   * Inside a horizontal `ScrollView` the content's width is *indefinite*: the
   * scroller's whole job is to let the content be as wide as it likes, so
   * there is no free space for `flex` to divide and every row ends up as wide
   * as its own longest word. The columns then line up with nothing — not with
   * the header, not with each other — and the TEAM and SEASON ticks, which
   * are the point of the table, are pushed off the right edge of a phone.
   *
   * A browser does not have this problem because the table's block container
   * gives it a width to start from. Measuring the scroller and handing the
   * table a real number is how you give Yoga the same thing.
   */
  const [scrollWidth, setScrollWidth] = useState(0)

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

  /**
   * Does one change, then reloads the page. A failure is said where the
   * change was asked for: `fail` puts it there, and by default it goes under
   * the add form.
   */
  const run = (
    work: () => Promise<void>,
    fail: (message: string) => void = setError
  ): void => {
    setBusy(true)
    setError(undefined)
    work()
      .then(async () => {
        onChanged?.()
        await load()
      })
      .catch((caught: unknown) => {
        fail(caught instanceof Error ? caught.message : 'Something went wrong')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  /**
   * Saves the roles sheet. Somebody already in this level gets the roles at
   * once. Somebody the page lists only because a level above lets them
   * watch — a season's spectator on one of its teams — holds nothing here
   * the roles can attach to, and the server rightly refuses to hand anybody
   * a role they have not accepted. So for them Save sends the same
   * invitation **Add somebody** would, with these roles in it, and says that
   * nothing changes until it is accepted. Saying nothing was the bug: the
   * sheet closed, the refusal landed under the add form a screen below, and
   * the table looked exactly as before.
   */
  const saveRoles = (
    who: ScopePerson,
    roles: { admin: boolean; flags: RoleFlag[] },
    scopeName: string
  ): void => {
    setRolesError(undefined)
    setPeopleNote(undefined)
    const invite = !isInHere(who, scopeKind, scopeId)
    run(async () => {
      if (invite) {
        const email = who.emails[0]
        const body = JSON.stringify({ userId: who.userId, email, ...roles })
        if (rolesInvitationKey.current?.body !== body)
          rolesInvitationKey.current = {
            body,
            key: `roles-${Date.now()}-${Math.random().toString(36).slice(2)}`
          }
        const answer = await client.addPerson(scopeKind, scopeId, email, {
          ...roles,
          idempotencyKey: rolesInvitationKey.current.key
        })
        setPeopleNote({
          requestId: answer.invited?.requestId,
          text: sprintf(
            lstrings.manage_roles_invited,
            who.displayName,
            scopeName,
            rolesInWords(roles, scopeKind)
          ),
          warning: false
        })
      } else {
        await client.setRoles(scopeKind, scopeId, who.userId, roles)
        setPeopleNote({
          text: sprintf(lstrings.manage_roles_saved, who.displayName),
          warning: false
        })
      }
      setChanging(undefined)
    }, setRolesError)
  }

  const add = (): void => {
    const wanted = email.trim()
    run(async () => {
      const body = JSON.stringify({
        kind: scopeKind,
        id: scopeId,
        email: wanted.toLowerCase(),
        ...inviteRoles
      })
      if (invitationKey.current?.body !== body)
        invitationKey.current = {
          body,
          key: `person-${Date.now()}-${Math.random().toString(36).slice(2)}`
        }
      const answer = await client.addPerson(scopeKind, scopeId, wanted, {
        ...inviteRoles,
        idempotencyKey: invitationKey.current.key
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

  const people = useMemo(() => page?.people ?? [], [page])
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
      <Wrap>
        <Card>
          <Text style={styles.muted}>{lstrings.manage_refused}</Text>
        </Card>
      </Wrap>
    )
  }

  if (page == null) {
    return (
      <Wrap>
        <Card>
          <Text style={styles.muted}>{lstrings.common_loading}</Text>
        </Card>
      </Wrap>
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
    scopeId,
    busy,
    invited: new Set(page.pending.map(pending => pending.email.toLowerCase())),
    onRemove: (person: ScopePerson) => {
      setPeopleNote(undefined)
      run(
        async () => {
          await client.removePerson(scopeKind, scopeId, person.userId)
        },
        message => {
          setPeopleNote({ text: message, warning: true })
        }
      )
    },
    onChangeRole: (person: ScopePerson) => {
      setRolesError(undefined)
      setChanging(person)
    }
  }

  return (
    <Wrap>
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
          {peopleNote != null && (
            <Text style={peopleNote.warning ? styles.warning : styles.detail}>
              {peopleNote.text}
            </Text>
          )}
          {peopleNote?.requestId != null && onOpenRequest != null && (
            <Button
              label="Open sent invitation"
              kind="secondary"
              onPress={() => {
                onOpenRequest(peopleNote.requestId!)
              }}
            />
          )}
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
            onLayout={event => {
              setScrollWidth(event.nativeEvent.layout.width)
            }}
          >
            <View
              style={[
                styles.table,
                // A declared width, and no `flexGrow` beside it — that
                // pairing is the whole of this. With `flexGrow: 1` on the
                // table the row container sized it to the scroller's own
                // width instead: it asked for 864 and rendered at 377, every
                // row sized to its own longest word, and the role column
                // started at a different x on all six of them. Declared
                // width alone and the columns line up, the role wraps to two
                // lines, and the ticks are where the header says they are.
                //
                // Never narrower than the columns need, never narrower than
                // the card — the second half is what stops a desktop showing
                // an 864-wide table in a 1280-wide space.
                { width: Math.max(theme.rem(TABLE_MIN_REM), scrollWidth) }
              ]}
            >
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
          <Button
            label="Choose invitation roles"
            kind="secondary"
            onPress={() => {
              setChoosingInviteRoles(true)
            }}
          />
          <Text style={styles.detail}>
            Requested access:{' '}
            {inviteRoles.admin
              ? adminLabel(scopeKind)
              : inviteRoles.flags.length === 0
                ? 'Watching'
                : inviteRoles.flags.map(flagLabel).join(', ')}
            . Access starts after acceptance.
          </Text>
          {sentRequest != null && onOpenRequest != null && (
            <Button
              label="Open sent invitation"
              kind="secondary"
              onPress={() => {
                onOpenRequest(sentRequest)
              }}
            />
          )}
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
        <RolesModal
          displayName={changing.displayName}
          scopeKind={scopeKind}
          scopeName={page.scope.name}
          held={heldAt(changing, scopeId)}
          inherited={inheritedAt(changing, scopeKind)}
          busy={busy}
          notice={
            isInHere(changing, scopeKind, scopeId)
              ? undefined
              : sprintf(
                  lstrings.role_invite_notice,
                  changing.displayName,
                  page.scope.name
                )
          }
          saveLabel={
            isInHere(changing, scopeKind, scopeId)
              ? undefined
              : lstrings.role_invite_save
          }
          error={rolesError}
          onClose={() => {
            setRolesError(undefined)
            setChanging(undefined)
          }}
          onSave={roles => {
            saveRoles(changing, roles, page.scope.name)
          }}
        />
      )}
      {choosingInviteRoles && (
        <RolesModal
          displayName={email.trim() === '' ? 'invited person' : email.trim()}
          scopeKind={scopeKind}
          scopeName={page.scope.name}
          held={[
            ...(inviteRoles.admin ? ['admin' as const] : []),
            ...ROLE_FLAGS.filter(flag => inviteRoles.flags.includes(flag))
          ]}
          onClose={() => {
            setChoosingInviteRoles(false)
          }}
          onSave={roles => {
            setInviteRoles(roles)
            setChoosingInviteRoles(false)
          }}
        />
      )}
    </Wrap>
  )
}

function EmbeddedPage(props: {
  children: React.ReactNode
}): React.ReactElement {
  return <View style={{ gap: 16 }}>{props.children}</View>
}

function labelFor(column: 'team' | 'season' | 'league'): string {
  if (column === 'team') return lstrings.manage_via_team
  if (column === 'season') return lstrings.manage_via_season
  return lstrings.manage_via_league
}

/**
 * Whether this person is in this very level — a member of it, or holding a
 * role on it — and so can be given roles here without an invitation.
 * Somebody listed only through a level above it is not.
 */
function isInHere(
  person: ScopePerson,
  scopeKind: 'league' | 'season' | 'team',
  scopeId: string
): boolean {
  const members =
    scopeKind === 'team'
      ? person.teams
      : scopeKind === 'season'
        ? person.seasons
        : person.leagues
  return (
    members.some(member => member.id === scopeId) ||
    grantsOf(person).some(
      grant => grant.kind === scopeKind && grant.id === scopeId
    )
  )
}

/** `Coach, Scorekeeper`, or `Team admin`: what an invitation asks for. */
function rolesInWords(
  roles: { admin: boolean; flags: RoleFlag[] },
  scopeKind: 'league' | 'season' | 'team'
): string {
  return [
    ...(roles.admin ? [adminLabel(scopeKind)] : []),
    ...ROLE_FLAGS.filter(flag => roles.flags.includes(flag)).map(flagLabel)
  ].join(', ')
}

/** The roles set on this one level, which is all this page may change. */
function heldAt(person: ScopePerson, scopeId: string): Role[] {
  return grantsOf(person).find(grant => grant.id === scopeId)?.roles ?? []
}

const HEIGHT = { league: 0, season: 1, team: 2 }

/** Whether a level sits above the one being managed, and so reaches it. */
function isAbove(
  kind: RoleGrant['kind'],
  scopeKind: 'league' | 'season' | 'team'
): boolean {
  return HEIGHT[kind] < HEIGHT[scopeKind]
}

/**
 * The roles a level above carries down to this one, each with the name of
 * the level it is set on. A page's tree holds only the levels above that
 * contain it, so any grant higher than this page reaches it.
 */
function inheritedAt(
  person: ScopePerson,
  scopeKind: 'league' | 'season' | 'team'
): Partial<Record<Role, string>> {
  const from: Partial<Record<Role, string>> = {}
  for (const grant of grantsOf(person)) {
    if (!isAbove(grant.kind, scopeKind)) continue
    for (const role of grant.roles) from[role] ??= grant.name
  }
  return from
}

/** One person, with a tick under every level their access comes through. */
function PersonRow(props: {
  person: ScopePerson
  columns: Array<'team' | 'season' | 'league'>
  scopeKind: 'league' | 'season' | 'team'
  scopeId: string
  busy: boolean
  /** The addresses with an invitation to this level still waiting. */
  invited: Set<string>
  onRemove: (person: ScopePerson) => void
  onChangeRole: (person: ScopePerson) => void
}): React.ReactElement {
  const {
    person,
    columns,
    scopeKind,
    scopeId,
    busy,
    invited,
    onRemove,
    onChangeRole
  } = props
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
  const roles = rolesOf(person, scopeKind, scopeId)
  // Invited here and not yet accepted: what the invitation asks for is not
  // theirs yet, and the row says so rather than looking unchanged.
  const isInvited = person.emails.some(address =>
    invited.has(address.toLowerCase())
  )

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
      <Pressable
        style={styles.roleBox}
        disabled={!canHoldRole || busy}
        accessibilityRole={canHoldRole ? 'button' : undefined}
        accessibilityLabel={
          canHoldRole
            ? sprintf(lstrings.role_title, person.displayName)
            : undefined
        }
        onPress={() => {
          onChangeRole(person)
        }}
      >
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
        {isInvited && (
          <Text style={styles.muted}>{lstrings.manage_pending}</Text>
        )}
      </Pressable>
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
            style={styles.actionButton}
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
            style={styles.actionButton}
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
 * Roles first — this level's, then those carried down from above, then those
 * on levels inside it — and then the widest membership down to the
 * narrowest, because "league admin" is the fact that explains all the
 * others. One line each rather than a single strongest role: somebody can be
 * a team's manager and a season's spectator at once, and a box saying only
 * "manager" would hide the half that is not removable from here.
 *
 * A level's roles share a line: `Coach · Songkeeper` for this level,
 * `Scorekeeper · from Spring league` from above, `Team admin · Owls` inside.
 */
function rolesOf(
  person: ScopePerson,
  scopeKind: 'league' | 'season' | 'team',
  scopeId: string
): Array<{ text: string; isAdmin: boolean }> {
  const lines: Array<{ text: string; isAdmin: boolean }> = []
  const grants = grantsOf(person)
  const here = grants.filter(grant => grant.id === scopeId)
  const above = grants.filter(
    grant => grant.id !== scopeId && isAbove(grant.kind, scopeKind)
  )
  const inside = grants.filter(
    grant => grant.id !== scopeId && !isAbove(grant.kind, scopeKind)
  )
  const words = (grant: RoleGrant): string =>
    grant.roles
      .map(role =>
        role === 'admin' ? adminLabel(grant.kind) : flagLabel(role)
      )
      .join(' · ')
  for (const grant of here) {
    lines.push({ text: words(grant), isAdmin: grant.roles.includes('admin') })
  }
  for (const grant of above) {
    lines.push({
      text: sprintf(lstrings.manage_role_from, words(grant), grant.name),
      isAdmin: grant.roles.includes('admin')
    })
  }
  for (const grant of inside) {
    lines.push({
      text: `${words(grant)} · ${grant.name}`,
      isAdmin: grant.roles.includes('admin')
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
    // `flexGrow`, not `minWidth: '100%'`. A percentage along a horizontal
    // scroller's own axis has nothing to be a percentage *of* on a phone —
    // the content is as wide as it likes — so it resolved to nothing and the
    // table sat at its intrinsic width with the last column half off the
    // edge, which is the very thing the comment above says it prevents.
    flexGrow: 1
  },
  table: {
    // The width is set inline from the measured scroller, because it has to
    // be a number rather than a rule. The padding sits inside it, so the
    // table does not overflow its own card by exactly its padding.
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
    // A fixed width, not `flex` with a floor under it — and the difference
    // between those two is a whole platform bug.
    //
    // `minWidth` on a flex item is **clamping** in CSS and **additive** in
    // Yoga. The browser grew this column to 76, saw that was under the 88
    // floor, froze it there and shared the rest over the other columns. iOS
    // reserved the 88 first and *then* gave it a grow share on top, landing
    // at 147. Two of these columns, so 118 points came out of the other six:
    // `TEAM` and `SEASON` fell from 56 to 45, `SEASON` needs about 52, and it
    // broke mid-word as `SEASO` / `N`.
    //
    // Fixed, both platforms reserve the same 176 and divide what is left over
    // the same 10.8 units. `Change role` is still never cut, which is what
    // the floor was for — guaranteed now rather than left to whichever way
    // the clamp went. It is what the box score's `cell` does, and the reason
    // that table has never had this problem: it never divides free space.
    // 7.5 rem, not 5.5: 5.5 was measured against the *label* and the button
    // adds its own padding, so at 88 the label came out `Chan…` on a phone.
    // `TABLE_MIN_REM` grows by the same 4 rem so the other columns keep every
    // point they had — this column is fixed, so it comes out of the table's
    // total rather than out of `TEAM` and `SEASON`.
    width: theme.rem(7.5),
    flexGrow: 0,
    flexShrink: 0,
    alignItems: 'flex-end'
  },
  actionButton: {
    // The browser lets this overflow its column leftwards into the
    // whitespace and draws it whole; Yoga clamps it to the column instead —
    // it is a cross-axis clamp, so `flexShrink: 0` does not stop it, which
    // was worth finding out. The column is wide enough for the button now.
    flexShrink: 0
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
