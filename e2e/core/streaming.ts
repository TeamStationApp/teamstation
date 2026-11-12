/**
 * The streaming scripts: those that publish, ingest, record or play video.
 * Their work, test and app, is owned apart from the rest of the suite, so a
 * full sweep lists them as disabled and runs none of them. `E2E_STREAMING=1`
 * runs them as any other script.
 */
export const STREAMING: readonly string[] = [
  'scripts/e2e/playbackReliability/playbackReliability.e2e.ts',
  'scripts/e2e/playerLayouts/capture.ts',
  'scripts/e2e/playerLayouts/liveProbe.ts',
  'scripts/e2e/scoreboardLog/e5.mjs',
  'scripts/e2e/scoreboardLog/f1Recording.ts',
  'src/app/cameraName.e2e.ts',
  'src/app/player/liveBuffer.e2e.ts',
  'src/app/player/liveMultiAngle.e2e.ts',
  'src/app/player/liveOrigin.e2e.ts',
  'src/app/player/liveOutage.e2e.ts',
  'src/app/player/liveStallDiagnostics.e2e.ts',
  'src/app/player/playbackControls.e2e.ts',
  'src/app/player/playerLayouts.e2e.ts',
  'src/app/player/playerLayoutsDevices.e2e.ts',
  'src/app/player/scoreboardOverlay/overlay.e2e.ts',
  'src/app/player/scoreboardOverlay/overlayPhone.e2e.ts',
  'src/app/quietStreamNative.e2e.ts',
  'src/app/stream/anglesEdgeStates.e2e.ts',
  'src/app/stream/bridgeSmoke.e2e.ts',
  'src/app/stream/focus.e2e.ts',
  'src/app/stream/gameRecording.e2e.ts',
  'src/app/stream/phoneStreaming2.e2e.ts',
  'src/app/stream/radarPairing.e2e.ts',
  'src/app/stream/streamManagement.e2e.ts',
  'src/app/stream/streamSettings.e2e.ts',
  'src/app/stream/streamingScreen.e2e.ts',
  'src/app/stream/twoDevices.e2e.ts',
  'src/app/stream/uploadRecording.e2e.ts',
  'src/app/stream/uploadReminder.e2e.ts',
  'src/server/director/cancelInterrupted.e2e.ts',
  'src/server/ingest/survive.e2e.ts',
  'src/server/live/localTail.e2e.ts',
  'src/server/media/secretPaths.e2e.ts'
]

const listed = new Set(STREAMING)

/** Why the sweep skips `file`, or null to run it. */
export function disabledFor(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!listed.has(file) || env.E2E_STREAMING === '1') return null
  return 'streaming: owned apart from this suite; E2E_STREAMING=1 runs it'
}

/** What the `streaming` fixture world made, as its manifest names it. */
export interface StreamingFixture {
  accounts: Record<string, { email: string; userId: string }>
  ids: Record<string, string>
}

/**
 * The scripts that need a game with videos already on it, for its angle
 * pills or its two recordings; every other script takes the game with none.
 */
const GAME_WITH_VIDEOS = new Set([
  'src/app/stream/bridgeSmoke.e2e.ts',
  'src/app/stream/streamSettings.e2e.ts'
])

/**
 * The `TS_STREAM_*` values a streaming script names that come from the
 * `streaming` fixture world: who films, who only watches, which game, and
 * whose walk-up song. Only the names the script uses are returned, so a
 * script's own value wins over nothing it did not ask for.
 */
export function streamingKnown(
  file: string,
  names: readonly string[],
  fixture: StreamingFixture
): Record<string, string> {
  const wanted = new Set(names)
  const { accounts, ids } = fixture
  const values: Record<string, string | undefined> = {
    TS_STREAM_EMAIL: accounts.coach?.email,
    TS_STREAM_VIEWER_EMAIL: accounts.viewer?.email,
    TS_STREAM_GAME: GAME_WITH_VIDEOS.has(file) ? ids.gameWithVideos : ids.game,
    TS_STREAM_WALKUP_PLAYER:
      ids.homeTeam == null || accounts.player == null
        ? undefined
        : `${ids.homeTeam}/${accounts.player.userId}`
  }
  const known: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (wanted.has(key) && value != null && value !== '') known[key] = value
  }
  return known
}
