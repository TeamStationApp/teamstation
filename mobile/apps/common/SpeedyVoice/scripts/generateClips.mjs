#!/usr/bin/env node
// Makes or checks TS Speedy's voice clips. See ../README.md.
//
//   XAI_API_KEY=… node generateClips.mjs [--samples <dir>]   make every clip
//   node generateClips.mjs --check                           check the committed set
//   node generateClips.mjs --samples <dir> --no-generate     only write sample phrases
//   XAI_API_KEY=… node generateClips.mjs --transcribe        transcribe the committed set
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkClips, clipNames, generate, transcribe, writeSamples } from './clipJobs.mjs'

const CLIPS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Sources/SpeedyVoice/Clips')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)

if (flag('--check')) {
  const problems = checkClips(CLIPS)
  for (const problem of problems) console.log(problem)
  console.log(problems.length === 0 ? `ok: ${clipNames().length} clips` : `${problems.length} problems`)
  process.exit(problems.length === 0 ? 0 : 1)
}

const apiKey = process.env.XAI_API_KEY
const needKey = () => {
  if (apiKey == null || apiKey === '') {
    console.error('XAI_API_KEY is not set')
    process.exit(2)
  }
}

if (flag('--transcribe')) {
  needKey()
  const { checked, misses } = await transcribe(CLIPS, { apiKey })
  for (const miss of misses) console.log(`MISMATCH ${miss.label} => ${JSON.stringify(miss.text)}`)
  console.log(`${checked - misses.length}/${checked} transcripts match`)
  process.exit(misses.length === 0 ? 0 : 1)
}

if (!flag('--no-generate')) {
  needKey()
  const written = await generate({ dir: CLIPS, apiKey, log: line => console.log(line) })
  console.log(`wrote ${written} clips`)
}

const samples = value('--samples')
if (samples != null) {
  for (const file of writeSamples(CLIPS, samples)) console.log(`sample ${file}`)
}
