import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Pressable, Text } from 'react-native'

import { GameScreen } from '../app/screens/GameScreen'
import { fakePhoneStreamModule } from '../app/stream/fakePhoneStreamModule'
import { makePhoneStream } from '../app/stream/phoneStreamClient'
import type { StreamingScreenProps } from '../app/stream/StreamingScreen.native'
import { useGameRecording } from '../app/stream/useGameRecording.native'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asGameDetail, type LiveStream, TeamStationClient } from '../common/api'

const DEVICE = '00000000-0000-4000-8000-000000000001'
const game = asGameDetail({
  id: 'game-recording',
  homeTeamId: 'home',
  awayTeamId: 'away',
  homeTeamName: 'Owls',
  awayTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'none',
  ingestMessage: null,
  videos: [],
  canScore: true,
  canDj: false,
  coachSides: ['home'],
  assignedRoles: { away: [], home: ['coach', 'scorekeeper', 'videographer'] },
  nonMemberView: false
})
let streams: LiveStream[] = []
const native = fakePhoneStreamModule({
  capabilities: { supported: true, deviceModel: 'Phone' },
  recordings: []
})
const phone = makePhoneStream(native)
const client = new TeamStationClient({ baseUrl: '/api/v1' })
client.game = async () => game
client.teams = async () => []
client.gameScheduling = async () => {
  throw new Error('No scheduling')
}
client.liveStreams = async () => ({
  gameId: game.id,
  mine: streams,
  others: [],
  canAdd: 4,
  maxCameras: 4
})
client.addLiveStream = async (_gameId, name, options) => {
  if (streams.length > 0 && options?.heldStreamId !== streams[0].id)
    throw new Error('A continuation must keep its stream')
  const stream: LiveStream = {
    id: 'liv_00000000000000000001',
    gameId: game.id,
    userId: 7,
    ownerName: 'Mookie Betts',
    slot: 1,
    label: name ?? 'Home',
    keyPrefix: 'ts_0000',
    state: 'idle',
    opensAt: '2026-05-20T16:00:00.000Z',
    closesAt: null,
    videoId: null,
    lastError: null,
    status: null,
    deviceId: DEVICE,
    deviceModel: 'Phone',
    localRecording: 'none',
    url: 'rtmp://ingest.example.test/live/ts_0000'
  }
  streams = [stream]
  return stream
}
function Camera(props: StreamingScreenProps): React.ReactElement {
  return (
    <>
      <Text>Recording camera: {props.session.angleName}</Text>
      <Text>
        {props.startOnOpen === true
          ? 'Automatic start requested'
          : 'Waiting to start'}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close camera"
        onPress={props.onClose}
      >
        <Text>Close camera</Text>
      </Pressable>
    </>
  )
}
function Fixture(): React.ReactElement {
  const [coach, setCoach] = useState(false)
  const recording = useGameRecording(
    client,
    game.id,
    phone,
    async () => DEVICE,
    Camera
  )
  return (
    <>
      {coach && <Text>Coach opened</Text>}
      <GameScreen
        client={client}
        gameId={game.id}
        initialTab="watch"
        recording={recording}
        onCoachGame={() => {
          setCoach(true)
        }}
      />
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <Fixture />
  </ThemeProvider>
)
