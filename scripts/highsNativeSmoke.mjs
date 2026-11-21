// The phones' engine (native/scheduler, as the NativeScheduler module
// compiles it: the engine's sources with the pinned HiGHS), built for this
// Mac and run on the packed league's request, beside the Node addon on the
// same request. It prints each season's settled count and games per team
// from both, with the native build's time, and fails when either is not
// options, or any count, team total or the number of games differs. Then
// the native build runs the packed league at a 1 s limit twice, waiting on
// a condition variable at each limit as the phones do: answered continue
// each time, it must reach the same proven counts; answered cancel, the
// canceled failure. HiGHS is built once under native/highs/vendor/build-host.
//
//   node scripts/highsNativeSmoke.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cmake, highsSource } from './highsSource.mjs'
import { buildNode, engineSources } from './schedulerBuild.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const build = join(root, 'native', 'highs', 'vendor', 'build-host')
const engine = join(root, 'native', 'scheduler')
const jobs = String(Math.max(1, availableParallelism()))

const source = await highsSource()
const cmakeBin = await cmake()
const library = join(build, 'lib', 'libhighs.a')
if (!existsSync(library)) {
  mkdirSync(build, { recursive: true })
  execFileSync(
    cmakeBin,
    [
      '-S',
      source,
      '-B',
      build,
      '-DBUILD_SHARED_LIBS=OFF',
      '-DBUILD_SHARED_EXTRAS_LIB=OFF',
      '-DFAST_BUILD=ON',
      '-DZLIB=OFF',
      '-DBUILD_TESTING=OFF',
      '-DBUILD_EXAMPLES=OFF',
      '-DBUILD_CXX_EXE=OFF',
      '-DCMAKE_BUILD_TYPE=Release'
    ],
    { stdio: 'inherit' }
  )
  execFileSync(cmakeBin, ['--build', build, '-j', jobs], { stdio: 'inherit' })
}

// A driver as small as the module's build: the request in, the result out.
const driver = join(build, 'schedulerSmoke.cpp')
writeFileSync(
  driver,
  `#include <atomic>
#include <condition_variable>
#include <fstream>
#include <iostream>
#include <iterator>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include "Engine.h"
using teamstation::scheduler::Decision;
// request.json result.json [continue|cancel]: at each limit the build waits
// on a condition variable, and another thread answers after 100 ms.
int main(int argc, char** argv) {
  std::ifstream in(argv[1], std::ios::binary);
  const std::string request((std::istreambuf_iterator<char>(in)), {});
  const std::string answer = argc > 3 ? argv[3] : "";
  std::atomic<bool> cancel{false};
  std::mutex mutex;
  std::condition_variable changed;
  std::optional<Decision> decided;
  teamstation::scheduler::Reporter reporter;
  reporter.emit = [&](const std::string& event) {
    std::cerr << "event " << event << std::endl;
    if (event.find(R"("kind":"limit")") == std::string::npos) return;
    std::thread([&] {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      {
        const std::lock_guard<std::mutex> lock(mutex);
        decided = answer == "cancel" ? Decision::Cancel : Decision::Continue;
      }
      changed.notify_all();
    }).detach();
  };
  reporter.decide = [&] {
    std::unique_lock<std::mutex> lock(mutex);
    changed.wait(lock, [&] { return decided.has_value(); });
    const Decision decision = *decided;
    decided.reset();
    return decision;
  };
  std::ofstream(argv[2], std::ios::binary)
      << teamstation::scheduler::buildSchedule(request, cancel, reporter);
  return 0;
}
`
)
const smoke = join(build, 'schedulerSmoke')
execFileSync(
  'clang++',
  [
    '-std=c++17',
    '-O2',
    `-I${engine}`,
    `-I${join(source, 'highs')}`,
    `-I${build}`,
    driver,
    ...engineSources(),
    library,
    join(build, 'lib', 'libhighs_extras.a'),
    '-o',
    smoke
  ],
  { stdio: 'inherit' }
)

// The request, and the addon's answer to it, through the TypeScript wrapper.
const require = createRequire(import.meta.url)
require('sucrase/register')
const { buildSchedule, wireRequest, readResult } = require(
  join(root, 'src', 'common', 'scheduler', 'engine.ts')
)
const { packedLeagueRun } = require(
  join(root, 'src', 'test', 'packedLeagueRun.ts')
)
const input = packedLeagueRun()
await buildNode()
const requestFile = join(build, 'packedLeague.request.json')
const resultFile = join(build, 'packedLeague.native.json')
writeFileSync(requestFile, JSON.stringify(wireRequest({ input })))

