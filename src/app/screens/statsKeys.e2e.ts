// Seed with statsTablesSeed.ts and start this tree's server/web build.
// MAESTRO_D_CLIENT_ROOT=<npm client> MAESTRO_D=statsKeys TEST_DEVICE=<browser>
// TEST_URL=<web> TEST_SEED=<seed.json> TEST_ARTIFACT_DIR=<dir>
// TEST_SURFACE=desktop|phone [TEST_TOKEN=<fresh sign-in token>]
// node -r sucrase/register src/app/screens/statsKeys.e2e.ts
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
async function main(): Promise<void> {
  const { MaestroD } = createRequire(
    join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
  )('./dist/cjs/index.js')
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  const surface = required('TEST_SURFACE')
  const seed = JSON.parse(readFileSync(required('TEST_SEED'), 'utf8'))
  const browser = await daemon.attach({
    device: required('TEST_DEVICE'),
    platform: 'web',
    appId: required('TEST_URL'),
    extra: {
      browser: 'chromium',
      windowSize: surface === 'phone' ? '390x844' : '1280x1000'
    },
    artifacts: 'none'
  })
  const read = async <T = unknown>(script: string): Promise<T> => {
    const result = await browser.evalBrowserScript({
      script: `return JSON.stringify((()=>{${script}})() ?? null)`
    })
    return JSON.parse(result.data) as T
  }
  const open = async (route: string): Promise<void> => {
    await browser.openBrowser({ url: required('TEST_URL') + route })
  }
  const until = async (script: string): Promise<void> => {
    for (let i = 0; i < 40; i++) {
      if (await read<boolean>(script)) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`Page condition failed: ${script}`)
  }
  const shot = async (name: string): Promise<void> => {
    writeFileSync(
      join(required('TEST_ARTIFACT_DIR'), `${name}-${surface}-after.png`),
      await browser.screenshot()
    )
  }
  try {
    if (process.env.TEST_TOKEN != null) {
      await open(`/signin/${process.env.TEST_TOKEN}`)
      await new Promise(resolve => setTimeout(resolve, 2500))
    }
    for (const [name, route] of [
      ['team', `/teams/${seed.coachTeam}?tab=stats`],
      ['season', '/seasons/sea_replaySeedSeason?tab=stats'],
      ['player', `/players/${seed.playerId}?tab=stats`]
    ]) {
      await open(route)
      await until(
        'return document.querySelector(\'[data-testid="pitching-stat-key"]\') !== null'
      )
      for (const kind of ['batting', 'pitching']) {
        const labels =
          kind === 'batting'
            ? 'GP PA AB AVG OBP OPS SLG H 1B 2B 3B HR RBI R BB SO K-L HBP SAC SF ROE FC SB SB% CS PIK'.split(
                ' '
              )
            : 'IP GP GS BF #P W L SV SVO BS SV% H R ER BB SO K-L HBP ERA WHIP LOB BK PIK CS SB SB% WP BAA'.split(
                ' '
              )
        const result = await read<{
          labels: string[]
          lengths: number[]
          columns: Array<{ left: number; right: number }>
          overflow: boolean
          width: number
        }>(`const key=document.querySelector('[data-testid="${kind}-stat-key"]');
          key.scrollIntoView({block:'center'});
          const columns=[...key.children];
          const rows=columns.flatMap(c=>[...c.children]);
          return {labels:rows.map(r=>r.children[0].children[0].textContent), lengths:columns.map(c=>c.children.length),
          columns:columns.map(c=>({left:c.getBoundingClientRect().left,right:c.getBoundingClientRect().right})),
          overflow:rows.some(r=>r.children[1].scrollWidth>r.children[1].clientWidth+1), width:innerWidth}`)
        assert.deepEqual(result.labels, labels)
        assert.deepEqual(result.lengths, [labels.length / 2, labels.length / 2])
        assert(result.columns[0].right <= result.columns[1].left)
        assert(result.columns[1].right <= result.width)
        assert.equal(result.overflow, false)
        await shot(`${name}-${kind}`)
      }
      console.log(
        `${surface}: ${name} keys have exact order, two columns and no overflow`
      )
    }
    for (const [name, route] of [
      ['game-box', `/games/${seed.boxScoreGame}?tab=boxScore`],
      ['coach-box', `/games/${seed.boxScoreGame}/coach/${seed.coachTeam}`]
    ]) {
      await open(route)
      await until(
        'return [...document.querySelectorAll(\'[data-testid="frozen-figures"]\')].some(e=>e.innerText.includes("#P"))'
      )
      const rows = await read<
        string[][]
      >(`const table=[...document.querySelectorAll('[data-testid="frozen-figures"]')].find(e=>e.innerText.includes('#P'));
        table.scrollIntoView({block:'center'});table.scrollLeft=table.scrollWidth;
        for(let e=table;e;e=e.parentElement)if(e.scrollWidth>e.clientWidth)e.scrollLeft=e.scrollWidth;
        const cells=table.innerText.split('\\n').filter(Boolean);return Array.from({length:cells.length/10},(_,i)=>cells.slice(i*10,i*10+10))`)
      assert(rows.flat().includes('SO'))
      assert(rows.flat().includes('#P'))
      const header = rows.find((r: string[]) => r.includes('#P'))
      assert(header != null)
      assert.equal(header.indexOf('#P'), header.indexOf('HBP') + 1)
      const counts = rows.slice(1).map(row => row[header.length - 1])
      assert(counts.length >= 2, 'pitcher rows and total')
      if (counts.every(value => value !== '—'))
        assert.equal(
          Number(counts.at(-1)),
          counts.slice(0, -1).reduce((total, value) => total + Number(value), 0)
        )
      await shot(name)
      console.log(`${surface}: ${name} shows SO and HBP/#P`)
    }
    await open(`/games/${seed.boxScoreGame}/replay`)
    await until(
      'return document.querySelector(\'[data-testid="replay-box-score"]\') !== null || [...document.querySelectorAll(\'[role="button"]\')].some(e=>/Box Score/i.test(e.textContent))'
    )
    await read(
      'const button=[...document.querySelectorAll(\'[role="button"]\')].find(e=>/Box Score/i.test(e.textContent));if(!document.querySelector(\'[data-testid="replay-box-score"]\') && button)button.click()'
    )
    await until(
      'return document.querySelector(\'[data-testid="replay-box-score"]\') !== null'
    )
    const replay = await read<string>(
      `const box=document.querySelector('[data-testid="replay-box-score"]');return box.innerText`
    )
    assert(/SO\s*HBP\s*#P/.test(replay))
    assert(replay.includes('Totals'))
    await shot('replay-box')
    console.log(`${surface}: replay shows SO, HBP/#P and totals`)
  } finally {
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
