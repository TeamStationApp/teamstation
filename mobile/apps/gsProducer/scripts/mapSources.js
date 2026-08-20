#!/usr/bin/env node
'use strict'

// Works out which control-channel source index drives which tile, by enabling one at a time.
//
// Needed because selection order is not tile order: selections carry a persistent `tileIndex`, so
// enabling index 0 can light up tile 3. An ablation that assumes index N == tile N silently
// measures the wrong tile and reports zeros for cameras that are working fine.

const BASE = process.env.PRODUCER_ADDRESS || 'http://Tests-iPad-Pro.local:8765'

const call = async path =>
  (await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) })).json()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const state = await call('/dump-state')
  const count = state.discoveredSourceCount
  console.log(`probing ${count} sources\n`)
  const map = []

  // One-based: the control channel applies index - 1 before looking up the selection.
  for (let index = 1; index <= count; index++) {
    for (let other = 1; other <= count; other++) {
      await call(`/enable-source?index=${other}&on=${other === index}`)
    }
    await call('/start')
    await sleep(6000)
    const before = await call('/dump-state')
    await sleep(14000)
    const after = await call('/dump-state')
    const elapsed = after.generatedAt - before.generatedAt

    const rates = after.tiles.map(
      (tile, i) =>
        (tile.receivedFrames - before.tiles[i].receivedFrames) / elapsed
    )
    const best = rates.indexOf(Math.max(...rates))
    const alive = rates[best] > 0.05
    const tile = after.tiles[best]
    map.push({
      index,
      tile: alive ? best : null,
      name: alive ? tile.displayName : '(no frames)',
      fps: rates[best]
    })
    console.log(
      `index ${index} -> ${alive ? `tile ${best} "${tile.displayName}"` : 'no tile produced frames'}` +
        `  ${rates[best].toFixed(1)} fps alone`
    )
  }

  console.log(
    '\nsolo rates, which is the ceiling each camera can reach with nothing competing:'
  )
  for (const entry of map) {
    console.log(
      `  index ${entry.index}  ${entry.name.padEnd(14)} ${entry.fps.toFixed(1)} fps`
    )
  }
  console.log(`\nmap: ${JSON.stringify(map.map(e => e.tile))}`)
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
