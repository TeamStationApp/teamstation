import { build, context } from 'esbuild'
import { copyFile, mkdir } from 'fs/promises'

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
  outfile: 'dist/app.js',
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
await copyFile('app/web/index.html', 'dist/index.html')

if (serve) {
  const ctx = await context(options)
  await ctx.watch()
  const { hosts, port } = await ctx.serve({ servedir: 'dist', port: 8080 })
  console.log(`app on http://${hosts[0] ?? '127.0.0.1'}:${port}`)
  console.log(`talking to ${apiBaseUrl}`)
} else {
  await build(options)
  console.log('built dist/app.js')
}
