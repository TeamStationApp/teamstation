/**
 * The legacy chat2 harness's device runtime: the device, browser and
 * recording it owns for the chat2 legacy modules (`src/app/chat/chat2.e2e.ts`,
 * `chat2Actions.integration.test.ts`). It moved here from
 * `e2e/rigs/chat2Maestro.ts`, which keeps the public-UI readers a harness
 * spec uses; the messaging category's commit converts these modules.
 */
import assert from 'node:assert/strict'
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync
} from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'

import puppeteer, { type Browser, type CDPSession, TargetType } from 'puppeteer'

import {
  Chat2Blocked,
  type Chat2Fixture,
  type Chat2Surface,
  digest,
  fixtureControl,
  need,
  outsideCheckout,
  privateJson,
  redact,
  sourceBinding
} from '../../e2e/fixtures/chat2Fixture'
import {
  ANDROID_COMPOSER_PLACEHOLDER,
  type AndroidCaptureIme,
  androidCaptureImeState,
  androidClosedCaptureGeometry,
  androidComposerControl,
  type AndroidDismissReference,
  androidDismissReference,
  androidImeFrame,
  androidScopedBounds,
  type Args,
  bounded,
  type Bounds,
  bounds,
  type CaptureViewport,
  type Chat2Device,
  code,
  type Daemon,
  dismissIosChatKeyboard,
  emptyEditorPlaceholder,
  exactIdAnswer,
  exactText,
  flattenPublicHierarchy,
  IOS_SIMULATOR_SNAPSHOT_CAP,
  iosPublicRead,
  iosRawTree,
  type IosReadNode,
  isIosSendButton,
  nativeClass,
  object,
  observedNativeValue,
  phoneTyping,
  PNG,
  pollNotVisible,
  type PublicNode,
  publicWebNodes,
  queryExactInput,
  queryExactTap,
  queryExactVisible,
  readAndroidComposerKeyboard,
  readIosComposerKeyboard,
  saveCapture,
  until
} from '../../e2e/rigs/chat2Maestro'
import { dismissNotificationAskOn } from './notificationAsk'
import { decodeRaster, type Raster, roundHalfEven } from './rasterImage'

function lockTree(path: string): void {
  if (!existsSync(path)) return
  if (statSync(path).isDirectory()) {
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) lockTree(join(path, name))
  } else chmodSync(path, 0o600)
}

/** android.view.KeyEvent.KEYCODE_PASTE */
const ANDROID_KEYCODE_PASTE = 279
/** The share of a box's pixels in each synthetic photo marker colour. */
function observeMarkerColors(
  image: Raster,
  box: { x: number; y: number; width: number; height: number },
  screenWidth: number,
  screenHeight: number
): Args {
  const x = roundHalfEven((box.x * image.width) / screenWidth)
  const y = roundHalfEven((box.y * image.height) / screenHeight)
  const width = roundHalfEven((box.width * image.width) / screenWidth)
  const height = roundHalfEven((box.height * image.height) / screenHeight)
  assert(
    x >= 0 &&
      y >= 0 &&
      width > 0 &&
      height > 0 &&
      x + width <= image.width &&
      y + height <= image.height,
    'Observed photo crop must fit actual raster'
  )
  const pixelCount = width * height
  assert(pixelCount > 20, 'Observed photo crop is too small to judge')
  let magentaPixels = 0
  let greenPixels = 0
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const at = (row * image.width + column) * 4
      const [red, green, blue] = image.data.subarray(at, at + 3)
      if (red > 170 && green < 110 && blue > 140) magentaPixels++
      if (green > 170 && red < 110 && blue < 130) greenPixels++
    }
  }
  const magentaFraction = magentaPixels / pixelCount
  const greenFraction = greenPixels / pixelCount
  return {
    raster: { width: image.width, height: image.height },
    crop: { x, y, width, height },
    pixelCount,
    magentaFraction,
    greenFraction,
    actualRenderedSyntheticMarker:
      magentaFraction > 0.08 && greenFraction > 0.08
  }
}

export class Chat2UI {
  readonly native: boolean
  /** A per-run browser never touches the profiles kept for historical captures. */
  private freshBrowserProfile?: string

  get usesFreshBrowserProfile(): boolean {
    return this.freshBrowserProfile != null
  }

  readonly steps: Args[] = []
  readonly captures: Args[] = []
  /** Ids a running search reads past the iOS simulator's snapshot cap. */
  private sought?: Set<string>
  /** The whole snapshot the latest iOS element read came from. */
  private lastIosReadNodes?: IosReadNode[]
  readonly runDir: string
  readonly binding: ReturnType<typeof sourceBinding>
  readonly deadline: AbortSignal
  device!: Chat2Device
  daemon?: Daemon
  browser?: Browser
  cdp?: CDPSession
  /** The page's uncaught exceptions and console errors, kept with a failure. */
  readonly pageErrors: Array<{ at: string; kind: string; text: string }> = []
  environment?: Args
  deviceId = ''
  cleanup: Args = {}
  private readonly root: string
  private readonly artifactRoot: string
  private readonly daemonName: string
  private webFrame?: {
    width: number
    height: number
    dpr: number
    coarse: boolean
  }

  private webZoom?: CaptureViewport
  private reportsDir?: string
  private connectCleanup?: () => Promise<Daemon>
  private webClipboardKey?: string
  private androidClosedCapture?: AndroidDismissReference

