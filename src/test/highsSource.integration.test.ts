import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

interface Pin {
  url: string
  sha256: string
}

interface Emscripten {
  home: string
  config: string
  emcc: string
  emcmake: string
  version: string
}

const {
  sha256,
  unpackPinned,
  pinned,
  emscripten,
  emscriptenHost,
  emscriptenHome,
  emscriptenConfig,
  cmakeHost,
  cmakePinned
}: {
  sha256: (bytes: Buffer) => string
  unpackPinned: (
    pin: Pin,
    into: string,
    fetchBytes: (url: string) => Promise<Buffer>
  ) => Promise<string>
  pinned: () => {
    cmake: { version: string; hosts: Record<string, Pin> }
    emscripten: {
      version: string
      releaseHash: string
      hosts: Record<string, Pin>
    }
  }
  emscripten: (
    env?: Record<string, string | undefined>,
    host?: string,
    fetchBytes?: (url: string) => Promise<Buffer>
  ) => Promise<Emscripten>
  emscriptenHost: (platform?: string, arch?: string) => string
  emscriptenHome: (
    env?: Record<string, string | undefined>,
    host?: string
  ) => string
  emscriptenConfig: (home: string, node?: string) => string
  cmakeHost: (platform?: string, arch?: string) => string
  cmakePinned: (host?: string) => { into: string; bin: string }
} = require('../../scripts/highsSource.mjs')

const {
  findPython,
  withoutVirtualHome,
  wasmFlags
}: {
  findPython: (
    env?: Record<string, string | undefined>,
    probe?: (
      command: string,
      args: string[],
      options: object
    ) => { error?: Error; status: number | null; stdout: string }
  ) => { python?: string; version?: string; error?: string }
  withoutVirtualHome: (bytes: Buffer) => Buffer
  wasmFlags: (env?: Record<string, string | undefined>) => string
} = require('../../scripts/schedulerBuild.mjs')

