import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { ActivityPage, TeamStationClient } from '../../common/api'
import {
  type ActivityRow,
  type Affiliation,
  type DirectoryPerson,
  localDate,
  type PersonAdministration
} from '../../common/userManagement'
import {
  Button,
  HandoffView,
  HeroCard,
  ListCard,
  ListRow,
  PillTabs,
  Screen,
  SectionHeader,
  SettingsGear,
  TextField,
  useBreakpoint,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot
} from '../components'
import { PagedList } from '../components/PagedList'
import { PagedListEmpty, PagedListEnd } from '../components/PagedListEnd'
import { PersonSearchRow } from '../components/PersonSearchRow'
import {
  PillBand,
  PinnedContent,
  PinnedSpacer
} from '../components/PinnedBands'
import { useSceneReveals } from '../components/sceneShown'
import { ActiveView, TabPages } from '../components/TabPages'
import { usePinnedTabs } from '../components/usePinnedTabs'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { type PagedRows, usePagedList } from '../hooks/usePagedList'
import type { UserManagementTab } from '../navigation/routes'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { NODE_ONLY } from './nodeOnly'
import {
  ActivityHeader,
  type ActivityKind,
  ActivityRowView
} from './userManagementRows'

export interface UserManagementScreenProps {
  client: TeamStationClient
  /** Whether the signed-in person administers the node. */
  allowed: boolean
  tab?: UserManagementTab
  /** Tells the shell, so the address says which tab is showing. */
  onTab?: (tab: UserManagementTab) => void
  /** The gear on a person's card: their Account page. */
  onEditAccount: (userId: string) => void
  onOpenGroup: (group: { kind: Affiliation['kind']; id: string }) => void
}

const TITLE = 'User Management'

const TABS: Array<{ id: UserManagementTab; label: string }> = [
  { id: 'logins', label: 'Recent Logins' },
  { id: 'sessions', label: 'Recent Sessions' },
  { id: 'users', label: 'User List' }
]

/** A row's height before it has been measured: a phone's stacks three lines. */
const ROW_HEIGHT = { narrow: 104, wide: 60 }
/** How long typing pauses before the search is asked. */
const SEARCH_PAUSE_MS = 500

const rowId = (row: ActivityRow): string => row.id

/** The screen, or for anybody who does not administer the node, a refusal. */
export function UserManagementScreen(
  props: UserManagementScreenProps
): React.ReactElement {
  const styles = getStyles(useTheme())
  if (!props.allowed)
    return (
      <Screen>
        <Text accessibilityRole="alert" style={styles.hint}>
          {NODE_ONLY}
        </Text>
      </Screen>
    )
  return <UserManagement {...props} />
}

/** One activity list, read a page of 50 at a time as the reader reaches its end. */
function useActivity(
  kind: ActivityKind,
  read: (cursor: string | null) => Promise<ActivityPage>
): PagedRows<ActivityRow> {
  // Read when its tab is first shown, not before: see `UserManagement`.
  return usePagedList<ActivityRow>({
    listKey: kind,
    keyOf: rowId,
    read,
    auto: false
  })
}

/**
 * Node administration's User Management: who signed in, each device's
 * sessions, and anybody's account, under pills that stay pinned beneath the
 * header while the title hands up into it.
 */
