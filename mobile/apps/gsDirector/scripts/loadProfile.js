#!/usr/bin/env node
'use strict'

// Samples the control server while the pipeline runs and reports CPU alongside frame rates.
//
// The point is to separate two failure modes that look identical in a frame counter: the app is out
// of CPU to decode arriving frames, or the frames are not arriving. Only the first one is fixed by
// buying a faster iPad, so the distinction decides a hardware purchase.

const BASE = process.env.DIRECTOR_ADDRESS
if (!BASE) {
  process.stderr.write(
    'set DIRECTOR_ADDRESS to the control server, e.g. http://127.0.0.1:8765\n'
  )
  process.exit(1)
}

async function call(path) {
  const response = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(8000)
  })
  return response.json()
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const args = process.argv.slice(2)
  const seconds = Number(
    args.find(a => a.startsWith('--seconds='))?.split('=')[1] || 40
  )
  const record = args.includes('--record')
  const label = args.find(a => a.startsWith('--label='))?.split('=')[1] || 'run'

  const state = await call('/dump-state')
  const available = state.tiles.filter(
    t => t.receivedFrames > 0 || t.state !== 'empty'
  ).length
  const count = Math.max(available, 4)
  for (let i = 1; i <= count; i++)
    await call(`/enable-source?index=${i}&on=true`)
  await call('/start')
  await sleep(6000)
  if (record) {
    await call('/record?on=true')
    await sleep(6000)
  }

  const samples = []
  const started = Date.now()
  while ((Date.now() - started) / 1000 < seconds) {
    const s = await call('/dump-state')
    const live = s.tiles.filter(t => t.receivedFrames > 0)
    samples.push({
      cpu: s.cpuPercent,
      cores: s.cpuCores,
      memory: s.availableMemoryMB,
      thermal: s.thermalState,
      fps: live.map(t => t.framesPerSecond),
      dropped: live.reduce((sum, t) => sum + t.droppedFrames, 0),
      archived: live.reduce((sum, t) => sum + t.archivedFrames, 0)
    })
    await sleep(2000)
  }

  if (record) await call('/record?on=false')

  // Discard the first few samples so startup transients do not pollute the steady-state figure.
  const steady = samples.slice(Math.min(3, samples.length - 1))
  const mean = values =>
    values.reduce((a, b) => a + b, 0) / (values.length || 1)
  const totalFps = steady.map(s => s.fps.reduce((a, b) => a + b, 0))
  const last = samples[samples.length - 1]

  console.log(`\n=== ${label} ${record ? '(recording)' : '(preview only)'} ===`)
  console.log(
    `cpu           ${mean(steady.map(s => s.cpu)).toFixed(1)}% of ${last.cores} cores  (peak ${Math.max(...steady.map(s => s.cpu)).toFixed(1)}%)`
  )
  console.log(
    `aggregate fps ${mean(totalFps).toFixed(1)} across ${last.fps.length} streams  [${last.fps.map(f => f.toFixed(1)).join(', ')}]`
  )
  console.log(`dropped       ${last.dropped}`)
  console.log(`archived      ${last.archived}`)
  console.log(`memory avail  ${last.memory} MB`)
  console.log(`thermal       ${last.thermal}`)
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
