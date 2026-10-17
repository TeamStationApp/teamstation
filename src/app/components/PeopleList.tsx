import React from 'react'
import { View } from 'react-native'

import type { RosterEntry, RosterSection } from '../../common/api'
import type { StringKey } from '../locales/en_US'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { initialsOf } from './initials'
import { ListCard } from './ListCard'
import { ListRow } from './ListRow'
import { flagLabel } from './RolesModal'
import { SectionHeader } from './SectionHeader'

/** The sections of a people list, in order, each with its heading. */
export const PEOPLE_SECTIONS: ReadonlyArray<
  readonly [RosterSection, StringKey]
> = [
  ['admin', 'roster_admins'],
  ['staff', 'roster_staff'],
  ['player', 'roster_players'],
  ['family', 'roster_family'],
  ['spectator', 'roster_spectators'],
  ['follower', 'roster_followers']
]

export interface PeopleListProps {
  people: RosterEntry[]
  /**
   * What tapping a person opens, or nothing for a row that opens nothing.
   * The caller decides: a player opens their page for whoever may see it,
   * and anybody else opens their profile for whoever manages the level.
   */
  onOpen?: (person: RosterEntry) => (() => void) | undefined
}

/**
 * A team's roster, or a season's or league's people: Admins, Staff, Players,
 * Family members, Spectators and Followers. The server decides who is in
 * which section; this draws them in order and leaves out an empty one.
 */
export function PeopleList({
  people,
  onOpen
}: PeopleListProps): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <>
      {PEOPLE_SECTIONS.map(([section, heading]) => {
        const listed = people.filter(person => person.section === section)
        if (listed.length === 0) return null
        return (
          <View key={section} style={styles.section}>
            <SectionHeader
              title={lstrings[heading]}
              note={String(listed.length)}
            />
            <ListCard>
              {listed.map(person => (
                <PersonRow
                  key={person.userId}
                  person={person}
                  onPress={onOpen?.(person)}
                />
              ))}
            </ListCard>
          </View>
        )
      })}
    </>
  )
}

/** Shared member/public presentation; callers alone supply navigation. */
type PersonPresentation = Pick<
  RosterEntry,
  | 'shortName'
  | 'section'
  | 'staffRoles'
  | 'positions'
  | 'teamNames'
  | 'guardianOf'
  | 'avatarUrl'
  | 'inheritedFrom'
  | 'jersey'
>
export function PersonRow({
  person,
  onPress
}: {
  person: PersonPresentation
  onPress?: () => void
}): React.ReactElement {
  return (
    <ListRow
      title={person.shortName}
      subtitle={peopleSubtitle(person)}
      emblem={initialsOf(person.shortName)}
      emblemUri={person.avatarUrl}
      emblemShape="circle"
      badgeLabel={inheritedPill(person)}
      badgeTone="neutral"
      trailing={
        person.jersey == null || person.jersey.trim() === ''
          ? undefined
          : `#${person.jersey.trim()}`
      }
      onPress={onPress}
    />
  )
}

/**
 * The line under a name: a player's positions, or on a season's or league's
 * list the teams they play on; for an admin or staff the roles they hold,
 * `Coach · Scorekeeper`; and for a family member the players here they are a
 * parent or guardian of, `Parent/guardian of Avery S`.
 */
export function peopleSubtitle<T extends PersonPresentation>(
  person: T
): string | undefined {
  if (person.section === 'family')
    return person.guardianOf != null && person.guardianOf.length > 0
      ? sprintf(lstrings.roster_guardian_of, person.guardianOf.join(', '))
      : undefined
  const parts =
    person.section === 'admin' || person.section === 'staff'
      ? person.staffRoles.map(flagLabel)
      : person.teamNames != null && person.teamNames.length > 0
        ? person.teamNames
        : person.positions
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * The pill on somebody given their place by a level above, naming the
 * highest one: `Season coach`, `League admin`, and for a member of a season
 * or league above `Season spectator`.
 */
export function inheritedPill(
  person: Pick<RosterEntry, 'inheritedFrom'>
): string | undefined {
  const from = person.inheritedFrom
  if (from == null) return undefined
  return sprintf(
    lstrings.roster_inherited_pill,
    from.level === 'league'
      ? lstrings.roster_level_league
      : lstrings.roster_level_season,
    lstrings[`roster_role_${from.role}`]
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  }
}))
