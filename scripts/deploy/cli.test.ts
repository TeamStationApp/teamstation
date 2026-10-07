import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { asObject, asString } from 'cleaners'
import { describe, it } from 'mocha'

import { privateJson } from './config'
import { app, fixtureSettings, testRoot } from './config.test'
import { gitFixture } from './source.test'
import { asRun, State } from './state'
import { endpoint } from './upload.test'

/** The CLI is real; the package compiler is an explicitly injected fixture builder. */
async function child(
  file: string,
  args: string[],
  ca: string,
  cancelWhenReady?: string
): Promise<{ code: number | null; output: string }> {
  const process = spawn(
    globalThis.process.execPath,
    ['-r', 'sucrase/register', file, ...args],
    {
      cwd: globalThis.process.cwd(),
      env: {
        ...globalThis.process.env,
        NODE_EXTRA_CA_CERTS: ca,
        FIXTURE_BUILD_HOLD: cancelWhenReady == null ? '0' : '1'
      },
      stdio: 'pipe'
    }
  )
  let output = ''
  process.stdout.on('data', chunk => {
    output += String(chunk)
  })
  process.stderr.on('data', chunk => {
    output += String(chunk)
  })
  const stopped = once(process, 'exit')
  if (cancelWhenReady != null) {
    for (
      let attempt = 0;
      attempt < 200 && !existsSync(cancelWhenReady);
      ++attempt
    )
      await new Promise(resolve => setTimeout(resolve, 20))
    process.kill('SIGTERM')
    assert(
      existsSync(cancelWhenReady),
      'The owned compiler started before cancellation'
    )
  }
  const [code] = await stopped
  return { code, output }
}
function wrapper(root: string): string {
  const file = `${root}/fixture-cli.cjs`
  writeFileSync(
    file,
    `const {main}=require(${JSON.stringify(path.resolve('scripts/deploy.ts'))});
const {nativeNumber}=require(${JSON.stringify(path.resolve('scripts/deploy/runner.ts'))});
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const compiler=async ctx=>{
 if(process.env.FIXTURE_BUILD_HOLD==='1')await ctx.processes.run({file:process.execPath,args:['-e',"require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)",path.join(ctx.settings.stateDirectory,'fixture-ready')],cwd:ctx.source});
 const dir=path.join(ctx.source,'Payload','Fixture.app');fs.mkdirSync(dir,{recursive:true});
 const number=nativeNumber('ios',ctx.buildNumber);
 fs.writeFileSync(path.join(dir,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>'+ctx.target.app+'</string><key>CFBundleShortVersionString</key><string>'+ctx.version+'</string><key>CFBundleVersion</key><string>'+number+'</string><key>CFBundleDisplayName</key><string>Fixture</string><key>CFBundleName</key><string>Fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>MinimumOSVersion</key><string>15.0</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array><key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array></dict></plist>');
 const macho=Buffer.alloc(32);macho.writeUInt32LE(0xfeedfacf,0);macho.writeUInt32LE(0x0100000c,4);macho.writeUInt32LE(2,12);fs.writeFileSync(path.join(dir,'Fixture'),macho);
 const out=path.join(ctx.source,'fixture.ipa');cp.execFileSync('zip',['-q','-r',out,'Payload'],{cwd:ctx.source});return{file:out,buildNumber:number};
};
main(process.argv.slice(2),{ios:compiler,android:async()=>{throw new Error('Fixture compiler failure')}}).then(code=>{process.exitCode=code}).catch(()=>{process.exitCode=1});\n`,
    { mode: 0o600 }
  )
  return file
}
describe('Actual CLI publishing compatibility', () => {
  for (const kind of ['mason', 'zealot'] as const) {
    const enabled =
      kind === 'mason'
        ? process.env.MASON_TEST_REPO != null
        : process.env.ZEALOT_TEST_CONFIG != null
    ;(enabled ? it : it.skip)(
      `publishes to actual ${kind} through one CLI command and repeats publish-only without rebuilding`,
      async function () {
        this.timeout(30000)
        const root = testRoot(`cli-${kind}-`)
        const service = await endpoint(root)
        let backend: ChildProcess | undefined
        let token: string, channelKey: string, port: number
        try {
          if (kind === 'zealot') {
            const fixture = privateJson(
              process.env.ZEALOT_TEST_CONFIG!,
              asObject({
                token: asString,
                channelKey: asString,
                httpOrigin: asString
              })
            )
            assert.equal(new URL(fixture.httpOrigin).hostname, '127.0.0.1')
            token = fixture.token
            channelKey = fixture.channelKey
            port = Number(new URL(fixture.httpOrigin).port)
          } else {
            const repo = process.env.MASON_TEST_REPO!
            const reserve = createServer().listen(0, '127.0.0.1')
            await once(reserve, 'listening')
            port = (reserve.address() as AddressInfo).port
            await new Promise<void>(resolve =>
              reserve.close(() => {
                resolve()
              })
            )
            const config = `${root}/mason.json`
            writeFileSync(
              config,
              JSON.stringify({
                origin: service.origin,
                database: `${root}/mason.sqlite`,
                storage: `${root}/packages`,
                port,
                freeSpaceBytes: 0
              }),
              { mode: 0o600 }
            )
            const key = JSON.parse(
              execFileSync(
                process.execPath,
                ['--input-type=module', '-', config],
                {
                  cwd: repo,
                  encoding: 'utf8',
                  stdio: ['pipe', 'pipe', 'pipe'],
                  input: `import {Store} from './lib/store.js';import {loadConfig} from './lib/config.js';import {ApiKeys} from './lib/upload/keys.js';const s=new Store(loadConfig(process.argv[2]));const id=s.addApp({slug:'${app}',name:'Fixture',position:0});s.addChannel({appId:id,platform:'ios',key:'fixture',allowedFormats:['ipa']});process.stdout.write(JSON.stringify(new ApiKeys(s).create('Fixture',[id])));s.close();`
                }
              )
            ) as { token: string }
            token = key.token
            channelKey = 'fixture'
            backend = spawn(
              process.execPath,
              ['lib/cli.js', 'serve', '--config', config],
              { cwd: repo, stdio: 'ignore' }
            )
            let ready = false
            for (let i = 0; i < 100; ++i) {
              try {
                ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok
              } catch {}
              if (ready) break
              await new Promise(resolve => setTimeout(resolve, 20))
            }
            assert(ready)
          }
          service.server.removeAllListeners('request')
          let dropNextUpload = true
          let uploads = 0
          let lookups = 0
          service.server.on('request', (req, res) => {
            if (
              req.method === 'POST' &&
              req.url?.startsWith('/api/apps/upload') === true
            )
              ++uploads
            if (req.url?.startsWith('/api/apps/version_exist') === true)
              ++lookups
            const upstream = request(
              {
                hostname: '127.0.0.1',
                port,
                method: req.method,
                path: req.url,
                headers: { ...req.headers, 'x-forwarded-proto': 'https' }
              },
              reply => {
                if (reply.statusCode === 201 && dropNextUpload) {
                  dropNextUpload = false
                  reply.resume()
                  res.destroy()
                  return
                }
                res.writeHead(reply.statusCode ?? 502, reply.headers)
                reply.pipe(res)
              }
            )
            upstream.on('error', () => res.destroy())
            req.pipe(upstream)
          })
          gitFixture(root)
          const settings = fixtureSettings(root) as Record<string, any>
          settings.apps[app].ios.upload = {
            kind,
            origin: service.origin,
            channelKey,
            tokenFile: `${root}/token.json`
          }
          // A fresh version avoids a previous disposable-fixture run colliding with this run.
          settings.apps[app].version = `1.2.${Date.now() % 100000000}`
          writeFileSync(
            `${root}/token.json`,
            JSON.stringify({ schemaVersion: 1, origin: service.origin, token }),
            { mode: 0o600 }
          )
          const config = `${root}/deployConfig.json`
          writeFileSync(
            config,
            JSON.stringify({
              schemaVersion: 1,
              branches: { master: { settings } }
            }),
            { mode: 0o600 }
          )
          const args = [
            '--config',
            config,
            '--app',
            app,
            '--branch',
            'master',
            '--platform',
            'ios'
          ]
          const file = wrapper(root)
          const ca = `${root}/tls.crt`
          const dry = await child(file, [...args, '--dry-run'], ca)
          assert.equal(dry.code, 0, dry.output)
          assert(!existsSync(`${root}/state`))
          const result = await child(file, args, ca)
          assert.equal(result.code, 0, result.output)
          assert.match(result.output, /ios uploaded/)
          assert.equal(uploads, kind === 'mason' ? 2 : 1)
          assert.equal(lookups, kind === 'zealot' ? 1 : 0)
          assert(!result.output.includes(token))
          const state = new State(`${root}/state`)
          let run
          try {
            const row = asObject({ data: asString })(
              state.db.prepare('SELECT data FROM runs').get()
            )
            run = asRun(JSON.parse(row.data))
            assert.equal(run.artifacts[0].published != null, true)
          } finally {
            state.close()
          }
          assert.equal(
            run.commit,
            execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: `${root}/source`,
              encoding: 'utf8'
            }).trim()
          )
          const replay = await child(
            file,
            [...args, '--publish-only', run.id],
            ca
          )
          assert.equal(replay.code, 0, replay.output)
          assert.match(replay.output, /already published/)
          const partialArgs = [...args.slice(0, -1), 'ios,android']
          const partial = await child(file, partialArgs, ca)
          assert.equal(partial.code, 1, partial.output)
          assert.match(partial.output, /ios uploaded/)
          assert.match(partial.output, /android build failed/)
          const cancelled = await child(
            file,
            args,
            ca,
            `${root}/state/fixture-ready`
          )
          assert.equal(cancelled.code, 1, cancelled.output)
          const finalState = new State(`${root}/state`)
          try {
            const records = finalState.db
              .prepare('SELECT data FROM runs')
              .all()
              .map(row =>
                asRun(JSON.parse(asObject({ data: asString })(row).data))
              )
            assert.equal(records.length, 3)
            const partialRun = records.find(
              record => record.platforms.length === 2
            )!
            assert.equal(partialRun.artifacts[0].published != null, true)
            assert.deepEqual(partialRun.failed, ['android'])
            assert.equal(finalState.reserve(app, 'ios', 42), 45)
          } finally {
            finalState.close()
          }
          assert.equal(
            execFileSync('git', ['worktree', 'list', '--porcelain'], {
              cwd: `${root}/source`,
              encoding: 'utf8'
            }).split('worktree ').length,
            2
          )
          console.log(
            `${kind}: actual CLI dry-run, upload, publish-only, partial failure and cancellation passed; package compilation was an injected fixture.`
          )
        } finally {
          if (backend != null) {
            const stopped = once(backend, 'exit')
            backend.kill('SIGTERM')
            await stopped
          }
          await service.close()
          rmSync(root, { recursive: true, force: true })
        }
      }
    )
  }
})
