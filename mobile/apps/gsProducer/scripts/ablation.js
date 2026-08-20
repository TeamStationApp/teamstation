#!/usr/bin/env node
'use strict'

// Localizes the ingest bottleneck by holding the camera set fixed and varying how much work the
// device does with each stream.
//
// The logic: if the link were the limit, removing on-device work would change nothing, because the
// bytes still have to arrive either way. So if preview-only runs at full rate and adding recording
// drops it, the cost is encode or disk. If preview-only is already short, the cost is upstream of
// encode — receive, decode or conversion. And comparing each camera against its own solo rate
// separates "this camera is slow on its own" from "these cameras interfere".
//
// One thing this has to control for, which corrupted the first attempt: source indices are not tile
// indices, and a dead source shifts every reading by one. Pass the live indices explicitly;
// scripts/mapSources.js finds them.
//
// Requires the app launched with camera discovery working, which means launched through Maestro.

const BASE = process.env.PRODUCER_ADDRESS || 'http://Tests-iPad-Pro.local:8765'

const call = async path =>
  (await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) })).json()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function argument(name, fallback) {
  const found = process.argv.find(a => a.startsWith(`--${name}=`))
  return found ? found.split('=')[1] : fallback
}

async function measure(indices, record, seconds, settle) {
  const total = (await call('/dump-state')).discoveredSourceCount
  // The control channel is one-based: it applies index - 1 before looking up the selection.
  for (let i = 1; i <= total; i++) {
    await call(`/enable-source?index=${i}&on=${indices.includes(i)}`)
  }
  await call('/start')
  await sleep(settle * 1000)
  if (record) {
    await call('/record?on=true')
    await sleep(6000)
  }

  const before = await call('/dump-state')
  const cpu = []
  const startedAt = Date.now()
  while ((Date.now() - startedAt) / 1000 < seconds) {
    await sleep(2500)
    cpu.push((await call('/dump-state')).cpuPercent)
  }
  const after = await call('/dump-state')
  const elapsed = after.generatedAt - before.generatedAt
  if (record) await call('/record?on=false')

  // Enabled selections occupy tiles 0..N-1 in ascending selection order.
  const slots = indices.length
  const delta = field =>
    after.tiles
      .slice(0, slots)
      .map((tile, i) => (tile[field] - before.tiles[i][field]) / elapsed)

  return {
    indices,
    record,
    received: delta('receivedFrames'),
    archived: delta('archivedFrames'),
    dropped: after.tiles
      .slice(0, slots)
      .reduce(
        (sum, tile, i) =>
          sum + (tile.droppedFrames - before.tiles[i].droppedFrames),
        0
      ),
    cpu: cpu.reduce((a, b) => a + b, 0) / (cpu.length || 1),
    cpuPeak: Math.max(...cpu),
    thermal: after.thermalState,
    names: after.tiles.slice(0, slots).map(t => t.displayName)
  }
}

async function main() {
  const seconds = Number(argument('seconds', 40))
  const settle = Number(argument('settle', 20))
  const live = argument('sources', '2,3,4').split(',').map(Number)
  const repeats = Number(argument('repeats', 1))

  console.log(
    `live sources [${live}], ${seconds}s per variant after ${settle}s settle, ${repeats} pass(es)\n`
  )

  const rows = []
  for (let pass = 1; pass <= repeats; pass++) {
    for (let count = 1; count <= live.length; count++) {
      for (const record of [false, true]) {
        const row = await measure(live.slice(0, count), record, seconds, settle)
        row.pass = pass
        rows.push(row)
        console.log(
          `pass ${pass}  ${count} cam ${record ? 'record ' : 'preview'}  ` +
            `rx [${row.received.map(f => f.toFixed(1)).join(', ')}]  ` +
            `sum ${row.received.reduce((a, b) => a + b, 0).toFixed(1)}  ` +
            `arch [${row.archived.map(f => f.toFixed(1)).join(', ')}]  ` +
            `cpu ${row.cpu.toFixed(1)}%  drop ${row.dropped}  ${row.thermal}`
        )
      }
    }
  }

  console.log('\n--- does on-device work cost ingest? ---')
  for (let count = 1; count <= live.length; count++) {
    const preview = rows.filter(r => r.indices.length === count && !r.record)
    const recording = rows.filter(r => r.indices.length === count && r.record)
    if (!preview.length || !recording.length) continue
    const sum = set =>
      set.reduce((a, r) => a + r.received.reduce((x, y) => x + y, 0), 0) /
      set.length
    const previewRate = sum(preview)
    const recordRate = sum(recording)
    console.log(
      `${count} cam: preview ${previewRate.toFixed(1)} fps -> recording ${recordRate.toFixed(1)} fps ` +
        `(${previewRate > 0 ? (((previewRate - recordRate) / previewRate) * 100).toFixed(0) : '?'}% cost), ` +
        `cpu ${preview[0].cpu.toFixed(1)}% -> ${recording[0].cpu.toFixed(1)}%`
    )
  }

  console.log('\n--- do the cameras interfere with each other? ---')
  const solo = rows.find(r => r.indices.length === 1 && !r.record)
  const most = rows
    .filter(r => r.indices.length === live.length && !r.record)
    .pop()
  if (solo && most) {
    console.log(`camera ${live[0]} alone: ${solo.received[0].toFixed(1)} fps`)
    console.log(
      `same camera with ${live.length - 1} others: ${most.received[0].toFixed(1)} fps`
    )
    console.log(
      `all ${live.length} together: ${most.received.map(f => f.toFixed(1)).join(', ')} fps`
    )
  }
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