  constructor(
    readonly fixture: Chat2Fixture,
    readonly surface: Chat2Surface,
    readonly scenario: string
  ) {
    this.root = process.cwd()
    this.native = surface === 'ios' || surface === 'android'
    // An iOS case reads a hierarchy of thousands of nodes at every step, and
    // the long ones (E5 frames four messages across a long QA history) need
    // most of an hour on a shared, loaded host.
    // iOS E5 on the grown QA history runs past ninety minutes on a loaded host.
    // Android's own climbs of the grown history (E9's oldest row) take most
    // of twenty minutes.
    this.deadline = AbortSignal.timeout(
      surface === 'ios' ? 10800000 : surface === 'android' ? 2700000 : 900000
    )
    this.artifactRoot = resolve(
      need(process.env.CHAT2_ARTIFACTS, 'CHAT2_ARTIFACTS required')
    )
    outsideCheckout(this.root, this.artifactRoot)
    this.binding = sourceBinding(this.root, fixture, surface)
    this.daemonName = need(
      process.env.MAESTRO_D,
      'Each run requires its own explicit MAESTRO_D name'
    )
    assert(
      this.daemonName.startsWith(fixture.ownershipId + '-') &&
        /^[\w-]+$/.test(this.daemonName),
      'Daemon name must bind this disposable ownership ID'
    )
    this.runDir = join(
      this.artifactRoot,
      'runs',
      this.binding.source.slice(0, 12) +
        '-' +
        surface +
        '-' +
        scenario +
        '-' +
        Date.now()
    )
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 })
  }

  async start(): Promise<void> {
    const bin = process.env.MAESTRO_D_BIN ?? 'maestro-d'
    const inventory = execFileSync(bin, ['ps'], {
      encoding: 'utf8',
      timeout: 8000
    })
    writeFileSync(join(this.runDir, 'daemon-inventory.txt'), inventory, {
      mode: 0o600
    })
    const clientRoot = need(
      process.env.MAESTRO_D_CLIENT_ROOT,
      'MAESTRO_D_CLIENT_ROOT must identify the installed/built client'
    )
    const { MaestroD } = createRequire(
      join(resolve(clientRoot), 'package.json')
    )('maestro-d') as { MaestroD: { connect: (args: Args) => Promise<Daemon> } }
    this.connectCleanup = async () =>
      await MaestroD.connect({ name: this.daemonName, bin, spawn: false })
    this.daemon = await MaestroD.connect({
      name: this.daemonName,
      bin,
      idleTimeout: 0,
      signal: this.deadline
    })
    if (!this.daemon.started) {
      this.daemon.close()
      this.daemon = undefined
      throw new Error(
        'Daemon name already exists; do not reuse another run lease'
      )
    }
    this.reportsDir = this.daemon.info?.reportsDir
    if (this.native) await this.startNative()
    else await this.startWeb()
    this.environment = this.native
      ? await this.device.platformInfo()
      : await this.dom(
          'return {width:innerWidth,height:innerHeight,coarse:matchMedia("(pointer:coarse)").matches,fine:matchMedia("(pointer:fine)").matches,dpr:devicePixelRatio,userAgent:navigator.userAgent}'
        )
  }

  /** WebDriverAgent's normalized hierarchy leaves out enabled:true. */
  get omitsEnabledTrue(): boolean {
    const devices = this.fixture?.devices as Chat2Fixture['devices'] | undefined
    return (
      this.physical ||
      (this.surface === 'ios' && devices?.ios?.driver === 'wda')
    )
  }

  /** A connected phone rather than a simulator or emulator. */
  get physical(): boolean {
    const devices = this.fixture?.devices as Chat2Fixture['devices'] | undefined
    return (
      this.native &&
      devices?.[this.surface === 'ios' ? 'ios' : 'android']?.physical === true
    )
  }

  private async startNative(): Promise<void> {
    const platform = this.surface === 'ios' ? 'ios' : 'android'
    const configured = this.fixture.devices[platform]
    const requestedDevice = need(
      process.env[
        platform === 'ios' ? 'CHAT_IOS_DEVICE' : 'CHAT_ANDROID_DEVICE'
      ],
      'Explicit task-owned native ID required'
    )
    assert(
      requestedDevice === configured.id && configured.owned,
      'Device does not match the owned descriptor'
    )
    this.deviceId = requestedDevice
    if (configured.physical) {
      // Lanes share no device, and a phone is neither booted nor shut down.
      const present =
        platform === 'ios'
          ? spawnSync('xcrun', ['devicectl', 'list', 'devices'], {
              encoding: 'utf8',
              timeout: 20000
            })
              .stdout.split('\n')
              .some(
                line =>
                  line.includes(this.deviceId) && /\bconnected\b/.test(line)
              )
          : spawnSync(
              process.env.CHAT2_ADB ?? 'adb',
              ['-s', this.deviceId, 'get-state'],
              { encoding: 'utf8', timeout: 5000 }
            ).stdout.trim() === 'device'
      assert(present, 'Connected physical device required')
    } else if (platform === 'android') {
      const sims = JSON.parse(
        execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
          encoding: 'utf8'
        })
      ) as { devices: Record<string, Array<{ udid: string; state: string }>> }
      assert(
        !Object.values(sims.devices)
          .flat()
          .some(
            d => d.udid === this.fixture.devices.ios.id && d.state === 'Booted'
          ),
        'Own iOS target must stop before Android starts'
      )
    } else {
      const adb = spawnSync(process.env.CHAT2_ADB ?? 'adb', ['devices'], {
        encoding: 'utf8',
        timeout: 5000
      })
      assert(
        adb.status === 0 &&
          !adb.stdout
            .split('\n')
            .some(line =>
              line.startsWith(this.fixture.devices.android.id + '\t')
            ),
        'Own Android target must stop before iOS starts'
      )
    }
    if (configured.physical) {
      // Nothing to boot.
    } else if (process.env.CHAT2_NATIVE_PREBOOTED !== '1') {
      const started = await need(this.daemon, 'Daemon required').startDevice({
        platform,
        name: configured.name,
        bootTimeout: 180
      })
      assert(started.id === this.deviceId, 'Boot returned a different device')
    } else if (platform === 'android') {
      const name = execFileSync(
        process.env.CHAT2_ADB ?? 'adb',
        ['-s', this.deviceId, 'emu', 'avd', 'name'],
        { encoding: 'utf8', timeout: 5000 }
      )
        .split('\n')[0]
        .trim()
      assert(
        name === configured.name,
        'Prebooted serial belongs to another AVD'
      )
    } else {
      const sims = JSON.parse(
        execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
          encoding: 'utf8'
        })
      ) as {
        devices: Record<
          string,
          Array<{ udid: string; name: string; state: string }>
        >
      }
      assert(
        Object.values(sims.devices)
          .flat()
          .some(
            d =>
              d.udid === this.deviceId &&
              d.name === configured.name &&
              d.state === 'Booted'
          ),
        'Exact owned prebooted simulator required'
      )
    }
    this.device = await need(this.daemon, 'Daemon required').attach({
      device: this.deviceId,
      platform,
      driver: configured.driver,
      ...(configured.teamId == null ? {} : { teamId: configured.teamId }),
      appId: this.fixture.appId,
      ...(process.env.CHAT2_UPDATE_OWN_APP === '1' &&
      !(configured.physical && platform === 'ios')
        ? {
            appFile:
              platform === 'ios'
                ? dirname(this.binding.binding.artifact)
                : this.binding.binding.artifact
          }
        : { noAppInstall: true }),
      artifacts: 'none',
      driverStartTimeout: 180,
      // iOS re-reads the whole accessibility tree for each command; a long
      // conversation pushed single commands past 30 s.
      commandTimeout: platform === 'ios' ? 90000 : 30000,
      ...phoneTyping(platform, configured.physical)
    })
    if (platform === 'ios') {
      const device = this.device
      const once = device.assertNotVisible.bind(device)
      device.assertNotVisible = async args => await pollNotVisible(once, args)
      if (!configured.physical) {
        const visibleOnce = device.assertVisible.bind(device)
        const tapOnce = device.tapOn.bind(device)
        const tapOnPoint = device.tapOnPoint.bind(device)
        device.assertVisible = async (args, options) =>
          await queryExactVisible(visibleOnce, args, options)
        device.tapOn = async (args, options) =>
          await queryExactTap(tapOnce, visibleOnce, tapOnPoint, args, options)
        const inputOnce = device.inputText.bind(device)
        device.inputText = async (args, options) =>
          await queryExactInput(
            inputOnce,
            visibleOnce,
            tapOnPoint,
            args,
            options,
            step => this.steps.push(step)
          )
      }
    }
    await this.device.launchApp({
      appId: this.fixture.appId,
      ...(platform === 'ios'
        ? { environment: { TS_DECLARED_AGE_LOWER: '18' } }
        : {})
    })
    // A phone's Google Password Manager sheet outlives the app that raised it,
    // and its own Password label would read as the app's sign-in form.
    if (
      platform === 'android' &&
      configured.physical &&
      (await this.visible(
        { text: '^Save password to Google Password Manager' },
        3000
      ))
    ) {
      await this.device.tapOn({ text: '^(Not now|Never)$' })
      this.steps.push({
        name: 'Phone password manager offer from an earlier run declined',
        outcome: 'passed'
      })
    }
    // A cold two-core emulator can raise the system's own ANR dialog over the
    // app; wait for System UI rather than closing anything, and record it.
    if (
      platform === 'android' &&
      (await this.visible({ text: ".* isn't responding$" }, 3000))
    ) {
      await this.device.tapOn({ text: '^Wait$' })
      this.steps.push({
        name: 'Android system ANR dialog answered with Wait',
        outcome: 'passed'
      })
    }
    if (platform === 'ios' && configured.physical) {
      // A phone's app container cannot be read, so the lane's own install of
      // the exact bound bundle is the binding, re-hashed here.
      const receipt = object(
        JSON.parse(
          readFileSync(
            need(
              process.env.CHAT2_PHYSICAL_INSTALL_RECEIPT,
              'Physical iOS install receipt required'
            ),
            'utf8'
          )
        )
      )
      const app = dirname(this.binding.binding.artifact)
      assert(
        receipt.device === this.deviceId &&
          receipt.appId === this.fixture.appId &&
          receipt.app === app &&
          receipt.executableSha256 === this.binding.binding.sha256 &&
          digest(this.binding.binding.artifact) === this.binding.binding.sha256,
        'Physical install differs from final bound build'
      )
      if (this.binding.binding.bundle != null)
        assert(
          receipt.bundleSha256 === this.binding.binding.bundle.sha256 &&
            digest(join(app, basename(this.binding.binding.bundle.path))) ===
              this.binding.binding.bundle.sha256,
          'Physically installed iOS JS differs from final source'
        )
      this.steps.push({
        name: 'Installed iOS build/source binding',
        outcome: 'passed',
        physical: true,
        installReceipt: process.env.CHAT2_PHYSICAL_INSTALL_RECEIPT,
        installedArtifactSha256: this.binding.binding.sha256
      })
    } else if (platform === 'ios') {
      const installed = execFileSync(
        'xcrun',
        [
          'simctl',
          'get_app_container',
          this.deviceId,
          this.fixture.appId,
          'app'
        ],
        { encoding: 'utf8' }
      ).trim()
      assert(
        digest(join(installed, basename(this.binding.binding.artifact))) ===
          this.binding.binding.sha256,
        'Installed iOS executable differs from final bound build'
      )
      if (this.binding.binding.bundle != null)
        assert(
          digest(
            join(installed, basename(this.binding.binding.bundle.path))
          ) === this.binding.binding.bundle.sha256,
          'Installed iOS JS differs from final source'
        )
      this.steps.push({
        name: 'Installed iOS build/source binding',
        outcome: 'passed',
        installedArtifactSha256: this.binding.binding.sha256
      })
    } else {
      const apkPath = execFileSync(
        process.env.CHAT2_ADB ?? 'adb',
        ['-s', this.deviceId, 'shell', 'pm', 'path', this.fixture.appId],
        { encoding: 'utf8', timeout: 5000 }
      )
        .trim()
        .split('\n')[0]
        .replace(/^package:/, '')
      assert(
        /^\/data\/app\/[A-Za-z0-9_./+~=-]+\.apk$/.test(apkPath),
        'Expected explicit installed application APK path'
      )
      const pulled = join(this.runDir, 'installed.apk')
      execFileSync(
        process.env.CHAT2_ADB ?? 'adb',
        ['-s', this.deviceId, 'pull', apkPath, pulled],
        { stdio: 'pipe', timeout: 20000 }
      )
      const installedSha256 = digest(pulled)
      // The hash is the proof; the copy (an APK per run) is not kept.
      rmSync(pulled)
      assert(
        installedSha256 === this.binding.binding.sha256,
        'Installed Android APK differs from final source build'
      )
      this.steps.push({
        name: 'Installed Android build/source binding',
        outcome: 'passed',
        installedArtifactSha256: installedSha256
      })
    }
  }

  private async startWeb(): Promise<void> {
    const requestedDevice = need(
      process.env.CHAT_WEB_DEVICE,
      'Explicit task-owned CHAT_WEB_DEVICE required'
    )
    assert(
      requestedDevice.startsWith(this.fixture.ownershipId + '-'),
      'Browser ID must bind this fixture ownership'
    )
    this.deviceId = requestedDevice
    const browser = need(
      this.fixture.browser,
      'Owned browser/profile descriptor required'
    )
    outsideCheckout(this.root, browser.profileRoot)
    const served = await fetch(
      this.fixture.webUrl.replace(/\/$/, '') +
        '/' +
        basename(this.binding.binding.artifact)
    )
    assert(served.ok, 'Actual served web bundle unavailable')
    const bytes = Buffer.from(await served.arrayBuffer())
    const expected = readFileSync(this.binding.binding.artifact)
    assert(
      bytes.equals(expected),
      'Actual served web JS differs from final bound build'
    )
    this.steps.push({
      name: 'Served final-source JS bytes',
      outcome: 'passed',
      sha256: this.binding.binding.sha256
    })
    const metrics = this.metrics()
    if (process.argv.includes('--fresh-web-profile')) {
      assert(
        !this.native && ['E3', 'E4', 'E7', 'E8', 'E9'].includes(this.scenario),
        'Fresh browser profiles are for standalone web regression cases'
      )
      mkdirSync(browser.profileRoot, { recursive: true, mode: 0o700 })
      this.freshBrowserProfile = mkdtempSync(
        join(browser.profileRoot, 'regression-')
      )
    }
    const profile =
      this.freshBrowserProfile ?? join(browser.profileRoot, this.surface)
    // The profile is kept between runs, and Chrome reopens a session's pages:
    // without this every earlier run's page comes back, more each time.
    rmSync(join(profile, 'Default', 'Sessions'), {
      recursive: true,
      force: true
    })
    this.device = await need(this.daemon, 'Daemon required').attach({
      device: this.deviceId,
      platform: 'web',
      driver: 'cdp',
      appId: this.fixture.webUrl,
      url: this.fixture.webUrl,
      artifacts: 'none',
      extra: {
        browser: browser.executable,
        userDataDir: profile,
        windowSize: metrics.width + 'x' + metrics.height
      }
    })
    const port = readFileSync(
      join(profile, 'DevToolsActivePort'),
      'utf8'
    ).split('\n')[0]
    this.browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:' + port,
      defaultViewport: null
    })
    await this.device.openLink({ link: this.fixture.webUrl })
    // A target that stalls is retried with a fresh marker; three stalls fail
    // the run in seconds rather than at the lease deadline.
    for (let attempt = 1; this.cdp == null; attempt++) {
      try {
        this.cdp = await this.currentWebTarget()
      } catch (error) {
        if (attempt >= 3) throw error
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
    const pageError = (kind: string, text: string): void => {
      if (this.pageErrors.length < 50)
        this.pageErrors.push({
          at: new Date().toISOString(),
          kind,
          text: text.slice(0, 4000)
        })
    }
    this.cdp.on('Runtime.exceptionThrown', event => {
      const details = event.exceptionDetails
      pageError('exception', details.exception?.description ?? details.text)
    })
    this.cdp.on('Runtime.consoleAPICalled', event => {
      if (event.type !== 'error') return
      pageError(
        'console.error',
        event.args
          .map(arg => arg.description ?? String(arg.value ?? ''))
          .join(' ')
      )
    })
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: metrics.dpr,
      mobile: metrics.coarse
    })
    await this.cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: metrics.coarse,
      maxTouchPoints: 1
    })
    const actual = await this.dom(
      'return {width:innerWidth,height:innerHeight,coarse:matchMedia("(pointer:coarse)").matches,dpr:devicePixelRatio}'
    )
    const matches =
      actual.width === metrics.width &&
      actual.height === metrics.height &&
      actual.coarse === metrics.coarse &&
      actual.dpr === metrics.dpr
    this.steps.push({
      name: 'Viewport and pointer measurements',
      outcome: matches ? 'passed' : 'failed',
      expected: metrics,
      actual: {
        width: actual.width,
        height: actual.height,
        coarse: actual.coarse,
        dpr: actual.dpr
      }
    })
    assert(
      matches,
      'Actual viewport/pointer/pixel scale differs from requested surface'
    )
    this.webFrame = { ...metrics }
  }

  /** Bind the observer to Maestro's current public document, including restored tabs. */
  private async currentWebTarget(): Promise<CDPSession> {
    const browser = need(this.browser, 'Passive browser observer required')
    const origin = new URL(this.fixture.webUrl).origin
    const attribute = 'data-observer-' + randomUUID().replace(/-/g, '')
    const marker = randomUUID()
    const name = JSON.stringify(attribute)
    const value = JSON.stringify(marker)
    const sessions: CDPSession[] = []
    let retained: CDPSession | undefined
    let marked = false
    let ownedPageCount = 0
    // A same-origin target that cannot be read (a prerender, a closing page)
    // cannot be the marked Maestro page; it is recorded, not used.
    const unreadable: string[] = []
    let targetId: string | undefined
    try {
      let selected: CDPSession | undefined
      try {
        const result = await this.dom(
          'const node=document.documentElement; const name=' +
            name +
            '; if(node.hasAttribute(name)) throw Error("Observer marker collision");' +
            ' node.setAttribute(name,' +
            value +
            '); return {marked:node.getAttribute(name)===' +
            value +
            ',origin:location.origin}'
        )
        marked = result.marked === true
        assert(
          marked && result.origin === origin,
          'Owned Maestro page marker required'
        )
        const matches: CDPSession[] = []
        // The browser's page targets, read without waiting for each page
        // object: one target that never finishes attaching must not stall the
        // run, and every protocol call below is bounded.
        for (const target of browser.targets()) {
          if (target.type() !== TargetType.PAGE) continue
          let pageOrigin: string
          try {
            pageOrigin = new URL(target.url()).origin
          } catch {
            continue
          }
          if (pageOrigin !== origin) continue
          ownedPageCount++
          try {
            const session = await bounded(
              target.createCDPSession(),
              10000,
              'Browser target session'
            )
            sessions.push(session)
            const probe = await bounded(
              session.send('Runtime.evaluate', {
                expression:
                  '({marker:document.documentElement.getAttribute(' +
                  name +
                  ')===' +
                  value +
                  ',origin:location.origin})',
                returnByValue: true
              }),
              10000,
              'Browser target probe'
            )
            assert(probe.exceptionDetails == null, 'Public DOM probe failed')
            const observed = object(probe.result.value)
            if (observed.marker === true && observed.origin === origin)
              matches.push(session)
          } catch (error) {
            unreadable.push(String(error).slice(0, 200))
          }
        }
        assert(
          matches.length === 1,
          'Exactly one Maestro-marked owned browser target required' +
            (unreadable.length > 0
              ? '; unreadable: ' + unreadable.join(' | ')
              : '')
        )
        selected = matches[0]
        const info = await bounded(
          selected.send('Target.getTargetInfo'),
          10000,
          'Browser target identity'
        )
        assert(
          info.targetInfo.type === 'page' &&
            new URL(info.targetInfo.url).origin === origin &&
            info.targetInfo.targetId !== '',
          'Marked browser page target identity required'
        )
        targetId = info.targetInfo.targetId
      } finally {
        const cleanup = await this.dom(
          'const node=document.documentElement; const name=' +
            name +
            '; const matched=node.getAttribute(name)===' +
            value +
            '; if(matched) node.removeAttribute(name);' +
            ' return {matched,absent:!node.hasAttribute(name)}'
        )
        assert(
          cleanup.absent === true && (!marked || cleanup.matched === true),
          'Owned Maestro page marker cleanup required'
        )
      }
      retained = need(selected, 'Unique marked browser observer required')
      this.steps.push({
        name: 'Exact Maestro browser target identity',
        outcome: 'passed',
        ownedOrigin: origin,
        ownedPageCount,
        unreadableCount: unreadable.length,
        matchCount: 1,
        targetId,
        markerSha256: createHash('sha256').update(marker).digest('hex'),
        markerRemoved: true
      })
      return retained
    } finally {
      for (const session of sessions)
        if (session !== retained)
          await bounded(session.detach(), 5000, 'Browser target detach').catch(
            () => {}
          )
    }
  }

  metrics(): { width: number; height: number; coarse: boolean; dpr: number } {
    if (!this.native && this.webFrame != null) return { ...this.webFrame }
    return {
      width:
        this.surface === 'web-wide'
          ? 1440
          : this.surface === 'web-320'
            ? 320
            : 390,
      height:
        this.surface === 'web-wide'
          ? 1000
          : this.surface === 'web-320'
            ? 700
            : 844,
      coarse: this.surface === 'web-touch' || this.surface === 'web-320',
      dpr: 2
    }
  }

  /** Starts a real new app workspace, preserving ordinary device keys and login. */
  async coldOpen(path: string, beforeLaunch?: () => void): Promise<void> {
    const at = new Date().toISOString()
    if (this.native) {
      await this.device.stopApp({ appId: this.fixture.appId })
      beforeLaunch?.()
      await this.device.launchApp({
        appId: this.fixture.appId,
        ...(this.surface === 'ios'
          ? { environment: { TS_DECLARED_AGE_LOWER: '18' } }
          : {})
      })
      await this.open(path)
    } else {
      // Full navigation through Maestro destroys the previous JS workspace.
      await this.device.openLink({ link: 'about:blank' })
      beforeLaunch?.()
      await this.device.openLink({
        link: this.fixture.webUrl.replace(/\/$/, '') + path
      })
    }
    this.steps.push({
      name: 'Real cold workspace lifecycle',
      at,
      platform: this.surface,
      path,
      keysReset: false
    })
  }

  /** Disable only the browser capability before app scripts, never app state. */
  async withoutWasm(check: () => Promise<void>): Promise<void> {
    assert(
      !this.native && this.cdp != null,
      'No-WASM is a browser capability case'
    )
    // A script added on a session without the Page domain is never run on
    // the next document (checked in Chrome), so WebAssembly stayed.
    await this.cdp.send('Page.enable')
    const script = await this.cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: 'delete globalThis.WebAssembly;' }
    )
    try {
      await this.coldOpen('/chat')
      await check()
    } finally {
      await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: script.identifier
      })
      await this.coldOpen('/chat')
    }
  }

  async renderedEffects(): Promise<Args> {
    if (this.native)
      return {
        method:
          'Native actual composition is captured; OS Settings and source-bound visual review required',
        publicNodes: (await this.nodes()).filter(n =>
          [
            'chat-message-spotlight',
            'chat-message-spotlight-controls',
            'chat-pinned-band',
            'chat-composer-band'
          ].includes(n.id ?? '')
        )
      }
    return await this.dom(
      'const ids=["chat-message-spotlight","chat-message-spotlight-controls","chat-pinned-band","chat-composer-band"];return {styles:ids.flatMap(id=>{const n=document.querySelector("[data-testid="+JSON.stringify(id)+"]");return n?[n,...n.querySelectorAll("*")].slice(0,60).map(el=>{const s=getComputedStyle(el);return {id:el.getAttribute("data-testid"),background:s.backgroundColor,backdrop:s.backdropFilter,filter:s.filter,transition:s.transitionDuration,animation:s.animationDuration,opacity:s.opacity}}):[]})}'
    )
  }

  async photoMarker(conversationId: string): Promise<Args> {
    return await this.renderedPhoto({
      id: 'chat-avatar',
      childOf: { id: 'chat-conversation-' + conversationId }
    })
  }

  async renderedPhoto(selected: Args): Promise<Args> {
    const observation: Args = {
      name: 'Rendered photo marker observation',
      selector: selected,
      observedAt: new Date().toISOString(),
      outcome: 'failed'
    }
    this.steps.push(observation)
    const path = join(this.runDir, 'photo-avatar-' + Date.now() + '.png')
    const evidencePath = path + '.observation.json'
    observation.evidencePath = evidencePath
    try {
      const box = await this.observedBounds(selected)
      observation.box = box
      const capture = await this.captureImage(path)
      observation.capture = capture
      observation.path = path
      const screen: Args = this.native
        ? await this.device.platformInfo()
        : object(object(capture.captureObserver).before)
      observation.platform = screen
      const width = Number(screen.screenWidth ?? screen.width)
      const height = Number(screen.screenHeight ?? screen.height)
      assert(
        [width, height].every(value => Number.isFinite(value) && value > 0),
        'Actual screenshot coordinate space required'
      )
      const proof = observeMarkerColors(
        decodeRaster(readFileSync(path)),
        box,
        width,
        height
      )
      observation.pixelResult = proof
      privateJson(evidencePath, observation)
      assert(
        proof.actualRenderedSyntheticMarker === true,
        'Actual avatar must show both synthetic photo marker colors'
      )
      observation.outcome = 'passed'
      privateJson(evidencePath, observation)
      return { box, capture, path, ...proof }
    } catch (error) {
      observation.error = error instanceof Error ? error.message : String(error)
      privateJson(evidencePath, observation)
      throw error
    }
  }

  async iosRaw(signal = AbortSignal.timeout(30000)): Promise<Uint8Array> {
    const api = this.device as unknown as {
      hierarchyRaw: (options: { signal: AbortSignal }) => Promise<Uint8Array>
    }
    return await api.hierarchyRaw({ signal })
  }

  /** These are fresh observed OS elements, never fabricated clipboard contents. */
  async iosMenuAction(label: string): Promise<void> {
    const read = iosPublicRead(
      await this.iosRaw(),
      { text: exactText(label) },
      'MenuItem'
    )
    const node = need(
      read.element,
      'Observed exact OS menu item required: ' + label
    )
    assert(node.enabled === true, 'Enabled observed OS menu item required')
    await this.tapObserved(node)
  }

  async clipboardSentinel(text: string): Promise<void> {
    if (!this.native) {
      assert(
        this.webClipboardKey == null,
        'One browser clipboard proof at a time'
      )
      const origin = new URL(this.fixture.webUrl).origin
      const permission = await this.device.grantPermissions(
        {
          origin,
          permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
        },
        { signal: AbortSignal.any([this.deadline, AbortSignal.timeout(5000)]) }
      )
      this.steps.push({
        browserClipboardPermission: { origin, response: permission }
      })
      const key = '__chat2Clipboard_' + randomUUID().replace(/-/g, '')
      this.webClipboardKey = key
      const result = await this.dom(
        `
        if(location.origin!==${JSON.stringify(origin)}||!isSecureContext||!document.hasFocus())throw Error('Owned focused secure clipboard page required');
        const key=${JSON.stringify(key)};if(Object.hasOwn(window,key))throw Error('Clipboard proof already exists');
        const previous=await navigator.clipboard.readText();window[key]={previous};
        await navigator.clipboard.writeText(${JSON.stringify(text)});
        return {sentinelInstalled:(await navigator.clipboard.readText())===${JSON.stringify(text)}};
      `,
        AbortSignal.any([this.deadline, AbortSignal.timeout(5000)])
      )
      this.steps.push({
        browserClipboardSentinelInstalled: result.sentinelInstalled
      })
      assert(
        result.sentinelInstalled === true,
        'Actual browser clipboard sentinel required'
      )
      return
    }
    if (this.surface !== 'ios') {
      await this.device.setClipboard({ text })
      await this.closeAndroidClipboardOverlay()
      return
    }
    if (this.physical) {
      // A phone's hold on a draft only moves its caret and raises no menu,
      // and its double tap selects one word (Cut, Copy, Paste; no Select
      // All). The phone's sentinel is that word: the text without its spaces.
      const word = text.replace(/\s+/g, '')
      await this.replaceDraft(word)
      await this.device.doubleTapOn({ id: 'chat-composer', point: '20%,50%' })
      await this.iosMenuAction('Cut')
      await this.pasteClipboard()
      assert.equal(
        await this.draft(),
        word,
        'Observed OS sentinel Cut/Paste required'
      )
      await this.replaceDraft('')
      return
    }
    await this.replaceDraft(text)
    await this.device.longPressOn({ id: 'chat-composer', duration: 600 })
    await this.iosMenuAction('Select All')
    // Cut, not Copy: Copy left the whole draft selected, and a long press on a
    // selection offers no Select All, so the next clear deleted one letter.
    await this.iosMenuAction('Cut')
    // Paste once to prove that the ordinary OS Cut installed the sentinel and
    // emptied the draft: a draft Cut left behind would read twice.
    await this.pasteClipboard()
    assert.equal(
      await this.draft(),
      text,
      'Observed OS sentinel Cut/Paste required'
    )
    await this.replaceDraft('')
  }

  async pasteClipboard(expected?: string): Promise<void> {
    if (!this.native) {
      assert(
        this.webClipboardKey != null && typeof expected === 'string',
        'Scoped synthetic clipboard proof required'
      )
      const signal = AbortSignal.any([this.deadline, AbortSignal.timeout(5000)])
      const actual = await until(
        async () => {
          const result = await this.dom(
            `
          if(location.origin!==${JSON.stringify(new URL(this.fixture.webUrl).origin)}||!isSecureContext||!document.hasFocus()||!Object.hasOwn(window,${JSON.stringify(this.webClipboardKey)}))throw Error('Original owned clipboard page required');
          const actual=await navigator.clipboard.readText();
          return actual===${JSON.stringify(expected)}?{matches:true,actual}:{matches:false};
        `,
            signal
          )
          this.steps.push({ actualBrowserCopyMatched: result.matches })
          return result.matches === true && typeof result.actual === 'string'
            ? result.actual
            : undefined
        },
        'Actual app Copy must replace the browser clipboard sentinel',
        5000
      )
      await this.device.inputText({ id: 'chat-composer', text: actual })
      return
    }
    if (this.surface === 'android') {
      // The driver cannot read Android's clipboard from the background, and
      // on Android 16 its hierarchy read fails while the field's floating
      // text menu is open (AccessibilityNodeInfo mSealed), so Paste in that
      // menu cannot be found. The system paste key pastes the clipboard into
      // the focused field, as a keyboard's paste does; the caller still
      // proves the pasted text.
      await this.device.tapOn({ id: 'chat-composer' })
      await this.androidKey(ANDROID_KEYCODE_PASTE)
      // The paste answers with a system toast ("pasted from your clipboard")
      // and the clipboard overlay, and the driver's hierarchy read fails
      // while such a window is up: wait them out, then close the overlay.
      await this.androidSystemWindowsSettled()
      await this.closeAndroidClipboardOverlay()
      // The pasted text reaches the field a moment after the key (the paste
      // toast is already up while the composer still reads empty); the
      // caller then proves the text itself.
      await until(
        async () => ((await this.draft()) !== '' ? true : undefined),
        'Android pasted text in the composer',
        10000
      ).catch(() => undefined)
      return
    }
    await this.device.longPressOn({ id: 'chat-composer', duration: 600 })
    await this.iosMenuAction('Paste')
  }

  /**
   * On Android 16 the driver's hierarchy read fails (AccessibilityNodeInfo
   * mSealed) while a transient system window such as a toast is up. Read
   * until one succeeds, ten seconds at most; any other failure is real.
   */
  async androidSystemWindowsSettled(): Promise<void> {
    assert(this.surface === 'android', 'Android system windows require Android')
    for (let attempt = 1; ; attempt++) {
      try {
        await this.device.hierarchy({ signal: this.deadline })
        this.steps.push({
          name: 'Android system windows settled',
          outcome: 'passed',
          attempts: attempt
        })
        return
      } catch (error) {
        if (!String(error).includes('mSealed') || attempt >= 10) throw error
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  }

  /**
   * Pull a finished phone recording to the host and remove it from the phone.
   * screenrecord writes the movie's index as it exits, so it must have exited.
   */
  async androidPullRecording(remote: string, local: string): Promise<void> {
    const adb = process.env.CHAT2_ADB ?? 'adb'
    for (let attempt = 0; attempt < 25; attempt++) {
      const running = spawnSync(
        adb,
        ['-s', this.deviceId, 'shell', 'pgrep', 'screenrecord'],
        { encoding: 'utf8', timeout: 5000 }
      )
      if ((running.stdout ?? '').trim() === '') break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const pulled = spawnSync(
      adb,
      ['-s', this.deviceId, 'pull', remote, local],
      {
        encoding: 'utf8',
        timeout: 60000
      }
    )
    assert.equal(
      pulled.status,
      0,
      'Android recording pull required: ' + (pulled.stderr ?? '').slice(-200)
    )
    spawnSync(adb, ['-s', this.deviceId, 'shell', 'rm', '-f', remote], {
      timeout: 10000
    })
    this.steps.push({
      name: 'Android recording pulled from the phone',
      outcome: 'passed',
      remote,
      path: local
    })
  }

  /** One Android key event through adb, for keys the driver has no name for. */
  async androidKey(code: number): Promise<void> {
    assert(this.surface === 'android', 'Android key event requires Android')
    const args = [
      '-s',
      this.deviceId,
      'shell',
      'input',
      'keyevent',
      String(code)
    ]
    const result = spawnSync(process.env.CHAT2_ADB ?? 'adb', args, {
      encoding: 'utf8',
      timeout: 15000
    })
    this.steps.push({
      name: 'Android key event',
      outcome: result.status === 0 ? 'passed' : 'failed',
      args,
      exitCode: result.status,
      transportError: result.error?.message
    })
    assert.equal(result.status, 0, 'Android key event required: ' + code)
  }

  async restoreClipboard(): Promise<void> {
    const key = this.webClipboardKey
    if (this.native || key == null) return
    try {
      const result = await this.dom(
        `
        const key=${JSON.stringify(key)};
        if(location.origin!==${JSON.stringify(new URL(this.fixture.webUrl).origin)}||!isSecureContext||!Object.hasOwn(window,key))throw Error('Original clipboard restoration buffer required');
        const state=window[key];try{await navigator.clipboard.writeText(state.previous);return {restored:(await navigator.clipboard.readText())===state.previous}}finally{delete window[key]}
      `,
        AbortSignal.timeout(5000)
      )
      this.steps.push({
        priorBrowserClipboardRestored: result.restored === true
      })
      assert(result.restored === true, 'Prior browser clipboard must restore')
    } catch (error) {
      this.steps.push({ priorBrowserClipboardRestored: false })
      throw error
    } finally {
      this.webClipboardKey = undefined
    }
  }

  /** Keep only the app-created temporary file input available for Maestro upload. */
  async uploadPhoto(path: string): Promise<void> {
    assert(!this.native, 'Controlled file-input upload is a browser operation')
    const key = '__chat2FileInput_' + randomUUID().replace(/-/g, '')
    const proof: Args = { controlledFileInput: true, osChooserClaimed: false }
    this.steps.push(proof)
    let completed = false
    try {
      proof.install = await this.dom(`
        const key=${JSON.stringify(key)},proto=HTMLInputElement.prototype;
        if(Object.hasOwn(window,key)||document.querySelectorAll('input[type="file"]').length!==0)throw Error('No existing file input or interception allowed');
        const own=Object.getOwnPropertyDescriptor(proto,'click'),original=proto.click,state={own,original,inputs:[]};
        state.replacement=function(...args){if(this instanceof HTMLInputElement&&this.type==='file'){
          if(!this.isConnected||state.inputs.length!==0||document.querySelectorAll('input[type="file"]').length!==1)throw Error('One newly connected temporary file input required');
          state.inputs.push(this);this.style.display='block';this.style.width='200px';this.style.height='30px';return;
        }return Reflect.apply(original,this,args)};
        window[key]=state;Object.defineProperty(proto,'click',{configurable:true,enumerable:own?.enumerable??false,writable:true,value:state.replacement});
        return {installed:proto.click===state.replacement};
      `)
      assert(
        (proof.install as Args).installed === true,
        'Exact temporary file-input interception must install'
      )
      await this.text('Attach')
      await this.text('Photos')
      await this.device.uploadFile({ css: 'input[type="file"]', path })
      await this.present('chat-attachment-chip')
      completed = true
    } finally {
      const result = await this.dom(
        `
        const key=${JSON.stringify(key)},state=window[key],proto=HTMLInputElement.prototype;
        if(!state)return {restored:true,installed:false};
        const wasReplacement=proto.click===state.replacement;
        const inputs=state.inputs.map(n=>({connected:n.isConnected,fileCount:n.files?.length??0}));
        if(state.own)Object.defineProperty(proto,'click',state.own);else delete proto.click;
        const actual=Object.getOwnPropertyDescriptor(proto,'click');
        const restored=proto.click===state.original&&(state.own?actual?.value===state.own.value&&actual?.writable===state.own.writable&&actual?.enumerable===state.own.enumerable&&actual?.configurable===state.own.configurable:actual===undefined);
        delete window[key];return {restored,installed:true,wasReplacement,inputs};
      `,
        AbortSignal.timeout(5000)
      )
      proof.restore = result
      assert(
        result.restored === true,
        'Exact original input click descriptor must restore'
      )
      if (completed) {
        const inputs = result.inputs as Array<{
          connected: boolean
          fileCount: number
        }>
        assert(
          result.installed === true &&
            result.wasReplacement === true &&
            inputs.length === 1 &&
            !inputs[0].connected &&
            inputs[0].fileCount === 1,
          'One actual uploaded temporary input must be consumed'
        )
      }
    }
  }

  /** iOS swipe duration controls its hold; drag supplies an explicit movement duration. */
  async measuredSwipe(
    input: {
      startX: number
      startY: number
      endX: number
      endY: number
      duration: number
    },
    signal = this.deadline
  ): Promise<void> {
    assert(
      Object.values(input).every(Number.isFinite) &&
        input.duration > 0 &&
        [input.startX, input.startY, input.endX, input.endY].every(
          value => value >= 0
        ),
      'Actual finite measured gesture coordinates required'
    )
    const screen = this.native
      ? await this.device.platformInfo({ signal })
      : this.metrics()
    const width = Number(
      'screenWidth' in screen ? screen.screenWidth : screen.width
    )
    const height = Number(
      'screenHeight' in screen ? screen.screenHeight : screen.height
    )
    assert(
      [width, height].every(value => Number.isFinite(value) && value > 0),
      'Actual measured gesture viewport required'
    )
    assert(
      [input.startX, input.endX].every(value => value > 0 && value < width) &&
        [input.startY, input.endY].every(value => value > 0 && value < height),
      'Measured gesture endpoints must stay strictly inside the actual viewport'
    )
    // The iOS driver takes whole points only.
    if (this.surface === 'ios')
      await this.device.dragAndDrop(
        {
          from: {
            point: `${Math.round(input.startX)},${Math.round(input.startY)}`
          },
          to: { point: `${Math.round(input.endX)},${Math.round(input.endY)}` },
          holdDuration: 16,
          duration: input.duration
        },
        { signal }
      )
    else if (this.native) await this.device.swipe(input, { signal })
    else
      await this.device.dragAndDrop({
        from: { point: `${input.startX},${input.startY}` },
        to: { point: `${input.endX},${input.endY}` },
        holdDuration: 1,
        duration: input.duration
      })
  }

  async deleteBackward(): Promise<void> {
    if (this.surface !== 'ios') {
      await this.device.pressKey({ key: 'BACKSPACE' })
      return
    }
    const raw = await this.iosRaw()
    const read = iosPublicRead(raw, { text: '^delete$' }, 'Key')
    const key =
      read.element ?? (await this.iosRead({ text: exactText('delete') }, 'Key'))
    const keyboard = iosPublicRead(raw, {}, 'Keyboard')
    assert(
      keyboard.element != null && key.enabled === true,
      'Observed enabled Delete key and Keyboard required'
    )
    const k = need(key.bounds, 'Delete key bounds required')
    const b = need(keyboard.element.bounds, 'Keyboard bounds required')
    assert(
      k.x >= b.x &&
        k.y >= b.y &&
        k.x + k.width <= b.x + b.width &&
        k.y + k.height <= b.y + b.height,
      'Delete key must belong to the actual Keyboard band'
    )
    await this.tapObserved(key)
  }

  /**
   * A locked conversation keeps its composer on screen but not editable. The
   * driver counts a read-only web field as enabled and iOS reports such a
   * field enabled too, so prove it: on web the field is read-only or disabled;
   * on iOS and Android a tap on it raises no keyboard. An empty draft has no Send action.
   */
  async assertComposerNotEditable(settle = 1500): Promise<Args> {
    if (!this.native) {
      const state = await this.dom(
        "const n=document.querySelector('[data-testid=\"chat-composer\"]');const s=document.querySelector('[aria-label=\"Send\"]');return {present:n!=null,readOnly:n!=null&&n.readOnly===true,disabled:n!=null&&n.disabled===true,sendDisabled:s==null?(n!=null&&!(n.value||'').trim()):(s.disabled===true||s.getAttribute('aria-disabled')==='true')}"
      )
      assert(
        state.present !== true ||
          state.readOnly === true ||
          state.disabled === true,
        'A locked composer must not accept text'
      )
      assert(state.sendDisabled === true, 'Send must be positively disabled')
      return { surface: this.surface, ...state }
    }
    if (this.surface === 'android') {
      // Android reports the window's input method directly: a tap on a
      // locked composer leaves it closed.
      await this.device.tapOn({ id: 'chat-composer' })
      await new Promise(resolve => setTimeout(resolve, settle))
      const ime = await this.readAndroidImeState()
      const send = (await this.nodes()).filter(
        node => node.text === 'Send' && /(?:^|\.)Button$/.test(node.type ?? '')
      )
      assert(
        ime.state === 'already-closed',
        'A tap on a locked composer must raise no keyboard'
      )
      assert(
        send.length === 0 || (send.length === 1 && send[0].enabled === false),
        'A locked composer must have no active Send action'
      )
      return {
        surface: this.surface,
        tapped: true,
        keyboard: false,
        ime: ime.state,
        sendDisabled: true
      }
    }
    assert(this.surface === 'ios', 'Composer editability is proven on iOS')
    await this.device.tapOn({ id: 'chat-composer' })
    await new Promise(resolve => setTimeout(resolve, settle))
    const raw = await this.iosRaw()
    const keyboard = iosPublicRead(raw, {}, 'Keyboard').element
    const send = iosPublicRead(
      raw,
      { text: exactText('Send') },
      'Button'
    ).element
    assert(
      keyboard == null,
      'A tap on a locked composer must raise no keyboard'
    )
    assert(
      send == null || send.enabled === false,
      'A locked composer must have no active Send action'
    )
    return {
      surface: this.surface,
      tapped: true,
      keyboard: false,
      sendDisabled: true
    }
  }

  async assertEmptyDraft(): Promise<void> {
    if (this.surface !== 'ios') {
      assert.equal(await this.draft(), '')
      return
    }
    // Two tree reads and a raw screenshot of a long conversation.
    const signal = AbortSignal.timeout(300000)
    const inspect = async (): Promise<Args> => {
      const raw = await this.iosRaw(signal)
      const rawPath = join(
        this.runDir,
        'ios-empty-raw-' + Date.now() + '-' + randomUUID() + '.json'
      )
      writeFileSync(rawPath, raw, { mode: 0o600, flag: 'wx' })
      // Physical WebDriverAgent returns XML and can include hundreds of
      // history and keyboard nodes. Verify the field inside its composer and
      // independently query for controls that would invalidate an empty draft.
      const phoneXML =
        this.physical &&
        Buffer.from(raw).toString('utf8').trimStart().startsWith('<')
      const input = iosPublicRead(
        raw,
        {
          id: 'chat-composer',
          ...(phoneXML ? { childOf: { id: 'chat-composer-band' } } : {})
        },
        'TextView'
      )
      assert(
        phoneXML || input.nodes.length < 300,
        'Empty-state tree reached the pinned native snapshot cap; completeness is unavailable'
      )
      if (phoneXML) {
        for (const selector of [
          { id: '^chat-send$' },
          { id: '^chat-attachment-chip$' },
          { text: '^Cancel reply$' }
        ])
          await this.device.assertNotVisible({ ...selector, timeout: 3000 })
      }
      const node = need(
        input.element,
        'Fresh raw iOS editable composer required for empty UI'
      )
      const placeholder = emptyEditorPlaceholder(node)
      assert(
        node.enabled === true && placeholder != null,
        'Actual enabled composer and observed placeholder required'
      )
      assert(
        node.value == null || node.value === placeholder,
        'Composer still exposes a nonempty value'
      )
      assert(
        !input.nodes.some(isIosSendButton),
        'Empty composer must have no Send button'
      )
      assert(
        !input.nodes.some(
          n => n.id === 'chat-attachment-chip' || n.label === 'Cancel reply'
        ),
        'Empty UI cannot retain reply or attachment chips'
      )
      const band = need(
        iosPublicRead(raw, { id: 'chat-composer-band' }).element?.bounds,
        'Fresh whole composer band required'
      )
      const box = need(node.bounds, 'Fresh editable bounds required')
      assert(
        box.x >= band.x &&
          box.y >= band.y &&
          box.x + box.width <= band.x + band.width &&
          box.y + box.height <= band.y + band.height,
        'Actual empty composer must fit its whole band'
      )
      return {
        composer: box,
        band,
        sendVisible: false,
        placeholder,
        placeholderSource:
          node.placeholderValue === placeholder
            ? 'placeholderValue'
            : 'label plus placeholder',
        rawPath,
        rawSha256: createHash('sha256').update(raw).digest('hex')
      }
    }
    const before = await inspect()
    const path = join(this.runDir, 'ios-empty-composer-' + Date.now() + '.png')
    const api = this.device as unknown as {
      screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
    }
    const image = saveCapture(await api.screenshot({ signal }), path)
    const after = await inspect()
    for (const key of ['composer', 'band'])
      assert.deepEqual(
        before[key],
        after[key],
        'Empty UI geometry changed during capture'
      )
    this.steps.push({
      name: 'Actual native empty composer UI',
      before,
      after,
      image,
      whitespaceFidelity:
        'Native AX trims values; no exact whitespace-string claim',
      actualImageReviewRequired: true
    })
  }

  async recordTransition(
    path: string,
    work: () => Promise<void>,
    recorder: (command: string, args: string[]) => ChildProcess = (
      command,
      args
    ) => spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }),
    inspect: (path: string) => Args = path => {
      const result = spawnSync(
        process.env.CHAT2_FFPROBE ?? 'ffprobe',
        [
          '-v',
          'error',
          '-threads',
          '2',
          '-read_intervals',
          '%+1',
          '-count_frames',
          '-show_entries',
          'stream=codec_type,width,height,nb_read_frames:format=duration',
          '-of',
          'json',
          path
        ],
        { encoding: 'utf8', timeout: 15000 }
      )
      assert(
        result.status === 0,
        'Actual native movie must be readable by ffprobe'
      )
      const actual = object(JSON.parse(result.stdout))
      const streams = Array.isArray(actual.streams)
        ? actual.streams.map(object)
        : []
      assert(
        streams.some(
          stream =>
            stream.codec_type === 'video' &&
            Number(stream.width) > 0 &&
            Number(stream.height) > 0 &&
            Number(stream.nb_read_frames) > 0
        ),
        'Actual decoded video frames required'
      )
      assert(
        Number(object(actual.format).duration) > 0,
        'Actual positive video duration required'
      )
      return {
        ...actual,
        validation:
          'At most the first second decoded with two threads; complete original retained for transition review'
      }
    }
  ): Promise<void> {
    if (this.surface === 'android') {
      // maestro-d's Android startRecording runs screenrecord with its path on
      // the phone and never pulls the movie back, so a host path records
      // nothing: record on the phone, then pull it.
      const remote = '/sdcard/chat2-' + basename(path)
      await this.device.startRecording({ path: remote })
      try {
        await work()
      } finally {
        await this.device.stopRecording()
      }
      await this.androidPullRecording(remote, path)
      return
    }
    if (this.surface !== 'ios') {
      await this.device.startRecording({ path })
      try {
        await work()
      } finally {
        await this.device.stopRecording()
      }
      return
    }
    assert(
      resolve(dirname(path)) === resolve(this.runDir) &&
        !existsSync(path) &&
        path.endsWith('.mp4'),
      'New owned recording artifact required'
    )
    assert(
      this.deviceId === this.fixture.devices?.ios?.id,
      'Exact owned simulator binding required'
    )
    const args = [
      'simctl',
      'io',
      this.deviceId,
      'recordVideo',
      '--codec',
      'h264',
      path
    ]
    const child = recorder('/usr/bin/xcrun', args)
    const observation: Args = {
      name: 'Read-only owned iOS simulator recording observer',
      path,
      pid: child.pid,
      argv: ['/usr/bin/xcrun', ...args],
      startedAt: new Date().toISOString(),
      uiActions: 'Maestro TypeScript only',
      outcome: 'failed'
    }
    this.steps.push(observation)
    let workCompleted = false
    let stopRequested = false
    let exited = false
    let started = false
    let failure: Error | undefined
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let startResolve: () => void, startReject: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      startResolve = resolve
      startReject = reject
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096)
      if (!started && stderr.includes('Recording started')) {
        started = true
        startResolve()
      }
    })
    child.once('error', error => {
      failure = error
      startReject(error)
    })
    const closed = new Promise<void>(resolve =>
      child.once('close', (code, signal) => {
        exited = true
        exitCode = code
        exitSignal = signal
        if (started && !stopRequested)
          failure = new Error(
            'Recorder exited before the requested transition completed'
          )
        if (!started)
          startReject(
            new Error('Recorder exited before its first-frame acknowledgment')
          )
        resolve()
      })
    )
    const startLimit = setTimeout(() => {
      startReject(
        new Error('No first-frame recording acknowledgment within 10 seconds')
      )
    }, 10000)
    const limit = setTimeout(() => {
      failure = new Error('Owned recording exceeded 120 seconds')
      child.kill('SIGINT')
    }, 120000)
    try {
      await ready
      clearTimeout(startLimit)
      assert(
        !exited && failure == null,
        'Acknowledged recorder must still be running'
      )
      await work()
      workCompleted = true
    } catch (error) {
      observation.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      clearTimeout(startLimit)
      clearTimeout(limit)
      stopRequested = true
      if (!exited) child.kill('SIGINT')
      const wait = async (milliseconds: number): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const result = await Promise.race([
          closed.then(() => true),
          new Promise<boolean>(resolve => {
            timer = setTimeout(() => {
              resolve(false)
            }, milliseconds)
          })
        ])
        clearTimeout(timer)
        return result
      }
      if (!(await wait(15000))) {
        failure = new Error(
          'Owned recording did not finalize within 15 seconds'
        )
        child.kill('SIGKILL')
        assert(
          await wait(2000),
          'Owned recorder did not exit after bounded forced cleanup'
        )
      }
      observation.completedAt = new Date().toISOString()
      observation.exitCode = exitCode
      observation.exitSignal = exitSignal
      observation.stderrSha256 = createHash('sha256')
        .update(stderr)
        .digest('hex')
      assert(failure == null, failure?.message)
      assert(
        exited && exitCode === 0 && exitSignal == null,
        'Native recorder must finalize with a successful exit'
      )
      assert(
        existsSync(path) && statSync(path).size > 32,
        'Actual finalized native recording required'
      )
      observation.stream = inspect(path)
      observation.sha256 = digest(path)
      observation.outcome = workCompleted ? 'passed' : 'failed'
    }
  }

  async iosRead(
    selected: Args,
    expectedType?: string,
    signal = AbortSignal.timeout(30000)
  ): Promise<IosReadNode> {
    assert(
      this.surface === 'ios',
      'iOS read adapter requires its owned iOS session'
    )
    const api = this.device as unknown as {
      hierarchyRaw: (options: { signal: AbortSignal }) => Promise<Uint8Array>
      assertVisible: (
        args: Args,
        options: { signal: AbortSignal }
      ) => Promise<unknown>
    }
    const raw = await api.hierarchyRaw({ signal })
    const path = join(
      this.runDir,
      'ios-public-read-' + Date.now() + '-' + randomUUID() + '.json'
    )
    writeFileSync(path, raw, { mode: 0o600, flag: 'wx' })
    const read = iosPublicRead(raw, selected, expectedType)
    this.lastIosReadNodes = read.nodes
    this.steps.push({
      name: 'Passive iOS public element read',
      rawHierarchy: path,
      sha256: createHash('sha256').update(raw).digest('hex'),
      selector: selected,
      expectedType,
      foundInSnapshot: read.element != null
    })
    if (read.element != null) return read.element
    let query: Args
    let literal: string | undefined
    if (typeof selected.id === 'string' && selected.text == null)
      query = { id: selected.id }
    else {
      assert(
        typeof selected.text === 'string' &&
          selected.text.startsWith('^') &&
          selected.text.endsWith('$'),
        'Exact literal native text required for positive fallback'
      )
      literal = selected.text.slice(1, -1)
      assert(
        exactText(literal) === selected.text &&
          /^[\p{L}\p{N} ,_-]+$/u.test(literal),
        'Only actual plain exact text can use the supported deep query'
      )
      query = { text: literal }
    }
    assert(
      selected.childOf == null,
      'Missing scoped native element cannot use an unscoped fallback'
    )
    const element = object(
      object(await api.assertVisible({ ...query, timeout: 120 }, { signal }))
        .element
    )
    if (typeof selected.id === 'string')
      assert(
        exactIdAnswer(element, selected.id),
        'Exact returned native public identifier required'
      )
    else
      // The element query answers with the label as its text alone.
      assert(
        element.accessibilityLabel === literal ||
          (element.accessibilityLabel == null && element.text === literal),
        'Exact returned native public label required'
      )
    if (expectedType != null)
      assert(
        nativeClass(element.class) === expectedType,
        'Expected actual native element type required'
      )
    const b = need(
      bounds(element.bounds),
      'Actual returned native public bounds required'
    )
    assert(
      [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
        b.width > 0 &&
        b.height > 0,
      'Positive finite returned public bounds required'
    )
    return {
      index: -1,
      // An exact id lookup may answer with XCTest's element UUID.
      id:
        typeof selected.id === 'string' ? selected.id : (element.id as string),
      type: nativeClass(element.class),
      text: typeof element.text === 'string' ? element.text : undefined,
      label:
        typeof element.accessibilityLabel === 'string'
          ? element.accessibilityLabel
          : undefined,
      bounds: b,
      enabled:
        typeof element.enabled === 'boolean' ? element.enabled : undefined
    }
  }

  async observedBounds(selected: Args, expectedType?: string): Promise<Bounds> {
    if (this.surface === 'ios')
      return need(
        (await this.iosRead(selected, expectedType)).bounds,
        'Observed iOS public bounds required'
      )
    const id = typeof selected.id === 'string' ? selected.id : undefined
    const child = object(selected.childOf)
    if (this.surface === 'android' && selected.childOf != null) {
      const proof: Args = {
        name: 'Passive scoped Android bounds',
        selector: selected,
        expectedType,
        observedAt: new Date().toISOString(),
        outcome: 'failed'
      }
      this.steps.push(proof)
      try {
        const hierarchy = await this.device.hierarchy()
        const path = join(
          this.runDir,
          'android-scoped-read-' + Date.now() + '-' + randomUUID() + '.json'
        )
        privateJson(path, hierarchy)
        proof.hierarchy = path
        proof.hierarchySha256 = digest(path)
        proof.bounds = androidScopedBounds(hierarchy, selected, expectedType)
        proof.outcome = 'passed'
        return proof.bounds as Bounds
      } catch (error) {
        proof.error = error instanceof Error ? error.message : String(error)
        throw error
      }
    }
    if (!this.native) {
      const text = typeof selected.text === 'string' ? selected.text : undefined
      assert(
        id != null || text != null,
        'Public identifier or text selector required'
      )
      assert(
        selected.childOf == null || typeof child.id === 'string',
        'Public parent identifier required'
      )
      const pattern = text == null ? undefined : new RegExp(text)
      const nodes = await this.nodes(
        typeof child.id === 'string' ? child.id : undefined
      )
      return need(
        nodes.find(node =>
          id != null ? node.id === id : pattern!.test(node.text ?? '')
        )?.bounds,
        'Measured public DOM element bounds required'
      )
    }
    const found =
      id != null && selected.childOf == null
        ? (await this.nodes()).find(
            node => node.id === id && node.bounds != null
          )?.bounds
        : undefined
    if (found != null) return found
    const copied = await this.device.copyTextFrom(selected)
    await this.closeAndroidClipboardOverlay()
    return need(
      copied.element?.bounds,
      'Measured public element bounds required'
    )
  }

  async publicBounds(id: string): Promise<Bounds> {
    return await this.observedBounds({ id })
  }

  async publicText(id: string): Promise<string> {
    if (!this.native) {
      const result = await this.dom(
        'const n=document.querySelector(' +
          JSON.stringify('[data-testid="' + id + '"]') +
          ');return {text:n?.textContent ?? n?.getAttribute("aria-label")}'
      )
      assert(typeof result.text === 'string', 'Public text required: ' + id)
      return result.text
    }
    if (this.surface === 'ios') {
      const text = (await this.iosRead({ id })).text
      assert(
        typeof text === 'string' && text !== '',
        'Positive observed iOS public text required'
      )
      return text
    }
    // The driver's copyTextFrom writes the device clipboard, and Android 13+
    // answers each write with a copied-text overlay over the app; the text
    // is read from the passive hierarchy instead.
    const found = (await this.nodes()).filter(
      node => node.id === id && typeof node.text === 'string'
    )
    assert(
      found.length === 1 && found[0].text !== '',
      'Native public text required: ' + id
    )
    return found[0].text!
  }

  /**
   * Android 13+ shows a copied-text overlay (preview, Share, Send to nearby
   * device) after each clipboard write, including the driver's own
   * copyTextFrom; it covers the lower screen until dismissed. Close it with
   * its own Dismiss control.
   */
  async closeAndroidClipboardOverlay(): Promise<boolean> {
    if (this.surface !== 'android') return false
    const dismiss = (await this.nodes()).find(
      node =>
        node.id === 'com.android.systemui:id/dismiss_button' &&
        node.bounds != null
    )
    if (dismiss == null) return false
    await this.tapObserved(dismiss)
    this.steps.push({
      name: 'Android copied-text overlay dismissed',
      outcome: 'passed'
    })
    return true
  }

  async resize(width: number, height: number): Promise<void> {
    assert(
      !this.native && this.cdp != null,
      'Only owned browser environment may resize'
    )
    const expected = { ...this.metrics(), width, height }
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: expected.dpr,
      mobile: expected.coarse
    })
    // A virtualized chat history relays out every mounted row for a new
    // width; the page can take seconds to answer its first read.
    const budget = 10000
    const end = Date.now() + budget
    const signal = AbortSignal.any([this.deadline, AbortSignal.timeout(budget)])
    let actual: Args = {}
    let matches = false
    for (;;) {
      actual = await this.dom(
        'return {width:innerWidth,height:innerHeight,coarse:matchMedia("(pointer:coarse)").matches,dpr:devicePixelRatio,scale:visualViewport?.scale ?? 1}',
        signal
      )
      matches =
        actual.width === width &&
        actual.height === height &&
        actual.coarse === expected.coarse &&
        actual.dpr === expected.dpr &&
        actual.scale === 1
      if (matches || Date.now() >= end) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    this.steps.push({
      name: 'Resized viewport and pointer measurements',
      outcome: matches ? 'passed' : 'failed',
      expected,
      actual: {
        width: actual.width,
        height: actual.height,
        coarse: actual.coarse,
        dpr: actual.dpr,
        scale: actual.scale
      }
    })
    assert(matches, 'Actual resized viewport/pointer/pixel scale differs')
    this.webFrame = expected
    this.webZoom = undefined
  }

  /** OS Settings UI is an explicit observed private recipe, driven only by Maestro. */
  /**
   * Back from the OS Settings app to the QA app. A physical iPhone animates the
   * switch through the app switcher, and a read in the meantime sees Settings
   * (or times out); Android's launch restarts the app on its Home tab. Either
   * way the app's own screen must be up first: a chat element, or the tab
   * bar's Chat item that every main screen shows.
   */
  async returnFromSettings(): Promise<void> {
    await this.device.launchApp({
      appId: this.fixture.appId,
      ...(this.surface === 'ios'
        ? { environment: { TS_DECLARED_AGE_LOWER: '18' } }
        : {})
    })
    await until(
      async () => {
        // Element lookups, not whole-tree reads: an iPhone's tree of a long
        // conversation can outlast its read. A lookup during the switch can
        // time out; the next one decides.
        try {
          if (await this.visible({ id: 'chat-.*' }, 2000)) return true
          return (await this.visible({ text: 'Chat' }, 1000)) ? true : undefined
        } catch {
          return undefined
        }
      },
      'QA app back in front after Settings',
      60000
    )
    // A relaunched app is still becoming active when its first element shows,
    // and a link sent then can lose its confirmation: wait until two reads a
    // second apart see the same screen.
    let previous = ''
    await until(
      async () => {
        const screen = JSON.stringify(
          (await this.nodes()).map(node => [node.id, node.text])
        )
        const still = screen === previous
        previous = screen
        if (still) return true
        await new Promise(resolve => setTimeout(resolve, 1000))
        return undefined
      },
      'QA app settled after Settings',
      30000
    )
    this.steps.push({
      name: 'QA app back in front after Settings',
      outcome: 'passed'
    })
  }

  private async settingsActions(
    actions: NonNullable<Chat2Fixture['variants']>[string]['set']
  ): Promise<void> {
    for (const action of actions) {
      assert(
        [
          'launchApp',
          'stopApp',
          'tapOn',
          'dragAndDrop',
          'scrollUntilVisible',
          'back',
          'pressKey',
          'setDarkMode'
        ].includes(action.command),
        'Unsupported Settings recipe command'
      )
      // A phone's Settings resumes where it was left; only Settings is
      // stopped, so a recipe starts from its root page.
      if (action.command === 'stopApp')
        assert(
          ['com.apple.Preferences', 'com.android.settings'].includes(
            String(action.args.appId)
          ),
          'Settings recipe may stop only OS Settings'
        )
      if (action.command === 'launchApp')
        assert(
          [
            this.fixture.appId,
            'com.apple.Preferences',
            'com.android.settings'
          ].includes(String(action.args.appId)),
          'Settings recipe may launch only own app or OS Settings'
        )
      if (
        this.surface === 'ios' &&
        action.command === 'tapOn' &&
        typeof action.args.id === 'string'
      )
        await this.settingsSettled(action.args.id)
      const command =
        this.device[
          action.command as
            | 'launchApp'
            | 'stopApp'
            | 'dragAndDrop'
            | 'tapOn'
            | 'scrollUntilVisible'
            | 'back'
            | 'pressKey'
            | 'setDarkMode'
        ]
      await command.call(this.device, action.args)
    }
  }

  /**
   * Waits until a Settings row holds still. A fresh simulator's Settings
   * inserts its "Optimizing Search and Siri" row after launch, moving every
   * row below it: a tap aimed at Appearance then opens Accessibility.
   */
  private async settingsSettled(id: string): Promise<void> {
    const device = this.device as unknown as {
      hierarchyRaw: (options: { signal: AbortSignal }) => Promise<Uint8Array>
    }
    const frame = async (): Promise<string | undefined> => {
      const tree = iosRawTree(
        await device.hierarchyRaw({ signal: AbortSignal.timeout(10000) })
      )
      const found = tree.nodes.filter(
        (n: unknown) =>
          n != null && typeof n === 'object' && (n as Args).identifier === id
      ) as Args[]
      // A row's cell and its button can carry the same identifier.
      return found.length > 0
        ? JSON.stringify(found.map(node => node.rect))
        : undefined
    }
    const reads: Array<string | undefined> = []
    const deadline = Date.now() + 10000
    let previous = await frame()
    reads.push(previous)
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const current = await frame()
      reads.push(current)
      if (current != null && current === previous) break
      assert(Date.now() < deadline, 'Settled Settings row required: ' + id)
      previous = current
    }
    this.steps.push({
      name: 'Settings row held still before its tap',
      id,
      reads: reads.length,
      outcome: 'passed'
    })
  }

  /** Raw-value predicates observe state; they do not use selector fallbacks. */
  private async settingsVerify(
    checks: NonNullable<Chat2Fixture['variants']>[string]['verify']
  ): Promise<void> {
    for (const check of checks) {
      if (check.rawValue == null) {
        assert(
          this.surface !== 'ios' || check.checked == null,
          'iOS checked-only state proof is unsupported'
        )
        await this.device.assertVisible({ ...check, timeout: 5000 })
        continue
      }
      assert(this.surface === 'ios', 'Observed raw-value contract is iOS-only')
      assert(
        check.id == null &&
          check.text == null &&
          check.checked == null &&
          check.selected == null,
        'Raw state predicate cannot mix selector state claims'
      )
      const device = this.device as unknown as {
        hierarchyRaw: (options: { signal: AbortSignal }) => Promise<Uint8Array>
        screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
      }
      const evidence: Args = {
        name: 'Observed native raw value',
        source: this.binding.source,
        deviceId: this.deviceId,
        daemonName: this.daemonName,
        expected: check.rawValue,
        outcome: 'failed'
      }
      this.steps.push(evidence)
      // A Settings page can show its stored state a moment after it opens:
      // the predicate is read again, each hierarchy kept, until it holds or
      // the deadline passes with its last mismatch. No error is inverted.
      const reads: Args[] = []
      evidence.reads = reads
      const deadline = Date.now() + 8000
      for (;;) {
        const raw = await device.hierarchyRaw({
          signal: AbortSignal.timeout(10000)
        })
        const file = join(
          this.runDir,
          'native-setting-' + randomUUID() + '.raw-hierarchy.json'
        )
        writeFileSync(file, raw, { flag: 'wx', mode: 0o600 })
        Object.assign(evidence, {
          rawPath: file,
          rawSha256: digest(file),
          observedAt: new Date().toISOString()
        })
        reads.push({ rawPath: file, observedAt: evidence.observedAt })
        try {
          evidence.actual = observedNativeValue(raw, check.rawValue)
          break
        } catch (error) {
          if (Date.now() >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
      evidence.image = saveCapture(
        await device.screenshot({ signal: AbortSignal.timeout(10000) }),
        String(evidence.rawPath) + '.png'
      )
      evidence.outcome = 'passed'
    }
  }

  /**
   * The lowest message body wholly on the screen, by its own id; undefined
   * when none is.
   */
  async visibleMessageBody(): Promise<
    { id: string; bounds: Bounds } | undefined
  > {
    const screen = await this.device.platformInfo()
    const height = Number(screen.screenHeight)
    const bodies = (await this.nodes()).filter(
      (node): node is PublicNode & { id: string; bounds: Bounds } =>
        node.id?.startsWith('chat-message-body-') === true &&
        node.bounds != null &&
        node.bounds.height > 0 &&
        node.bounds.y >= 0 &&
        node.bounds.y + node.bounds.height <= height
    )
    const lowest = bodies.sort((a, b) => b.bounds.y - a.bounds.y)[0]
    return lowest == null ? undefined : { id: lowest.id, bounds: lowest.bounds }
  }

  async variant(
    name: string,
    sweep: () => Promise<void>,
    // A font-scale change can relaunch the app on Home (Android always, an
    // iPhone when it ended the app behind Settings): the scenario returns to
    // its chat before the growth is measured.
    resume?: () => Promise<void>
  ): Promise<void> {
    assert(
      [
        'light',
        'dark',
        'large-text',
        'reduced-motion',
        'reduced-transparency'
      ].includes(name),
      'Unknown accessibility variant'
    )
    const row: Args = {
      name,
      startedAt: new Date().toISOString(),
      platform: this.surface
    }
    const recipe = this.fixture.variants?.[this.surface + ':' + name]
    let browserZoomAttempted = false
    const nativeTextBefore = this.native
      ? await this.publicBounds('chat-composer')
      : undefined
    // A one-line composer keeps its minimum height under a modest text size;
    // a message body wholly on screen shows the same setting by its own
    // line boxes, read again by its id afterwards.
    const nativeBodyBefore =
      this.native && name === 'large-text'
        ? await this.visibleMessageBody()
        : undefined
    const before = this.native
      ? undefined
      : await this.dom(
          'const n=document.querySelector(\'[data-testid="chat-composer"]\');return {font:n?parseFloat(getComputedStyle(n).fontSize):0,height:n?.getBoundingClientRect().height,scale:visualViewport?.scale??1,dpr:devicePixelRatio,viewportWidth:visualViewport?.width??innerWidth}'
        )
    try {
      if (this.native) {
        if (this.surface === 'android' && name === 'reduced-transparency') {
          assert(
            recipe?.applicability === 'not-applicable' &&
              (recipe.reason?.length ?? 0) > 20,
            'Explicit Android platform-applicability rationale required'
          )
          row.applicability = 'not-applicable'
          row.reason = recipe.reason
          row.environment =
            'No Android OS reduced-transparency preference; inspect actual native fallback composition'
        } else if (name === 'light' || name === 'dark') {
          assert(
            recipe?.applicability === 'applicable' &&
              recipe.restore.length > 0 &&
              recipe.verify.length > 0 &&
              recipe.restoreVerify.length > 0,
            'Native appearance requires observed restoration recipe'
          )
          // A physical iPhone has no driver-level appearance switch: its
          // observed Display & Brightness recipe sets it instead.
          if (!(this.surface === 'ios' && this.physical))
            try {
              await this.device.setDarkMode({ enabled: name === 'dark' })
            } catch (error) {
              // The simulator runner can time out its main thread while the
              // device is busy; setting one appearance again is idempotent.
              if (
                !(
                  error instanceof Error ? error.message : String(error)
                ).includes('main thread execution timed out')
              )
                throw error
              row.appearanceSetRetried = true
              await this.device.setDarkMode({ enabled: name === 'dark' })
            }
          await this.settingsActions(recipe.set)
          await this.settingsVerify(recipe.verify)
          await this.returnFromSettings()
          row.environment = {
            method:
              this.surface === 'ios' && this.physical
                ? 'Observed Display & Brightness recipe'
                : 'Maestro setDarkMode',
            requested: name,
            observed: await this.device.platformInfo()
          }
        } else {
          const actual = need(
            recipe,
            'Observed native OS Settings recipe required for ' + name
          )
          assert(
            actual.applicability === 'applicable' &&
              actual.verify.length > 0 &&
              actual.restoreVerify.length > 0,
            'Native variant requires applied and restored setting observations'
          )
          await this.settingsActions(actual.set)
          await this.settingsVerify(actual.verify)
          row.environment = {
            method: 'Observed OS Settings via Maestro',
            selectors: actual.verify
          }
          await this.returnFromSettings()
        }
      } else {
        const features = [
          {
            name: 'prefers-color-scheme',
            value: name === 'dark' ? 'dark' : 'light'
          },
          {
            name: 'prefers-reduced-motion',
            value: name === 'reduced-motion' ? 'reduce' : 'no-preference'
          },
          {
            name: 'prefers-reduced-transparency',
            value: name === 'reduced-transparency' ? 'reduce' : 'no-preference'
          }
        ]
        await need(this.cdp, 'Owned CDP environment required').send(
          'Emulation.setEmulatedMedia',
          { features }
        )
        await need(this.cdp, 'Owned CDP environment required').send(
          'Emulation.setEmulatedOSTextScale',
          { scale: name === 'large-text' ? 1.5 : 1 }
        )
        const observe = async (): Promise<Args> =>
          await this.dom(
            'const n=document.querySelector(\'[data-testid="chat-composer"]\');return {dark:matchMedia("(prefers-color-scheme:dark)").matches,motion:matchMedia("(prefers-reduced-motion:reduce)").matches,transparency:matchMedia("(prefers-reduced-transparency:reduce)").matches,font:n?parseFloat(getComputedStyle(n).fontSize):0,height:n?.getBoundingClientRect().height,scale:visualViewport?.scale??1,dpr:devicePixelRatio,viewportWidth:visualViewport?.width??innerWidth}'
          )
        let actual = await observe()
        assert(
          actual.dark === (name === 'dark') &&
            actual.motion === (name === 'reduced-motion') &&
            actual.transparency === (name === 'reduced-transparency'),
          'Actual browser media preferences differ'
        )
        if (name === 'large-text') {
          if (!(
            Number(actual.font) > Number(before?.font) ||
            Number(actual.height) > Number(before?.height)
          )) {
            browserZoomAttempted = true
            await this.device.pressKey({ key: 'Cmd+=' })
            await this.device.pressKey({ key: 'Cmd+=' })
            actual = await observe()
            const pixelFont = (value: Args | undefined): number =>
              Number(value?.font) * Number(value?.scale) * Number(value?.dpr)
            if (pixelFont(actual) <= pixelFont(before)) {
              await this.cdp?.send('Emulation.setPageScaleFactor', {
                pageScaleFactor: 1.5
              })
              actual = await observe()
              row.textScaleMethod =
                'Actual browser viewport zoom; OS text scale alone had no app effect'
            } else
              row.textScaleMethod =
                'Observed ordinary browser zoom through Maestro keyboard'
          } else
            row.textScaleMethod =
              'Observed OS text-scale glyph or line-box growth'
          assert(
            Number(actual.font) > Number(before?.font) ||
              Number(actual.height) > Number(before?.height) ||
              Number(actual.font) * Number(actual.scale) * Number(actual.dpr) >
                Number(before?.font) *
                  Number(before?.scale) *
                  Number(before?.dpr),
            'Browser accessibility setting must enlarge actual glyph/line-box or observed viewport pixel scale'
          )
          row.textGrowth = { before, after: actual }
          this.webZoom = await this.captureViewport()
          row.captureGeometry = this.webZoom
        }
        row.environment = actual
      }
      if (this.native && name === 'large-text') {
        // A text-size change can relaunch the app on Home: Android always,
        // iOS when it ended the app while Settings was in front.
        if (
          resume != null &&
          !(await this.visible({ id: exactText('chat-composer') }, 2000))
        ) {
          row.resumedAfterSettings = true
          await resume()
        }
        const after = await this.publicBounds('chat-composer')
        const bodyAfter =
          nativeBodyBefore == null
            ? undefined
            : (await this.nodes()).find(
                node => node.id === nativeBodyBefore.id && node.bounds != null
              )?.bounds
        // Kept before the judgment, so a refusal shows what was measured.
        row.textGrowth = {
          before: nativeTextBefore,
          after,
          body:
            nativeBodyBefore == null
              ? undefined
              : {
                  id: nativeBodyBefore.id,
                  before: nativeBodyBefore.bounds,
                  after: bodyAfter
                }
        }
        assert(
          after.height > Number(nativeTextBefore?.height) ||
            (bodyAfter != null &&
              nativeBodyBefore != null &&
              bodyAfter.height > nativeBodyBefore.bounds.height),
          'Native OS large text must enlarge actual composer or message line-boxes'
        )
      }
      if (name === 'dark') {
        row.applicability = 'not-applicable'
        row.reason =
          'App has no public dark-theme selector; default ThemeProvider uses tsBallpark. OS-dark is applied and its actual light fallback is reviewed. Mounted tsDark component coverage is separate.'
        row.osPreferenceApplied = true
      }
      await sweep()
      row.outcome = 'passed'
    } finally {
      if (this.native) {
        if (recipe?.applicability === 'applicable') {
          await this.settingsActions(recipe.restore)
          await this.settingsVerify(recipe.restoreVerify)
          await this.returnFromSettings()
        }
      } else {
        if (browserZoomAttempted) await this.device.pressKey({ key: 'Cmd+0' })
        await this.cdp?.send('Emulation.setPageScaleFactor', {
          pageScaleFactor: 1
        })
        await this.cdp?.send('Emulation.setEmulatedMedia', { features: [] })
        await this.cdp?.send('Emulation.setEmulatedOSTextScale', { scale: 1 })
        this.webZoom = undefined
      }
      row.restoredAt = new Date().toISOString()
      this.steps.push({ ...row, variant: name, name: 'Accessibility variant' })
    }
  }

  async step(name: string, run: () => Promise<void>): Promise<void> {
    const row: Args = { name, startedAt: new Date().toISOString() }
    this.steps.push(row)
    try {
      await run()
      row.outcome = 'passed'
    } catch (error) {
      row.outcome = error instanceof Chat2Blocked ? 'blocked' : 'failed'
      row.error = redact(this.fixture, String(error))
      // Where it was raised: a bare assertion's message names no check.
      if (error instanceof Error && typeof error.stack === 'string')
        row.stack = redact(
          this.fixture,
          error.stack.split('\n').slice(1, 9).join('\n')
        )
      throw error
    } finally {
      row.finishedAt = new Date().toISOString()
    }
  }

  async nodes(
    parentId?: string,
    signal = this.deadline
  ): Promise<PublicNode[]> {
    if (this.native) {
      const nodes = flattenPublicHierarchy(
        await this.device.hierarchy({ signal })
      )
      return this.surface === 'ios' && !this.physical
        ? await this.withChrome(nodes)
        : nodes
    }
    const result = await this.dom(
      'return {nodes:(' +
        publicWebNodes.toString() +
        ')(' +
        JSON.stringify(parentId) +
        ')}'
    )
    assert(Array.isArray(result.nodes), 'Observed public DOM nodes required')
    return result.nodes as PublicNode[]
  }

  /**
   * The iOS simulator driver's snapshot stops at a node cap, and a long
   * history can fill it before the screen's fixed chrome. Chrome that a full
   * snapshot left out is measured by its own element lookup.
   */
  private async withChrome(nodes: PublicNode[]): Promise<PublicNode[]> {
    if (nodes.length < IOS_SIMULATOR_SNAPSHOT_CAP) return nodes
    const measured: PublicNode[] = []
    // Each id is unique and carries no pattern characters, so the driver
    // resolves it with an element query rather than the capped snapshot.
    // A search adds the row it is looking for; the query finds it only while
    // it is on the screen.
    const chrome = [
      'chat-message-history',
      'chat-conversation-identity',
      'chat-composer-band',
      'chat-pinned-band'
    ]
    for (const id of [...chrome, ...(this.sought ?? [])])
      if (!nodes.some(node => node.id === id)) {
        // A sought row is often off the screen: one snapshot pass and one
        // element query answer for it.
        const queried = await this.iosQueried(
          id,
          chrome.includes(id) ? 3000 : 1
        )
        if (queried != null) measured.push(queried)
      }
    return measured.length === 0 ? nodes : [...nodes, ...measured]
  }

  /** Reads `id` past the snapshot cap until the returned release is called. */
  seek(id: string): () => void {
    const sought = (this.sought ??= new Set())
    sought.add(id)
    return () => {
      sought.delete(id)
    }
  }

  /**
   * One id the iOS simulator's capped snapshot left out, from the driver's
   * element query; undefined when it is not on the screen.
   */
  async iosQueried(
    id: string,
    timeout = 3000
  ): Promise<IosReadNode | undefined> {
    let element: Args
    try {
      element = object(
        object(await this.device.assertVisible({ id, timeout })).element
      )
    } catch {
      return undefined
    }
    // A substring hit in the snapshot is another element.
    if (!exactIdAnswer(element, id)) return undefined
    const box = bounds(element.bounds)
    if (box == null) return undefined
    const label =
      typeof element.accessibilityLabel === 'string' &&
      element.accessibilityLabel !== ''
        ? element.accessibilityLabel
        : typeof element.text === 'string'
          ? element.text
          : undefined
    const kind =
      typeof element.class === 'string'
        ? element.class.replace(/^XCUIElementType/, '')
        : undefined
    const attributes =
      element.attributes != null && typeof element.attributes === 'object'
        ? (element.attributes as Record<string, unknown>)
        : {}
    const value =
      typeof attributes.value === 'string'
        ? attributes.value
        : typeof element.text === 'string'
          ? element.text
          : undefined
    return {
      index: -1,
      id,
      type: kind == null ? undefined : kind[0].toUpperCase() + kind.slice(1),
      label,
      value,
      text: label,
      bounds: box,
      enabled:
        typeof element.enabled === 'boolean' ? element.enabled : undefined
    }
  }

  async dom(script: string, signal = this.deadline): Promise<Args> {
    assert(
      !this.native,
      'Browser DOM inspection cannot inspect native/private app state'
    )
    const result = await this.device.evalBrowserScript(
      {
        script: 'return JSON.stringify(await(async()=>{' + script + '})())'
      },
      { signal }
    )
    return typeof result.data === 'string'
      ? object(JSON.parse(result.data))
      : object(result.data)
  }

  async visible(selector: Args, timeout = 1000): Promise<boolean> {
    try {
      await this.device.assertVisible({ ...selector, timeout })
      return true
    } catch (error) {
      if (code(error) !== 'COMMAND_FAILED') throw error
      return false
    }
  }

  async text(text: string): Promise<void> {
    await this.device.tapOn({ text: exactText(text) })
  }

  async id(id: string): Promise<void> {
    await this.device.tapOn({ id })
  }

  async present(id: string): Promise<void> {
    // An iOS tree of thousands of nodes can outlast 15 s on a loaded host
    // while a screen is still arriving (E9's return to the chat).
    await this.device.assertVisible({
      id,
      timeout: this.surface === 'ios' ? 45000 : 15000
    })
  }

  /**
   * Entering messaging asks about notifications once per person per device:
   * answered Not Now if it comes up, as nothing here is about it.
   */
  async notNow(): Promise<void> {
    await dismissNotificationAskOn(this.device)
  }

  async absent(id: string): Promise<void> {
    // One iOS hierarchy read takes seconds, so 3 s can be a single look taken
    // while an overlay is still animating out. The native drivers match an id
    // as a pattern, so `chat-composer` would find `chat-composer-band`; anchor
    // the id.
    await this.device.assertNotVisible({
      id: this.native ? exactText(id) : id,
      timeout: this.surface === 'ios' ? 15000 : 3000
    })
  }

  async open(path: string): Promise<void> {
    assert(
      path.startsWith('/chat') ||
        (this.scenario === 'I3' && path === '/dev/chat-bench'),
      'Only fixture chat routes or the exact I3 bench route may be opened'
    )
    if (!this.native) {
      await this.dom(
        'history.pushState(null,"",' +
          JSON.stringify(path) +
          ');dispatchEvent(new PopStateEvent("popstate"));return {publicHistoryNavigation:true,path:location.pathname}'
      )
      return
    }
    await this.openNativeLink(path)
    // A link sent while a just-relaunched app is still starting can be
    // dropped; the app then stays on Home. Send it once more, recorded. A
    // slow start routes the first link late, and a second one would open the
    // conversation again, so the resend waits well past a slow start.
    const routed =
      path === '/chat'
        ? { id: 'chat-conversation-list' }
        : path === '/dev/chat-bench'
          ? { text: exactText('Chat crypto bench') }
          : { id: 'chat-message-history' }
    if (
      (path === '/chat' ||
        path === '/dev/chat-bench' ||
        /^\/chat\/cnv_[^/]+$/.test(path)) &&
      !(await this.visible(routed, 45000))
    ) {
      // The screen the first link left, for a resend that also fails.
      const unrouted = join(
        this.runDir,
        `unrouted-link-${this.steps.length}.png`
      )
      const evidence = await this.captureImage(unrouted).then(
        () => unrouted,
        () => undefined
      )
      this.steps.push({
        name: 'Native chat link resent after an unrouted first delivery',
        path,
        evidence,
        outcome: 'passed'
      })
      await this.openNativeLink(path)
      // A simulator asks before every link, and the link a running app
      // accepts that way can be lost; one that starts the app arrives as its
      // launch address. The start keeps the launch setting returnFromSettings
      // passes, through the simulator's own launch environment.
      if (
        this.surface === 'ios' &&
        !this.physical &&
        !(await this.visible(routed, 45000))
      ) {
        const simctl = (...args: string[]): number | null =>
          spawnSync('xcrun', ['simctl', ...args], {
            encoding: 'utf8',
            timeout: 60000
          }).status
        assert(
          simctl(
            'spawn',
            this.deviceId,
            'launchctl',
            'setenv',
            'TS_DECLARED_AGE_LOWER',
            '18'
          ) === 0,
          'QA app launch setting for its link failed'
        )
        // Not running already is as good as stopped.
        simctl('terminate', this.deviceId, this.fixture.appId)
        this.steps.push({
          name: 'iOS simulator app started by its unrouted link',
          path,
          outcome: 'passed'
        })
        await this.openNativeLink(path)
      }
    }
  }

  private async openNativeLink(path: string): Promise<void> {
    if (this.physical) {
      // A phone may also hold the store TeamStation, which claims the same
      // scheme; deliver the link to the QA app by its own identifier.
      const link = this.fixture.scheme + ':/' + path
      const result =
        this.surface === 'ios'
          ? spawnSync(
              'xcrun',
              [
                'devicectl',
                'device',
                'process',
                'launch',
                '--device',
                this.deviceId,
                '--payload-url',
                link,
                this.fixture.appId
              ],
              { encoding: 'utf8', timeout: 60000 }
            )
          : spawnSync(
              process.env.CHAT2_ADB ?? 'adb',
              [
                '-s',
                this.deviceId,
                'shell',
                'am',
                'start',
                '-W',
                '-a',
                'android.intent.action.VIEW',
                '-d',
                link,
                '-p',
                this.fixture.appId
              ],
              { encoding: 'utf8', timeout: 60000 }
            )
      assert(result.status === 0, 'QA app link delivery failed')
      return
    }
    await this.device.openLink({
      link: this.native
        ? this.fixture.scheme + ':/' + path
        : this.fixture.webUrl.replace(/\/$/, '') + path
    })
    if (this.surface === 'ios') {
      const asking = (nodes: PublicNode[]): boolean =>
        nodes.some(n => /Open in .TeamStation/.test(n.text ?? ''))
      for (let i = 0; i < 10; i++) {
        const nodes = await this.nodes()
        if (asking(nodes)) {
          // A just-relaunched app becoming active can withdraw the
          // confirmation between two reads; tap its button only while a
          // fresh read still shows it, or the tap lands on the screen behind.
          const current = await this.nodes()
          if (!asking(current)) {
            this.steps.push({
              name: 'iOS link confirmation withdrawn before its tap',
              path,
              poll: i,
              outcome: 'passed'
            })
            break
          }
          const open = need(
            current.find(n => n.text === 'Open' && n.bounds != null),
            'Observed native Open alert button required'
          )
          await this.tapObserved(open)
          // What the accepted link opened, beside the button's point.
          const after = join(
            this.runDir,
            `link-alert-accepted-${this.steps.length}.png`
          )
          this.steps.push({
            name: 'iOS link confirmation accepted',
            path,
            poll: i,
            button: open.bounds,
            evidence: await this.captureImage(after).then(
              () => after,
              () => undefined
            ),
            outcome: 'passed'
          })
          break
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
  }

  async tapObserved(node: PublicNode): Promise<void> {
    const b = need(node.bounds, 'Observed public element bounds required')
    await this.device.tapOnPoint(
      {
        x: Math.round(b.x + b.width / 2),
        y: Math.round(b.y + b.height / 2)
      },
      { signal: AbortSignal.timeout(15000) }
    )
  }

  async hideKeyboard(): Promise<void> {
    if (this.surface !== 'ios') {
      await this.device.hideKeyboard()
      return
    }
    await dismissIosChatKeyboard(this)
  }

  /** Save the actual native snapshot before validating any Android capture metadata. */
  async androidHierarchy(
    signal: AbortSignal
  ): Promise<{ raw: unknown; evidence: Args }> {
    signal = AbortSignal.any([this.deadline, signal])
    signal.throwIfAborted()
    assert(
      this.surface === 'android' &&
        this.native &&
        this.deviceId !== '' &&
        this.fixture.devices.android.owned &&
        this.deviceId === this.fixture.devices.android.id,
      'Exact owned Android required for capture observation'
    )
    const raw = await this.device.hierarchy({ signal })
    const path = join(
      this.runDir,
      'android-capture-hierarchy-' + randomUUID() + '.json'
    )
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600, flag: 'wx' })
    const evidence = {
      path,
      sha256: digest(path),
      observedAt: new Date().toISOString(),
      source: this.binding.source
    }
    this.steps.push({ name: 'Fresh Android capture hierarchy', ...evidence })
    signal.throwIfAborted()
    return { raw, evidence }
  }

  async androidComposerControl(
    label: string,
    signal: AbortSignal
  ): Promise<Bounds> {
    signal = AbortSignal.any([this.deadline, signal])
    const proof: Args = {
      name: 'Actual Android composer control visibility',
      label,
      outcome: 'failed'
    }
    this.steps.push(proof)
    try {
      const { raw, evidence } = await this.androidHierarchy(signal)
      proof.rawHierarchy = evidence
      const screen = await this.device.platformInfo({ signal })
      signal.throwIfAborted()
      const viewport = {
        width: Number(screen.screenWidth),
        height: Number(screen.screenHeight)
      }
      proof.viewport = viewport
      const node = androidComposerControl(raw, label, viewport)
      proof.node = node
      proof.outcome = 'passed'
      return bounds(node.bounds)!
    } catch (error) {
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /** Passive state settlement precedes exactly one ordinary hide; functional hides are unchanged. */
  async hideKeyboardForCapture(expectedText?: string): Promise<void> {
    if (this.surface !== 'android') {
      await this.hideKeyboard()
      return
    }
    assert(
      this.scenario === 'capture',
      'Capture-only Android dismissal required'
    )
    this.androidClosedCapture = undefined
    const end = Date.now() + 90000
    const signal = AbortSignal.any([this.deadline, AbortSignal.timeout(90000)])
    const initial = await this.observeAndroidIme(
      { signal, timeoutMs: Math.min(5000, end - Date.now()) },
      'state'
    )
    const first = await this.androidHierarchy(signal)
    const original = androidDismissReference(
      first.raw,
      need(initial.state, 'Actual initial IME state required'),
      initial.viewport,
      expectedText
    )
    let before = await this.verifyAndroidClosedCapture(original, end, true)
    if (before.initialState === 'open') {
      const positive = await readAndroidComposerKeyboard(
        this,
        signal,
        Math.max(1, Math.min(10000, end - Date.now()))
      )
      const fresh = await this.androidHierarchy(signal)
      const measured = androidDismissReference(
        fresh.raw,
        { state: 'open', flags: {}, keyboard: positive.geometry.keyboard },
        initial.viewport,
        before.text
      )
      for (const key of ['history', 'text', 'reply', 'chips'] as const)
        assert(
          JSON.stringify(before[key]) === JSON.stringify(measured[key]),
          'Actual pre-hide context changed: ' + key
        )
      before = measured
      this.steps.push({
        name: 'Fresh focused Android capture composer before hide',
        geometry: positive.geometry
      })
    }
    signal.throwIfAborted()
    await this.device.hideKeyboard(undefined, { signal })
    signal.throwIfAborted()
    assert(Date.now() < end, 'Android capture dismissal exceeded 90 seconds')
    await this.verifyAndroidClosedCapture(before, end)
    this.androidClosedCapture = before
  }

  private async verifyAndroidClosedCapture(
    before: AndroidDismissReference,
    end: number,
    initial = false
  ): Promise<AndroidDismissReference> {
    const remaining = (): number => {
      assert(
        Date.now() < end,
        'Android capture IME did not settle within its deadline'
      )
      return Math.max(1, end - Date.now())
    }
    const signal = AbortSignal.any([
      this.deadline,
      AbortSignal.timeout(remaining())
    ])
    const samples: Args[] = []
    const proof: Args = {
      name: initial
        ? 'Passive Android initial capture state'
        : 'Positive Android closed capture state',
      initialState: before.initialState,
      samples,
      outcome: 'failed'
    }
    this.steps.push(proof)
    let previous:
      | { signature: string; hash: string; raster: string; at: number }
      | undefined
    try {
      for (let count = 0; count < 24; count++) {
        signal.throwIfAborted()
        const sample: Args = { startedAt: new Date().toISOString() }
        samples.push(sample)
        const observed = await this.observeAndroidIme(
          { signal, timeoutMs: Math.min(5000, remaining()) },
          'state'
        )
        const state = need(observed.state, 'Actual current IME state required')
        sample.ime = observed
        const { raw, evidence } = await this.androidHierarchy(signal)
        sample.rawHierarchy = evidence
        let geometry: Args | undefined
        try {
          geometry = androidClosedCaptureGeometry(raw, before)
          sample.geometry = geometry
        } catch (error) {
          sample.geometryError =
            error instanceof Error ? error.message : String(error)
          previous = undefined
        }
        let open: AndroidDismissReference | undefined
        if (initial && state.state === 'open') {
          const reference = androidDismissReference(
            raw,
            state,
            before.viewport,
            before.text
          )
          for (const key of ['history', 'text', 'reply', 'chips'] as const)
            assert(
              JSON.stringify(reference[key]) === JSON.stringify(before[key]),
              'Passive initial context changed: ' + key
            )
          if (
            reference.band.y + reference.band.height <=
            reference.keyboard!.y + 2
          )
            open = reference
          else sample.openLayoutPending = true
        }
        const bytes = Buffer.from(await this.device.screenshot({ signal }))
        const png = bytes.subarray(0, 8).equals(PNG)
        const jpeg = bytes[0] === 255 && bytes[1] === 216
        const path = join(
          this.runDir,
          'android-closed-frame-' +
            randomUUID() +
            (png ? '.raw.png' : jpeg ? '.raw.jpg' : '.raw.bin')
        )
        writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
        const at = Date.now()
        const image: Args = {
          path,
          sha256: digest(path),
          at: new Date(at).toISOString(),
          bytes: bytes.length
        }
        sample.image = image
        assert(png || jpeg, 'Actual raw Android PNG/JPEG required')
        let raster: { width: number; height: number; mode: string }
        try {
          const { width, height, mode } = decodeRaster(bytes)
          raster = { width, height, mode }
          image.validation = { decoded: true }
        } catch (error) {
          image.validation = {
            decoded: false,
            error: error instanceof Error ? error.message : String(error)
          }
          throw new Error(
            'Actual raw Android frame must decode within deadline'
          )
        }
        assert(
          Number.isFinite(raster.width) &&
            Number.isFinite(raster.height) &&
            raster.width > 0 &&
            raster.height > 0,
          'Actual positive decoded Android raster required'
        )
        image.raster = raster
        signal.throwIfAborted()
        remaining()
        if (open != null) {
          proof.outcome = 'passed'
          proof.initialDispatch = 'open'
          return open
        }
        if (state.state === 'already-closed' && geometry != null) {
          const current = {
            signature: JSON.stringify(geometry),
            hash: String(image.sha256),
            raster: JSON.stringify(raster),
            at
          }
          if (
            current.signature === previous?.signature &&
            current.hash === previous.hash &&
            current.raster === previous.raster &&
            current.at - previous.at >= 200
          ) {
            proof.outcome = 'passed'
            proof.exactPairMs = current.at - previous.at
            return initial
              ? androidDismissReference(
                  raw,
                  state,
                  before.viewport,
                  before.text
                )
              : before
          }
          previous = current
        } else previous = undefined
        await new Promise(resolve =>
          setTimeout(resolve, Math.min(200, remaining()))
        )
      }
      throw Error(
        'Complete Android closed OS/context and exact raw pair did not settle'
      )
    } catch (error) {
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      proof.completedAt = new Date().toISOString()
    }
  }

  async back(): Promise<void> {
    if (this.surface !== 'ios') {
      await this.device.back()
      return
    }
    const back = (await this.nodes()).find(
      n =>
        n.type?.includes('Button') === true &&
        n.text === 'Back' &&
        n.bounds != null
    )
    await this.tapObserved(need(back, 'Observed public Back control required'))
  }

  /** Typing a standalone at-sign transfers editing to the public member chooser. */
  async typeMentionTrigger(): Promise<void> {
    const proof: Args = {
      name: 'Typed mention trigger opens member chooser',
      outcome: 'failed'
    }
    this.steps.push(proof)
    try {
      await this.appendComposer('@')
      await this.present('chat-picker-scene')
      await this.present('chat-picker-header')
      if (this.surface === 'ios') {
        const search = await this.iosRead(
          { text: exactText('Search members') },
          'TextField'
        )
        proof.search = search
        assert(search.enabled === true, 'Actual enabled member Search required')
      } else
        await this.device.assertVisible({
          text: exactText('Search members'),
          enabled: true,
          timeout: 15000
        })
      proof.outcome = 'passed'
    } catch (error) {
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /** Composer input names its real field on iOS; generic append also serves Search. */
  async appendComposer(text: string): Promise<void> {
    if (this.surface === 'ios')
      await this.device.inputText({ id: 'chat-composer', text })
    else await this.append(text)
  }

  /** Select one actual member and observe the native scene's completed focus handoff. */
  async selectMention(member: Chat2Fixture['members'][number]): Promise<void> {
    const id = 'chat-mention-member-' + member.userId
    if (!this.native) {
      await this.id(id)
      return
    }
    const proof: Args = {
      name: 'Observed native member selection',
      memberId: member.userId,
      samples: [],
      focusSignal:
        this.surface === 'ios' ? 'unavailable-on-ios' : 'focused-editor',
      outcome: 'failed'
    }
    this.steps.push(proof)
    const read = async (): Promise<PublicNode[]> => {
      const nodes: PublicNode[] =
        this.surface === 'ios'
          ? iosPublicRead(await this.iosRaw(), { id: 'chat-picker-scene' })
              .nodes
          : await this.nodes()
      // A long member list can pass the simulator snapshot's cap.
      if (
        this.surface === 'ios' &&
        !this.physical &&
        nodes.length >= IOS_SIMULATOR_SNAPSHOT_CAP
      )
        for (const key of ['chat-picker-header', id, 'chat-composer'])
          if (!nodes.some(node => node.id === key)) {
            const queried = await this.iosQueried(key)
            // An unanchored id could reach the composer band instead.
            if (
              queried != null &&
              (key !== 'chat-composer' || queried.type === 'TextView')
            )
              nodes.push(queried)
          }
      ;(proof.samples as unknown[]).push(
        nodes.filter(
          node =>
            node.id === id ||
            node.id === 'chat-composer' ||
            node.id === 'chat-picker-scene' ||
            node.type === 'Keyboard' ||
            node.type === 'TextField' ||
            node.type === 'EditText'
        )
      )
      return nodes
    }
    type Box = NonNullable<PublicNode['bounds']>
    const positive = (b: PublicNode['bounds']): b is Box =>
      b != null &&
      [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
      b.width > 0 &&
      b.height > 0
    const one = (nodes: PublicNode[], key: string): PublicNode => {
      const rows = nodes.filter(node => node.id === key)
      assert.equal(
        rows.length,
        1,
        'Unique actual member control required: ' + key
      )
      return rows[0]
    }
    let nodes = await read()
    const readClearBottom = async (): Promise<number> => {
      if (this.surface === 'android') {
        const observed = await this.observeAndroidIme({}, 'state')
        return observed.state?.state === 'already-closed'
          ? observed.viewport.height
          : need(observed.bounds, 'Actual Android IME frame required').y
      }
      const keyboard = need(
        nodes.find(node => node.type === 'Keyboard')?.bounds,
        'Actual iOS Keyboard required'
      )
      assert(positive(keyboard), 'Positive actual iOS Keyboard required')
      return keyboard.y
    }
    let clearBottom = await readClearBottom()
    const clear = (node: PublicNode, current: PublicNode[]): boolean => {
      const h = one(current, 'chat-picker-header').bounds
      const b = node.bounds
      return (
        positive(b) &&
        positive(h) &&
        Number.isFinite(clearBottom) &&
        clearBottom > 0 &&
        b.y >= h.y + h.height + 8 &&
        b.y + b.height <= clearBottom - 8
      )
    }
    const memberRow = (current: PublicNode[]): PublicNode => {
      const row = one(current, id)
      assert.equal(row.type, 'Button', 'Actual member Button required')
      assert.equal(
        this.surface === 'ios' ? (row as IosReadNode).label : row.text,
        member.name + ', ' + member.role,
        'Exact member name and role required'
      )
      return row
    }
    try {
      // Android leaves rows outside the list's window out of its tree: an
      // absent row is searched for like one the keyboard covers.
      if (
        !nodes.some(node => node.id === id) ||
        !clear(memberRow(nodes), nodes)
      ) {
        const fields = nodes.filter(node =>
          this.surface === 'ios'
            ? node.type === 'TextField' &&
              (node as IosReadNode).label === 'Search members'
            : node.type === 'EditText' &&
              node.text === 'Search members' &&
              node.focused === true
        )
        assert.equal(
          fields.length,
          1,
          'Unique observed empty member Search required'
        )
        assert(
          fields[0].enabled !== false && clear(fields[0], nodes),
          'Actual enabled Search must clear header and Keyboard'
        )
        if (this.surface === 'ios')
          assert(
            (fields[0] as IosReadNode).value == null ||
              (fields[0] as IosReadNode).value === '',
            'Existing Search query must remain unchanged'
          )
        await this.text('Search members')
        await this.device.inputText({
          text: member.name,
          ...(this.surface === 'android' ? { keyPress: true } : {})
        })
        nodes = await read()
        if (this.surface === 'android') clearBottom = await readClearBottom()
      }
      assert(
        clear(memberRow(nodes), nodes),
        'Exact member row must clear header and actual Keyboard before tap'
      )
      await this.id(id)
      await until(
        async () => {
          const current = await read()
          const editors = current.filter(node => node.id === 'chat-composer')
          const e = editors[0]
          const b = e?.bounds
          if (
            current.some(node => node.id === 'chat-picker-scene') ||
            editors.length !== 1 ||
            e.enabled === false ||
            !positive(b) ||
            b.y + b.height > clearBottom + 1
          )
            return undefined
          const expected = '@' + member.name + ' '
          const ready =
            this.surface === 'ios'
              ? // The simulator's snapshot trims outer whitespace and a phone's
                // WebDriverAgent keeps it; interior spaces stay exact in both.
                e.type === 'TextView' &&
                e.enabled === true &&
                [expected, expected.trimEnd()].includes(
                  (e as IosReadNode).value ?? ''
                ) &&
                current.filter(node => node.type === 'Keyboard').length === 1 &&
                current.some(
                  node =>
                    node.type === 'Keyboard' &&
                    positive(node.bounds) &&
                    b.y + b.height <= node.bounds.y + 1
                )
              : e.type === 'EditText' &&
                e.focused === true &&
                e.text === expected
          if (ready && this.surface === 'android')
            assert(
              b.y + b.height <= (await this.readAndroidIme()).bounds.y + 1,
              'Focused selected composer must clear fresh IME'
            )
          return ready ? true : undefined
        },
        'selected exact member in actual composer after picker closes',
        10000
      )
      proof.outcome = 'passed'
    } catch (error) {
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async replaceDraft(
    text: string,
    options: { focused?: boolean } = {}
  ): Promise<void> {
    if (this.surface === 'ios') {
      // Every iOS step re-reads the accessibility tree, which grows with the
      // conversation; seven to nine steps took over 90 s on a long history,
      // and a clear plus sentinel proof passed 180 s on a grown QA history.
      const signal = AbortSignal.timeout(360000)
      const options = { signal }
      const api = this.device as unknown as {
        tapOn: (
          args: Args,
          options: { signal: AbortSignal }
        ) => Promise<unknown>
        tapOnPoint: (
          args: Args,
          options: { signal: AbortSignal }
        ) => Promise<unknown>
        longPressOn: (
          args: Args,
          options: { signal: AbortSignal }
        ) => Promise<unknown>
        inputText: (
          args: Args,
          options: { signal: AbortSignal }
        ) => Promise<unknown>
        screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
      }
      const proof: Args = {
        name: 'Observed iOS editor replacement',
        expectedLength: text.length,
        expectedSha256: createHash('sha256').update(text).digest('hex'),
        outcome: 'failed',
        whitespaceFidelity:
          'Native AX trims outer whitespace; exact ambiguous strings are never accepted'
      }
      this.steps.push(proof)
      const editorReads: IosReadNode[] = []
      proof.editorReads = editorReads
      // The composer band each read's snapshot held: the band rides the
      // keyboard, whose suggestion bar comes and goes while typing.
      const bands = new Map<IosReadNode, Bounds>()
      const editorBands: Array<Bounds | undefined> = []
      proof.editorBands = editorBands
      const read = async (): Promise<IosReadNode> => {
        signal.throwIfAborted()
        const node = await this.iosRead(
          { id: 'chat-composer' },
          'TextView',
          signal
        )
        editorReads.push(node)
        const band = this.lastIosReadNodes?.find(
          n => n.id === 'chat-composer-band'
        )?.bounds
        editorBands.push(band)
        if (band != null) bands.set(node, band)
        assert(node.enabled === true, 'Actual enabled iOS editor required')
        return node
      }
      const exact = (node: IosReadNode): string | undefined => {
        const value = node.index >= 0 ? node.value : node.text
        return value != null &&
          value !== node.label &&
          value !== node.placeholderValue
          ? value
          : undefined
      }
      const rawEmpty = (node: IosReadNode): boolean =>
        node.index >= 0 &&
        typeof node.placeholderValue === 'string' &&
        node.placeholderValue !== '' &&
        node.value == null
      const tap = async (node: PublicNode): Promise<void> => {
        const box = need(
          node.bounds,
          'Actual observed editor action bounds required'
        )
        await api.tapOnPoint(
          {
            point: `${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}`
          },
          options
        )
      }
      const actionReads: Args[] = []
      proof.actionReads = actionReads
      const actionRaw = async (): Promise<Uint8Array> => {
        const bytes = await this.iosRaw(signal)
        const path = join(
          this.runDir,
          'ios-editor-actions-' + Date.now() + '-' + randomUUID() + '.json'
        )
        writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
        actionReads.push({
          path,
          sha256: createHash('sha256').update(bytes).digest('hex')
        })
        return bytes
      }
      // A system banner (a delivered notification) can cover the app for one
      // snapshot, which then lists neither the editor nor the keyboard: read
      // again, briefly.
      const appRaw = async (): Promise<Uint8Array> => {
        let raw = await actionRaw()
        for (
          let attempt = 0;
          attempt < 4 &&
          iosPublicRead(raw, { id: 'chat-composer' }, 'TextView').element ==
            null &&
          iosPublicRead(raw, {}, 'Keyboard').element == null;
          attempt++
        ) {
          await new Promise(resolve => setTimeout(resolve, 1500))
          raw = await actionRaw()
        }
        return raw
      }
      const remove = async (current?: string): Promise<void> => {
        // Typing can leave the keyboard lowered, its keys reported below the
        // screen: tapping the editor raises it before any key is pressed.
        const screen = await this.device.platformInfo({ signal })
        const height = Number(screen.screenHeight)
        for (let attempt = 0; ; attempt++) {
          const shown = iosPublicRead(await appRaw(), {}, 'Keyboard').element
            ?.bounds
          if (shown != null && shown.y + shown.height <= height + 1) break
          assert(attempt < 3, 'Shown iOS Keyboard required for replacement')
          proof.keyboardRaised = attempt + 1
          await api.tapOn({ id: 'chat-composer' }, options)
          await new Promise(resolve => setTimeout(resolve, 700))
        }
        await api.longPressOn({ id: 'chat-composer', duration: 600 }, options)
        let raw = await appRaw()
        let menu = iosPublicRead(
          raw,
          { text: exactText('Select All') },
          'MenuItem'
        ).element
        if (menu == null && current != null && /\s/.test(current)) {
          // A long press selects the word under it: all of a one-word draft,
          // but only part of a longer one, and iOS then offers no Select All.
          // A caret placed after the text, tapped again, does.
          const field = need(
            iosPublicRead(raw, { id: 'chat-composer' }, 'TextView').element
              ?.bounds,
            'Actual editor bounds required for its end caret'
          )
          const end = {
            point: `${Math.round(field.x + field.width - 12)},${Math.round(field.y + field.height - 10)}`
          }
          await api.tapOnPoint(end, options)
          await new Promise(resolve => setTimeout(resolve, 700))
          await api.tapOnPoint(end, options)
          raw = await appRaw()
          menu = iosPublicRead(
            raw,
            { text: exactText('Select All') },
            'MenuItem'
          ).element
        }
        if (menu != null) {
          assert(menu.enabled === true, 'Enabled observed Select All required')
          await tap(menu)
          raw = await appRaw()
        }
        // An absent Select All is no claim about selection; the fresh value proves deletion.
        const key = need(
          iosPublicRead(raw, { text: '^delete$' }, 'Key').element,
          'Observed Delete key required for replacement'
        )
        const keyboard = need(
          iosPublicRead(raw, {}, 'Keyboard').element?.bounds,
          'Actual Keyboard required for replacement'
        )
        const box = need(key.bounds, 'Actual Delete key bounds required')
        assert(
          key.enabled === true &&
            box.x >= keyboard.x &&
            box.y >= keyboard.y &&
            box.x + box.width <= keyboard.x + keyboard.width &&
            box.y + box.height <= keyboard.y + keyboard.height,
          'Enabled Delete key must belong to actual Keyboard'
        )
        await tap(key)
        // Without Select All one Delete removes the selected word or one
        // character: when text remains, the rest of the observed draft
        // follows, and the caller's fresh read decides.
        if (
          menu == null &&
          current != null &&
          Array.from(current).length > 1 &&
          !rawEmpty(await read())
        )
          for (let n = 1; n < Array.from(current).length; n++) await tap(key)
      }
      try {
        await api.tapOn({ id: 'chat-composer' }, options)
        const before = await read()
        proof.before = before
        if (!rawEmpty(before)) await remove(exact(before))
        if (text !== '') {
          await api.inputText({ id: 'chat-composer', text }, options)
          const after = await read()
          proof.after = after
          assert.equal(
            exact(after),
            text,
            'Actual editor must exactly equal requested replacement'
          )
        } else {
          const placeholder = need(
            before.placeholderValue ?? before.label,
            'Observed editor placeholder/label required'
          )
          assert(
            placeholder !== '',
            'Nonempty observed editor placeholder required'
          )
          let reference = before
          if (!rawEmpty(before)) reference = await read()
          // Typing the sentinel can let the keyboard fall, and the composer
          // rides it; deleting raises it again. The empty editor's own
          // geometry, read with the keyboard up, is the one to keep.
          const shape = reference
          let sentinel: string | undefined
          if (!rawEmpty(reference)) {
            const digit = need(
              ['7', '8', '9', '4', '2', '6', '3', '5', '1', '0'].find(
                value => !placeholder.includes(value)
              ),
              'Disjoint editor sentinel required'
            )
            sentinel = digit.repeat(4)
            await api.inputText(
              { id: 'chat-composer', text: sentinel },
              options
            )
            reference = await read()
            proof.sentinel = reference
            assert.equal(
              exact(reference),
              sentinel,
              'Fresh exact sentinel must prove the previous clear'
            )
            await remove()
            // A long press that put the caret before the sentinel leaves
            // Delete nothing to remove: with the caret placed after it, one
            // Delete per character does, and the fresh read below decides.
            const left = await read()
            if ((exact(left) ?? left.text ?? '').includes(sentinel)) {
              proof.sentinelDeleteRetried = true
              const field = need(left.bounds, 'Actual editor bounds required')
              await api.tapOnPoint(
                {
                  point: `${Math.round(field.x + field.width - 12)},${Math.round(field.y + field.height - 10)}`
                },
                options
              )
              const key = need(
                iosPublicRead(await appRaw(), { text: '^delete$' }, 'Key')
                  .element,
                'Observed Delete key required for replacement'
              )
              // One Delete per character of the sentinel.
              for (let left = sentinel.length; left > 0; left--) await tap(key)
            }
          }
          const baseLabel = need(
            reference.placeholderValue ?? reference.label,
            'Observed product editor label required'
          )
          assert(baseLabel !== '', 'Nonempty product editor label required')
          const emptyLabels = [baseLabel, baseLabel + ' ' + baseLabel]
          proof.allowedEmptyLabels = emptyLabels
          const verify = async (): Promise<IosReadNode> => {
            const node = await read()
            proof.afterCandidate = node
            const box = need(node.bounds, 'Actual editor geometry required')
            const prior = need(
              shape.bounds,
              'Actual reference editor geometry required'
            )
            assert(
              emptyLabels.includes(node.label ?? ''),
              'Empty editor label must equal the observed product label or exact label-plus-placeholder'
            )
            // The editor grows upward with its lines: against a reference
            // that held text, its bottom edge and width are what must stay.
            // Both ride the keyboard with the composer band, so where both
            // snapshots hold the band, the bottom edge is read against it.
            const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1
            const band = bands.get(node)
            const priorBand = bands.get(shape)
            const lift = (b: Bounds | undefined): number =>
              band != null && priorBand != null ? b!.y + b!.height : 0
            proof.geometryCompared =
              (rawEmpty(shape)
                ? 'editor x, width, height and bottom edge'
                : 'editor x, width and bottom edge') +
              (band != null && priorBand != null
                ? ', against the composer band'
                : '')
            assert(
              near(box.x, prior.x) &&
                near(box.width, prior.width) &&
                (!rawEmpty(shape) || near(box.height, prior.height)) &&
                near(
                  box.y + box.height - lift(band),
                  prior.y + prior.height - lift(priorBand)
                ),
              'Same editor geometry required after deletion'
            )
            assert(
              rawEmpty(node) ||
                (node.value == null &&
                  sentinel != null &&
                  typeof node.label === 'string' &&
                  node.text === node.label &&
                  !node.text.includes(sentinel)),
              'Fresh editor must expose empty placeholder after deleting known disjoint sentinel'
            )
            return node
          }
          proof.after = await verify()
          // A staged file can be sent with an empty caption. The legacy flows
          // clear ordinary drafts and replies, with or without a staged file.
          const nodes = need(
            this.lastIosReadNodes,
            'Fresh editor snapshot required'
          )
          const chip = nodes.find(n => n.id === 'chat-attachment-chip')
          const hasFile =
            chip != null ||
            (nodes.length >= 300 &&
              (await this.visible({ id: '^chat-attachment-chip$' }, 120)))
          if (hasFile) {
            proof.preservedAttachment =
              chip ??
              (await this.iosRead(
                { id: 'chat-attachment-chip' },
                undefined,
                signal
              ))
            const send = await this.iosRead(
              { text: exactText('Send') },
              'Button',
              signal
            )
            assert(
              typeof send.enabled === 'boolean',
              'Observed attachment Send state required'
            )
            proof.send = send
          } else {
            assert(
              !nodes.some(isIosSendButton),
              'Empty composer must have no Send button'
            )
            await this.device.assertNotVisible({
              id: '^chat-send$',
              timeout: 3000
            })
          }
          proof.sendVisible = hasFile
          const path = join(
            this.runDir,
            'ios-editor-empty-' + Date.now() + '-' + randomUUID() + '.png'
          )
          proof.image = saveCapture(await api.screenshot(options), path)
          proof.revalidated = await verify()
          proof.emptyEvidence =
            sentinel == null
              ? 'Actual raw empty value and placeholder'
              : 'Known disjoint sentinel followed only by observed Delete; fresh placeholder and positive controls; lossy AX value/placeholder distinction qualified'
          proof.actualImageReviewRequired = true
        }
        proof.outcome = 'passed'
      } catch (error) {
        proof.error = error instanceof Error ? error.message : String(error)
        throw error
      }
      return
    }
    // A closing message overlay keeps the chat behind it inert until it is
    // gone; a tap during its fade (long on a loaded host) focuses nothing.
    if (!this.native) await this.composerInteractive()
    // A composer already proven focused (a pinch-zoomed page's own tap) is not
    // tapped again by id, whose layout coordinates miss a panned visual viewport.
    if (this.native || options.focused !== true) await this.id('chat-composer')
    if (!this.native) {
      const before = await this.dom(
        `const n=document.querySelector('[data-testid="chat-composer"]');return {focused:n?.isConnected===true&&document.activeElement===n,editable:n instanceof HTMLTextAreaElement&&!n.disabled&&!n.readOnly&&n.getAttribute('aria-disabled')!=='true',value:n?.value}`
      )
      assert(
        before.focused === true &&
          before.editable === true &&
          typeof before.value === 'string',
        'Browser replacement requires the focused enabled composer'
      )
      const selected = await this.dom(
        `const n=document.querySelector('[data-testid="chat-composer"]');if(!(n instanceof HTMLTextAreaElement)||!n.isConnected||n.disabled||n.readOnly||n.getAttribute('aria-disabled')==='true'||document.activeElement!==n)throw Error('Actual focused enabled composer required for public selection');n.select();return {focused:n.isConnected&&document.activeElement===n,value:n.value,start:n.selectionStart,end:n.selectionEnd}`
      )
      assert(
        selected.focused === true &&
          selected.value === before.value &&
          selected.start === 0 &&
          selected.end === before.value.length,
        'Browser replacement must select the entire current draft'
      )
      await this.device.eraseText({ characters: 1 })
      assert.equal(
        await this.draft(),
        '',
        'Browser replacement must completely clear the prior draft'
      )
      if (text !== '') await this.append(text)
      assert.equal(
        await this.draft(),
        text,
        'Browser replacement must equal the complete expected draft'
      )
      return
    }
    await this.device.eraseText()
    if (this.surface === 'android') await this.androidDraftCleared()
    if (text !== '') await this.append(text)
  }

  /**
   * The Pixel's eraseText can pass and leave the draft (E10's typing probe
   * stayed in all six runs, two lines tall, shrinking the reader). The draft
   * is read back; the empty field reads as '' or its placeholder. A draft
   * left behind is cleared once more through the field's own menu (Select
   * all, then the Delete key), and a draft that still stays fails with what
   * was read.
   */
  async androidDraftCleared(): Promise<void> {
    const empty = (value: string): boolean =>
      value === '' || value === ANDROID_COMPOSER_PLACEHOLDER
    const left = await this.draft()
    if (empty(left)) return
    const proof: Args = {
      name: 'Android draft cleared again through its menu',
      leftLength: left.length,
      outcome: 'failed'
    }
    this.steps.push(proof)
    await this.device.longPressOn({ id: 'chat-composer', duration: 600 })
    await this.device.tapOn({ text: '^Select all$' })
    // The driver's eraseText clears through the field's setText, which this
    // field can miss; the Delete key goes through the keyboard.
    await this.device.pressKey({ key: 'backspace' })
    const after = await this.draft()
    assert(
      empty(after),
      'Android draft must clear; still read: ' + JSON.stringify(after)
    )
    proof.outcome = 'passed'
  }

  /** Wait for the browser composer to leave any modal overlay's inert background. */
  async composerInteractive(): Promise<void> {
    assert(!this.native, 'Browser composer required')
    await until(
      async () => {
        const value = await this.dom(
          `const n=document.querySelector('[data-testid="chat-composer"]');return {present:n!=null,inert:n?.closest('[aria-hidden="true"]')!=null}`
        )
        return value.present === true && value.inert === false
          ? true
          : undefined
      },
      'browser composer outside a closing overlay',
      15000
    )
  }

  async append(text: string): Promise<void> {
    if (!this.native && text.includes('\n')) {
      const proof: Args = {
        name: 'Multiline composer selector input',
        length: text.length,
        sha256: createHash('sha256').update(text).digest('hex'),
        outcome: 'failed'
      }
      this.steps.push(proof)
      try {
        assert.equal(
          await this.draft(),
          '',
          'Multiline input requires an actually empty composer'
        )
        // The selector route uses Element.Input; the keyboard route cannot type literal newlines.
        await this.device.inputText({ id: 'chat-composer', text })
        assert.equal(
          await this.draft(),
          text,
          'Actual composer must equal the complete multiline input'
        )
        proof.outcome = 'passed'
      } catch (error) {
        proof.error = error instanceof Error ? error.message : String(error)
        throw error
      }
      return
    }
    await this.device.inputText({
      text,
      ...(this.surface === 'android' ? { keyPress: true } : {})
    })
  }

  async draft(): Promise<string> {
    if (!this.native) {
      const value = (
        await this.dom(
          'return {value:document.querySelector(\'[data-testid="chat-composer"]\')?.value}'
        )
      ).value
      assert(typeof value === 'string', 'Public composer value required')
      return value
    }
    if (this.surface === 'ios') {
      // A paste or edit can still be landing in the field when it is read:
      // three reads, a second apart, before the value counts as ambiguous.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000))
        const node = await this.iosRead({ id: 'chat-composer' }, 'TextView')
        assert(
          node.enabled === true,
          'Actual enabled iOS editable composer required'
        )
        if (
          node.value != null &&
          node.value !== node.placeholderValue &&
          node.value !== node.label
        )
          return node.value
        if (node.index < 0 && node.text != null && node.text !== node.label)
          return node.text
      }
      throw new Chat2Blocked(
        'Native composer value is empty, placeholder, or ambiguous; an explicit empty-UI proof is required'
      )
    }
    // copyTextFrom writes the device clipboard, so a draft read between an
    // app's Copy and the paste replaced the copied text with the draft (E5
    // pasted an empty field). The field's text is read from the passive
    // hierarchy when it is there; copyTextFrom is only the fallback.
    // Just after the app's restart the composer can still be mounting: look
    // for it for a few seconds before falling back.
    let passive: PublicNode[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000))
      passive = (await this.nodes()).filter(
        node => node.id === 'chat-composer' && typeof node.text === 'string'
      )
      if (passive.length > 0) break
    }
    if (passive.length === 1)
      return passive[0].text === ANDROID_COMPOSER_PLACEHOLDER
        ? ''
        : passive[0].text!
    const value = await this.device.copyTextFrom({ id: 'chat-composer' })
    await this.closeAndroidClipboardOverlay()
    // An empty field's text is its placeholder (its hint), which is no draft.
    if (typeof value.data === 'string')
      return value.data === ANDROID_COMPOSER_PLACEHOLDER ? '' : value.data
    throw new Chat2Blocked('Native public composer text could not be read')
  }

  async assertKeyboard(): Promise<void> {
    if (this.surface === 'ios') {
      // Two reads of a long conversation's tree and a raw screenshot passed
      // 90 s on a loaded simulator.
      const signal = AbortSignal.timeout(300000)
      const evidence: Args = {
        name: 'Positive iOS composer above software keyboard',
        focusSignal: 'unavailable-on-ios',
        method:
          'Exact enabled composer and observed Keyboard geometry; raw image and ordinary text delivery require review',
        startedAt: new Date().toISOString()
      }
      this.steps.push(evidence)
      try {
        const before = await readIosComposerKeyboard(this, signal)
        evidence.before = before.geometry
        const api = this.device as unknown as {
          screenshot: (options: { signal: AbortSignal }) => Promise<Uint8Array>
        }
        evidence.image = saveCapture(
          await api.screenshot({ signal }),
          join(this.runDir, 'ios-composer-keyboard-' + Date.now() + '.png')
        )
        const after = await readIosComposerKeyboard(this, signal)
        evidence.after = after.geometry
        assert(
          Object.keys(before.geometry).every(key => {
            const a = before.geometry[key as keyof typeof before.geometry]
            const b = after.geometry[key as keyof typeof after.geometry]
            return (['x', 'y', 'width', 'height'] as const).every(
              axis => Math.abs(a[axis] - b[axis]) <= 1
            )
          }),
          'iOS composer/Keyboard geometry changed during its raw screenshot'
        )
        signal.throwIfAborted()
        evidence.outcome = 'passed'
      } catch (error) {
        evidence.outcome = 'failed'
        evidence.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        evidence.completedAt = new Date().toISOString()
      }
      return
    }
    if (this.surface === 'android') {
      const proof = await readAndroidComposerKeyboard(
        this,
        AbortSignal.timeout(10000)
      )
      this.steps.push({
        name: 'Positive focused Android composer above observed IME',
        geometry: proof.geometry,
        outcome: 'passed'
      })
      return
    }
    await this.device.assertVisible({
      id: 'chat-composer',
      focused: true,
      timeout: 2000
    })
    if (!this.native) {
      const focus = await this.dom(
        'return {focused:document.activeElement?.getAttribute("data-testid")==="chat-composer"}'
      )
      assert(focus.focused === true, 'Explicit Reply must focus the composer')
      return
    }
    await this.keyboardVisible()
  }

  async keyboardVisible(): Promise<void> {
    assert(this.native, 'Software keyboard proof is native only')
    if (this.surface === 'ios') {
      await this.assertKeyboard()
      return
    }
    await this.readAndroidIme()
  }

  /** Capture-only OS geometry observer; every UI input remains a Maestro command. */
  async readAndroidIme(
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<{
    bounds: Bounds
    rawPath: string
    viewport: { width: number; height: number }
  }> {
    // A phone's keyboard can still be animating in when it is first read;
    // read again while it is reported hidden, within a bounded wait.
    const end = Date.now() + (this.physical ? 15000 : 0)
    let result: Awaited<ReturnType<Chat2UI['observeAndroidIme']>>
    for (;;) {
      try {
        result = await this.observeAndroidIme(options, 'open')
        break
      } catch (error) {
        if (
          Date.now() >= end ||
          !(error instanceof Error ? error.message : '').includes(
            'IME visibility'
          )
        )
          throw error
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    return {
      bounds: need(result.bounds, 'Positive observed Android IME required'),
      rawPath: result.rawPath,
      viewport: result.viewport
    }
  }

  /** Whether the Android keyboard is actually on screen, and where. */
  async readAndroidImeState(): Promise<AndroidCaptureIme> {
    return need(
      (await this.observeAndroidIme({}, 'state')).state,
      'Observed Android IME state required'
    )
  }

  private async observeAndroidIme(
    options: { signal?: AbortSignal; timeoutMs?: number },
    mode: 'open' | 'state'
  ): Promise<{
    bounds?: Bounds
    state?: AndroidCaptureIme
    rawPath: string
    viewport: { width: number; height: number }
  }> {
    const limit = Math.min(5000, options.timeoutMs ?? 5000)
    assert(
      Number.isFinite(limit) && limit > 0,
      'Finite Android IME observation bound required'
    )
    const signal =
      options.signal == null
        ? AbortSignal.timeout(limit)
        : AbortSignal.any([options.signal, AbortSignal.timeout(limit)])
    const end = Date.now() + limit
    const proof: Args = {
      name: 'Read-only owned Android IME window',
      source: this.binding.source,
      daemonName: this.daemonName,
      observedAt: new Date().toISOString(),
      deviceId: this.deviceId,
      outcome: 'failed'
    }
    this.steps.push(proof)
    try {
      signal.throwIfAborted()
      assert(
        this.surface === 'android' &&
          this.native &&
          this.deviceId !== '' &&
          this.fixture.devices.android.owned &&
          this.deviceId === this.fixture.devices.android.id,
        'Exact owned Android device required for IME observation'
      )
      const api = this.device as unknown as {
        platformInfo: (options: { signal: AbortSignal }) => Promise<Args>
      }
      const screen = await api.platformInfo({ signal })
      const remaining = Math.min(limit, end - Date.now())
      assert(remaining > 0, 'Android IME observation deadline expired')
      const args = [
        '-s',
        this.deviceId,
        'shell',
        'dumpsys',
        'window',
        'InputMethod'
      ]
      const result = spawnSync(process.env.CHAT2_ADB ?? 'adb', args, {
        encoding: 'utf8',
        timeout: remaining,
        maxBuffer: 2 * 1024 * 1024
      })
      const rawPath = join(this.runDir, 'android-ime-' + randomUUID() + '.txt')
      const stderrPath = rawPath + '.stderr.txt'
      writeFileSync(rawPath, result.stdout ?? '', { flag: 'wx', mode: 0o600 })
      writeFileSync(stderrPath, result.stderr ?? '', {
        flag: 'wx',
        mode: 0o600
      })
      Object.assign(proof, {
        args,
        rawPath,
        rawSha256: digest(rawPath),
        stderrPath,
        stderrSha256: digest(stderrPath),
        exitCode: result.status,
        signal: result.signal,
        transportError: result.error?.message
      })
      assert(
        result.status === 0 && result.signal == null && result.error == null,
        'Android IME observation transport failed'
      )
      signal.throwIfAborted()
      assert(Date.now() <= end, 'Android IME observation deadline expired')
      const viewport = {
        width: Number(screen.screenWidth),
        height: Number(screen.screenHeight)
      }
      const state =
        mode === 'state'
          ? androidCaptureImeState(result.stdout, viewport)
          : undefined
      const measured =
        mode === 'open'
          ? androidImeFrame(result.stdout, viewport)
          : state?.keyboard
      proof.bounds = measured
      if (state != null) proof.observedState = state
      proof.viewport = {
        width: screen.screenWidth,
        height: screen.screenHeight
      }
      proof.outcome = 'passed'
      return { bounds: measured, state, rawPath, viewport }
    } catch (error) {
      proof.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async captureViewport(): Promise<CaptureViewport> {
    const value = await this.dom(
      'return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,coarse:matchMedia("(pointer:coarse)").matches,scale:typeof visualViewport==="undefined"||visualViewport===null?1:visualViewport.scale,scrollX,scrollY}'
    )
    assert(
      ['width', 'height', 'dpr', 'scale'].every(
        key =>
          typeof value[key] === 'number' &&
          Number.isFinite(value[key]) &&
          Number(value[key]) > 0
      ) &&
        ['scrollX', 'scrollY'].every(
          key => typeof value[key] === 'number' && Number.isFinite(value[key])
        ) &&
        typeof value.coarse === 'boolean',
      'Actual browser capture geometry required'
    )
    return value as unknown as CaptureViewport
  }

  /** Observe pixels on the same owned tab; never alter its rendering geometry. */
  async captureImage(destination: string): Promise<Args> {
    if (this.native)
      return {
        ...saveCapture(await this.device.screenshot(), destination),
        captureObserver: {
          method: 'maestro-d native screenshot',
          source: this.binding.source
        }
      }
    const cdp = need(this.cdp, 'Owned tab CDP capture observer required')
    const frame = need(
      this.webFrame,
      'Strictly measured browser frame required before capture'
    )
    const expectedRaster = {
      width: frame.width * frame.dpr,
      height: frame.height * frame.dpr
    }
    const before = await this.captureViewport()
    const expected = this.webZoom ?? { ...frame, scale: 1 }
    const parameters = {
      format: 'png' as const,
      captureBeyondViewport: false,
      fromSurface: true
    }
    const observation: Args = {
      name: 'Read-only viewport capture observer',
      method: 'CDP Page.captureScreenshot on the owned Maestro-controlled tab',
      source: this.binding.source,
      parameters,
      frame,
      expectedRaster,
      before,
      zoomGeometry: this.webZoom
    }
    this.steps.push(observation)
    try {
      assert(
        ['width', 'height', 'dpr', 'coarse', 'scale'].every(
          key =>
            before[key as keyof CaptureViewport] ===
            expected[key as keyof typeof expected]
        ),
        'Browser capture geometry differs from its measured frame or observed variant'
      )
      assert(
        Number.isInteger(expectedRaster.width) &&
          Number.isInteger(expectedRaster.height),
        'Measured browser raster must have exact integral dimensions'
      )
      if (this.webZoom != null)
        assert(
          Math.abs(before.width * before.dpr - expectedRaster.width) <
            before.dpr + 0.000001 &&
            Math.abs(before.height * before.dpr - expectedRaster.height) <
              before.dpr + 0.000001,
          'Observed browser zoom must preserve the measured physical frame'
        )
      const screenshot = await cdp.send('Page.captureScreenshot', parameters)
      assert(typeof screenshot.data === 'string', 'Raw CDP PNG bytes required')
      const bytes = Buffer.from(screenshot.data, 'base64')
      const rawPath =
        destination +
        (bytes.subarray(0, 8).equals(PNG) ? '.raw.png' : '.raw.bin')
      writeFileSync(rawPath, bytes, { mode: 0o600, flag: 'wx' })
      const rawSha256 = digest(rawPath)
      observation.rawPath = rawPath
      observation.rawSha256 = rawSha256
      const after = await this.captureViewport()
      observation.after = after
      assert(
        (Object.keys(before) as Array<keyof CaptureViewport>).every(
          key => before[key] === after[key]
        ),
        'Read-only capture changed browser viewport, pixel scale or scroll'
      )
      assert(
        bytes.length >= 24 &&
          bytes.subarray(0, 8).equals(PNG) &&
          bytes.toString('ascii', 12, 16) === 'IHDR',
        'CDP capture must return actual PNG bytes without conversion'
      )
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      observation.actualRaster = { width, height }
      assert(
        width === expectedRaster.width && height === expectedRaster.height,
        'Viewport PNG dimensions differ from the exact measured browser raster'
      )
      writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' })
      observation.outcome = 'passed'
      return {
        rawPath,
        rawSha256,
        sha256: digest(destination),
        format: 'PNG',
        width,
        height,
        captureObserver: observation
      }
    } catch (error) {
      observation.outcome = 'failed'
      throw error
    }
  }

  async shot(kind: string, note: string): Promise<void> {
    assert(/^[a-z][a-z-]+$/.test(kind), 'Safe proof name required')
    if (
      this.surface === 'android' &&
      this.scenario === 'capture' &&
      ['conversation', 'floating-pins', 'attention'].includes(kind)
    ) {
      const before = need(
        this.androidClosedCapture,
        'Immutable actual Android dismissal witness required before closed-keyboard capture'
      )
      await this.verifyAndroidClosedCapture(before, Date.now() + 90000)
    }
    const file = `${this.surface}-${kind}-after.png`
    const path = join(
      this.runDir,
      String(this.captures.length + 1).padStart(3, '0') + '-' + file
    )
    const image = await this.captureImage(path)
    this.captures.push({
      file,
      path,
      at: new Date().toISOString(),
      note,
      ...image
    })
  }

  async finish(
    outcome: 'passed' | 'failed' | 'blocked',
    error?: unknown
  ): Promise<string> {
    try {
      if (outcome !== 'passed' && this.device != null) {
        try {
          await this.captureImage(join(this.runDir, 'failure.png'))
        } catch {}
        try {
          privateJson(
            join(this.runDir, 'failure-public-hierarchy.json'),
            await this.device.hierarchy()
          )
        } catch {}
        if (this.pageErrors.length > 0)
          privateJson(
            join(this.runDir, 'failure-page-errors.json'),
            this.pageErrors
          )
      }
    } finally {
      if (this.cdp != null) await this.cdp.detach().catch(() => {})
      if (this.browser != null) await this.browser.disconnect()
      // Cleanup cannot inherit the UI lease's expired AbortSignal.
      const daemon =
        this.daemon == null
          ? undefined
          : await this.connectCleanup?.().catch(() => this.daemon)
      const physical = this.physical
      if (daemon != null) {
        if (physical && this.deviceId !== '') {
          // Never power, reboot or reset a phone; only the QA app stops.
          try {
            await this.device?.stopApp({ appId: this.fixture.appId })
            this.cleanup.physicalAppStopped = true
          } catch (failure) {
            this.cleanup.physicalAppStopError = redact(
              this.fixture,
              String(failure)
            )
          }
        }
        try {
          await daemon.detach(this.deviceId)
        } catch (failure) {
          this.cleanup.detachError = redact(this.fixture, String(failure))
        }
        if (this.native && this.deviceId !== '' && !physical) {
          try {
            await daemon.stopDevice(this.deviceId, { force: true })
            this.cleanup.deviceStopRequested = true
          } catch (failure) {
            this.cleanup.deviceStopError = redact(this.fixture, String(failure))
          }
        }
        try {
          await daemon.shutdown({ wait: 20000 })
          this.cleanup.daemonStopped = true
        } catch (failure) {
          this.cleanup.daemonError = redact(this.fixture, String(failure))
          daemon.close()
        }
        this.cleanup.daemonPid = daemon.info?.pid
      }
      try {
        if (physical && this.deviceId !== '') {
          this.cleanup.nativeAbsence = {
            id: this.deviceId,
            physical: true,
            appStopped: this.cleanup.physicalAppStopped === true,
            absent: this.cleanup.physicalAppStopped === true
          }
        } else if (this.native && this.deviceId !== '') {
          const platform = this.surface
          if (platform === 'ios') {
            const result = spawnSync(
              'xcrun',
              ['simctl', 'shutdown', this.deviceId],
              { encoding: 'utf8', timeout: 10000 }
            )
            const inventory = spawnSync(
              'xcrun',
              ['simctl', 'list', 'devices', '--json'],
              { encoding: 'utf8', timeout: 8000 }
            )
            let state: string | undefined
            if (inventory.status === 0) {
              const data = JSON.parse(inventory.stdout) as {
                devices: Record<string, Array<{ udid: string; state: string }>>
              }
              state = Object.values(data.devices)
                .flat()
                .find(d => d.udid === this.deviceId)?.state
            }
            this.cleanup.nativeAbsence = {
              id: this.deviceId,
              state,
              shutdownExit: result.status,
              absent: state === 'Shutdown'
            }
          } else {
            const adb = process.env.CHAT2_ADB ?? 'adb'
            const name = spawnSync(
              adb,
              ['-s', this.deviceId, 'emu', 'avd', 'name'],
              { encoding: 'utf8', timeout: 3000 }
            )
            if (name.status === 0) {
              assert(
                name.stdout.split('\n')[0].trim() ===
                  this.fixture.devices.android.name,
                'Refuse shutting down another AVD'
              )
              spawnSync(adb, ['-s', this.deviceId, 'emu', 'kill'], {
                encoding: 'utf8',
                timeout: 5000
              })
            }
            let inventory = spawnSync(adb, ['devices', '-l'], {
              encoding: 'utf8',
              timeout: 5000
            })
            for (
              let i = 0;
              i < 30 &&
              inventory.status === 0 &&
              inventory.stdout
                .split('\n')
                .some(l => l.startsWith(this.deviceId + '\t'));
              i++
            ) {
              await new Promise(resolve => setTimeout(resolve, 200))
              inventory = spawnSync(adb, ['devices', '-l'], {
                encoding: 'utf8',
                timeout: 5000
              })
            }
            this.cleanup.nativeAbsence = {
              id: this.deviceId,
              absent:
                inventory.status === 0 &&
                !inventory.stdout
                  .split('\n')
                  .some(l => l.startsWith(this.deviceId + '\t')),
              inventory: inventory.stdout
            }
          }
        }
      } catch (failure) {
        this.cleanup.deviceVerificationError = redact(
          this.fixture,
          String(failure)
        )
      }
      const daemonStatus = spawnSync(
        process.env.MAESTRO_D_BIN ?? 'maestro-d',
        ['status', '--daemon', this.daemonName, '--json'],
        { encoding: 'utf8', timeout: 5000 }
      )
      this.cleanup.daemonAbsence = {
        name: this.daemonName,
        exit: daemonStatus.status,
        absent: daemonStatus.status === 3
      }
      this.cleanup.daemonStopped = daemonStatus.status === 3
      if (this.fixture.cleanupServices) {
        try {
          this.cleanup.services = fixtureControl(this.fixture, 'cleanup')
        } catch (failure) {
          this.cleanup.servicesError = redact(this.fixture, String(failure))
        }
      }
      if (
        this.freshBrowserProfile != null &&
        this.cleanup.daemonStopped === true
      )
        rmSync(this.freshBrowserProfile, { recursive: true, force: true })
      if (this.reportsDir != null) lockTree(this.reportsDir)
    }
    const receipt = join(this.runDir, 'result.json')
    const cleanupFailed =
      this.cleanup.daemonError != null ||
      this.cleanup.deviceStopError != null ||
      this.cleanup.servicesError != null ||
      this.cleanup.deviceVerificationError != null ||
      this.cleanup.daemonStopped !== true ||
      (this.native && object(this.cleanup.nativeAbsence).absent !== true)
    const result = {
      scenario: this.scenario,
      surface: this.surface,
      variant: process.env.CHAT2_VARIANT ?? 'default',
      outcome: cleanupFailed ? 'failed' : outcome,
      source: this.binding.source,
      applicationSource: this.binding.applicationSource,
      harnessSource: this.binding.harnessSource,
      binding: this.binding,
      fixtureOwnership: this.fixture.ownershipId,
      device: this.deviceId,
      daemon: this.daemonName,
      environment: this.environment,
      steps: this.steps,
      captures: this.captures,
      cleanup: this.cleanup,
      error:
        error == null
          ? undefined
          : redact(
              this.fixture,
              error instanceof Error ? error.message : 'Unknown harness failure'
            ),
      completedAt: new Date().toISOString(),
      method:
        'All UI actions through maestro-d TypeScript; CDP only for browser environment and read-only viewport capture observation; native capture through Maestro; captures prove composition, no smoothness/physical-haptic claim'
    }
    privateJson(receipt, result)
    if (result.outcome === 'passed' && this.scenario === 'capture') {
      const indexPath = join(this.artifactRoot, 'proof-index.json')
      const index = existsSync(indexPath)
        ? (JSON.parse(readFileSync(indexPath, 'utf8')) as { entries: Args[] })
        : { entries: [] as Args[] }
      for (const image of this.captures) {
        const file = String(image.file)
        const destination = join(this.artifactRoot, file)
        if (existsSync(destination))
          copyFileSync(destination, join(this.runDir, 'replaced-' + file))
        copyFileSync(String(image.path), destination)
        chmodSync(destination, 0o600)
        index.entries = index.entries.filter(row => row.file !== file)
        index.entries.push({
          ...image,
          source: this.binding.source,
          surface: this.surface,
          device: this.deviceId,
          receipt,
          imageFormat: 'PNG',
          evidenceStatus: 'captured',
          scenario: this.scenario,
          driver: this.native
            ? 'maestro-d TypeScript'
            : 'maestro-d TypeScript actions; read-only CDP viewport capture'
        })
      }
      privateJson(indexPath, index)
    }
    if (cleanupFailed)
      throw new Error(
        'Owned resource shutdown failed; see private result receipt'
      )
    return receipt
  }
}