function UserManagement(props: UserManagementScreenProps): React.ReactElement {
  const { client, onTab, onEditAccount, onOpenGroup } = props
  const styles = getStyles(useTheme())
  const narrow = useBreakpoint() === 'phone'
  const [tab, setTab] = useState<UserManagementTab>(props.tab ?? 'logins')
  useEffect(() => {
    if (props.tab != null) setTab(props.tab)
  }, [props.tab])
  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight)
  const { progress } = handoff
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress} style={styles.headerPills}>
          <Text style={styles.headerTitle}>{TITLE}</Text>
        </HandoffView>
      ),
      [progress, styles.headerPills, styles.headerTitle]
    )
  )
  const [recordedSince, setRecordedSince] = useState<string | null>(null)
  const logins = useActivity(
    'logins',
    useCallback(async cursor => await client.recentLogins(cursor), [client])
  )
  const sessions = useActivity(
    'sessions',
    useCallback(
      async cursor => {
        const page = await client.recentSessions(cursor)
        if (cursor == null) setRecordedSince(page.recordedSince ?? null)
        return page
      },
      [client]
    )
  )
  const shown = tab === 'sessions' ? sessions : logins
  // Each list's first page waits for its tab, so User List asks for none.
  const opened = useRef(new Set<UserManagementTab>())
  useEffect(() => {
    if (tab === 'users' || opened.current.has(tab)) return
    opened.current.add(tab)
    shown.refresh().catch(() => undefined)
  }, [tab, shown])
  const { pinned, selectTab } = usePinnedTabs({
    head: { headerHeight, handoff },
    ready: tab === 'users' || !shown.loading,
    tab,
    anchorOnRow: false
  })
  const choose = useCallback(
    (next: UserManagementTab): void => {
      selectTab(next)
      setTab(next)
      onTab?.(next)
    },
    [onTab, selectTab]
  )
  return (
    <Screen {...pinned.screen} pagedList>
      <PillBand part={pinned.pillBand}>
        <PillTabs
          tabs={TABS}
          selected={tab}
          onSelect={choose}
          size="compact"
          accessibilityLabel={TITLE}
        />
      </PillBand>
      <TabPages keep page={tab} index={TABS.findIndex(item => item.id === tab)}>
        <PinnedContent key={tab} part={pinned.content}>
          <ActiveView ref={handoff.ref}>
            <Text accessibilityRole="header" style={styles.title}>
              {TITLE}
            </Text>
          </ActiveView>
          {tab === 'users' ? (
            <UserList
              client={client}
              onEditAccount={onEditAccount}
              onOpenGroup={onOpenGroup}
            />
          ) : (
            <ActivityList
              kind={tab}
              list={shown}
              narrow={narrow}
              note={
                tab === 'sessions' && recordedSince != null
                  ? `Sessions recorded since ${localDate(recordedSince)}`
                  : undefined
              }
            />
          )}
          <View />
        </PinnedContent>
      </TabPages>
      <PinnedSpacer part={pinned.spacer} />
    </Screen>
  )
}

/** Logins or sessions, newest first, with the next 50 read at the end. */
function ActivityList(props: {
  kind: ActivityKind
  list: PagedRows<ActivityRow>
  narrow: boolean
  note?: string
}): React.ReactElement {
  const { kind, list, narrow, note } = props
  const styles = getStyles(useTheme())
  const { rows, loadMore } = list
  const renderRow = useCallback(
    (row: ActivityRow) => (
      <ActivityRowView row={row} kind={kind} narrow={narrow} />
    ),
    [kind, narrow]
  )
  const extraData = useMemo(() => ({ kind, narrow }), [kind, narrow])
  const readOn = useCallback(() => {
    loadMore().catch(() => undefined)
  }, [loadMore])
  return (
    <View style={styles.section}>
      {note != null && <Text style={styles.hint}>{note}</Text>}
      {!narrow && rows.length > 0 && <ActivityHeader kind={kind} />}
      <PagedList
        data={rows}
        keyOf={rowId}
        renderItem={renderRow}
        extraData={extraData}
        estimatedItemSize={narrow ? ROW_HEIGHT.narrow : ROW_HEIGHT.wide}
        empty={
          <PagedListEmpty
            list={list}
            loadingLabel={
              kind === 'logins' ? 'Loading logins' : 'Loading sessions'
            }
            spinnerStyle={styles.loading}
            none={
              <Text style={styles.hint}>
                {kind === 'logins'
                  ? 'No logins are recorded.'
                  : 'No sessions are recorded yet.'}
              </Text>
            }
          />
        }
        footer={
          <View>
            <PagedListEnd list={list} />
            {list.atEnd && rows.length > 0 && (
              <Text style={[styles.hint, styles.end]}>No older activity.</Text>
            )}
          </View>
        }
        onEndReached={readOn}
      />
    </View>
  )
}

