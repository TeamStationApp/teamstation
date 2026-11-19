# TS Speedy for Android

The Android build of TS Speedy: a paired TAG One radar's pitch speed and exit velocity, large and
spoken. Phones only, portrait only. It behaves as the iPhone build does; see
[`../tsSpeedy/README.md`](../tsSpeedy/README.md) for what it shows and says.

## Build and test

```bash
SPEEDY_ANDROID_SERIAL=<serial> bash scripts/build.sh   # debug APK, installed on that phone
bash scripts/test-unit.sh                              # Robolectric suites
COVERAGE=1 bash scripts/test-unit.sh                   # and Kover's 90% gate plus changed-line coverage
```

Both builds are signed with a debug keystore (`TS_ANDROID_DEBUG_KEYSTORE`, by default
`~/.android/debug.keystore`); Mason re-signs the release APK.

## Layout

```
app/src/main/kotlin/app/teamstation/speedy/
  MainActivity.kt         keeps the screen on, asks for Bluetooth, starts the radar, passes UI-test links on
  SpeedyEnvironment.kt    the model, radar and player, once per process
  core/                   the logic: SpeedBoard, Phrase, Announcer, ReadoutMetrics, RadarStatus, Wav,
                          AudioSetting, the UI-test links, and SpeedyModel
  radar/FleetRadar.kt     streamcore's RadarFleet as one always-on radar
  audio/                  ClipPlayer, and the AudioTrack and audio focus it plays through
  ui/                     ReadoutScreen and SettingsScreen (Compose)
e2e/speedy.e2e.ts         maestro-d scenarios A1–A6 (steps in ../../test/speedy.ts)
../common/
  SpeedyVoice/            the voice clips, read here as assets
  android/streamcore/     the TAG One radar and its Bluetooth link, shared with TS Cameraman and the
                          TeamStation app
```

The radar needs Bluetooth scan and connect, and fine and coarse location: Android 12 and later
ignore a request for fine location that does not also ask for coarse. The app asks at launch and
starts the radar once that is answered; Settings offers the request again while it is refused.

The voice plays on the media stream, so the ringer's silent mode does not mute it, and other audio
ducks while it speaks.

## UI tests

Launched with the `uiTest` extra, the app answers the same `tsspeedy://test/…` links as the iPhone
build, shows `speedy-speech-log` and `speedy-awake` black on black, and writes what its player played
to `files/speech-capture.wav`.
