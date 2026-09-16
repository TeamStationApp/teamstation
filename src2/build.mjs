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
const apiBaseUrl = process.env.GS_API_BASE_URL ?? 'http://127.0.0.1:9100/api/v1'
const mediaBaseUrl = process.env.GS_MEDIA_BASE_URL ?? '/media'

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
    GS_API_BASE_URL: JSON.stringify(apiBaseUrl),
    GS_MEDIA_BASE_URL: JSON.stringify(mediaBaseUrl)
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