describe('the pinned HiGHS source', function () {
  const scratch = mkdtempSync(join(tmpdir(), 'highs-source-'))
  after(function () {
    rmSync(scratch, { recursive: true, force: true })
  })

  /** A release archive with its one top directory and these files. */
  function release(name: string, files: Record<string, string>): Buffer {
    const top = join(scratch, 'src', name)
    mkdirSync(top, { recursive: true })
    for (const [file, text] of Object.entries(files))
      writeFileSync(join(top, file), text)
    const archive = join(scratch, `${name}.tar.gz`)
    execFileSync('tar', ['-czf', archive, '-C', join(scratch, 'src'), name])
    return readFileSync(archive)
  }

  it('unpacks a pin once, replaces the whole tree for a new one, and keeps no archive', async function () {
    const into = join(scratch, 'vendor', 'HiGHS')
    const first = release('HiGHS-1', { 'old.h': 'old', 'kept.h': 'one' })
    const second = release('HiGHS-2', { 'kept.h': 'two' })
    const fetched: string[] = []
    const fetchBytes = async (url: string): Promise<Buffer> => {
      fetched.push(url)
      return url === 'one' ? first : second
    }
    await unpackPinned({ url: 'one', sha256: sha256(first) }, into, fetchBytes)
    expect(readFileSync(join(into, 'old.h'), 'utf8')).equals('old')
    await unpackPinned({ url: 'one', sha256: sha256(first) }, into, fetchBytes)
    expect(fetched).deep.equals(['one'])
    await unpackPinned({ url: 'two', sha256: sha256(second) }, into, fetchBytes)
    expect(readFileSync(join(into, 'kept.h'), 'utf8')).equals('two')
    expect(existsSync(join(into, 'old.h'))).equals(false)
    expect(existsSync(`${into}.tar.gz`)).equals(false)
    expect(existsSync(`${into}.unpacking`)).equals(false)
  })

  it('refuses bytes that are not the pinned ones, and leaves the tree as it was', async function () {
    const into = join(scratch, 'vendor', 'Refused')
    const good = release('Good', { 'a.h': 'a' })
    await unpackPinned(
      { url: 'good', sha256: sha256(good) },
      into,
      async () => good
    )
    let refused: unknown
    await unpackPinned(
      { url: 'bad', sha256: 'f'.repeat(64) },
      into,
      async () => good
    ).catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).matches(/refusing it/)
    expect(readFileSync(join(into, 'a.h'), 'utf8')).equals('a')
  })

  it('pins doctest’s single header, and the committed one is those bytes', function () {
    const root = join(__dirname, '..', '..')
    const pins = JSON.parse(
      readFileSync(join(root, 'native', 'highs', 'highs-source.json'), 'utf8')
    ) as { doctest: { version: string; url: string; sha256: string } }
    expect(pins.doctest.version).equals('2.4.11')
    expect(pins.doctest.url).contains(`/v${pins.doctest.version}/`)
    const header = readFileSync(
      join(root, 'native', 'scheduler', 'test', 'doctest.h')
    )
    expect(sha256(header)).equals(pins.doctest.sha256)
    expect(header.toString('utf8')).contains(
      `#define DOCTEST_VERSION_PATCH ${pins.doctest.version.split('.')[2]}`
    )
    expect(
      existsSync(
        join(root, 'native', 'scheduler', 'test', 'doctest.LICENSE.txt')
      )
    ).equals(true)
  })

  it('pins Emscripten for this Mac and the Linux hosts, from the release’s own builds', function () {
    const pin = pinned().emscripten
    expect(pin.version).matches(/^\d+\.\d+\.\d+$/)
    expect(pin.releaseHash).matches(/^[0-9a-f]{40}$/)
    expect(Object.keys(pin.hosts).sort()).deep.equals([
      'linux-x64',
      'mac-arm64'
    ])
    const os: Record<string, string> = {
      'linux-x64': 'linux',
      'mac-arm64': 'mac'
    }
    for (const [host, entry] of Object.entries(pin.hosts)) {
      expect(entry.url, host).matches(
        new RegExp(
          `^https://storage\\.googleapis\\.com/webassembly/emscripten-releases-builds/${os[host]}/${pin.releaseHash}/wasm-binaries[-a-z0-9]*\\.tar\\.xz$`
        )
      )
      expect(entry.sha256, host).matches(/^[0-9a-f]{64}$/)
    }
    expect(emscriptenHost('darwin', 'arm64')).equals('mac-arm64')
    expect(emscriptenHost('linux', 'x64')).equals('linux-x64')
    expect(emscriptenHost('win32', 'ia32')).equals('win32-ia32')
    expect(emscriptenHome({ HOME: '/h' }, 'mac-arm64')).equals(
      `/h/.cache/teamstation/emscripten-${pin.version}-mac-arm64`
    )
    expect(
      emscriptenHome({ HOME: '/h', TS_EMSCRIPTEN_HOME: '/opt/em' }, 'mac-arm64')
    ).equals('/opt/em')
    expect(emscriptenConfig('/em', '/bin/node').split('\n')).deep.equals([
      'LLVM_ROOT = "/em/bin"',
      'BINARYEN_ROOT = "/em"',
      'NODE_JS = "/bin/node"',
      'CACHE = "/em/emscripten/cache"',
      ''
    ])
  })

  it('pins CMake for the Mac and Linux x64 from Kitware’s releases, each unpacking to its own cmake', function () {
    const pin = pinned().cmake
    expect(pin.version).matches(/^\d+\.\d+\.\d+$/)
    expect(Object.keys(pin.hosts).sort()).deep.equals(['linux-x64', 'mac'])
    const file: Record<string, string> = {
      'linux-x64': 'linux-x86_64',
      mac: 'macos-universal'
    }
    for (const [host, entry] of Object.entries(pin.hosts)) {
      expect(entry.url, host).equals(
        `https://github.com/Kitware/CMake/releases/download/v${pin.version}/cmake-${pin.version}-${file[host]}.tar.gz`
      )
      expect(entry.sha256, host).matches(/^[0-9a-f]{64}$/)
    }
    expect(cmakeHost('darwin', 'arm64')).equals('mac')
    expect(cmakeHost('darwin', 'x64')).equals('mac')
    expect(cmakeHost('linux', 'x64')).equals('linux-x64')
    const mac = cmakePinned('mac')
    expect(mac.bin).equals(
      join(mac.into, 'CMake.app', 'Contents', 'bin', 'cmake')
    )
    const linux = cmakePinned('linux-x64')
    expect(linux.into).not.equals(mac.into)
    expect(linux.bin).equals(join(linux.into, 'bin', 'cmake'))
  })

  it('fetches the Linux CMake as pinned, with its cmake where the build runs it', async function () {
    this.timeout(600_000)
    const into = join(scratch, 'cmake-linux-x64')
    await unpackPinned(pinned().cmake.hosts['linux-x64'], into, async url => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${url} answered ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    })
    expect(existsSync(join(into, 'bin', 'cmake'))).equals(true)
  })

  it('refuses a host with no Emscripten pinned, and a release that is not the pinned bytes', async function () {
    let refused: unknown
    await emscripten({ HOME: scratch }, 'win32-ia32').catch(
      (error: unknown) => {
        refused = error
      }
    )
    expect(String(refused)).matches(
      /No Emscripten is pinned for win32-ia32.*mac-arm64, linux-x64/
    )
    refused = undefined
    await emscripten(
      { HOME: scratch, TS_EMSCRIPTEN_HOME: join(scratch, 'em') },
      emscriptenHost(),
      async () => Buffer.from('not the release')
    ).catch((error: unknown) => {
      refused = error
    })
    expect(String(refused)).matches(/refusing it/)
    expect(existsSync(join(scratch, 'em', 'emscripten'))).equals(false)
  })

  it('fetches this host’s Emscripten once, checked, with a config naming it', async function () {
    this.timeout(900_000)
    const found = await emscripten()
    const pin = pinned().emscripten
    expect(found.version).equals(pin.version)
    expect(readFileSync(join(found.home, '.sha256'), 'utf8')).equals(
      pin.hosts[emscriptenHost()].sha256
    )
    expect(readFileSync(found.config, 'utf8')).equals(
      emscriptenConfig(found.home)
    )
    const python = findPython()
    if (python.error != null) expect.fail(python.error)
    const version = execFileSync(found.emcc, ['--version'], {
      env: {
        ...process.env,
        EM_CONFIG: found.config,
        EMSDK_PYTHON: python.python
      },
      encoding: 'utf8'
    })
    expect(version).contains(pin.version)
    // A second call reads the marker and fetches nothing.
    const again = await emscripten(process.env, emscriptenHost(), async () => {
      throw new Error('fetched again')
    })
    expect(again.home).equals(found.home)
  })

  it('needs python3 3.8 or later, and builds the module with no build-host path', function () {
    const answer =
      (stdout: string, status = 0) =>
      () => ({ status, stdout })
    expect(findPython({}, answer('/usr/bin/python3\n3 9\n'))).deep.equals({
      python: '/usr/bin/python3',
      version: '3.9'
    })
    expect(findPython({}, answer('/usr/bin/python3\n3 7\n')).error).matches(
      /is 3\.7: .* needs 3\.8 or later/
    )
    expect(findPython({}, answer('/usr/bin/python2\n2 7\n')).error).matches(
      /is 2\.7/
    )
    expect(findPython({}, answer('', 1)).error).matches(/No python3 on PATH/)
    expect(
      findPython({}, () => ({
        error: new Error('ENOENT'),
        status: null,
        stdout: ''
      })).error
    ).matches(/No python3 on PATH/)
    expect(findPython().error).equals(undefined)
    const flags = wasmFlags({ HOME: '/Users/someone' })
    expect(flags).contains('-g0')
    expect(flags).contains('-fwasm-exceptions')
    expect(flags).contains('-ffile-prefix-map=/Users/someone=home')
    expect(
      withoutVirtualHome(
        Buffer.from('HOME:"/home/web_user",x="/home/other"')
      ).toString()
    ).equals('HOME:"",x="/home/other"')
  })
})
