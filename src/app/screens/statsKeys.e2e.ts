/**
 * Deterministic statsTablesSeed fixture and a running worktree API/web build.
 * TEST_SEED is the JSON printed by statsTablesSeed.ts, with any log prefix removed.
 * Set MAESTRO_D, MAESTRO_D_CLIENT_ROOT, MAESTRO_D_BIN, REPLAY_API,
 * REPLAY_WEB_URL, REPLAY_SERVER_LOG and REPLAY_ARTIFACTS as kit.e2e documents.
 * Run: node -r sucrase/register src/app/screens/statsKeys.e2e.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  attachWeb,
  connect,
  required,
  shot,
  signInWeb
} from '../../../e2e/rigs/replayKit'

async function main(): Promise<void> {
  const seed = JSON.parse(readFileSync(required('TEST_SEED'), 'utf8')) as {
    playerId: string
    boxScoreGame: string
    coachTeam: string
    nineInnings: string
  }
  const daemon = await connect()
  try {
    for (const [size, suffix] of [
      ['1280x1000', 'desktop'],
      ['390x844', 'phone']
    ]) {
      const m = await attachWeb(daemon, size)
      try {
        await signInWeb(m, 'stats-tables@example.test')
        for (const [name, route] of [
          ['season', '/seasons/sea_replaySeedSeason?tab=stats'],
          ['team', '/teams/tem_replayPines?tab=stats'],
          ['player', `/players/${seed.playerId}?tab=stats`]
        ]) {
          await m.openBrowser({ url: required('REPLAY_WEB_URL') + route })
          await m.assertVisible({
            text: '.*Batting.*|.*BATTING.*|.*Career.*',
            timeout: 30000
          })
          const result = await m.evalBrowserScript({
            script: `
            const keys = ['batting', 'pitching'].map(kind => document.querySelector('[data-testid="'+kind+'-stats-key"]'));
            if(keys.some(key=>!key))throw Error('Missing stats key');
            for(const [index,key] of keys.entries()){
              const counts=[...key.children].map(column=>column.children.length);
              if(JSON.stringify(counts)!==JSON.stringify(index===0?[13,13]:[15,14]))throw Error('Key column lengths '+counts);
            }
            const pitching=keys[1].textContent;
            if(!pitching.includes('#P - Number of pitches')||!pitching.includes('S - Strikes'))throw Error('Missing count definitions');
            keys[0].scrollIntoView({block:'center'});
            return 'PASS';
          `
          })
          assert.match(JSON.stringify(result), /PASS/)
          await shot(m, `${name}-${suffix}-after`)
        }
        if (suffix === 'phone')
          for (const [name, route] of [
            ['game-box', `/games/${seed.boxScoreGame}?tab=boxScore`],
            [
              'coach-box',
              `/games/${seed.boxScoreGame}/coach/${seed.coachTeam}`
            ],
            ['replay-box', `/games/${seed.nineInnings}/replay`]
          ]) {
            await m.openBrowser({ url: required('REPLAY_WEB_URL') + route })
            await m.assertVisible({ text: '.*Totals.*', timeout: 30000 })
            const result = await m.evalBrowserScript({
              script: `
            const scope=${JSON.stringify(name)}==='coach-box'
              ? document.querySelector('[data-testid="Coach box score"]')
              : ${JSON.stringify(name)}==='replay-box'
                ? document.querySelector('[data-testid="replay-box-score"]')
                : document.body;
            if(!scope)throw Error('Missing active box-score container');
            const key=scope.querySelector('[data-testid="box-stats-key"]');
            if(!key || !key.textContent.includes('#P - Number of pitches') || !key.textContent.includes('S - Strikes'))throw Error('Missing bottom key');
            if(scope.querySelectorAll('[data-testid="box-stats-key"]').length!==1)throw Error('Repeated box key');
            for(const definition of ['AB - At bats','R - Runs scored','H - Hits','RBI - Runs batted in','BB - Base on balls (walks)','SO - Strikeouts','HR - Home runs','HBP - Hit by pitch','AVG - Batting average','IP - Innings pitched','BF - Batters faced','ER - Earned runs','E - Errors']) {
              if(!key.textContent.includes(definition))throw Error('Missing box definition '+definition);
            }
            const text=scope.textContent;
            if(!text.includes('HBP') || !text.includes('#P') || !text.includes('SO'))throw Error('Missing box labels');
            const tables=[...scope.querySelectorAll('[data-testid="frozen-figures"]')];
            const pitching=tables.flatMap(table=>[...table.querySelectorAll('div')].filter(row=>
              [...row.children].map(cell=>cell.textContent).join('|').endsWith('HBP|#P|S')
            ));
            for(const header of pitching){
              const labels=[...header.children].map(cell=>cell.textContent);
              const rows=[...header.parentElement.children].slice(1).map(row=>[...row.children].map(cell=>cell.textContent));
              const total=rows.pop();
              for(const label of ['#P','S']){
                const index=labels.indexOf(label);
                const counts=rows.map(row=>row[index]);
                const expected=counts.some(value=>value==='—')?'—':String(counts.reduce((sum,value)=>sum+Number(value),0));
                if(total[index]!==expected)throw Error(label+' total does not equal pitcher rows');
              }
            }
            key.scrollIntoView({block:'center', behavior:'instant'});
            if(${JSON.stringify(name)}==='replay-box') {
              // A phone's replay deck scrolls behind its playback controls.
              // Its bottom padding must let the final definitions clear them.
              scope.scrollTop=scope.scrollHeight;
              const last=key.children[0].lastElementChild.getBoundingClientRect();
              const deck=scope.getBoundingClientRect();
              if(last.top<deck.top || last.bottom>innerHeight-96)throw Error('Last definition hidden by playback controls');
              const figures=scope.querySelector('[data-testid="replay-box-score-tables"]');
              if(figures)figures.scrollLeft=figures.scrollWidth;
            }
            for(const figures of scope.querySelectorAll('[data-testid="frozen-figures"]')) {
              for(let node=figures;node;node=node.parentElement) {
                if(node.scrollWidth>node.clientWidth && ['auto','scroll'].includes(getComputedStyle(node).overflowX)) {
                  node.scrollLeft=node.scrollWidth;
                  break;
                }
              }
            }
            return 'PASS';
          `
            })
            assert.match(JSON.stringify(result), /PASS/)
            await new Promise(resolve => setTimeout(resolve, 1000))
            await shot(m, `${name}-after`)
          }
      } finally {
        await m.detach()
      }
    }
  } finally {
    await daemon.shutdown()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
