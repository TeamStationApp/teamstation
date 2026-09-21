import babel from '@babel/core'
import { build, context } from 'esbuild'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

/**
 * Everything below is written relative to the repository root, and this is
 * what makes that true wherever the command is run from.
 *
 * `dist/` has to land beside `lib/` at the top of the tree, because that is
 * where Caddy is pointed and where the service's working directory is. Anchor
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
const worklets = {
  name: 'reanimated-worklets',
  setup(pluginBuild) {
    // `.tsx?`, not `.tsx`: a hook file is plain TypeScript and is exactly where
    // a shared worklet ends up, so a filter that missed it left
    // `useAnimatedStyle` uncompiled and every screen using it blank.
    pluginBuild.onLoad({ filter: /app\/.*\.tsx?$/ }, async args => {
      const source = await readFile(args.path, 'utf8')
      // Only files that mention Reanimated can contain a worklet, and the check
      // costs nothing next to parsing a file that cannot.
      if (!/react-native-reanimated|['"]worklet['"]/.test(source)) return null
      const result = await babel.transformAsync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        sourceMaps: 'inline',
        plugins: [
          ['@babel/plugin-syntax-typescript', { isTSX: true }],
          '@babel/plugin-syntax-jsx',
          'react-native-worklets/plugin'
        ]
      })
      return { contents: result.code, loader: 'tsx' }
    })
  }
}

const options = {
  plugins: [worklets],
  entryPoints: ['src2/app/web/index.tsx'],
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
  // React Native packages ship platform variants as `.web.js` beside `.js` and
  // expect the bundler to prefer them; Metro and webpack are configured for it
  // and esbuild is not, out of the box. Without this, Gesture Handler resolves
  // its native file and asks for `react-native/Libraries/...` internals that
  // react-native-web does not have, and the build fails on two imports that
  // have nothing to do with anything we wrote.
  resolveExtensions: [
    '.web.tsx',
    '.web.ts',
    '.web.jsx',
    '.web.js',
    '.tsx',
    '.ts',
    '.jsx',
    '.js',
    '.json'
  ],
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
    // `global` is what a React Native runtime calls it and no browser does.
    // Worklets are compiled to code that reaches for it, and React Native Web
    // reaches for it too — stopping an `Animated` timing calls
    // `global.cancelAnimationFrame`. Either way the bundle throws
    // `global is not defined` and takes the screen with it.
    global: 'globalThis'
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
}

await mkdir('dist', { recursive: true })
const template = await readFile('src2/app/web/index.html', 'utf8')

/**
 * The two files Apple and Google fetch to decide whether a link may open the
 * app. They are built rather than placed on the server: a deploy replaces the
 * versions directory wholesale, so a hand-placed copy is one deploy from gone.
 */
async function copyWellKnown() {
  await mkdir('dist/.well-known', { recursive: true })
  for (const name of ['apple-app-site-association', 'assetlinks.json']) {
    await copyFile(
      `src2/app/web/.well-known/${name}`,
      `dist/.well-known/${name}`
    )
  }
}
await copyWellKnown()

if (serve) {
  await writeFile('dist/index.html', template)
  const ctx = await context(options)
  await ctx.watch()
  // Without the fallback every address but `/` answers 404 on a reload, which
  // is every address the app hands out.
  const { hosts, port } = await ctx.serve({
    servedir: 'dist',
    fallback: 'dist/index.html',
    // Overridable because two worktrees are often being served at once, and
    // the second one silently failing to bind is a confusing way to spend ten
    // minutes. `GS_API_BASE_URL` moves the API port to match.
    port: Number(process.env.GS_SERVE_PORT ?? 8080)
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
