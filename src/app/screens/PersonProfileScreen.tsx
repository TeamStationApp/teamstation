import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  PersonProfile,
  ProfileSection,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { PersonMessageButton } from '../chat/PersonMessageButton'
import {
  Button,
  Card,
  Emblem,
  initialsOf,
  ListCard,
  ListRow,
  Screen,
  SectionHeader
} from '../components'
import { type RoleRowKind, RoleRows } from '../components/RoleRows'
import { useSceneReveals } from '../components/sceneShown'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PersonProfileScreenProps {
  client: TeamStationClient
  /** The team, season or league the profile was opened from. */
  kind: 'league' | 'season' | 'team'
  id: string
  userId: string
  /** One of the players they guard, opened on the team found for them. */
  onOpenPlayer?: (
    userId: string,
    name: string,
    from: { onTeam: string }
  ) => void
  /** Tells the shell whose profile this is, once it knows. */
  onTitle?: (name: string) => void
  /** After a role changes, for anything that shows the viewer's own. */
  onChanged?: () => void
  onOpenChat?: (chat: { id: string; title: string }) => void | Promise<void>
}

/**
 * One person, as the team, season or league they were opened from sees them.
 *
 * A hero card with their photo, their name (the whole of it for whoever
 * manages the level's people) and the level the profile is for, which is
 * the one its switches change. Then the players they are a parent or guardian
 * of there, each opening that player's page. Then what they hold, a section
 * per level: Team, Season (every season the team is in, as one) and League
 * roles from a team; Season and League from a season; League from a league.
 * Only the level the profile was opened from has switches; the levels above
 * are for reading, whoever is looking, and are changed on their own pages.
 */
