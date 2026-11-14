import React from 'react'
import { createRoot } from 'react-dom/client'
import { View } from 'react-native'

import { createDevelopmentSession } from '../app/scoring/developmentSession'
import type { ChatTurn } from '../app/scoring/RosterChat'
import { RosterEditor } from '../app/scoring/RosterEditor'
import { initialScoringState } from '../app/scoring/scoringMachine'
import { useScoringSheetTheme } from '../app/scoring/scoringSheetTheme'
import {
  ScopedThemeProvider,
  ThemeProvider,
  useTheme
} from '../app/theme/ThemeContext'
import { asGameDetail, asRosterEntry, type RosterEntry } from '../common/api'
import type { RosterQuestion } from '../common/scoring/rosterCommands'
import { copyState } from '../common/scoring/state'
import { userIdOfGumbo } from '../common/userId'
import { dictatingHealth, fakeDictation } from './dictationFakes'

/**
 * The real roster editor with its dictation chat open on the Defense tab: two
 * turns said earlier and a question still to answer, as the sheet opens over
 * a substitution said on the scoring screen. The turns and the question come
 * from the editor's `initialDraft`; `fakeDictation` only stands in for the
 * socket and microphone dictation needs, so no model is called. The home
 * team is the lineup fixture's (nine in the field, four on the bench), in
 * the scoring sheet's theme and margins. Served by `coachPlan.e2e.ts` from
 * `dist/` at an iPhone's 402×874.
 */
const NAMES = {
  away: [
    'Judge',
    'Altuve',
    'Bregman',
    'Alvarez',
    'Tucker',
    'Pena',
    'Diaz',
    'Maldonado',
    'Valdez'
  ],
  home: [
    'Ohtani',
    'Lindor',
    'Alonso',
    'Nimmo',
    'Marte',
    'McNeil',
    'Escobar',
    'Canha',
    'Senga',
    'Soto',
    'Harper',
    'Turner',
    'Freeman'
  ]
}
/** A team's players, numbered from 1 in order. */
function roster(names: readonly string[], firstId: number): RosterEntry[] {
  return names.map((name, index) =>
    asRosterEntry({
      userId: userIdOfGumbo(firstId + index),
      gumboId: firstId + index,
      shortName: name,
      jersey: String(index + 1),
      positions: [],
      isPlayer: true,
      role: 'player',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
    })
  )
}
const game = asGameDetail({
  nonMemberView: false,
  id: 'roster-chat-overlay',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: true,
  assignedRoles: { away: [], home: ['scorekeeper'] },
  videos: []
})
const session = createDevelopmentSession(
  game,
  roster(NAMES.away, 1),
  roster(NAMES.home, 101)
)
for (const player of Object.values(session.gameData.players))
  player.local = true
const state = initialScoringState(session)
const away = state.session.liveData.boxscore.teams.away
const home = state.session.liveData.boxscore.teams.home
const chat: ChatTurn[] = [
  {
    key: 0,
    said: 'Number 5 plays shortstop',
    lines: [{ kind: 'done', text: 'Marte to SS' }]
  },
  { key: 1, said: 'Number 3 subs in at third base', lines: [] }
]
const question: RosterQuestion = {
  question: 'Which #3?',
  options: [
    {
      label: 'Owls #3',
      side: 'away',
      commands: [
        {
          type: 'setPositions',
          side: 'away',
          places: [{ player: away.battingOrder[2], position: '3B' }]
        }
      ]
    },
    {
      label: 'Hawks #3',
      side: 'home',
      commands: [
        {
          type: 'setPositions',
          side: 'home',
          places: [{ player: home.battingOrder[2], position: '3B' }]
        }
      ]
    }
  ]
}
const dictation = fakeDictation()

function Sheet(): React.ReactElement {
  const theme = useScoringSheetTheme()
  return (
    <ScopedThemeProvider theme={theme}>
      <Editor />
    </ScopedThemeProvider>
  )
}

function Editor(): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      style={{
        flex: 1,
        padding: 16,
        backgroundColor: theme.backgroundColor
      }}
    >
      <RosterEditor
        state={state}
        initialDraft={{
          draft: copyState(state.session),
          side: 'home',
          mode: 'defense',
          chat,
          question
        }}
        dictate={{
          health: dictatingHealth,
          url: 'ws://127.0.0.1/api/v1/dictation',
          gameId: game.id,
          log: state.log,
          startEnabled: true,
          tapMs: 0,
          tailMs: 0,
          openSocket: dictation.openSocket,
          openMicrophone: dictation.openMicrophone
        }}
        onCancel={() => {}}
        onSave={() => {}}
      />
    </View>
  )
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <Sheet />
  </ThemeProvider>
)
// The editor's dictation opens its socket once it knows the server
// dictates; the fake's opens when asked, as a real one does on connecting.
const opening = setInterval(() => {
  if (dictation.sockets.length === 0) return
  clearInterval(opening)
  dictation.socket().open()
}, 50)