/**
 * The search, its ten people in Add Person's rows, and the one chosen: their
 * card, their addresses and every team, season and league they are part of.
 * Choosing somebody replaces the results; typing again brings them back.
 */
function UserList(props: {
  client: TeamStationClient
  onEditAccount: (userId: string) => void
  onOpenGroup: UserManagementScreenProps['onOpenGroup']
}): React.ReactElement {
  const { client, onEditAccount, onOpenGroup } = props
  const styles = getStyles(useTheme())
  const [query, setQuery] = useState('')
  const asked = useDebouncedValue(query.trim(), SEARCH_PAUSE_MS)
  const [found, setFound] = useState<DirectoryPerson[]>()
  const [searchError, setSearchError] = useState('')
  const [chosen, setChosen] = useState<string>()
  const [person, setPerson] = useState<PersonAdministration>()
  const [personError, setPersonError] = useState('')
  // Each read has its own Retry, so one never repeats the other.
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [personAttempt, setPersonAttempt] = useState(0)
  // Back from somebody's Account page, what it changed shows.
  const reveals = useSceneReveals()
  const beginSearch = useLatestRequest()
  const beginPerson = useLatestRequest()

  useEffect(() => {
    const current = beginSearch()
    setFound(undefined)
    setSearchError('')
    if (asked === '') return
    client
      .directory(asked)
      .then(people => {
        if (current()) setFound(people)
      })
      .catch((error: unknown) => {
        if (current())
          setSearchError(
            error instanceof Error ? error.message : 'People could not load.'
          )
      })
  }, [asked, searchAttempt, reveals, client, beginSearch])

  useEffect(() => {
    const current = beginPerson()
    setPerson(undefined)
    setPersonError('')
    if (chosen == null) return
    client
      .personAdministration(chosen)
      .then(answer => {
        if (current()) setPerson(answer)
      })
      .catch((error: unknown) => {
        if (current())
          setPersonError(
            error instanceof Error
              ? error.message
              : 'This person could not load.'
          )
      })
  }, [chosen, personAttempt, reveals, client, beginPerson])

  return (
    <View style={styles.section}>
      <TextField
        label="Find a person"
        value={query}
        leadingIcon="search"
        placeholder="Name or email"
        autoCapitalize="none"
        onChangeText={value => {
          setQuery(value)
          setChosen(undefined)
        }}
        action={
          query === ''
            ? undefined
            : {
                label: 'Clear',
                onPress: () => {
                  setQuery('')
                  setChosen(undefined)
                }
              }
        }
      />
      {chosen != null ? (
        <PersonDetails
          person={person}
          error={personError}
          onRetry={() => {
            setPersonAttempt(value => value + 1)
          }}
          onEditAccount={onEditAccount}
          onOpenGroup={onOpenGroup}
        />
      ) : asked === '' ? (
        <Text style={styles.hint}>
          Type a name or an email address to find a person.
        </Text>
      ) : searchError !== '' ? (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {searchError}
          </Text>
          <Button
            label="Retry"
            kind="text"
            onPress={() => {
              setSearchAttempt(value => value + 1)
            }}
          />
        </View>
      ) : found == null ? (
        <Text style={styles.hint}>Looking for people…</Text>
      ) : found.length === 0 ? (
        <Text style={styles.hint}>No people match.</Text>
      ) : (
        <View style={styles.results}>
          {found.map(row => (
            <ListCard key={row.userId}>
              <PersonSearchRow
                userId={row.userId}
                name={row.displayName}
                avatarUrl={row.avatarUrl}
                detail={row.email}
                affiliations={row.affiliations}
                onPress={() => {
                  setChosen(row.userId)
                }}
              />
            </ListCard>
          ))}
        </View>
      )}
    </View>
  )
}

