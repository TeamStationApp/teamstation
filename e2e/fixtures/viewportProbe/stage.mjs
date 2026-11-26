// On the isolated stack: node e2e/fixtures/viewportProbe/stage.mjs dist
// The scoring measurement uses the deployed application's own top-level
// document and bundle. Only the fixture copy gains the read-only recorder.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import fieldScene from '../../rigs/fieldScene.cjs'

const dir = resolve(process.argv[2] ?? 'dist')
const index = await readFile(resolve(dir, 'index.html'), 'utf8')
const app = /<script\b[^>]*\bsrc="\/app(?:-[A-Za-z0-9_]+)?\.js"/
if (!app.test(index)) throw new Error('Cannot find the deployed app script')
const target = resolve(dir, 'viewportProbe')
await mkdir(target, { recursive: true })
for (const asset of ['index.html', 'surface.js', 'reference.html']) {
  await copyFile(
    fileURLToPath(new URL(asset, import.meta.url)),
    resolve(target, asset)
  )
}
await writeFile(
  resolve(target, 'scene.js'),
  `
if (new URLSearchParams(location.search).has('geometry')) {
  ${fieldScene.FIELD_SCENE_PROBE};
  window.scoringLandmarks = (radius, angle) => {
    ${fieldScene.THREE_STATE}
    if (!three || !three.scene.getObjectByName('vintage-scoreboard')) return;
    const corners = [-1,1].flatMap(sign => [Math.PI/4,angle].map(a => project(sign*radius*Math.sin(a),0,-radius*Math.cos(a))));
    const board = (()=>{ ${fieldScene.BOARD_BOUNDS} })();
    return {corners,board};
  };
}
`
)
await writeFile(
  resolve(target, 'scoring.html'),
  index.replace(
    app,
    '<script src="/viewportProbe/scene.js"></script>\n<script src="/viewportProbe/surface.js"></script>\n$&'
  )
)
