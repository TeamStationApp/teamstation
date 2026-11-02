# TeamStation TV

The tvOS target uses React Native TV with an isolated dependency tree. Shared application code lives in `src/app/tv`. Build and run on a task-owned tvOS simulator; Android TV packaging is a later deliverable.

Install dependencies using the repository's approved dependency scanner in both the root and this directory, then run `pod install` in `ios`. Build with `bash appletv/scripts/build-simulator.sh` from the repository root. The simulator build uses ad-hoc signing and simulator-only Keychain entitlements. Device signing uses the normal provisioning identity; no signing team is committed.

Start Metro from `appletv` with `npm start -- --port 8097`. Run native tests from the repository root:

```sh
TV_SIMULATOR_UDID="$TV_SIMULATOR_UDID" bash appletv/scripts/test-native.sh
```

The script requires an explicit simulator, runs XCTest, and exports measured LLVM counters bound to the current native source files. `npm run coverage.tv` merges those counters with the shared JavaScript/component tests and enforces the changed-line gate. Set `TS_COVERAGE_BASE` to the feature branch's reviewed integration base. The companion web build must exist in `dist` for the browser approval journey.

Use a Maestro D build with explicit tvOS simulator support. Attach the app to the task's `appleTvNative` daemon with `--platform ios --device "$TV_SIMULATOR_UDID" --app-file appletv/DerivedData/Build/Products/Debug-appletvsimulator/TeamStationTV.app`. The Apple WDA driver uses platform `ios` for both iOS and tvOS and selects the WDA target from the explicit device's runtime. Browser approval uses the separate `appleTvExperience` daemon.

```sh
export TV_METRO_URL='http://127.0.0.1:8097/index.bundle?platform=ios&dev=true&minify=false'
# Also set TV_ARTIFACTS and MAESTRO_D_CLIENT_ROOT to task-owned paths.
node -r sucrase/register appletv/e2e/auth.e2e.ts
```

The authentication journey creates and removes an isolated database. It approves the TV's letters through the real companion web screen, relaunches to verify Keychain restoration, signs out, and expires a request to verify automatic renewal.

Generate a synthetic moving clock and run the four-player probe:

```sh
ffmpeg -y -f lavfi -i 'testsrc=duration=60:size=640x360:rate=15:decimals=1' -c:v libx264 -pix_fmt yuv420p -preset ultrafast -movflags +faststart "$TV_PROBE_FILE"
node -r sucrase/register appletv/e2e/probe.e2e.ts
```

The development-only probe checks that four native playback clocks keep advancing while the second angle is hidden, the first is enlarged, and both changes are reversed. These simulator results do not establish physical-device decoder capacity or frame pacing. Production builds ignore development API, Metro, and probe environment overrides.

## App icon and device installation

Regenerate the tvOS layered icon and top-shelf assets from the shared TeamStation app logo with `swift appletv/scripts/make-icons.swift`, run from the repository root. The asset catalog is validated by the tvOS build.

For a paired Apple TV, build the `TeamStationTV` workspace scheme in Release using the device destination and your local signing team. Release embeds the JavaScript bundle and defaults to `https://app.teamstation.app/api/v1`; it does not require Metro. Set the Xcode build setting `TV_API_BASE_URL` to an HTTPS API URL when building for another environment, for example `https://tv.example.test/api/v1`. The value is embedded in the app's `TVApiBaseUrl` Info.plist entry in both Debug and Release. Keep device identifiers and signing configuration outside source control. The selected server must have the TV authentication and collection endpoints deployed before sign-in can succeed.
