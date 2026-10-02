# The phone apps

`src/app` has been a React Native application since it was written — views, text,
`StyleSheet`, Reanimated, Gesture Handler, a theme with no hex code in any
screen — and `react-native-web` is what renders it in a browser. These are the
same sources, rendered by iOS and Android instead.

There is no second app. There is one app, and a handful of files that exist
twice because a browser and a handset genuinely disagree.

## Running it

From the **repository root**, which is where the package is and therefore
where React Native takes its project root from: `ios/`, `android/`,
`index.js`, `metro.config.js` and `babel.config.js` all sit beside it, and the
sources they build are under `src/`.

```sh
npm install                # once
(cd ios && pod install)    # once, and after any native dependency changes
npm run metro              # leave running

npm run ios                # or: open ios/TeamStation.xcworkspace
npm run android
```

The first Android build fetches an SDK level and build-tools of its own —
React Native 0.87 compiles against 37 — so it takes a while and needs the
network, and then does not again.

`pod install` wants a UTF-8 locale. CocoaPods under Homebrew's Ruby throws
`Unicode Normalization not appropriate for ASCII-8BIT` without one:

```sh
(cd ios && LANG=en_US.UTF-8 pod install)
```

It talks to **production** by default — `PRIMARY_HOST` from
`src/common/primaryUrl.ts`, the same name the server builds its own links
from — so there is nothing else to start. Point it somewhere else for a day's
work against a local server:

```sh
TS_API_BASE_URL=http://192.168.1.20:9100/api/v1 npx react-native start --reset-cache
TS_API_BASE_URL=http://192.168.1.20:9100/api/v1 npm run ios
```

`--reset-cache` is not optional. Babel inlines the value and Metro caches the
transform, so changing it between runs silently keeps the old one baked in.

A LAN address, not the loopback: on a simulator `127.0.0.1` is the Mac, and on
a handset it is the handset. `app/native/config.ts` refuses a loopback rather
than building an app that can only talk to the machine that made it.

The sign-in screen offers an
e-mail code first; the password is behind *Use a password instead*.

## The rule: `foo.tsx` is the web, `foo.native.tsx` is the phone

`build.mjs`'s `resolveExtensions` contains no `.native.*`, so **the web bundle
cannot pick one up**; Metro prefers `.native.tsx`. That is the structural
guarantee, and it is worth being precise about what it does and does not say:
the shared files *are* edited — a `GlassView` in place of a glass style, a
`collapsable` on a card, a field that names its own return key — but every one
of those changes lands on **both** ends. Nothing is done to a shared file for
one platform's benefit alone; where the two genuinely disagree, that is what a
sibling is for. What exists twice:

| | |
|---|---|
| `navigation/useAddressBar` | `window.history` there; a history array and Android's Back here |
| `theme/fonts` | a CSS font stack there; one family name here |
| `assets/index` | a data URL there; a Metro asset here |
| `components/TsMark` | inline `<svg>` there; `react-native-svg` here |
| `components/Gradient` | a CSS gradient there; two SVG stops here |
| `components/GlassView` | `backdrop-filter` there; `UIGlassEffect` here |
| `components/useHandoff` | `getBoundingClientRect` there; `measure` on the animation thread here |
| `platform/clipboard`, `sessionStore`, `safeArea`, `nativeDriver` | what a browser gets for free |
| `player/VideoView`, `attachHls`, `engine` | a `<video>` and `hls.js` there; `react-native-video` here |
| `player/useKeyboardShortcuts` | arrow keys there; nothing to bind here |
| `screens/GameWatchLayout` | the one forked **region**, below |
| `field/FieldCanvas` | a `<canvas>` and WebGL2 there; expo-gl's `GLView` here, below |
| `scoring/OutcomePicker`, `scoring/MoreMenu` | the web's drop menus; here `DropMenuView` over `dropMenu.ts`: tap opens above the button, drag up and release chooses, with hover and submenus |

