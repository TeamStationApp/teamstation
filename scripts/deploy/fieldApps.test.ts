import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Stage } from '@mason/types'
import { afterEach, describe, it } from 'mocha'

import {
  archiveCameraman,
  archiveDirector,
  archiveDistributor,
  CAMERAMAN_APP,
  CAMERAMAN_DEVELOP_APP,
  CAMERAMAN_DEVELOP_NAME,
  compileCameraman,
  DIRECTOR_APP,
  DIRECTOR_DEVELOP_APP,
  DIRECTOR_DEVELOP_NAME,
  DISTRIBUTOR_APP,
  DISTRIBUTOR_DEVELOP_APP,
  DISTRIBUTOR_DEVELOP_NAME,
  FIELD_TEAM,
  fieldAppId,
  fieldLinkSettings,
  fieldOrigin,
  setup,
  signCameraman,
  writeFieldClientConfig
} from '../../Masonfile'

describe('field app builds', function () {
  let dir = ''
  afterEach(function () {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  for (const branch of [
    'master',
    'develop',
    'paul/masonAppBuilds',
    undefined,
    ''
  ]) {
    it(`points ${String(branch)} at the right host`, function () {
      const origin = fieldOrigin(branch)
      if (branch == null || branch === '' || branch === 'master')
        assert.equal(origin, 'https://app.teamstation.app')
      else assert.equal(origin, 'https://develop.teamstation.app')
    })
  }

  it('writes the team and the link host the native projects read', function () {
    dir = mkdtempSync(path.join(tmpdir(), 'field-app-'))
    writeFieldClientConfig(dir, DIRECTOR_APP)
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(dir, 'clientConfig.json'), 'utf8')),
      {
        appleTeamId: FIELD_TEAM,
        appOrigin: 'https://director.teamstation.app'
      }
    )
    writeFieldClientConfig(dir, CAMERAMAN_APP)
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, 'clientConfig.json'), 'utf8'))
        .appOrigin,
      'https://cameraman.teamstation.app'
    )
    // No host's app-site-association lists a develop id or Distributor.
    for (const app of [
      DIRECTOR_DEVELOP_APP,
      CAMERAMAN_DEVELOP_APP,
      DISTRIBUTOR_APP,
      DISTRIBUTOR_DEVELOP_APP
    ]) {
      writeFieldClientConfig(dir, app)
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(dir, 'clientConfig.json'), 'utf8')),
        { appleTeamId: FIELD_TEAM }
      )
    }
    assert.equal(
      statSync(path.join(dir, 'clientConfig.json')).mode & 0o777,
      0o600
    )
  })

  it("archives with the app's xcconfig and its server", function () {
    assert.deepEqual(fieldLinkSettings('mobile/apps/tsDirector', 'develop'), [
      '-xcconfig',
      'mobile/apps/tsDirector/clientConfig.xcconfig',
      'SWIFT_ENABLE_EXPLICIT_MODULES=NO',
      'TS_PRIMARY_HOST=develop.teamstation.app'
    ])
    assert.ok(
      fieldLinkSettings('mobile/apps/tsDistributor', 'master').includes(
        'TS_PRIMARY_HOST=app.teamstation.app'
      )
    )
  })

  for (const branch of ['master', 'develop']) {
    it(`requests ${branch} builds and does not start them on push`, function () {
      const workflows: Record<
        string,
        {
          options: { triggers?: unknown; timeout?: string }
          stages: Array<{
            name: string
            on?: { type?: string }
            xcode?: string
            apple?: { distribution: string; platform?: string; app?: string }
          }>
          parallel: boolean
          android?: Array<{ name: string; type?: string; publishes?: string[] }>
          ios?: {
            on?: { type?: string }
            tools?: { xcode?: string }
            apple?: { app?: string }
          }
        }
      > = {}
      setup({
        branch,
        apiVersion() {},
        buildNumber() {},
        parallel() {
          assert.fail('stages belong to a workflow')
        },
        workflow(name, options, declare) {
          const recorded = {
            options,
            stages: [] as Array<{
              name: string
              on?: { type?: string }
              xcode?: string
              apple?: { distribution: string; platform?: string; app?: string }
            }>,
            parallel: false,
            android: undefined as
              | Array<{ name: string; type?: string; publishes?: string[] }>
              | undefined,
            ios: undefined as
              | {
                  on?: { type?: string }
                  tools?: { xcode?: string }
                  apple?: { app?: string }
                }
              | undefined
          }
          declare({
            stage(stageName, stage) {
              recorded.stages.push({
                name: stageName,
                on: stage.on,
                xcode: stage.tools?.xcode,
                apple: stage.apple
              })
            },
            parallel(_group, members, groupOptions) {
              recorded.parallel = groupOptions?.failFast === false
              recorded.ios = members.ios?.[0]
              recorded.android = (members.android ?? []).map(member => ({
                name: member.name,
                type: member.on?.type,
                publishes: member.publishes
              }))
            }
          })
          workflows[name] = recorded
        }
      })
      for (const name of ['director', 'cameraman', 'distributor']) {
        assert.deepEqual(workflows[name]?.options.triggers, [{ request: true }])
        assert.equal(workflows[name]?.options.timeout, '8h')
      }
      const fieldApp = branch === 'master' ? DIRECTOR_APP : DIRECTOR_DEVELOP_APP
      const cameraApp =
        branch === 'master' ? CAMERAMAN_APP : CAMERAMAN_DEVELOP_APP
      assert.equal(workflows.director?.stages[0]?.apple?.app, fieldApp)
      assert.equal(workflows.director?.stages[0]?.apple?.distribution, 'adHoc')
      assert.equal(workflows.director?.stages[0]?.on?.type, 'macos-arm64')
      assert.equal(workflows.director?.stages[0]?.xcode, '26.6')
      assert.equal(workflows.cameraman?.parallel, true)
      assert.equal(workflows.cameraman?.ios?.apple?.app, cameraApp)
      assert.equal(workflows.cameraman?.ios?.on?.type, 'macos-arm64')
      assert.equal(workflows.cameraman?.ios?.tools?.xcode, '26.6')
      // Only the android-signing node's release key publishes the APK.
      assert.deepEqual(workflows.cameraman?.android, [
        { name: 'compile', type: 'do-linux', publishes: undefined },
        { name: 'sign', type: 'macos-arm64', publishes: [cameraApp] }
      ])
      assert.equal(workflows.distributor?.stages[0]?.on?.type, 'macos-arm64')
      assert.equal(workflows.distributor?.stages[0]?.xcode, '26.6')
      assert.equal(workflows.distributor?.stages[0]?.apple?.platform, 'macos')
      assert.equal(
        workflows.distributor?.stages[0]?.apple?.distribution,
        'development'
      )
      assert.equal(
        workflows.distributor?.stages[0]?.apple?.app,
        branch === 'master' ? DISTRIBUTOR_APP : DISTRIBUTOR_DEVELOP_APP
      )
    })
  }

  function stage(
    branch: string,
    archive: { ipa?: string; app?: string } | null
  ): {
    ctx: Stage
    commands: string[]
    box: {
      published?: unknown
      gradleEnv?: Record<string, string>
      xcargs?: string[]
      stashed?: string
      unstashed?: string
    }
    saved: string[]
  } {
    dir = mkdtempSync(path.join(tmpdir(), 'field-stage-'))
    for (const appDir of [
      'mobile/apps/tsDirector/App',
      'mobile/apps/tsCameraman/App',
      'mobile/apps/tsCameramanAndroid/app/src/main/res/values',
      'mobile/apps/tsDistributor'
    ])
      mkdirSync(path.join(dir, appDir), { recursive: true })
    writeFileSync(
      path.join(dir, 'mobile/apps/tsDirector/project.yml'),
      'PRODUCT_BUNDLE_IDENTIFIER: app.teamstation.director\nPRODUCT_NAME: TS Director\nPRODUCT_BUNDLE_IDENTIFIER: app.teamstation.director.unittests\n'
    )
    writeFileSync(
      path.join(dir, 'mobile/apps/tsDirector/App/Info.plist'),
      '<key>CFBundleDisplayName</key>\n  <string>TS Director</string>\n' +
        '<string>app.teamstation.director.control</string>\n<string>tsdirector</string>\n'
    )
    writeFileSync(
      path.join(dir, 'mobile/apps/tsCameraman/project.yml'),
      'PRODUCT_BUNDLE_IDENTIFIER: app.teamstation.cameraman\nPRODUCT_NAME: TS Cameraman\nPRODUCT_BUNDLE_IDENTIFIER: app.teamstation.cameraman.unittests\n'
    )
    writeFileSync(
      path.join(dir, 'mobile/apps/tsCameraman/App/Info.plist'),
      '<key>CFBundleDisplayName</key>\n  <string>TS Cameraman</string>\n' +
        '<string>app.teamstation.cameraman.control</string>\n<string>tscameraman</string>\n'
    )
    writeFileSync(
      path.join(
        dir,
        'mobile/apps/tsCameramanAndroid/app/src/main/AndroidManifest.xml'
      ),
      '<data android:scheme="tscameraman" />\n'
    )
    writeFileSync(
      path.join(dir, 'mobile/apps/tsDistributor/project.yml'),
      'PRODUCT_BUNDLE_IDENTIFIER: app.teamstation.distributor\nPRODUCT_NAME: TS Distributor\nINFOPLIST_KEY_CFBundleDisplayName: TS Distributor\n'
    )
    writeFileSync(
      path.join(dir, 'mobile/apps/tsCameramanAndroid/app/build.gradle.kts'),
      'namespace = "app.teamstation.cameraman"\napplicationId = "app.teamstation.cameraman"\n'
    )
    writeFileSync(
      path.join(
        dir,
        'mobile/apps/tsCameramanAndroid/app/src/main/res/values/strings.xml'
      ),
      '<string name="app_name">TS Cameraman</string>\n'
    )
    const commands: string[] = []
    const saved: string[] = []
    const box: {
      published?: unknown
      gradleEnv?: Record<string, string>
      xcargs?: string[]
      stashed?: string
      unstashed?: string
    } = {}
    const ctx = {
      workspace: dir,
      run: { branch, commit: 'a'.repeat(40) },
      async sh(command: string, options?: { env?: Record<string, string> }) {
        commands.push(command)
        if (options?.env?.MASON_BUILD_NUMBER != null)
          box.gradleEnv = options.env
        return { code: 0, stdout: '', stderr: '' }
      },
      getBuildNumber(app: string) {
        assert.ok(
          [
            DIRECTOR_APP,
            DIRECTOR_DEVELOP_APP,
            CAMERAMAN_APP,
            CAMERAMAN_DEVELOP_APP,
            DISTRIBUTOR_APP,
            DISTRIBUTOR_DEVELOP_APP
          ].includes(app)
        )
        return '26110801'
      },
      artifacts: {
        async save(name: string) {
          saved.push(name)
        }
      },
      async publish(options: unknown) {
        box.published = options
      },
      async stash(name: string, paths: string) {
        box.stashed = `${name} ${paths}`
      },
      async unstash(name: string) {
        box.unstashed = name
      },
      apple: {
        async archive(options?: { xcargs?: string[] }) {
          box.xcargs = options?.xcargs
          if (archive == null)
            return { archive: 'none.xcarchive', dsyms: 'none' }
          return { archive: 'app.xcarchive', dsyms: 'app.dSYM', ...archive }
        }
      },
      fs: {
        async glob() {
          return archive?.ipa == null
            ? []
            : [
                'mobile/apps/tsCameramanAndroid/app/build/outputs/apk/release/app.apk'
              ]
        }
      }
    }
    return { ctx: ctx as unknown as Stage, commands, box, saved }
  }

  it('archives Director for production when the run is master', async function () {
    const run = stage('master', { ipa: 'Director.ipa' })
    await archiveDirector(run.ctx)
    assert.ok(
      run.commands.some(command =>
        command.includes('"$PWD/mobile/apps/tsDirector/scripts/bootstrap.sh"')
      )
    )
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(dir, 'mobile/apps/tsDirector/clientConfig.json'),
          'utf8'
        )
      ).appOrigin,
      'https://director.teamstation.app'
    )
    // Links open the field app from its own host; it still signs in to production.
    assert.ok(
      run.box.xcargs?.includes('TS_PRIMARY_HOST=app.teamstation.app') === true
    )
    assert.deepEqual(run.box.published, {
      app: DIRECTOR_APP,
      platform: 'ios',
      path: 'Director.ipa',
      version: '1.0',
      buildNumber: '26110801'
    })
    assert.deepEqual(run.saved, ['director-ipa', 'director-dsym'])
    const project = readFileSync(
      path.join(dir, 'mobile/apps/tsDirector/project.yml'),
      'utf8'
    )
    assert.ok(
      project.includes('PRODUCT_BUNDLE_IDENTIFIER: app.teamstation.director\n')
    )
    assert.ok(project.includes('PRODUCT_NAME: TS Director\n'))
    assert.ok(
      !run.box.xcargs?.some(arg => arg.startsWith('PRODUCT_BUNDLE_IDENTIFIER='))
    )
    assert.deepEqual(
      run.box.xcargs,
      fieldLinkSettings('mobile/apps/tsDirector', 'master')
    )
    assert.ok(
      run.commands.includes(
        'node scripts/clientConfig.mjs mobile/apps/tsDirector --entitlements App/Director.entitlements'
      )
    )
  })

  it('installs a develop Director beside the master app', async function () {
    const run = stage('develop', { ipa: 'Director.ipa' })
    await archiveDirector(run.ctx)
    await archiveDirector(run.ctx)
    // Ordinary web links: no link host lists the develop id.
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(dir, 'mobile/apps/tsDirector/clientConfig.json'),
          'utf8'
        )
      ).appOrigin,
      undefined
    )
    assert.ok(
      run.box.xcargs?.includes('TS_PRIMARY_HOST=develop.teamstation.app') ===
        true
    )
    const project = readFileSync(
      path.join(dir, 'mobile/apps/tsDirector/project.yml'),
      'utf8'
    )
    assert.ok(
      project.includes(`PRODUCT_BUNDLE_IDENTIFIER: ${DIRECTOR_DEVELOP_APP}\n`)
    )
    assert.ok(
      project.includes(
        'PRODUCT_BUNDLE_IDENTIFIER: app.teamstation.director.unittests\n'
      )
    )
    assert.ok(project.includes('PRODUCT_NAME: TS Director\n'))
    assert.equal(
      readFileSync(
        path.join(dir, 'mobile/apps/tsDirector/App/Info.plist'),
        'utf8'
      ),
      `<key>CFBundleDisplayName</key>\n  <string>${DIRECTOR_DEVELOP_NAME}</string>\n` +
        `<string>${DIRECTOR_DEVELOP_APP}.control</string>\n<string>tsdirector-develop</string>\n`
    )
    // Command-line settings reach every target, Swift packages included; project.yml names the app.
    assert.ok(
      !run.box.xcargs?.some(arg =>
        /^PRODUCT_(BUNDLE_IDENTIFIER|NAME)=/.test(arg)
      )
    )
    assert.equal(
      (run.box.published as { app: string }).app,
      DIRECTOR_DEVELOP_APP
    )
  })

  it('installs a branch Director beside the master app', async function () {
    assert.equal(
      fieldAppId(DIRECTOR_APP, DIRECTOR_DEVELOP_APP, 'paul/masonAppBuilds'),
      DIRECTOR_DEVELOP_APP
    )
    assert.equal(
      fieldAppId(DIRECTOR_APP, DIRECTOR_DEVELOP_APP, 'master'),
      DIRECTOR_APP
    )
    assert.equal(
      fieldAppId(CAMERAMAN_APP, CAMERAMAN_DEVELOP_APP, undefined),
      CAMERAMAN_APP
    )
    const run = stage('paul/masonAppBuilds', { ipa: 'Director.ipa' })
    await archiveDirector(run.ctx)
    assert.equal(
      (run.box.published as { app: string }).app,
      DIRECTOR_DEVELOP_APP
    )
  })

  it('refuses a Director archive that exported no IPA', async function () {
    const run = stage('develop', null)
    await assert.rejects(archiveDirector(run.ctx), /No IPA was exported/)
  })

  it('archives Cameraman and compiles its Android release against develop', async function () {
    const ios = stage('develop', { ipa: 'Cameraman.ipa' })
    await archiveCameraman(ios.ctx)
    assert.deepEqual(ios.saved, ['cameraman-ipa', 'cameraman-dsym'])
    assert.equal(
      (ios.box.published as { platform: string; app: string }).app,
      CAMERAMAN_DEVELOP_APP
    )
    const plist = readFileSync(
      path.join(dir, 'mobile/apps/tsCameraman/App/Info.plist'),
      'utf8'
    )
    assert.equal(
      plist,
      `<key>CFBundleDisplayName</key>\n  <string>${CAMERAMAN_DEVELOP_NAME}</string>\n` +
        `<string>${CAMERAMAN_DEVELOP_APP}.control</string>\n<string>tscameraman-develop</string>\n`
    )
    const android = stage('develop', { ipa: 'ignored' })
    await compileCameraman(android.ctx)
    assert.equal(
      android.box.gradleEnv?.TS_PRIMARY_HOST,
      'develop.teamstation.app'
    )
    assert.equal(android.box.gradleEnv?.MASON_APP_VERSION, '1.0')
    assert.equal(
      readFileSync(
        path.join(dir, 'mobile/apps/tsCameramanAndroid/app/build.gradle.kts'),
        'utf8'
      ),
      `namespace = "app.teamstation.cameraman"\napplicationId = "${CAMERAMAN_DEVELOP_APP}"\n`
    )
    // Each segment of an Android package name starts with a letter and is letters, digits or _.
    assert.match(
      CAMERAMAN_DEVELOP_APP,
      /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/
    )
    assert.equal(
      readFileSync(
        path.join(
          dir,
          'mobile/apps/tsCameramanAndroid/app/src/main/res/values/strings.xml'
        ),
        'utf8'
      ),
      `<string name="app_name">${CAMERAMAN_DEVELOP_NAME}</string>\n`
    )
    assert.equal(
      readFileSync(
        path.join(
          dir,
          'mobile/apps/tsCameramanAndroid/app/src/main/AndroidManifest.xml'
        ),
        'utf8'
      ),
      '<data android:scheme="tscameraman-develop" />\n'
    )
    // The compile node signs with a keystore of its own; the sign stage publishes.
    assert.equal(android.box.published, undefined)
    assert.equal(
      android.box.stashed,
      'cameraman-release mobile/apps/tsCameramanAndroid/app/build/outputs/apk/release/*.apk'
    )
    await signCameraman(android.ctx)
    assert.equal(android.box.unstashed, 'cameraman-release')
    assert.ok(
      android.commands.includes(
        '"$HOME/.local/bin/teamstation-sign-release-apk" mobile/apps/tsCameramanAndroid/app/build/outputs/apk/release'
      )
    )
    assert.deepEqual(android.box.published, {
      app: CAMERAMAN_DEVELOP_APP,
      platform: 'android',
      path: 'mobile/apps/tsCameramanAndroid/app/build/outputs/apk/release/app.apk',
      version: '1.0',
      buildNumber: '26110801'
    })
    assert.deepEqual(android.saved, ['cameraman-apk'])
  })

  it('refuses to publish a Cameraman APK that was not signed', async function () {
    const run = stage('master', null)
    await assert.rejects(
      signCameraman(run.ctx),
      /No Cameraman release APK was signed/
    )
    assert.equal(run.box.published, undefined)
  })

  it('refuses a Cameraman compile that produced no APK', async function () {
    const run = stage('master', null)
    await assert.rejects(
      compileCameraman(run.ctx),
      /No Cameraman release APK was built/
    )
  })

  it('packs the Distributor app as a disk image and publishes it for macOS', async function () {
    const run = stage('master', { app: 'TS Distributor.app' })
    await archiveDistributor(run.ctx)
    assert.ok(
      run.commands.some(command => command.startsWith('xcodegen generate'))
    )
    assert.ok(
      run.commands.some(command =>
        command.startsWith(
          'hdiutil create -volname "TS Distributor" -srcfolder distributor-image -ov -format UDZO distributor.dmg'
        )
      )
    )
    assert.deepEqual(run.box.published, {
      app: DISTRIBUTOR_APP,
      platform: 'macos',
      path: 'distributor.dmg',
      version: '1.0',
      buildNumber: '26110801'
    })
    assert.deepEqual(run.saved, ['distributor-app', 'distributor-dsym'])
    // The image holds the app, an Applications link and the Read Me, as package.sh's does.
    assert.ok(
      run.commands.includes(
        'rm -rf distributor-image && mkdir distributor-image && ditto "TS Distributor.app" "distributor-image/TS Distributor.app" && ln -s /Applications distributor-image/Applications'
      )
    )
    const readMe = readFileSync(
      path.join(dir, 'distributor-image', 'Read Me.txt'),
      'utf8'
    )
    assert.ok(readMe.startsWith('TS Distributor, build 26110801'))
    assert.ok(readMe.includes('click Open Anyway'))
    assert.ok(readMe.includes('"/Applications/TS Distributor.app"'))
    assert.equal(
      readFileSync(
        path.join(dir, 'mobile/apps/tsDistributor/project.yml'),
        'utf8'
      ),
      'PRODUCT_BUNDLE_IDENTIFIER: app.teamstation.distributor\nPRODUCT_NAME: TS Distributor\nINFOPLIST_KEY_CFBundleDisplayName: TS Distributor\n'
    )
  })

  it('installs a develop Distributor beside the master app', async function () {
    const run = stage('develop', { app: `${DISTRIBUTOR_DEVELOP_NAME}.app` })
    await archiveDistributor(run.ctx)
    await archiveDistributor(run.ctx)
    assert.equal(
      readFileSync(
        path.join(dir, 'mobile/apps/tsDistributor/project.yml'),
        'utf8'
      ),
      `PRODUCT_BUNDLE_IDENTIFIER: ${DISTRIBUTOR_DEVELOP_APP}\nPRODUCT_NAME: ${DISTRIBUTOR_DEVELOP_NAME}\nINFOPLIST_KEY_CFBundleDisplayName: ${DISTRIBUTOR_DEVELOP_NAME}\n`
    )
    assert.ok(
      run.commands.some(command =>
        command.startsWith(
          `hdiutil create -volname "${DISTRIBUTOR_DEVELOP_NAME}" `
        )
      )
    )
    assert.equal(
      (run.box.published as { app: string }).app,
      DISTRIBUTOR_DEVELOP_APP
    )
  })

  it('refuses a Distributor archive that exported no app', async function () {
    const run = stage('develop', null)
    await assert.rejects(archiveDistributor(run.ctx), /No app was exported/)
  })
})
