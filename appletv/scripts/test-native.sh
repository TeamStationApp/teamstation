#!/usr/bin/env bash
set -euo pipefail
tv_test_metro_port="${TV_METRO_PORT:-8097}"
if [[ ! "$tv_test_metro_port" =~ ^[0-9]{1,5}$ ]] || (( 10#$tv_test_metro_port < 1 || 10#$tv_test_metro_port > 65535 )); then
  echo "TV_METRO_PORT must be a port from 1 to 65535" >&2
  exit 1
fi
if [[ "$(curl --silent --fail --max-time 5 "http://127.0.0.1:$tv_test_metro_port/status" || true)" != "packager-status:running" ]]; then
  echo "Start this checkout's Metro from appletv with npm start -- --port $tv_test_metro_port before native tests" >&2
  exit 1
fi
if [[ -n "${TV_DEVICE_UDID:-}" ]]; then
  : "${TV_DEVELOPMENT_TEAM:?Set the signing team for physical-device tests}"
  tv_test_device="$TV_DEVICE_UDID"
  tv_test_sdk=appletvos
  tv_test_destination="platform=tvOS,id=$tv_test_device"
  tv_test_options=("DEVELOPMENT_TEAM=$TV_DEVELOPMENT_TEAM" "CODE_SIGN_IDENTITY=Apple Development" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates)
else
  : "${TV_SIMULATOR_UDID:?Set TV_DEVICE_UDID or TV_SIMULATOR_UDID}"
  tv_test_device="$TV_SIMULATOR_UDID"
  tv_test_sdk=appletvsimulator
  tv_test_destination="platform=tvOS Simulator,id=$tv_test_device"
  tv_test_options=(CODE_SIGN_IDENTITY=-)
fi
if [[ -n "${TV_ONLY_TESTING:-}" ]]; then
  tv_test_options+=("-only-testing:$TV_ONLY_TESTING")
fi
if [[ -n "${TV_API_BASE_URL:-}" ]]; then
  tv_test_options+=("TV_API_BASE_URL=$TV_API_BASE_URL")
fi
cd "$(dirname "$0")/../.."
node appletv/scripts/test-video-seek.cjs
mkdir -p appletv/coverage
rm -rf appletv/coverage/native-tests.xcresult
rm -f appletv/coverage/native-snapshot.json appletv/coverage/native-counts.json
node scripts/llvm-changed-line-counts.cjs --snapshot appletv/coverage/native-snapshot.json --root . \
  --source appletv/ios/TeamStationTV/AppDelegate.swift --source appletv/ios/TeamStationTV/TVSession.m --source appletv/ios/TeamStationTV/TVRemote.m --source appletv/ios/TeamStationTV/TVPresentation.m
xcodebuild -workspace appletv/ios/TeamStationTV.xcworkspace -scheme TeamStationTV \
  -configuration Debug -sdk "$tv_test_sdk" -destination "$tv_test_destination" \
  -derivedDataPath appletv/DerivedData -resultBundlePath appletv/coverage/native-tests.xcresult \
  CODE_SIGNING_ALLOWED=YES SWIFT_ENABLE_EXPLICIT_MODULES=NO "TV_METRO_PORT=$tv_test_metro_port" "RCT_METRO_PORT=$tv_test_metro_port" "${tv_test_options[@]}" test
xcrun llvm-cov export -format=lcov \
  -instr-profile="appletv/DerivedData/Build/ProfileData/$tv_test_device/Coverage.profdata" \
  "appletv/DerivedData/Build/Products/Debug-$tv_test_sdk/TeamStationTV.app/TeamStationTV.debug.dylib" \
  "$PWD/appletv/ios/TeamStationTV/AppDelegate.swift" "$PWD/appletv/ios/TeamStationTV/TVSession.m" "$PWD/appletv/ios/TeamStationTV/TVRemote.m" "$PWD/appletv/ios/TeamStationTV/TVPresentation.m" \
  > appletv/coverage/native.lcov
node scripts/llvm-changed-line-counts.cjs --manifest appletv/coverage/native-snapshot.json \
  --lcov appletv/coverage/native.lcov --out appletv/coverage/native-counts.json --root .
