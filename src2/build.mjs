import { build, context } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'

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
 * origin and Caddy routes /api/* to the server. It used to default to the
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
  process.env.GS_API_BASE_URL ??
  (serve ? 'http://127.0.0.1:9100/api/v1' : '/api/v1')

// A production bundle that names a loopback address cannot work anywhere but
// the machine that built it. Refuse to write one.
if (!serve && /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(apiBaseUrl)) {
  throw new Error(
    `Refusing to build with GS_API_BASE_URL=${apiBaseUrl}: a deployed app ` +
      'cannot reach the loopback of the device it is running on.'
  )
}

const options = {
  entryPoints: ['app/web/index.tsx'],
  // A content hash in the name, for production only. Without it the bundle is
  // always `/app.js`, and a browser that has cached one has no way to learn
  // there is a newer one — Paul's phone loaded the page twice after a fix was
  // deployed and never asked for the script at all. A name that changes when
  // the bytes change makes a stale copy impossible rather than unlikely.
  ...(serve
    ? { outfile: 'dist/app.js' }
    : { outdir: 'dist', entryNames: 'app-[hash]' }),
  bundle: true,
  format: 'iife',
  target: ['es2021'],
  jsx: 'automatic',
  sourcemap: true,
  minify: !serve,
  logLevel: 'info',
  alias: { 'react-native': 'react-native-web' },
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      serve ? 'development' : 'production'
    ),
    __DEV__: serve ? 'true' : 'false',
    GS_API_BASE_URL: JSON.stringify(apiBaseUrl)
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
}

await mkdir('dist', { recursive: true })
const template = await readFile('app/web/index.html', 'utf8')

if (serve) {
  await writeFile('dist/index.html', template)
  const ctx = await context(options)
  await ctx.watch()
  // Without the fallback every address but `/` answers 404 on a reload, which
  // is every address the app hands out.
  const { hosts, port } = await ctx.serve({
    servedir: 'dist',
    fallback: 'dist/index.html',
    port: 8080
  })
  console.log(`app on http://${hosts[0] ?? '127.0.0.1'}:${port}`)
  console.log(`talking to ${apiBaseUrl}`)
} else {
  // Old hashed bundles would otherwise pile up, one per deploy, for ever.
  for (const name of await readdirSafe('dist')) {
    if (/^app-[A-Z0-9]+\.js(\.map)?$/i.test(name)) await rm(`dist/${name}`)
  }

  const result = await build({ ...options, metafile: true })
  const script = Object.keys(result.metafile.outputs).find(
    name => name.endsWith('.js') && !name.endsWith('.map')
  )
  if (script == null) throw new Error('esbuild produced no script')
  const file = script.replace(/^dist\//, '')

  // The page names the bundle, so the page must not be cached even briefly —
  // that is what `no-cache` in the Caddyfile is for. It is small and it is the
  // only thing that has to be fetched to learn the current bundle's name.
  await writeFile(
    'dist/index.html',
    template.replace('src="/app.js"', `src="/${file}"`)
  )
  console.log(`built dist/${file}`)
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
