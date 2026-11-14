// Runs one tier of the mocha suites (scripts/testTiers.mjs): `--tier unit`, the
// default and what `npm test` runs, or `--tier integration`, what
// `npm run test.integration` runs. Each tier is its `.test.ts` files and the
// app's `.test.tsx` files of that tier. Other arguments go to mocha
// (`--grep` …).
//
// The files are split into groups of about GROUP_BYTES of test source, each a
// run of consecutive files in path order (the app's in bundles, from
// build-scoring-tests.mjs), and each group runs in a mocha process of its own,
// TS_TEST_JOBS at a time, the largest first. A group starts with nothing left behind
// by another, and a process gives its memory back when its group ends: one
// long process would hold the modules of every file it ran.
//
// TS_TEST_JOBS sets how many groups run at once (one less than the cores, by
// default); TS_TEST_JOBS=1 runs one group at a time. A group's output prints
// when it ends, and the run ends with the totals and the groups that failed.
//
// The integration files in SERIAL time real FFmpeg writers against the wall
// clock, so they run after the rest, alone, on a machine nothing else is
// loading.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'

import { specFiles, tierOptions, withoutTier } from './testTiers.mjs'

const tier = tierOptions(process.argv.slice(2))
const mochaArgs = withoutTier(process.argv.slice(2))

const jobs = Number(
  process.env.TS_TEST_JOBS ?? Math.max(1, availableParallelism() - 1)
)
if (!Number.isInteger(jobs) || jobs < 1)
  throw new Error(`Expected TS_TEST_JOBS to be a count, got ${jobs}`)

/** A group's test source: small groups share out evenly and stay light. */
const GROUP_BYTES = 400_000

const built = spawnSync(
  process.execPath,
  [
    'scripts/build-scoring-tests.mjs',
    `--chunk-bytes=${GROUP_BYTES}`,
    `--tier=${tier.tier}`
  ],
  { stdio: 'inherit' }
)
if (built.status !== 0) process.exit(built.status ?? 1)

const chunks = JSON.parse(readFileSync('lib/scoring-tests-chunks.json', 'utf8'))
const specs = specFiles(tier.tier)

/** Consecutive files, about GROUP_BYTES of them to a group. */
const groups = []
for (const file of specs) {
  const bytes = statSync(file).size
  const last = groups.at(-1)
  if (last == null || (last.bytes > 0 && last.bytes + bytes > GROUP_BYTES))
    groups.push({ bytes, files: [file] })
  else {
    last.bytes += bytes
    last.files.push(file)
  }
}
const tasks = [
  ...chunks.map(chunk => ({
    name: `${chunk.file} (${chunk.files.length} app files)`,
    bytes: chunk.bytes,
    files: [chunk.file]
  })),
  ...groups.map(group => ({
    name:
      group.files.length === 1
        ? group.files[0]
        : `${group.files[0]} … ${group.files.at(-1)} (${group.files.length} files)`,
    bytes: group.bytes,
    files: group.files
  }))
].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))

// Each process's heap is held to its share of the machine's memory: the 8 GB
// CI gives the one run would let a few processes take more than it has.
const heapMb = Math.min(
  8192,
  Math.max(2048, Math.floor(((totalmem() / 2 ** 20) * 0.6) / jobs))
)
const env = {
  ...tier.env,
  NODE_OPTIONS: [
    ...(process.env.NODE_OPTIONS ?? '')
      .split(/\s+/)
      .filter(option => option !== '' && !option.startsWith('--max-old-space')),
    `--max-old-space-size=${heapMb}`
  ].join(' ')
}

const totals = { passing: 0, failing: 0, pending: 0 }
const failed = []

/** Runs one group's mocha, and prints its output once it ends. */
async function runGroup(task) {
  const started = Date.now()
  const child = spawn(
    process.execPath,
    [
      'node_modules/mocha/bin/mocha.js',
      '--timeout',
      '20000',
      '--exit',
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      ...tier.require.flatMap(module => ['-r', module]),
      ...mochaArgs,
      ...task.files
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const output = []
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => output.push(chunk))
  const code = await new Promise(resolve => {
    child.on('close', (status, signal) =>
      resolve(status ?? (signal == null ? 1 : 128))
    )
  })
  const text = Buffer.concat(output).toString('utf8')
  for (const kind of Object.keys(totals)) {
    const count = new RegExp(`^\\s+(\\d+) ${kind}\\b`, 'm').exec(text)
    if (count != null) totals[kind] += Number(count[1])
  }
  if (code !== 0) failed.push(`${task.name}: exit ${code}`)
  const secs = Math.round((Date.now() - started) / 1000)
  process.stdout.write(`\n── ${task.name}, ${secs} s\n${text}`)
}

const queue = [...tasks]
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let task = queue.shift(); task != null; task = queue.shift())
      await runGroup(task)
  })
)
if (tier.serial.length > 0)
  await runGroup({
    name: `run alone: ${tier.serial.join(', ')}`,
    files: tier.serial
  })

process.stdout.write(
  `\n${tier.tier}: ${totals.passing} passing, ${totals.failing} failing, ` +
    `${totals.pending} pending, in ${tasks.length + (tier.serial.length > 0 ? 1 : 0)} groups\n`
)
for (const line of failed) process.stdout.write(`failed: ${line}\n`)
process.exit(failed.length === 0 ? 0 : 1)
