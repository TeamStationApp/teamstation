import { createHash } from 'crypto'
import { build, context } from 'esbuild'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

import buildInfoTools from '../scripts/build-info.cjs'
import { buildWasm, findCargo } from '../scripts/chatCryptoBuild.mjs'
import { webSettings } from '../scripts/web-build-settings.mjs'
import {
  cspFor,
  integrityOf,
  originsFor,
  withCsp,
  withIntegrity
} from './buildCsp.mjs'

/**
 * Everything below is written relative to the repository root, and this is
 * what makes that true wherever the command is run from.
 *
 * `dist/` has to land beside `lib/` at the top of the tree, because that is
 * where the server looks for it. Anchor
 * it to this file rather than to the shell's idea of where it is: `npm run
 * build.web` runs from the root, but a person debugging runs it from wherever
 * they happen to be standing, and a bundle built into the wrong directory is
 * a deploy that serves the previous one with no error anywhere.
 */
process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))

/**
 * Bundles the web app.
 *
 *   node build.mjs           build once into dist/
 *   node build.mjs --serve   build, watch and serve on 8080
 *
 * esbuild rather than Metro or webpack: it understands TypeScript and JSX on
 * its own, so the whole configuration is the alias below. `react-native` is
 * aliased to `react-native-web`, which is what makes one set of components
 * render in a browser now and on a phone later.
 */
const serve = process.argv.includes('--serve')

/**
 * Where the app looks for the API.
 *
 * Relative by default, because in production the app and the API are the same
 * origin and /api/* is routed to the server. It used to default to the
 * loopback instead, which is correct on the one machine running both and wrong
 * on every other device in the world: the bundle told each visitor's *own*
 * phone to answer on port 9100, the request never left the handset, and the
 * screen said "Load failed" while the server sat there with nothing in any log
 * to show for it. It cost a morning.
 *
 * A dev server on :8080 is genuinely a different origin from the API on :9100,
 * so serving locally still points at the port — the case that needs the
 * absolute URL is the one that asks for it.
 */
const apiBaseUrl =
  process.env.TS_API_BASE_URL ??
  (serve ? 'http://127.0.0.1:9100/api/v1' : '/api/v1')

// A production bundle that names a loopback address cannot work anywhere but
// the machine that built it. Refuse to write one.
if (!serve && /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(apiBaseUrl)) {
  throw new Error(
    `Refusing to build with TS_API_BASE_URL=${apiBaseUrl}: a deployed app ` +
      'cannot reach the loopback of the device it is running on.'
  )
}

/**
 * The page's Content-Security-Policy (`buildCsp.mjs`), written into every
 * build: the API and its socket from `TS_API_BASE_URL` when that is absolute,
 * and the media origins the deploy names in `TS_MEDIA_ORIGINS`
 * (space-separated; `src/deploy/mediaOrigins.mjs` prints them).
 */
const policy = cspFor(
  originsFor(apiBaseUrl, process.env.TS_MEDIA_ORIGINS ?? '')
)

/**
 * Where the build is written. `dist/` always, except for the tests of the
 * build itself, which must not replace a served bundle.
 */
const out = process.env.TS_WEB_OUT_DIR ?? 'dist'

/**
 * Chat's crypto core, as the WebAssembly module every browser loads
 * (`crates/chat-crypto`, built by `scripts/chatCryptoBuild.mjs`). It is
 * copied beside the bundle under a name with its hash in it, as the bundle
 * is (plain `chat-crypto.wasm` under `--serve`), and the bundle is told where
 * it is and what its sha384 must be: `core.web.ts` fetches it with that
 * integrity and refuses anything else. Under `--serve` a change to the crate
 * needs a restart, since the watch follows the bundle only.
 */
const found = findCargo()
if (found.error != null) throw new Error(found.error)
const wasmBytes = await readFile(buildWasm(found))
const wasmFile = serve
  ? 'chat-crypto.wasm'
  : `chat-crypto-${createHash('sha256').update(wasmBytes).digest('hex').slice(0, 16)}.wasm`

/**
 * Reanimated's worklets, and nothing else.
 *
 * Reanimated compiles the functions that run on the animation thread with a
 * Babel plugin, and its own documentation says the build without that plugin is
 * possible on the web and is not the configuration they test. esbuild cannot run
 * Babel plugins, so Babel goes in front of it — but only over this app's own
 * `.tsx`, never `node_modules`, and only with the two syntax plugins it needs to
 * parse the file.
 *
 * Syntax plugins rather than a preset on purpose: the plugin then hands back
 * TypeScript and JSX untouched apart from the worklets it rewrote, so esbuild
 * still does the actual transform at its own speed. A full `@babel/preset-*`
 * pass here would transpile everything twice and cost far more than it does.
 */

