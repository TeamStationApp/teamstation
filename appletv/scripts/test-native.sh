#!/usr/bin/env bash
set -euo pipefail
: "${TV_SIMULATOR_UDID:?Set the task simulator UDID}"
cd "$(dirname "$0")/../.."
node appletv/scripts/test-video-seek.cjs
mkdir -p appletv/coverage
rm -rf appletv/coverage/native-tests.xcresult
rm -f appletv/coverage/native-snapshot.json appletv/coverage/native-counts.json
node scripts/llvm-changed-line-counts.cjs --snapshot appletv/coverage/native-snapshot.json --root . \
  --source appletv/ios/TeamStationTV/AppDelegate.swift --source appletv/ios/TeamStationTV/TVSession.m --source appletv/ios/TeamStationTV/TVRemote.m --source appletv/ios/TeamStationTV/TVPresentation.m
xcodebuild -workspace appletv/ios/TeamStationTV.xcworkspace -scheme TeamStationTV \
  -configuration Debug -sdk appletvsimulator -destination "platform=tvOS Simulator,id=$TV_SIMULATOR_UDID" \
  -derivedDataPath appletv/DerivedData -resultBundlePath appletv/coverage/native-tests.xcresult \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
xcrun llvm-cov export -format=lcov \
  -instr-profile="appletv/DerivedData/Build/ProfileData/$TV_SIMULATOR_UDID/Coverage.profdata" \
  appletv/DerivedData/Build/Products/Debug-appletvsimulator/TeamStationTV.app/TeamStationTV.debug.dylib \
  "$PWD/appletv/ios/TeamStationTV/AppDelegate.swift" "$PWD/appletv/ios/TeamStationTV/TVSession.m" "$PWD/appletv/ios/TeamStationTV/TVRemote.m" "$PWD/appletv/ios/TeamStationTV/TVPresentation.m" \
  > appletv/coverage/native.lcov
node scripts/llvm-changed-line-counts.cjs --manifest appletv/coverage/native-snapshot.json \
  --lcov appletv/coverage/native.lcov --out appletv/coverage/native-counts.json --root .
