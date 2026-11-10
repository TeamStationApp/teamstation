import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Text } from 'react-native'

import { GameScreen } from '../app/screens/GameScreen'
import { CameraAnglesPanel } from '../app/stream/CameraAnglesPanel.native'
import {
  fakePhoneStreamModule,
  RECORDING,
  STATUS_EVENT
} from '../app/stream/fakePhoneStreamModule'
import { makePhoneStream } from '../app/stream/phoneStreamClient'
import {
  StreamingScreen,
  type StreamingScreenProps
} from '../app/stream/StreamingScreen.native'
import { useGameRecording } from '../app/stream/useGameRecording.native'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asGameDetail, type LiveStream, TeamStationClient } from '../common/api'
import { userIdOfGumbo } from '../common/userId'

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
const mode = new URLSearchParams(location.search)
const interrupted = mode.get('interrupted')

const native = fakePhoneStreamModule({
  capabilities: {
    supported: true,
    deviceModel: 'Phone',
    canRecordLocally: true
  },
  recordings: []
})
const originalStart = native.startRecording
native.startRecording = async (...args) => {
  await originalStart(...args)
  native.emitStatus(STATUS_EVENT)
}
const originalStop = native.stopRecording
native.stopRecording = async () => {
  await originalStop()
  native.emitStatus({
    ...STATUS_EVENT,
    phase: 'idle',
    isRecording: false,
    recordingSeconds: 0
  })
  native.answers.recordings = [
    {
      ...RECORDING,
      gameId: game.id,
      liveStreamId: streams.find(s => s.deviceId === DEVICE)?.id
    }
  ]
}
const originalOpen = native.open
native.open = async (...args) => {
  await originalOpen(...args)
  native.emitStatus({
    ...STATUS_EVENT,
    phase: 'idle',
    isRecording: false,
    recordingSeconds: 0
  })
}
const phone = makePhoneStream(native)
Object.assign(window, { recordingFixture: { native, streams: () => streams } })
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
  maxCameras: 4,
  discarded: []
})
client.streamAccess = async () => ({
  canFilm: true,
  requested: false,
  canRequest: false,
  teamId: 'home'
})
client.updateLiveStream = async (_gameId, id) => streams.find(s => s.id === id)!
client.revealLiveStream = async (_gameId, id) => streams.find(s => s.id === id)!
client.revokeLiveStream = async (_gameId, id) => {
  streams = streams.filter(s => s.id !== id)
}
client.addLiveStream = async (_gameId, name, options) => {
  const held = streams.find(s => s.id === options?.heldStreamId)
  if (held != null) return held
  const stream: LiveStream = {
    id: `liv_${String(streams.length + 1).padStart(20, '0')}`,
    gameId: game.id,
    userId: userIdOfGumbo(7),
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
    deviceId: options?.deviceId ?? null,
    deviceModel: options?.deviceModel ?? null,
    source: options?.source ?? null,
    localRecording: 'none',
    url: 'rtmp://ingest.example.test/live/ts_0000'
  }
  streams = [...streams, stream]
  if (interrupted != null && options?.deviceId != null) {
    native.answers.interruptedSession = {
      liveStreamId: interrupted === 'other' ? 'liv_other' : stream.id,
      gameId: game.id,
      angleName: stream.label,
      streaming: true,
      downtimeSeconds: 10
    }
    native.answers.resumeInterrupted = true
  }
  return stream
}
function Camera(props: StreamingScreenProps): React.ReactElement {
  return <StreamingScreen {...props} />
}
function Fixture(): React.ReactElement {
  const [coach, setCoach] = useState(false)
  const recording = useGameRecording(
    client,
    game.id,
    true,
    phone,
    async () => DEVICE,
    Camera
  )
  return (
    <>
      {coach && <Text>Coach opened</Text>}
      {mode.has('videos') ? (
        <CameraAnglesPanel
          signedIn
          client={client}
          gameId={game.id}
          phone={phone}
          deviceId={async () => DEVICE}
          Screen={Camera}
          hasVideo={false}
        />
      ) : (
        <GameScreen
          signedIn
          client={client}
          gameId={game.id}
          initialTab="watch"
          recording={recording}
          onCoachGame={() => {
            setCoach(true)
          }}
        />
      )}
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <Fixture />
  </ThemeProvider>
)
