import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import type { GameDetail, GameStationClient } from '../../common/api'
import { BaseballScreen } from '../field/BaseballScreen'
import { useFieldSurface } from '../field/useFieldSurface'
import { useScoringExit } from './useScoringExit'

export function ScoringScreen(props: {
  client: GameStationClient
  gameId: string
  onExit: () => void
}): React.ReactElement {
  const [game, setGame] = useState<GameDetail>()
  const [failed, setFailed] = useState(false)
  const [dirty, setDirty] = useState(false)
  const surface = useFieldSurface()
  const exit = useScoringExit(props.gameId, dirty, props.onExit)
  useEffect(() => {
    let live = true
    setGame(undefined)
    setFailed(false)
    props.client.game(props.gameId).then(
      value => {
        if (live) setGame(value)
      },
      () => {
        if (live) setFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [props.client, props.gameId])
  if (game == null)
    return (
      <View
        style={[
          surface.root,
          {
            backgroundColor: '#102b23',
            justifyContent: 'center',
            alignItems: 'center'
          }
        ]}
      >
        {failed ? (
          <Text style={{ color: 'white' }}>Game not found.</Text>
        ) : (
          <ActivityIndicator accessibilityLabel="Loading game" />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Exit Current Game"
          onPress={exit}
          style={{ padding: 20 }}
        >
          <Text style={{ color: 'white' }}>Exit Current Game</Text>
        </Pressable>
      </View>
    )
  return <BaseballScreen onExit={exit} onDirtyChange={setDirty} />
}