**A native sibling may not import from its own web twin.** Metro resolves
`./foo` inside `foo.native.tsx` back to `foo.native.tsx`, and the binding is
`undefined` at run time — silently. Anything two siblings share goes in a third
module that is neither of them: `videoViewProps.ts`, `gradientProps.ts`,
`keyboardShortcuts.ts`, `handoff.ts`, `insets.ts`, `resumeAfterRecovery.ts`,
`gameWatchLayoutProps.ts`.

`tsconfig.native.json` catches that, and much else. It resolves the way Metro
does — `moduleSuffixes: [".native", ""]` — and its library has **no `dom`**, so
a stray `window` or `getBoundingClientRect` is a compile error rather than a
crash on a device. Run all three:

```sh
npm run typecheck          # the page, and the server
npm run typecheck.native   # the app
```

## The scoring field: expo-gl without Expo

The scoring field is three.js through `@react-three/fiber`, and on a phone
Fiber draws through **expo-gl**, which needs **expo-modules-core**. Those two
are the only Expo packages installed; there is no `expo` package and no other
`expo-*`. Never a WebView.

### Versions, and why these

| | |
|---|---|
| `expo-gl` | **58.0.1** |
| `expo-modules-core` | **58.0.4** |
| `expo-modules-autolinking` | **58.0.3** (the Podfile and Gradle tooling, not app code) |
| `expo-modules-jsi` | **58.0.3**, pinned by an override |

React Native 0.87 falls between two Expo SDKs. SDK 57 (targets 0.86) was
tried first and **does not build** against 0.87:

- Android: its Gradle plugins compile with Kotlin 2.1.20, and 0.87's
  Gradle 9.4.1 ships a Kotlin 2.3 standard library that compiler cannot read.
- iOS: `ExpoModulesCore` precompiles React from 0.87's prebuilt
  `React.framework` and fails on `-Werror=non-modular-include-in-framework-module`.

