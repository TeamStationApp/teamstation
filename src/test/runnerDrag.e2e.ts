import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import express from 'express'

import { maestro } from './refinementsMaestro.e2e'

/** Exercise real touch capture in WebKit while defender editing becomes locked. */
async function main(): Promise<void> {
  const device = process.env.SCORING_DEVICE_UDID
  const output = process.env.SCORING_ARTIFACT_DIR
  assert(
    device != null && output != null,
    'Supply simulator and artifact directory'
  )
  const directory = path.join(output, 'fixture')
  await mkdir(directory, { recursive: true })
  const { build } = await import('esbuild')
  const { webSettings } = require('../../scripts/web-build-settings.mjs')
  await build({
    ...webSettings,
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {ThemeProvider} from './src/app/theme/ThemeContext';
        import {FieldCanvas} from './src/app/field/FieldCanvas';
        import {BASES, createPlayers} from './src/app/field/fieldModel';
        import {runnerTargets} from './src/app/scoring/runnerDrag';
        const players = createPlayers();
        const runner = players[9], defender = players[0];
        runner.position = {...BASES[1]}; runner.target = {...BASES[1]};
        runner.runnerBase = 1; runner.name = runner.displayName = 'Runner';
        const shown = [runner, defender];
        function Fixture() {
          const [active, setActive] = useState(false);
          const [bases, setBases] = useState(null);
          const [result, setResult] = useState('Ready');
          const tapIds = active ? [] : [defender.id];
          return <ThemeProvider><div style={{height:'100dvh', touchAction:'none'}}>
            <FieldCanvas players={shown} selected="" onSelect={()=>{}} view="home" zoom={1}
              tapIds={tapIds} onGestureActive={setActive}
              interaction={{generation:0,selectableIds:[...tapIds,runner.id],runnerIds:[runner.id],gestures:['place']}}
              onBaseProjection={setBases}
              onRunnerDrag={value => {if(value) fetch('/drag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:value.to,progress:value.progress})})}}
              onRunnerDrop={(id,to,decision) => setResult(decision+' on '+to)} />
            {bases && [1,2].flatMap(base => Object.entries(runnerTargets(bases.bases[base],bases.width,bases.height,base)).map(([decision,rect]) =>
              <div key={base+decision} style={{position:'absolute',left:rect.x,top:rect.y,width:rect.width,height:rect.height,pointerEvents:'none',color:'white',background:'#00308788',display:'flex',alignItems:'center',justifyContent:'center'}}>{base+' '+decision}</div>))}
            <div style={{position:'absolute',top:10,left:10,color:'white'}}>{result}</div>
          </div></ThemeProvider>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: path.join(directory, 'app.js'),
    define: {
      __DEV__: 'true',
      global: 'globalThis',
      'process.env': '{}',
      'process.env.NODE_ENV': '"development"'
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
  await cp('src/app/assets/fonts', path.join(directory, 'fonts'), {
    recursive: true
  })
  const html = (await readFile('src/app/web/index.html', 'utf8')).replace(
    '</head>',
    '<style>body{overflow:hidden}#root{display:block}</style></head>'
  )
  await writeFile(path.join(directory, 'index.html'), html)
  const app = express()
  const drags: unknown[] = []
  app.use(express.json())
  app.post('/drag', (req, res) => {
    drags.push(req.body)
    res.sendStatus(204)
  })
  app.use(express.static(directory))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address != null && typeof address !== 'string')
  const daemon = await maestro('score-screen-runner-drag')
  let m: Awaited<ReturnType<typeof daemon.attach>> | undefined
  try {
    m = await daemon.attach({
      device,
      platform: 'ios',
      appId: 'com.apple.mobilesafari',
      artifacts: 'on-failure'
    })
    await m.openLink({ link: `http://127.0.0.1:${address.port}` })
    await m.assertVisible({ text: 'Runner', timeout: 30000 })
    await writeFile(path.join(output, 'before.png'), await m.screenshot())
    for (const [base, decision] of [
      [2, 'safe'],
      [1, 'safe'],
      [1, 'out']
    ] as const) {
      await m.command('dragAndDrop', {
        from: { text: 'Runner' },
        to: { text: `${base} ${decision}` },
        holdDuration: 500,
        duration: 1500
      })
      await writeFile(
        path.join(output, `${base}-${decision}.png`),
        await m.screenshot()
      )
      await m.assertVisible({ text: `${decision} on ${base}`, timeout: 5000 })
    }
    assert(drags.length > 0, 'The runner never moved')
    console.log(
      'PASS simulator Safari: runner advances and offers Safe/Out for a pickoff'
    )
  } finally {
    await writeFile(
      path.join(output, 'drags.json'),
      JSON.stringify(drags, null, 2)
    )
    await m?.detach()
    await daemon.shutdown()
    server.closeAllConnections()
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      })
    )
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