export function PersonProfileScreen(
  props: PersonProfileScreenProps
): React.ReactElement {
  const { client, kind, id, userId, onOpenPlayer, onTitle, onChanged } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [profile, setProfile] = useState<PersonProfile | undefined>()
  const [refused, setRefused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [readError, setReadError] = useState<string>()
  const [savedUnavailable, setSavedUnavailable] = useState(false)

  const begin = useLatestRequest()
  const beginWrite = useLatestRequest()
  const writing = useRef(false)
  const identity = useRef({ client, kind, id, userId })
  identity.current = { client, kind, id, userId }
  // The shell's callback changes with every render of the shell; reading
  // it from a ref keeps the profile from loading again when it does.
  const titled = useRef(onTitle)
  titled.current = onTitle
  const load = useCallback(async (): Promise<void> => {
    const current = begin()
    const found = await client.personProfile(kind, id, userId)
    if (!current()) return
    setProfile(found)
    setReadError(undefined)
    setSavedUnavailable(false)
    titled.current?.(found.person.fullName ?? found.person.shortName)
  }, [client, id, kind, userId, begin])

  // On coming back from the player's page, the person is read again in place.
  const reveals = useSceneReveals()
  const readAt = useRef(reveals)
  useEffect(() => {
    if (readAt.current !== reveals) {
      readAt.current = reveals
      load().catch(() => undefined)
      return
    }
    setProfile(undefined)
    setRefused(false)
    setBusy(false)
    setError(undefined)
    setReadError(undefined)
    setSavedUnavailable(false)
    writing.current = false
    const current = beginWrite()
    load().catch(() => {
      if (current()) setRefused(true)
    })
  }, [load, beginWrite, reveals])

  // A successful write must not become a retryable write when its read fails.
  const refreshSaved = async (current: () => boolean): Promise<void> => {
    try {
      await load()
    } catch (caught) {
      if (!current()) return
      setProfile(undefined)
      if (caught instanceof HttpError && caught.code === 'notFound')
        setSavedUnavailable(true)
      else
        setReadError(
          caught instanceof Error ? caught.message : 'Something went wrong'
        )
    }
  }

  const change = async (
    role: RoleRowKind,
    give: boolean,
    active: () => boolean = () => true
  ): Promise<void> => {
    if (writing.current) return
    writing.current = true
    const alive = beginWrite()
    const sameOwner = (): boolean =>
      alive() &&
      identity.current.client === client &&
      identity.current.kind === kind &&
      identity.current.id === id &&
      identity.current.userId === userId
    const current = (): boolean => active() && sameOwner()
    setBusy(true)
    setError(undefined)
    try {
      if (give) await client.addRole(kind, id, userId, role)
      else await client.removeRole(kind, id, userId, role)
      if (current()) {
        onChanged?.()
        await refreshSaved(sameOwner)
      }
    } catch (caught) {
      if (current())
        setError(
          caught instanceof Error ? caught.message : 'Something went wrong'
        )
      throw caught
    } finally {
      if (sameOwner()) {
        writing.current = false
        setBusy(false)
      }
    }
  }

  if (profile == null)
    return (
      <Screen>
        <Card>
          <Text style={styles.muted}>
            {savedUnavailable
              ? 'Change saved. This person is no longer available in this group.'
              : readError != null
                ? 'Change saved. This profile could not be refreshed.'
                : refused
                  ? lstrings.profile_refused
                  : lstrings.common_loading}
          </Text>
          {readError != null && (
            <>
              <Text accessibilityRole="alert" style={styles.error}>
                {readError}
              </Text>
              <Button
                label="Retry"
                onPress={() => {
                  const current = beginWrite()
                  setReadError(undefined)
                  refreshSaved(current).catch(() => undefined)
                }}
              />
            </>
          )}
        </Card>
      </Screen>
    )

  const { person, context, guardianOf, sections, viewer } = profile
  const name = person.fullName ?? person.shortName
  return (
    <Screen>
      <View style={styles.page}>
        <Card>
          <View style={styles.hero}>
            <Emblem
              uri={person.avatarUrl}
              fallback={initialsOf(person.shortName)}
              shape="circle"
              size={4.5}
            />
            <View style={styles.heroText}>
              <Text style={styles.name} accessibilityRole="header">
                {name}
              </Text>
              <Text style={styles.context}>
                {sprintf(contextLine(context.kind), context.name)}
              </Text>
            </View>
          </View>
          {props.onOpenChat != null && (
            <PersonMessageButton
              key={person.userId}
              client={client}
              userId={person.userId}
              onOpenChat={props.onOpenChat}
            />
          )}
        </Card>

        {guardianOf.length > 0 && (
          <View style={styles.section}>
            <SectionHeader
              title={lstrings.profile_guardian_of}
              note={String(guardianOf.length)}
            />
            <ListCard>
              {guardianOf.map(child => (
                <ListRow
                  key={child.userId}
                  title={child.shortName}
                  emblem={initialsOf(child.shortName)}
                  emblemUri={child.avatarUrl}
                  emblemShape="circle"
                  onPress={
                    onOpenPlayer == null
                      ? undefined
                      : () => {
                          onOpenPlayer(child.userId, child.shortName, {
                            onTeam: child.teamId
                          })
                        }
                  }
                />
              ))}
            </ListCard>
          </View>
        )}

        {viewer.manages && !person.canHoldRoles && (
          <Text style={styles.muted}>
            {sprintf(lstrings.profile_no_sign_in, person.shortName)}
          </Text>
        )}
        {error != null && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}

        {sections.map(section => (
          <View
            key={section.level}
            style={styles.section}
            testID={`roles-${section.level}`}
          >
            <SectionHeader
              title={sectionTitle(section)}
              note={section.groups.map(group => group.name).join(' · ')}
            />
            {!section.editable && section.level !== context.kind && (
              <Text style={styles.muted}>
                {sprintf(
                  lstrings.profile_level_note,
                  section.groups.map(group => group.name).join(', ')
                )}
              </Text>
            )}
            <RoleRows
              section={section}
              owner={client}
              ownerLabel={name}
              ownerIdentity={`${kind}:${id}:${userId}`}
              canHoldRoles={person.canHoldRoles}
              viewer={viewer}
              busy={busy}
              onAdd={role => {
                change(role, true).catch(() => undefined)
              }}
              onRemove={async (role, current) => {
                await change(role, false, current)
              }}
            />
          </View>
        ))}
      </View>
    </Screen>
  )
}

/** `Team · %s`, `Season · %s`, `League · %s`. */
function contextLine(kind: 'league' | 'season' | 'team'): string {
  if (kind === 'team') return lstrings.profile_context_team
  if (kind === 'season') return lstrings.profile_context_season
  return lstrings.profile_context_league
}

export function sectionTitle(section: ProfileSection): string {
  if (section.level === 'team') return lstrings.profile_team_roles
  if (section.level === 'season') return lstrings.profile_season_roles
  return lstrings.profile_league_roles
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(theme.spaceLgRem) },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  heroText: { flex: 1, gap: theme.rem(theme.spaceXsRem) },
  name: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  context: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.secondaryTextColor
  },
  section: { gap: theme.rem(theme.spaceMdRem) },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
