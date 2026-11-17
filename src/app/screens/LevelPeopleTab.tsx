import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'

import type {
  LevelPeople,
  RosterSection,
  TeamStationClient
} from '../../common/api'
import { Card } from '../components'
import { peopleAdds, PeopleList } from '../components/PeopleList'
import { useSceneReveals } from '../components/sceneShown'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface LevelPeopleTabProps {
  client: TeamStationClient
  kind: 'league' | 'season'
  id: string
  /** A player, opened on their page, narrowed to the season it was. */
  onOpenPlayer?: (
    userId: string,
    name: string,
    from?: { seasonId?: string }
  ) => void
  /** Anybody else, as a profile, for whoever manages the level's people. */
  onOpenPerson?: (userId: string, name: string) => void
  /** The level's name, for the adds' accessible labels. */
  name?: string
  /**
   * The level's Add People screen, which Add Staff and Add Spectator open
   * for its administrators.
   */
  onAddPeople?: (role?: 'admin') => void
}

/**
 * A season's or league's People tab: its people in the roster's sections,
 * with no Players (the server lists nobody for playing). Admins, Staff and
 * Spectators show their header and count even when empty, and the level's
 * administrators get Add Staff and Add Spectator beside them. Your own row
 * opens your profile here, including when you also play on a team the level
 * reaches, because that player page has no section for this level. Anyone
 * else's player row opens their page. Every other row opens a profile for
 * the level's administrators, coaches and assistants.
 */
export function LevelPeopleTab(props: LevelPeopleTabProps): React.ReactElement {
  const { client, kind, id, onOpenPlayer, onOpenPerson, onAddPeople } = props
  const styles = getStyles(useTheme())
  const [answer, setAnswer] = useState<LevelPeople | undefined>()
  const [error, setError] = useState<string | undefined>()

  // A role, a player's settings or a removal, on a screen pushed over this.
  const reveals = useSceneReveals()
  useEffect(() => {
    let live = true
    client
      .levelPeople(kind, id)
      .then(found => {
        if (live) {
          setAnswer(found)
          setError(undefined)
        }
      })
      .catch((caught: unknown) => {
        if (live)
          setError(
            caught instanceof Error ? caught.message : 'People could not load'
          )
      })
    return () => {
      live = false
    }
  }, [client, id, kind, reveals])

  if (answer == null)
    return (
      <Card>
        <Text style={styles.muted}>{error ?? lstrings.common_loading}</Text>
      </Card>
    )
  return (
    <PeopleList
      people={answer.people}
      kept={KEPT}
      adds={
        answer.admin && onAddPeople != null
          ? peopleAdds(props.name ?? '', onAddPeople)
          : undefined
      }
      onOpen={person => {
        if (person.self && onOpenPerson != null)
          return () => {
            onOpenPerson(person.userId, person.shortName)
          }
        if (person.isPlayer && onOpenPlayer != null)
          return () => {
            onOpenPlayer(
              person.userId,
              person.shortName,
              kind === 'season' ? { seasonId: id } : undefined
            )
          }
        if (answer.manages && onOpenPerson != null)
          return () => {
            onOpenPerson(person.userId, person.shortName)
          }
        return undefined
      }}
    />
  )
}

const KEPT: readonly RosterSection[] = ['admin', 'staff', 'spectator']

const getStyles = cacheStyles((theme: Theme) => ({
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  }
}))
