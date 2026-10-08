import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { describe, it } from 'mocha'

import { bundleEnvironment } from './apple'
import { app, fixtureSettings, testRoot } from './config.test'
import { Processes } from './process'
import { nativeNumber, options, run } from './runner'
import { gitFixture } from './source.test'
import { State } from './state'
import { endpoint } from './upload.test'

describe('Deployment runner with actual Mason', () => {
  const enabled = process.env.MASON_TEST_REPO != null
  ;(enabled ? it : it.skip)(
    'builds through an explicit fake compiler boundary and publishes through the real HTTPS API',
    async function () {
      this.timeout(20000)
      const mason = process.env.MASON_TEST_REPO
      assert(mason != null)
      const root = testRoot('mason-')
      const service = await endpoint(root)
      const probe = createServer().listen(0, '127.0.0.1')
      await once(probe, 'listening')
      const port = (probe.address() as AddressInfo).port
      probe.close()
      await once(probe, 'close')
      service.server.removeAllListeners('request')
      service.server.on('request', (req, res) => {
        const upstream = request(
          {
            host: '127.0.0.1',
            port,
            path: req.url,
            method: req.method,
            headers: req.headers
          },
          reply => {
            res.writeHead(reply.statusCode!, reply.headers)
            reply.pipe(res)
          }
        )
        upstream.on('error', () => res.destroy())
        req.pipe(upstream)
      })
      const configFile = path.join(root, 'mason.json')
      writeFileSync(
        configFile,
        JSON.stringify({
          origin: service.origin,
          database: path.join(root, 'mason.sqlite'),
          storage: path.join(root, 'packages'),
          port,
          freeSpaceBytes: 0
        }),
        { mode: 0o600 }
      )
      const credential = execFileSync(
        process.execPath,
        ['--input-type=module', '-', configFile],
        {
          cwd: mason,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          input: `import {Store} from './lib/store.js'; import {loadConfig} from './lib/config.js'; import {ApiKeys} from './lib/upload/keys.js'; const store = new Store(loadConfig(process.argv[2])); const id = store.addApp({slug:'${app}',name:'Example',position:0}); store.addChannel({appId:id,platform:'ios',key:'fixture',allowedFormats:['ipa']}); process.stdout.write(JSON.stringify(new ApiKeys(store).create('Fixture',[id]))); store.close();`
        }
      )
      const tokenFile = path.join(root, 'token.json')
      writeFileSync(tokenFile, credential, { mode: 0o600 })
      const child = spawn(
        process.execPath,
        ['lib/cli.js', 'serve', '--config', configFile],
        { cwd: mason, stdio: 'pipe' }
      )
      let logs = ''
      child.stdout.on('data', chunk => {
        logs += String(chunk)
      })
      child.stderr.on('data', chunk => {
        logs += String(chunk)
      })
      try {
        let ready = false
        for (let i = 0; i < 100; i++) {
          try {
            ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok
          } catch {
            /* Wait for actual service. */
          }
          if (ready) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert(ready)
        gitFixture(root)
        const settings = fixtureSettings(root) as Record<string, unknown>
        const apps = settings.apps as Record<
          string,
          { ios: { upload: object } }
        >
        apps[app].ios.upload = {
          kind: 'mason',
          origin: service.origin,
          channelKey: 'fixture',
          tokenFile
        }
        const config = path.join(root, 'deployConfig.json')
        writeFileSync(
          config,
          JSON.stringify({
            schemaVersion: 1,
            branches: { master: { settings } }
          }),
          { mode: 0o600 }
        )
        const selected = options([
          '--build-number-file',
          path.join(root, 'source/.git/buildNum.json'),
          '--config',
          config,
          '--app',
          app,
          '--branch',
          'master',
          '--platform',
          'ios'
        ])
        assert.equal(
          await run(
            selected,
            {
              ios: async context => {
                const buildNumber = nativeNumber('ios', context.buildNumber)
                const payload = path.join(
                  context.source,
                  'Payload',
                  'Example.app'
                )
                mkdirSync(payload, { recursive: true })
                writeFileSync(
                  path.join(payload, 'Info.plist'),
                  `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${app}</string><key>CFBundleShortVersionString</key><string>${context.version}</string><key>CFBundleVersion</key><string>${buildNumber}</string></dict></plist>`
                )
                const file = path.join(context.source, 'fixture.ipa')
                execFileSync(
                  'zip',
                  ['-q', '-0', file, 'Payload/Example.app/Info.plist'],
                  { cwd: context.source, stdio: 'pipe' }
                )
                return { file, buildNumber }
              }
            },
            new AbortController().signal,
            line => {
              logs += line + '\n'
            }
          ),
          0
        )
        const state = new State(path.join(root, 'state'))
        const id = String(state.db.prepare('SELECT id FROM runs').get()?.id)
        const record = state.load(id)
        state.close()
        assert.equal(record.artifacts[0].published, 1)
        const pluginOutput = await new Processes(
          new AbortController().signal
        ).run({
          file: process.env.DEPLOY_TEST_BUNDLE ?? 'bundle',
          args: [
            'exec',
            'ruby',
            '-e',
            `require 'json'; require 'fastlane'; Fastlane.load_actions; require 'fastlane/plugin/zealot'; begin; input=JSON.parse(STDIN.read, symbolize_names: true); params=FastlaneCore::Configuration.create(Fastlane::Actions::ZealotAction.available_options,input); Fastlane::Actions::ZealotAction.run(params); puts "RELEASE_ID=#{Fastlane::Actions.lane_context[Fastlane::Actions::SharedValues::ZEALOT_RELEASE_ID]}"; rescue => error; puts "PLUGIN_ERROR=#{error.class}: #{error.message}"; end`
          ],
          cwd: root,
          env: {
            ...bundleEnvironment(),
            SSL_CERT_FILE: path.join(root, 'tls.crt')
          },
          input: JSON.stringify({
            endpoint: service.origin,
            token: JSON.parse(credential).token,
            channel_key: 'fixture',
            file: path.join(root, 'output', id, 'ios.ipa'),
            branch: record.branch,
            git_commit: record.commit,
            source: 'api',
            hide_user_token: true,
            verify_ssl: true,
            fail_on_error: true,
            timeout: 15
          })
        })
        assert(
          pluginOutput.includes('RELEASE_ID=1'),
          pluginOutput.replaceAll(JSON.parse(credential).token, '[redacted]')
        )
        assert(!pluginOutput.includes(JSON.parse(credential).token))
        assert.equal(
          await run(
            { ...selected, publishOnly: id },
            {},
            new AbortController().signal,
            () => {}
          ),
          0
        )
        assert(
          !logs.includes(
            (JSON.parse(readFileSync(tokenFile, 'utf8')) as { token: string })
              .token
          )
        )
      } finally {
        const stopped = once(child, 'exit')
        child.kill('SIGTERM')
        await stopped
        await service.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