let started = Date.now()
const addon = await buildSchedule({ input })
const addonSeconds = (Date.now() - started) / 1000
started = Date.now()
execFileSync(smoke, [requestFile, resultFile], { stdio: 'inherit' })
const nativeSeconds = (Date.now() - started) / 1000
const native = readResult(readFileSync(resultFile, 'utf8'), input)

/** Each season's settled count and its teams' regular games, sorted. */
function counts(built) {
  if (built.kind !== 'options') return null
  return Object.fromEntries(
    built.targets.map(target => [
      target.seasonId,
      {
        settled: target.regular,
        teams: built.options[0].fairness
          .filter(
            row => row.seasonId === target.seasonId && !row.exhibitionTeam
          )
          .map(row => row.regularGames)
          .sort((a, b) => a - b)
          .join(' ')
      }
    ])
  )
}

console.log(
  `addon:  ${addon.kind}${addon.kind === 'failure' ? ` ${addon.failure}: ${addon.message}` : ''} (${addonSeconds.toFixed(1)} s)`
)
console.log(
  `native: ${native.kind}${native.kind === 'failure' ? ` ${native.failure}: ${native.message}` : ''} (${nativeSeconds.toFixed(1)} s)`
)
const fromAddon = counts(addon)
const fromNative = counts(native)
let differ = fromAddon == null || fromNative == null
console.log('season   addon  native')
for (const season of input.seasons) {
  const a = fromAddon?.[season.id]
  const n = fromNative?.[season.id]
  if (a?.settled !== n?.settled || a?.teams !== n?.teams) differ = true
  console.log(
    `${season.id.padEnd(8)} ${String(a?.settled).padStart(5)}  ${String(n?.settled).padStart(6)}`
  )
}
const games = built =>
  built.kind === 'options' ? built.options[0].games.length : -1
console.log(`games: addon ${games(addon)}, native ${games(native)}`)
if (differ || games(addon) !== games(native)) {
  console.error('The native engine and the addon disagree')
  process.exit(1)
}
console.log('The native engine agrees with the addon')

/** The packed league at a 1 s limit, natively, each limit answered `answer`. */
function limited(answer) {
  const file = join(build, `packedLeague.limit.request.json`)
  const out = join(build, `packedLeague.${answer}.json`)
  writeFileSync(file, JSON.stringify(wireRequest({ input, limitMs: 1000 })))
  const started = Date.now()
  const run = spawnSync(smoke, [file, out, answer], { encoding: 'utf8' })
  if (run.status !== 0)
    throw new Error(`the native build failed: ${run.stderr}`)
  const events = run.stderr
    .split('\n')
    .filter(line => line.startsWith('event '))
    .map(line => JSON.parse(line.slice(6)))
  return {
    seconds: (Date.now() - started) / 1000,
    events,
    limits: events.filter(event => event.kind === 'limit'),
    result: readResult(readFileSync(out, 'utf8'), input)
  }
}

const continued = limited('continue')
const settled = counts(continued.result)
console.log(
  `limit 1 s, continue: ${continued.limits.length} limits (${continued.limits.map(limit => `${limit.stage} ${limit.solvedMs} ms`).join(', ')}), ${continued.result.kind}, proven ${continued.result.provenOptimal}, ${input.seasons.map(season => settled?.[season.id]?.settled).join('/')} (${continued.seconds.toFixed(1)} s)`
)
const canceled = limited('cancel')
console.log(
  `limit 1 s, cancel: ${canceled.limits.length} limit, ${canceled.result.kind} ${canceled.result.failure ?? ''} (${canceled.seconds.toFixed(1)} s)`
)
const proven =
  continued.limits.length > 0 &&
  continued.result.kind === 'options' &&
  continued.result.provenOptimal === true &&
  input.seasons.every(
    season => settled?.[season.id]?.settled === fromAddon?.[season.id]?.settled
  )
if (!proven) {
  console.error('Continuing at the limit did not reach the proven counts')
  process.exit(1)
}
if (canceled.limits.length !== 1 || canceled.result.failure !== 'canceled') {
  console.error('Cancel at the limit did not cancel the build')
  process.exit(1)
}
console.log(
  'The native engine pauses at its limit, continues to the proof, and cancels'
)
