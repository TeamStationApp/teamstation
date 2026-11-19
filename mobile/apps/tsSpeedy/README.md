# TS Speedy

A paired TAG One radar's pitch speed and exit velocity, in numbers big enough to read from the
dugout, and spoken aloud.

iPhone only, portrait only. The Android build is `../tsSpeedyAndroid`.

## What it does

- The pitch speed fills about 80% of the screen's width above a line 15% below the center; the exit
  velocity sits below the line at three quarters of that size. Each number turns to `--` five
  seconds after its reading. A number with three digits shrinks to fit.
- The gear opens Settings, which holds only the radar: pair one TAG One, see its status and battery,
  unpair it. Pairing another replaces it. The radar is always on.
- The speaker button turns the voice on and off. It starts on and is remembered. With it on:
  - a pitch is said alone, "56", once 250 ms have passed with no exit;
  - an exit within those 250 ms joins it, "56 and 52 exit";
  - a later exit, or an exit alone, is "52 exit".

  Only 20 to 99 is spoken. The clips are the shared `../common/SpeedyVoice` package. The voice plays
  under the silent switch and lowers other audio while it speaks.
- The screen never sleeps while the app is open.

## Quick start

TS Speedy has no server and no sign-in. Signing needs the Apple team in a one-line, gitignored
`clientConfig.json` beside `project.yml` (Mason writes it for its builds):

```json
{"appleTeamId": "<team>"}
```

```bash
npm run bootstrap                                     # generate Speedy.xcodeproj from project.yml
SPEEDY_SIMULATOR_UDID=<udid> npm run test:unit        # unit tests on a simulator
SPEEDY_SIMULATOR_UDID=<udid> COVERAGE=1 npm run test:unit   # and changed-line coverage, 90% or more
SPEEDY_DEVICE_UDID=<udid> npm run build:device        # build and install on an iPhone
```

`project.yml` is the source of truth for the Xcode project; the `.xcodeproj` is generated and not
committed.

## Layout

```
App/                      the app: SpeedyApp, ReadoutView, SettingsView, FleetRadar (the shared
                          radar fleet as one always-on radar), ClipPlayer (AVAudioEngine)
Packages/SpeedyCore/      the logic: SpeedBoard, Phrase, Announcer, ReadoutMetrics, RadarStatus,
                          Wav, AudioSetting, the UI-test links, and SpeedyModel
Tests/SpeedyUnitTests/    Swift Testing suites, hosted by the app
e2e/speedy.e2e.ts         maestro-d scenarios E1–E6 (steps in ../../test/speedy.ts)
../common/
  SpeedyVoice/            the voice clips and the xAI generator that made them
  CameramanCapture/       the TAG One radar and its Bluetooth link, shared with TS Cameraman and
                          the TeamStation app
```

## UI tests

Launched with `-uiTest true`, the app answers `tsspeedy://test/…` links:

| Link | Effect |
| --- | --- |
| `radar-feed?pitch=56&exit=0` | a reading, exactly as the radar delivers one |
| `radar-sequence?pitch=56&exit=52&gapMs=100` | a pitch, then its exit `gapMs` later |
| `reset` | clears the numbers, a waiting pitch and the speech log |

It also shows, black on black, `speedy-speech-log` (the last phrase spoken, as words, or `muted`)
and `speedy-awake`, and writes what its player plays to `Documents/speech-capture.wav`. Without
`-uiTest` none of this exists. See `e2e/speedy.e2e.ts` for how to run the scenarios.