const workerOptions = {
  entryPoints: ['src/app/platform/passwordWorker.ts'],
  bundle: true,
  outdir: 'dist',
  entryNames: serve ? 'password-worker' : 'password-worker-[hash]',
  format: 'iife',
  target: ['es2021'],
  minify: !serve,
  // Mapped like the app bundle, so a deploy uploads the worker's map to Sentry too.
  sourcemap: true,
  metafile: true
}
const workerBuild = await build(workerOptions)
const workerFile = Object.keys(workerBuild.metafile.outputs).find(name =>
  name.endsWith('.js')
)
if (workerFile == null) throw new Error('Password worker build failed')
if (serve) {
  const workerContext = await context(workerOptions)
  await workerContext.watch()
}

const options = {
  ...webSettings,
  entryPoints: ['src/app/web/index.tsx'],
  // A content hash in the name, for production only. Without it the bundle is
  // always `/app.js`, and a browser that has cached one has no way to learn
  // there is a newer one — Paul's phone loaded the page twice after a fix was
  // deployed and never asked for the script at all. A name that changes when
  // the bytes change makes a stale copy impossible rather than unlikely.
  ...(serve
    ? { outfile: `${out}/app.js` }
    : { outdir: out, entryNames: 'app-[hash]' }),
  bundle: true,
  format: 'iife',
  target: ['es2021'],
  jsx: 'automatic',
  // React Native packages ship platform variants as `.web.js` beside `.js` and
  // expect the bundler to prefer them; Metro and webpack are configured for it
  // and esbuild is not, out of the box. Without this, Gesture Handler resolves
  // its native file and asks for `react-native/Libraries/...` internals that
  // react-native-web does not have, and the build fails on two imports that
  // have nothing to do with anything we wrote.
  sourcemap: true,
  minify: !serve,
  logLevel: 'info',
  define: {
    'process.env.TS_BUILD_INFO': JSON.stringify(
      buildInfoTools.bundleBuildInfo()
    ),
    'process.env.NODE_ENV': JSON.stringify(
      serve ? 'development' : 'production'
    ),
    __DEV__: serve ? 'true' : 'false',
    TS_API_BASE_URL: JSON.stringify(apiBaseUrl),
    TS_CHAT_WASM_URL: JSON.stringify(`/${wasmFile}`),
    TS_CHAT_WASM_INTEGRITY: JSON.stringify(integrityOf(wasmBytes)),
    TS_PASSWORD_WORKER_URL: JSON.stringify(
      '/' + workerFile.replace(/^dist\//, '')
    ),
    TS_FIELD_PREVIEW: process.env.TS_FIELD_PREVIEW === '1' ? 'true' : 'false',
    // Where the app reports crashes; empty reports nothing (src/app/sentry.ts).
    'process.env.TS_SENTRY_DSN': JSON.stringify(
      process.env.TS_SENTRY_DSN ?? ''
    ),
    // `global` is what a React Native runtime calls it and no browser does.
    // Worklets are compiled to code that reaches for it, and React Native Web
    // reaches for it too — stopping an `Animated` timing calls
    // `global.cancelAnimationFrame`. Either way the bundle throws
    // `global is not defined` and takes the screen with it.
    global: 'globalThis'
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
}

await mkdir(out, { recursive: true })
const template = withCsp(
  await readFile('src/app/web/index.html', 'utf8'),
  policy
)
const mark = await readFile('src/app/assets/teamStationMark.svg', 'utf8')
const viewBox = /viewBox="([^"]+)"/.exec(mark)
if (viewBox == null) throw new Error('TeamStation mark has no viewBox')
const artwork = /<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/.exec(mark)
if (artwork == null) throw new Error('TeamStation mark has no SVG artwork')
// An inset mark on the light app canvas, with an iOS-style rounded outline.
await writeFile(
  `${out}/favicon.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <title>TeamStation</title>
  <rect width="256" height="256" rx="56" fill="#F5F7F1"/>
  <svg x="24" y="24" width="208" height="208" viewBox="${viewBox[1]}">${artwork[1]}</svg>
</svg>\n`
)
await copyFile('src/app/web/favicon.ico', `${out}/favicon.ico`)
await copyFile('src/app/web/favicon.png', `${out}/favicon.png`)
// The privacy policy is a plain page, readable without loading the app; the
// stores link to https://web.teamstation.app/privacy.html.
await copyFile('src/app/web/privacy.html', `${out}/privacy.html`)
// The text fonts the phones carry, so the web draws the very same faces
// (`index.html` declares them); never a system font. In production each is
// renamed `<Family>-<Style>-<hash>.ttf`, its content's hash as the bundle's
// is, so the server can let a browser keep it for ever: the page waits for
// these faces (`font-display: block`), and a revalidation on every load would
// leave its text blank for a round trip on a weak connection. Only
// `index.html` is rewritten to the new names (`withFonts`); a new page naming
// a font must go through it too, or it names a file production does not have.
await rm(`${out}/fonts`, { recursive: true, force: true })
await mkdir(`${out}/fonts`, { recursive: true })
/** Each font's path in `index.html`, and the path it is served at. */
const fontPaths = []
for (const family of ['SpaceGrotesk', 'Inter', 'Quicksand'])
  for (const style of ['Regular', 'Medium', 'SemiBold', 'Bold']) {
    const source = `src/app/assets/fonts/${family}-${style}.ttf`
    const name = serve
      ? `${family}-${style}.ttf`
      : `${family}-${style}-${createHash('sha256')
          .update(await readFile(source))
          .digest('hex')
          .slice(0, 12)}.ttf`
    await copyFile(source, `${out}/fonts/${name}`)
    fontPaths.push([`/fonts/${family}-${style}.ttf`, `/fonts/${name}`])
  }
