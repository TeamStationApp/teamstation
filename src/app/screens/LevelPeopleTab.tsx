import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'

import type { LevelPeople, TeamStationClient } from '../../common/api'
import { Card } from '../components'
import { PeopleList } from '../components/PeopleList'
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
}

/**
 * A season's or league's People tab: its people in the roster's six
 * sections, opened the way a team's are. A player's row opens their page;
 * for the level's administrators, coaches and assistants every other row
 * opens that person's profile, where their roles here are changed.
 */
export function LevelPeopleTab(props: LevelPeopleTabProps): React.ReactElement {
  const { client, kind, id, onOpenPlayer, onOpenPerson } = props
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
  if (answer.people.length === 0)
    return (
      <Card>
        <Text style={styles.muted}>{lstrings.people_none}</Text>
      </Card>
    )
  return (
    <PeopleList
      people={answer.people}
      onOpen={person => {
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

const getStyles = cacheStyles((theme: Theme) => ({
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  }
}))