const ROLE_LABELS: Record<Affiliation['roles'][number], string> = {
  admin: 'Admin',
  'head coach': 'Head coach',
  coach: 'Coach',
  assistant: 'Assistant',
  scorekeeper: 'Scorekeeper',
  songkeeper: 'Songkeeper',
  videographer: 'Videographer',
  player: 'Player',
  member: 'Member',
  following: 'Following'
}
const KIND_LABELS: Record<Affiliation['kind'], string> = {
  team: 'Team',
  season: 'Season',
  league: 'League'
}

/** Primary, Unverified, both or neither, under an address. */
function emailNote(row: {
  isPrimary: boolean
  isVerified: boolean
}): string | undefined {
  const parts = [
    ...(row.isPrimary ? ['Primary'] : []),
    ...(row.isVerified ? [] : ['Unverified'])
  ]
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** The chosen person: their card with its gear, addresses and affiliations. */
function PersonDetails(props: {
  person: PersonAdministration | undefined
  error: string
  onRetry: () => void
  onEditAccount: (userId: string) => void
  onOpenGroup: UserManagementScreenProps['onOpenGroup']
}): React.ReactElement {
  const { person, error, onRetry, onEditAccount, onOpenGroup } = props
  const styles = getStyles(useTheme())
  if (error !== '')
    return (
      <View>
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
        <Button label="Retry" kind="text" onPress={onRetry} />
      </View>
    )
  if (person == null) return <Text style={styles.hint}>Loading…</Text>
  const primary = person.emails.find(row => row.isPrimary) ?? person.emails[0]
  return (
    <View style={styles.section}>
      <HeroCard
        name={person.displayName}
        secondary={primary?.email}
        uri={person.avatarUrl}
        person={{ userId: person.userId }}
        end={
          <SettingsGear
            label={`Edit ${person.displayName}’s account`}
            onPress={() => {
              onEditAccount(person.userId)
            }}
          />
        }
      />
      <View style={styles.section}>
        <SectionHeader title="Email addresses" />
        {person.emails.length === 0 ? (
          <Text style={styles.hint}>No email addresses.</Text>
        ) : (
          <ListCard>
            {person.emails.map(row => (
              <ListRow
                key={row.email}
                title={row.email}
                subtitle={emailNote(row)}
              />
            ))}
          </ListCard>
        )}
      </View>
      <View style={styles.section}>
        <SectionHeader title="Affiliations" />
        {person.affiliations.length === 0 ? (
          <Text style={styles.hint}>No teams, seasons or leagues.</Text>
        ) : (
          <ListCard>
            {person.affiliations.map(row => (
              <ListRow
                key={`${row.kind}:${row.id}`}
                title={row.name}
                subtitle={[
                  KIND_LABELS[row.kind],
                  ...row.roles.map(role => ROLE_LABELS[role])
                ].join(' · ')}
                subtitleNumberOfLines={2}
                onPress={() => {
                  onOpenGroup({ kind: row.kind, id: row.id })
                }}
              />
            ))}
          </ListCard>
        )}
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  results: { gap: theme.rem(theme.spaceSmRem) },
  title: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(1.5),
    fontFamily: theme.semiBoldTextFont,
    paddingBottom: theme.rem(0.5)
  },
  headerTitle: {
    color: theme.headerTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700' as const
  },
  headerPills: { alignItems: 'flex-start' as const },
  hint: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.3)
  },
  end: { textAlign: 'center' as const, paddingVertical: theme.rem(0.75) },
  error: { color: theme.dangerColor, fontSize: theme.rem(0.875) },
  loading: { paddingVertical: theme.rem(theme.spaceLgRem) }
}))