/** The page with each font named as it is served. */
const withFonts = page =>
  fontPaths.reduce((text, [from, to]) => text.replaceAll(from, to), page)

/** Keep the web AudioWorklet at the bundle origin. */
await copyFile('src/app/scoring/pcm16kWorklet.js', `${out}/pcm16kWorklet.js`)

// Earlier deploys' modules, then this one's, so exactly one is left.
for (const name of await readdirSafe(out)) {
  if (/^chat-crypto-[0-9a-f]+\.wasm$/.test(name) && name !== wasmFile) {
    await rm(`${out}/${name}`)
  }
}
await writeFile(`${out}/${wasmFile}`, wasmBytes)

if (serve) {
  // No integrity here: the watch rebuilds `app.js` after this page is
  // written, and a hash of the first build would refuse every later one.
  await writeFile(`${out}/index.html`, template)
  const ctx = await context(options)
  await ctx.watch()
  // Without the fallback every address but `/` answers 404 on a reload, which
  // is every address the app hands out.
  const { hosts, port } = await ctx.serve({
    servedir: out,
    fallback: `${out}/index.html`,
    // Overridable because two worktrees are often being served at once, and
    // the second one silently failing to bind is a confusing way to spend ten
    // minutes. `TS_API_BASE_URL` moves the API port to match.
    port: Number(process.env.TS_SERVE_PORT ?? 8080)
  })
  console.log(`app on http://${hosts[0] ?? '127.0.0.1'}:${port}`)
  console.log(`talking to ${apiBaseUrl}`)
} else {
  // Old hashed bundles would otherwise pile up, one per deploy, for ever.
  for (const name of await readdirSafe(out)) {
    if (/^app-[A-Z0-9]+\.js(\.map)?$/i.test(name)) await rm(`${out}/${name}`)
  }

  const result = await build({ ...options, metafile: true })
  const script = Object.keys(result.metafile.outputs).find(
    name => name.endsWith('.js') && !name.endsWith('.map')
  )
  if (script == null) throw new Error('esbuild produced no script')
  const file = path.basename(script)

  // The page names the bundle, so the page must not be cached even briefly —
  // that is what its `no-cache` header is for. It is small and it is the
  // only thing that has to be fetched to learn the current bundle's name.
  // The script tag carries the bundle's hash too (Subresource Integrity).
  await writeFile(
    `${out}/index.html`,
    withFonts(withIntegrity(template.replace('src="/app.js"', `src="/${file}"`), {
      [`/${file}`]: await readFile(`${out}/${file}`)
    }))
  )
  console.log(`built ${out}/${file}`)
}

/** `readdir`, treating a missing directory as empty. */
async function readdirSafe(dir) {
  const { readdir } = await import('fs/promises')
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}