SDK 58 (targets 0.88) carries the 0.87 fixes by name in its changelogs: the
Gradle plugins on Kotlin 2.2.21 and AGP 9.2.1 (0.87's), headers resolved from
0.87's self-contained XCFrameworks, and Expo module views receiving props on
0.87. Each version is the newest one at least seven days old when it was
chosen (the machine's `min-release-age`); `expo-modules-core` 58.0.4 asks for
`expo-modules-jsi ~58.0.3`, which would otherwise resolve to a newer release.

`overrides` also lets `expo-modules-core` accept the app's
`react-native-worklets` 0.12: its optional peer range stops at 0.10. The
worklets integration is not used by expo-gl.

`ios/Podfile` sets **iOS 16.4**, the floor `ExpoModulesCore` and `expo-gl`
declare; React Native's own is 15.1. The project's deployment target moved
with it.

### What stands in for the `expo` package

Installing `expo` would bring its CLI, `expo-asset`, `expo-file-system`,
`expo-font`, `expo-constants` and `expo-keep-awake`, and autolinking would
link every one of them into both apps. What this app needs from it is small,
and lives in `src/app/native/expoStandIn/`, installed as `expo` by a `file:`
dependency (so `npm ci` on the server installs it too):

- **The peer.** `expo-gl` names `expo` as a peer, and imports its
  `expo-modules-core` API from it. `index.js` re-exports that API.
- **`bin/autolinking`**, the one line Expo's Podfile and Gradle tooling run.
- **`assets.js`**, which `metro.config.js` resolves `expo-asset` and
  `expo-file-system` to. Fiber's native entry imports both, to load textures
  and files by URL. The field computes every surface and loads nothing by URL
  except a team's logo, so on a phone **the dugouts show no logo**; the load
  fails and `useTeamLogo` already treats that as no logo.

And the three pieces of native glue the `expo` package would otherwise own:

| | |
|---|---|
| `ios/Podfile` | `use_expo_modules!`, defined in place from `expo-modules-autolinking` (what `expo/scripts/autolinking.rb` does) |
| `ios/TeamStation/TSExpoModules.mm` | installs the Expo modules into each JavaScript runtime, as `EXReactNativeFactory` does — a category on `RCTReactNativeFactory`, which overrides nothing |
| `android/settings.gradle`, `build.gradle`, `app/build.gradle` | the `expo-autolinking-settings` plugin and `useExpoModules()`, `expo-root-project`, and `expo-autolinking` applied to the app |
| `android/.../ExpoModulesPackage.kt` | the `expo` package's `ExpoModulesPackage`, over the list `expo-autolinking` generates, added in `MainApplication` |

When bumping Expo, take one SDK line for all four packages and diff those
files against the same version of the `expo` package; they are copies.

### What the phone's field does differently

- **No shadow maps.** With `shadows` on, expo-gl on the Pixel 10 drew frames
  with the field missing or speckled whenever players moved. The players'
  blob shadows (`PlayerShadows`) still draw.
- **A new Canvas when the size changes.** expo-gl sizes its drawing buffer
  once, so a rotated phone drew the old frame stretched and torn.
- **Its own touch bridge** (`field/fieldTouches.ts`). Fiber's native Canvas
  sends the press from `onPanResponderStart`, and on the iPhone no press ever
  reached the scene. The bridge sends the same DOM pointer events from the
  responder grant, so the raycast hit-testing is the web's own.
- **Nameplates are views over the canvas** (`field/NativeNameplates.tsx`), as
  the browser's are HTML over its canvas, from the same `onNameplates` report.
  What a plate says is rendered by React when it changes; where it is moves
  each frame on the UI thread through a Reanimated shared value, so a moving
  player re-renders nothing.
- **The browser's resolution cap** (`fieldResolution.ts`, 1.25 on a phone).
  expo-gl always draws at the screen's full ratio, so the Canvas is laid out
  smaller and stretched over the field, and `FieldRenderScale` holds the
  scene at the field's own size so framing and hit-testing match the web.
  The scene's props come through a relay (`fieldPropsRelay.ts`) so the
  Canvas element never changes: Fiber reconfigures, and resizes, on every
  render of it.
- **The scoreboard texture is drawn when its words change**, not when the
  scoring screen hands over a new object with the same words: redrawing the
  1024×512 bulbs cost about 120 ms a render on the Pixel.
- **One trajectory angle a frame.** The drag reports every touch move and
  each report re-renders the scoring screen; `frameThrottle.ts` hands on the
  latest once a frame (on both ends).
- **The menu button is filled**, not glass: iOS 26's glass cannot see into
  the GL field and drew it empty.
- three's CommonJS build calls Node's `process.emitWarning`, so
  `metro.config.js` resolves `three` to its ES module, and `babel.config.js`
  adds the class static block transform three's classes need.

`tsconfig.native.json` includes `field/fiberNativeEvents.d.ts`, which declares
the DOM pointer members `FieldScene` reads, as Fiber's native events carry
them.

### Testing it on a phone against this Mac

A **Release** build embeds the bundle, so it needs no Metro; set
`TS_API_BASE_URL` on the build and Babel inlines it. Android's release
variant refuses cleartext HTTP, so a local run needs a variant that allows it
(a `localRelease` copied from `release` with
`manifestPlaceholders.usesCleartextTraffic = "true"`, not committed).

The URL is part of the bundle, so a build for a new URL has to make a new
bundle. Xcode's bundle phase always does, with `--reset-cache`. Gradle's
bundle task skips work it calls up to date, and the environment is not
something it compares, so `app/build.gradle` declares `TS_API_BASE_URL` as an
input of every bundle task: a changed value rebuilds the bundle, and the same
value leaves it alone. Build, install, then read the URL out of what is on
the phone rather than trusting the build:

```sh
cd android
TS_API_BASE_URL=http://<lan-ip>:9120/api/v1 ./gradlew assembleLocalRelease --console=plain \
  | grep createBundle        # no UP-TO-DATE after a URL change
adb install -r app/build/outputs/apk/localRelease/app-localRelease.apk
adb pull "$(adb shell pm path app.teamstation.app | sed -n 's/^package://p' | head -1)" installed.apk
unzip -p installed.apk assets/index.android.bundle | grep -ao 'http://[0-9.]*:[0-9]*/api/v1' | sort -u
```

On iOS the same check is
`grep -ao 'http://[0-9.]*:[0-9]*/api/v1' build-device/Build/Products/Release-iphoneos/TeamStation.app/main.jsbundle`.

WDA on the iPhone can report the phone as landscape while it is upright; a
point tap then lands at the transposed position. Tap by text wherever you
can.

## Walk-up music: the app's own TurboModule

`WalkUpMusic` is the one native module the app writes itself. Its spec is
`src/app/walkup/NativeWalkUpMusic.ts`, which `codegenConfig` in
`package.json` names `TeamStationWalkUpMusicSpec`; the screens use it through
`walkUpMusic.native.ts`, which is one call to the shared `makeWalkUpMusic.ts`.

- **iOS** (`ios/TeamStation/WalkUpMusic/`): `RCTWalkUpMusic.mm` over
  `WalkUpMusic.swift` (MusicKit) and `SystemVolume.swift` (the fades).
  `codegenConfig.ios.modulesProvider` maps the name to the class, so a new
  spec needs `pod install`. Catalog search and playback need the **MusicKit
  App Service** enabled on the `app.teamstation.app` App ID, and playback an
  Apple Music subscription on the phone; without them a search fails with
  Apple's own words, which the picker shows. The library search is only
  asked with media-library access: MediaPlayer crashes without it.
- **Android** (`android/.../co/teamstation/app/walkup/`): MediaStore, the
  system file picker and Media3 ExoPlayer, registered in `MainApplication`
  through `WalkUpMusicPackage`. The app's codegen library is linked by CMake
  only if it existed when CMake was configured: after adding or renaming a
  spec, `rm -rf android/app/.cxx` or the app starts with "'WalkUpMusic' could
  not be found".
- **Local files are matched by a hash** of the normalised title and artist
  and the length (`localFileId.ts`, `LocalFileId.kt`), held together by
  `localFileId.fixtures.json`; `(cd android && ./gradlew :app:testDebugUnitTest
  --tests '*LocalFileIdTest')` is the Kotlin half.
- **On a phone under test**: Maestro's `launchApp` grants every permission,
  so a check that starts without music access launches with `adb shell
  monkey` instead (`scripts/walkup-native-android.mjs`). Every playback
  report is logged under the `WalkUpMusic` tag and posted to `/api/v1/logs`
  as `[client walkUpMusic-<platform>]`.

## The video

Six modules drive the picture and every one was written against
`HTMLVideoElement`. They speak to `VideoHandle` now — exactly the members they
use, which `HTMLVideoElement` satisfies without being told to, so the web path
is a type change and nothing else.

`NativeVideoHandle` implements the same shape over a `react-native-video`
player, and it **owns the playhead** rather than reporting it: the quarter-speed
crawl integrates against `currentTime` frame by frame and the angle switch reads
it at the instant of the swap, while the player offers a promise and a callback
four times a second.

Two things about that are worth knowing before changing it:

- It tracks the **seek target**, not a count of seeks outstanding. ExoPlayer
  keeps one boolean and coalesces: ten seeks in ten frames — which is what a
  crawl does — are answered once, so a counter stays positive for ever and the
  playhead freezes where the crawl left it. There is a one-second watchdog for
  the seek Android never acknowledges at all, which is one issued while paused
  **and** buffering — a stalled live stream.
- **iOS and Android differ here more than anywhere else.** `RCTVideo` answers
  every seek; ExoPlayer does not. Anything about the playhead looks perfect on
  the simulator and can still be wrong on the emulator, so judge it on Android.

A failure that names the **address** escalates at once instead of climbing the
retry ladder: a playback URL carries a short-lived signed token, and once it has
expired the same address can never work. `addressIsWrong()` classifies it and
the caller mints a fresh URL.

## The one forked region

`app/screens/GameWatchLayout.tsx` and `.native.tsx`. The watch half of the game
screen is `position: sticky` plus a nested scroller with a measured height —
two things a browser does with a style and a phone cannot do at all.

The contract is what keeps the fork from spreading: it takes the **seven
rendered blocks** the screen has already built, as `ReactNode`s, and never a
game, a client or a list of highlights. Neither file knows what a game is.

The peg is a clamped `translateY` on the animation thread, not
`stickyHeaderIndices`. A sticky header docks at the scroll view's own top edge,
and this app's glass header *overlays* the scroll view, so it would peg the
picture **behind** the header — and the one lever that moves a sticky header
down is iOS-only. The clamp is what `sticky` inherits from its containing block
and is what stops the picture riding out over the stream panel.

## Liquid Glass

`ios/TeamStation/TSGlassView.mm`, a legacy `RCTViewManager` that React Native
0.87 still mounts under Fabric and finds by name. iOS 26 draws `UIGlassEffect`,
which refracts and highlights what passes beneath it; earlier versions draw
`systemThinMaterial`, which is what the CSS `backdrop-filter` was imitating.

No tint crosses the bridge: the effect adapts to what is behind it, and a tint
on top reads as coloured plastic. Where somebody has asked for less
transparency the JavaScript draws a filled view and never mounts the glass —
the same branch a browser without `backdrop-filter` takes, and what Android
gets too.

## Fonts

Built, not downloaded. `app/assets/fonts/README.md` says why in full; the short
version is that Space Grotesk's variable font defaults to **Light**, and
Material Symbols files its ligatures as **required** (`rlig`), so the obvious
subset throws every icon away.

```sh
python3 -m venv tools/.venv                      # gitignored, and still there in a month
tools/.venv/bin/pip install fonttools cairosvg
tools/.venv/bin/python tools/makeFonts.py        # after adding to IconName
tools/.venv/bin/python tools/makeAppIcons.py     # the icon, from the mark's own paths
```

## Testing

The web app is the thing that must not break, and the shared edits are large
enough that a typecheck does not settle it. Stand it up locally — both ends
are already configured for each other, `serverConfig.json` allowlists
`127.0.0.1:8080` and `build.mjs` points a served bundle at `:9100` — and look:

```sh
npm start          # the API, on 9100, against teamstation_dev
npm run start.web  # the app, on 8080, pointed at it
```

The four things worth looking at are the ones a compiler cannot judge: the
watch tab at desktop width (the card scrolls past, the picture pegs, the
highlight column measures itself to the window), the same at phone width, the
header's computed `backdrop-filter`, and the manage table.

```sh
maestro --device <udid|serial> test maestro/smoke.yaml
```

Maestro directly, and not `mobile/scripts/run-maestro.js`. That runner exists
so the TS Director flows can name no device and be pointed at one iPad or
another; these flows have the same property — none of them names a device —
but the runner also knows about Director's build scripts and its simulator
conventions, which have nothing to do with this app. One flag is cheaper than
teaching it about a second project.

Every screen the app has, in one pass. It exists to catch the failure this port
is most exposed to — a screen that draws nothing because something in it
reached for the DOM — which is invisible to a typecheck and obvious the moment
anything looks. Run it at every gate, not at the end; it has already found a
crash on Android, a dead deep link on iOS, and a Back button that did nothing.

The two pieces of native logic that cannot be reasoned about from reading are
pure modules with tests of their own, because neither can be loaded in a test
otherwise: `player/seekTracker.ts` (whether to believe the player about the
playhead, which is where ExoPlayer's coalescing and its silence about a
paused-and-buffering seek both land) and `navigation/history.ts` (the rules a
browser would have kept, which went wrong twice while this was being built and
both times looked like a hang).

Nothing in the suite depends on the host's free disk any more.
`server/live/controller.ts` takes `freeBytes` as an option now, defaulting to
the real one, because it did not: `sync()` asked the **machine** how full it
was, and a laptop that filled up during an unrelated build failed four
assertions in `server/live/sync.test.ts` with nothing in the message to
suggest the code was fine. The test hands it a terabyte; the one case that
wants the refusal raises the floor instead.

`maestro/androidBack.yaml` covers the one question only Android can ask: its
system Back walks the **address**, so from the box score the first press
returns to the video and the second leaves the game — which is what a browser
does with the same two addresses.

## What this costs the server

`.gitattributes` keeps `ios/`, `android/`, `maestro/` and `tools/` out of a
`git archive HEAD src` — checked, and it does: the archive holds none of them
and is 3.4 MB, which is small either way.

The packages are the real weight, and they cannot be solved with a flag:
a server install is a plain `npm ci` and has to be, because the server starts
through `sucrase` from `devDependencies`. Measured in this tree:

| | |
|---|---|
| Added by this branch (`react-native-video`, `-svg`, `-safe-area-context`, clipboard, async-storage, the CLI) | **81 MB** |
| Already there before it (`react-native`, Reanimated, Gesture Handler, Worklets) | **1.5 GB** |
| Whole `node_modules` | 1.9 GB |

So the server was already carrying React Native five times over; this branch
adds about five per cent to that. Splitting the package in two is the real
answer and is a change of its own.

## Gate iOS on the iPad simulator, not the iPhone one

**Maestro's driver is broken on the iPhone 17 Pro simulator, in three ways
that are one fault wearing three hats.** On the iPad Pro simulator, on the
same build and the same JavaScript, none of them happen.

1. **The view hierarchy stops at about y = 390 points.** On a signed-out login
   card the heading and subtitle come through and the `E-MAIL ADDRESS` label
   below them does not. On Home it stops at `FINAL` and omits `Watch`, `Box
   Score`, `YOUR TEAMS` and all ten team rows.
2. **A coordinate tap below that line lands on something higher up.**
3. **A drag is delivered as a tap.** Two swipes, one entirely below the fold
   and one entirely above it, each opened a game row instead of scrolling.

What rules out the app as the cause, in order of how conclusive it is:

- **The iPad publishes everything** — the same Home down to a team row at
  y = 1336, all four header destinations, and drags scroll it.
- **Android publishes the identical screens** in full, and its `FINAL` sits at
  the same y as iOS's; it simply keeps going.
- Above the cutoff sits `Account, review`, a `Pressable` with a label,
  published normally. Below it sits `E-MAIL ADDRESS`, a plain `Text` — the
  same kind of node as the subtitle forty points above that *is* published.
  A boundary that keeps a pressable and drops a text is not about the node.
- Swapping `Screen`'s `Animated.ScrollView` for a plain one changed nothing,
  and neither did removing `automaticallyAdjustKeyboardInsets`. Reanimated is
  not it either.

So: **run the iOS flows against the iPad Pro simulator.** `tapOn` by name
works there, drags work, and iOS does not have to drop out of the gate. The
iPhone simulator is for screenshots only until its driver is fixed.

Two things this invalidates rather than proves, and they are worth naming
because they were written down as facts once already:

- The sign-in card on iOS "does not scroll with the keyboard up" and
  "`keyboardDismissMode` does not fire". Both were observed only through a
  driver that cannot drag. Untested, not false — retry on the iPad.
- A real accessibility defect below the cutoff has not been ruled out on the
  iPhone, because the instrument cannot see there. It has only been shown that
  the app is not the reason Maestro cannot.

## Installing on a real iPhone

Signing needs nothing set up: the Mac has one team, **`G5LQ7MERPK`**, and its
`iOS Team Provisioning Profile: *` is a wildcard that already covers
`app.teamstation.app` and already lists the phones. So the team is the only
thing the build has to be told.

```sh
cd ios
xcodebuild -workspace TeamStation.xcworkspace -scheme TeamStation \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath build-device \
  DEVELOPMENT_TEAM=G5LQ7MERPK CODE_SIGN_STYLE=Automatic

xcrun devicectl device install app --device <device-id> \
  build-device/Build/Products/Release-iphoneos/TeamStation.app
```

`xcrun devicectl list devices` gives the id. Build **Release**, not Debug: the
JS is bundled into the app, so it needs neither Metro nor this Mac, and
`app/native/config.ts` defaults a device build to production.

`generic/platform=iOS` rather than the phone's own id, because pinning the id
fails outright the moment the phone is off the network — and a build that
needs the device present to *compile* is a build you cannot prepare in
advance.

### A VPN on the phone stops a wireless install

Wireless installs go over Bonjour on the local network: the Mac has to see the
phone advertising on the same LAN. A VPN on the phone pulls its traffic into
the tunnel, and unless it is set to allow local network access the phone stops
being visible — `devicectl list devices` moves it from `connected` to
`unavailable`, and the install fails with `CoreDeviceService was unable to
locate a device`.

Three ways round it, easiest first: **plug in a cable**, which bypasses
networking entirely; turn the VPN off for the few seconds an install takes; or
enable local network access in the VPN client.

## Never put `minWidth` on a flex item in a row that divides

The rule, and it is checkable: **on a row that shares out free space, a
`minWidth` on a flex item costs you its minimum *plus* its grow share on iOS,
and only its minimum in a browser — and no flex property will get it back.**

The manage table lost 118 points to this. Each `Change role` column asked for
`flex: 1.3` with a `minWidth` of 88. The browser grew it to 76, saw that was
under the floor, froze it there and shared the rest over the other columns.
Yoga reserved the 88 first and then added a grow share on top, landing at
147. Two such columns, so `TEAM` and `SEASON` dropped from 56 points to 45,
`SEASON` needs about 52, and its heading broke mid-word as `SEASO` / `N`.

`flexShrink: 0` does **not** rescue this, and the reason is worth knowing:
Yoga's clamp is on the *cross axis*, not a shrink, so no flex property has any
purchase on it. The same clamp is why an oversized child overflows its column
in a browser and draws whole, and is cut on iOS.

Use a fixed `width` with `flexGrow: 0` instead, and take the width out of the
table's total rather than out of its neighbours. That is what the box score's
`cell` does — and why that table, which is the same kind of sideways scroller
on the same screen, has never had this problem: **it never divides free space
at all.** Every stat cell is a fixed width, the row has no declared width, and
the content container has no `flexGrow`. No division, nothing for the two
platforms to disagree about.

## Running the sweep against a local server

The suite runs against production by default. To run it locally — which is
the only way to test a branch's *own* web app rather than what is deployed —
four things have to line up, and three of them bit before they worked.

```sh
npm run start                                     # API, from serverConfig.json
TS_SERVE_PORT=8090 TS_API_BASE_URL=http://127.0.0.1:9100/api/v1 npm run start.web
```

- **`TS_SERVE_PORT`.** Two worktrees are often served at once and the second
  silently fails to bind. Use it rather than killing whatever holds 8080 —
  that will be another branch's server.
- **`corsOrigins` in `serverConfig.json`** lists the origins the API will
  answer with credentials. It ships with `:8080` only, so a web app served on
  any other port renders *signed out* with no error worth reading.
- **The app cannot use a loopback URL**: on a handset `127.0.0.1` is the
  handset, and `app/native/config.ts` refuses one. Build with the Mac's LAN
  address and set `listenHost` to `0.0.0.0` so the simulator can reach it:
  `TS_API_BASE_URL=http://<lan-ip>:9100/api/v1 xcodebuild …`
- **The dev database has none of the fixtures** the flows expect:
  the flows' sign-in, its password, and the invite code
  the clipboard check reads. Add them to the dev database rather than editing
  the flows, so the same suite runs unchanged against both. `TEAM_ID` is the
  one thing that genuinely differs, and it is a parameter.

```sh
maestro test -e TEAM_ID=tem_xxx maestro/smoke.yaml
```

## Drive the app with its own URL scheme, not with taps

On the iPhone simulator **Maestro cannot deliver touches at all**: `tapOn` by
text, `tapOn` by point and `swipe` all report `COMPLETED` and change nothing.
A null result from a tap there is worthless.

`xcrun simctl openurl` goes round it completely, because every screen in this
app has an address:

```sh
xcrun simctl openurl <udid> "teamstation://teams/<id>/manage"
xcrun simctl openurl <udid> "teamstation://games/<id>?tab=boxScore"
```

That reaches every screen, tab and filter without a press, and it is how the
landscape and manage-table faults were both measured. Pair it with
`xcrun simctl io <udid> screenshot` and the Maestro *hierarchy*, which does
still work — it is only touch that is dead, and the old truncation at y≈390
is gone, so bounds can be measured to the point.

## When an iOS gate run wedges: shut the simulator down

`Save Password?` is the one thing that can stop an iOS flow dead. It is
offered the moment the sign-in form is submitted, it **re-presents on every
launch until it is answered**, and while it is up Maestro cannot see the app
at all — the hierarchy is the status bar and nothing else.

Nothing in Maestro's reach clears it: not `tapOn: 'Not Now'`, not a point tap
at its measured centre, and it survives `simctl terminate` and `launch`.

```sh
xcrun simctl shutdown <udid> && sleep 5 && xcrun simctl boot <udid>
```

That clears it. `maestro/signIn.yaml` taps it blind at the right coordinates
during the run, guarded on platform and on the home screen not already
showing, and then asserts `YOUR TEAMS` — so if the tap misses, the run fails
saying the home screen is not there rather than timing out thirty seconds
later on something unrelated.

Two smaller ones from the same afternoon, both on the Android emulator and
both fixed in the flow rather than worked around by hand: the keyboard
sometimes opens **fullscreen** (the IME's extract editor) and covers the card,
so the flow uses the Back key rather than tapping the heading to dismiss it;
and the emulator can come back in **landscape**, where `Use a password
instead` is below the fold, so the flow scrolls to it.

## Known differences from the web, deliberately

- **Android has no glass.** It gets `theme.glassFallbackColor` and an
  elevation, which is exactly the branch `glassStyle` takes in a browser
  without `backdrop-filter`. Blurring a backdrop on Android means compositing
  it to a bitmap every frame, under a scrolling list, for a tint that is
  already legible.
- **No edge-swipe back on iOS.** The chevron in the header is the way back, as
  it is on the web. An edge pan was written and did not fire — it never
  activated against the scroll view's own recogniser — and was removed rather
  than shipped dead.

  Trying again: the cheap answer is `react-native-screens` and a single
  `ScreenStack` around the pushed screens, which gets the **system's** back
  recogniser for nothing rather than imitating it. (That package was installed
  for a while and dropped, correctly, because nothing used it.) Making the
  hand-rolled pan work instead means `blocksExternalGesture` against the outer
  scroller — and then against `PillTabs` and the manage table too, both of
  which put horizontal scrollers near the screen edge, so the cost is higher
  than it looks.
- **`minSdkVersion` is 28**, because numeric font weights only resolve from
  there and the app asks for 500 and 600 in about twenty-five places.
- **Text does not scale with the OS.** The web app does not either — that is
  the parity answer — but on a phone it is a real accessibility difference,
  and it is not a one-line fix: React 19 dropped `defaultProps` for function
  components, so the usual `Text.defaultProps.allowFontScaling = false` is
  simply ignored. Making it scale properly means `theme.rem` reading
  `PixelRatio.getFontScale()` so the boxes grow with the type, on both ends.
- **Only two cards ever preview a video at once**, and that is structural
  rather than a matter of vigilance. `videoUrl` reaches a `VideoPoster` from
  `HomeScreen.tsx:188` (the live card) and from `HomeScreen.tsx:263` through
  `GameHeroCard`. `GameRowProps` has no `videoUrl` field at all, and `GameRow`
  is the only thing the four list screens render, so putting a preview in a
  list would need a new prop — a visible, greppable change.

  The path that *is* one prop away is `GameScreen.tsx:764`, which renders a
  `GameHeroCard` without a `videoUrl`. Give it one and there are three
  decoders on the screen that is already decoding the game.
- **Neither app is signed for anything but a simulator.** Android's release
  build still uses the debug keystore the template ships, which is fine for an
  emulator and is not a thing to put on a phone somebody else owns; iOS has no
  `DEVELOPMENT_TEAM` at all. Both want Paul's accounts, and the App Links and
  universal links below want the same two facts.
- **Universal links and App Links are not live.** The custom `teamstation://`
  scheme works on both platforms and the `https://` intent filters are
  declared; Apple's `apple-app-site-association` needs a team ID and Android's
  `assetlinks.json` needs the release signing fingerprint.
