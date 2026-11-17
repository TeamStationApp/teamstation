import React from 'react'
import { View } from 'react-native'

import type { RosterEntry, RosterSection } from '../../common/api'
import type { StringKey } from '../locales/en_US'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { ListCard } from './ListCard'
import { ListRow } from './ListRow'
import { PersonAffiliationLine } from './PersonAffiliationLine'
import { positionLabel } from './roleLabels'
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
  /**
   * Sections drawn even with nobody in them: the header and a `0` count,
   * and no empty card.
   */
  kept?: readonly RosterSection[]
  /**
   * What adds somebody to a section: a pill left of its count, or under an
   * empty section's header a blue button the size of Add Game.
   */
  adds?: Partial<Record<RosterSection, PeopleAdd>>
}

/** An add on a people section, opening wherever people are added to it. */
export interface PeopleAdd {
  label: string
  /** Names the group, since several sections carry an add. */
  accessibilityLabel: string
  onPress: () => void
}

/**
 * A team's roster, or a season's or league's people: Admins, Staff, Players,
 * Family members, Spectators and Followers. The server decides who is in
 * which section; this draws them in order and leaves out an empty one,
 * unless it is `kept`.
 */
export function PeopleList({
  people,
  onOpen,
  kept = [],
  adds = {}
}: PeopleListProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <>
      {PEOPLE_SECTIONS.map(([section, heading]) => {
        const listed = people.filter(person => person.section === section)
        if (listed.length === 0 && !kept.includes(section)) return null
        const add = adds[section]
        const testID = `people-add-${section}`
        return (
          <View key={section} style={styles.section}>
            <SectionHeader
              title={lstrings[heading]}
              note={String(listed.length)}
              noteActions={
                add == null || listed.length === 0
                  ? undefined
                  : [{ ...add, testID }]
              }
            />
            {listed.length === 0 ? (
              add == null ? null : (
                <Button
                  label={add.label}
                  accessibilityLabel={add.accessibilityLabel}
                  testID={testID}
                  color={theme.scoreActionColor}
                  style={styles.emptyAdd}
                  onPress={() => {
                    add.onPress()
                  }}
                />
              )
            ) : (
              <ListCard>
                {listed.map(person => (
                  <PersonRow
                    key={person.userId}
                    person={person}
                    onPress={onOpen?.(person)}
                  />
                ))}
              </ListCard>
            )}
          </View>
        )
      })}
    </>
  )
}

/** Add Staff and Add Spectator, each opening the group's Add People screen. */
export function peopleAdds(
  name: string,
  onAddPeople: (role?: 'admin') => void
): Partial<Record<RosterSection, PeopleAdd>> {
  return {
    admin: {
      label: lstrings.people_add_admin,
      accessibilityLabel: sprintf(lstrings.people_add_admin_to, name),
      onPress: () => {
        onAddPeople('admin')
      }
    },
    staff: {
      label: lstrings.people_add_staff,
      accessibilityLabel: sprintf(lstrings.people_add_staff_to, name),
      onPress: () => {
        onAddPeople()
      }
    },
    spectator: {
      label: lstrings.people_add_spectator,
      accessibilityLabel: sprintf(lstrings.people_add_spectator_to, name),
      onPress: () => {
        onAddPeople()
      }
    }
  }
}

/** Shared member/public presentation; callers alone supply navigation. */
type PersonPresentation = Pick<
  RosterEntry,
  | 'userId'
  | 'shortName'
  | 'section'
  | 'staffRoles'
  | 'isHeadCoach'
  | 'positions'
  | 'avatarUrl'
  | 'inheritedFrom'
  | 'jersey'
> & {
  /** The affiliation line under the name; none on a public page. */
  affiliations?: string
}
export function PersonRow({
  person,
  onPress
}: {
  person: PersonPresentation
  onPress?: () => void
}): React.ReactElement {
  const subtitle = peopleSubtitle(person)
  return (
    <ListRow
      title={person.shortName}
      subtitle={subtitle}
      accessibilityLabel={[person.shortName, subtitle, person.affiliations]
        .filter(part => part != null && part !== '')
        .join(', ')}
      person={{
        userId: person.userId,
        uri: person.avatarUrl
      }}
      badgeLabel={inheritedPill(person)}
      badgeTone="neutral"
      trailing={
        person.jersey == null || person.jersey.trim() === ''
          ? undefined
          : `#${person.jersey.trim()}`
      }
      detailContent={
        <PersonAffiliationLine affiliations={person.affiliations} />
      }
      onPress={onPress}
    />
  )
}

/**
 * What somebody does here, on the line under their name and above their
 * affiliation line: a player's positions, and for an admin or staff the
 * roles they hold, `Coach · Scorekeeper`. Their teams and the players or
 * guardians they are tied to are the affiliation line's.
 */
export function peopleSubtitle<T extends PersonPresentation>(
  person: T
): string | undefined {
  const parts =
    person.section === 'admin' || person.section === 'staff'
      ? person.staffRoles.map(flag => positionLabel(flag, person.isHeadCoach))
      : person.section === 'family'
        ? []
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
  },
  emptyAdd: { alignSelf: 'center' as const }
}))
