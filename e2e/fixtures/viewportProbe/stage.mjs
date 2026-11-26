// On the isolated stack: node e2e/fixtures/viewportProbe/stage.mjs dist
// The scoring measurement uses the deployed application's own top-level
// document and bundle. Only the fixture copy gains the read-only recorder.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = resolve(process.argv[2] ?? 'dist')
const index = await readFile(resolve(dir, 'index.html'), 'utf8')
const app = /<script\b[^>]*\bsrc="\/app(?:-[^"/]+)?\.js"/
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
  resolve(target, 'scoring.html'),
  index.replace(app, '<script src="/viewportProbe/surface.js"></script>\n$&')
)
