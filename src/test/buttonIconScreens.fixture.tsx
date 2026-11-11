import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { Composer } from '../app/chat/Composer'
import { MessageActions } from '../app/chat/MessageActions'
import { PlayerSearchField } from '../app/components/PlayerSearchField'
import { TextField } from '../app/components/TextField'
import { BarButton, ExitButton } from '../app/player/multiCam/barParts'
import { OverlayButton } from '../app/stream/overlay/OverlayButton'
import { RecordButton } from '../app/stream/overlay/RecordButton'
import { SlideToStop } from '../app/stream/overlay/SlideToStop'
import { TessChat } from '../app/tess/TessChat'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { WalkUpControl } from '../app/walkup/WalkUpControl'

/** Isolated production screen regions with deterministic, synthetic state. */
export function ButtonIconScreensFixture({
  screen
}: {
  screen: string
}): React.ReactElement {
  const [action, setAction] = useState('ready')
  const [text, setText] = useState('Ready for practice')
  const [playing, setPlaying] = useState(false)
  const hit = (name: string): void => {
    setAction(name)
  }
  return (
    <ThemeProvider>
      <View style={{ flex: 1, paddingTop: 60, backgroundColor: '#f5f7f1' }}>
        <Text
          style={{ textAlign: 'center', height: 28 }}
        >{`Action: ${action}`}</Text>
        {screen === 'chat' && (
          <View
            style={{
              flex: 1,
              justifyContent: 'flex-end',
              padding: 16,
              gap: 16
            }}
          >
            <Text>Practice starts at six.</Text>
            <MessageActions
              reply
              react
              visible
              onReply={() => {
                hit('reply')
              }}
              onReact={() => {
                hit('react')
              }}
              onMore={() => {
                hit('more')
              }}
            />
            <Composer
              text={text}
              onText={setText}
              enabled
              sending={false}
              context={{
                kind: 'reply',
                name: 'Mike Trout',
                snippet: 'Practice starts at six.'
              }}
              onCancelContext={() => {
                hit('cancel-reply')
              }}
              attachments={[]}
              onRemoveAttachment={() => {
                hit('remove')
              }}
              sources={['files']}
              onAttach={() => {
                hit('attach')
              }}
              onSend={() => {
                hit('send')
              }}
            />
          </View>
        )}
        {screen === 'tess' && (
          <TessChat
            takesFocus={() => false}
            onClose={() => {
              hit('close')
            }}
            onNavigate={() => {
              hit('navigate')
            }}
            tess={{
              loading: false,
              messages: [],
              thinking: false,
              live: null,
              thoughtSeconds: {},
              error: null,
              queued: [
                {
                  id: 'queued',
                  text: 'Show the next practice',
                  attachments: [],
                  seq: 1
                }
              ],
              send: async () => {
                hit('send')
                return true
              },
              upload: async () => null,
              sendNow: async () => {
                hit('send-now')
              },
              unqueue: () => {
                hit('remove-queued')
              },
              editQueued: () => null,
              confirmAll: async () => {
                hit('confirm')
              },
              stop: async () => {
                hit('stop')
              },
              showError: () => {
                hit('error')
              }
            }}
          />
        )}
        {screen === 'stream' && (
          <View
            style={{
              flex: 1,
              backgroundColor: '#33413b',
              padding: 24,
              justifyContent: 'space-between'
            }}
          >
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between' }}
            >
              <OverlayButton
                glyph="flip"
                accessibilityLabel="Flip camera"
                onPress={() => {
                  hit('flip')
                }}
              />
              <OverlayButton
                glyph="settings"
                accessibilityLabel="Camera settings"
                onPress={() => {
                  hit('settings')
                }}
              />
            </View>
            <View style={{ gap: 24, alignItems: 'center' }}>
              <RecordButton
                recording={playing}
                onPress={() => {
                  setPlaying(!playing)
                  hit('record')
                }}
              />
              <SlideToStop
                onStop={() => {
                  hit('stop')
                }}
              />
            </View>
          </View>
        )}
        {screen === 'player' && (
          <View
            style={{
              flex: 1,
              backgroundColor: '#17241e',
              justifyContent: 'flex-end',
              padding: 24
            }}
          >
            <ExitButton
              visible
              onPress={() => {
                hit('exit')
              }}
            />
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between' }}
            >
              <BarButton
                icon="volume_up"
                hint="Sound"
                onPress={() => {
                  hit('sound')
                }}
              />
              <BarButton
                icon="replay_10"
                hint="Rewind"
                onPress={() => {
                  hit('rewind')
                }}
              />
              <BarButton
                icon={playing ? 'pause' : 'play_arrow'}
                hint="Play"
                onPress={() => {
                  setPlaying(!playing)
                  hit('play')
                }}
              />
              <BarButton
                icon="forward_10"
                hint="Forward"
                onPress={() => {
                  hit('forward')
                }}
              />
            </View>
          </View>
        )}
        {screen === 'search' && (
          <View style={{ padding: 24, gap: 24 }}>
            <TextField label="Name" value={text} onChangeText={setText} />
            <PlayerSearchField value={text} onChangeText={setText} />
          </View>
        )}
        {screen === 'walkup' && (
          <View style={{ padding: 24, height: 180 }}>
            <WalkUpControl
              batterName="Mike Trout"
              playing={playing}
              dimmed={false}
              onPress={() => {
                setPlaying(!playing)
                hit('song')
              }}
            />
          </View>
        )}
      </View>
    </ThemeProvider>
  )
}
