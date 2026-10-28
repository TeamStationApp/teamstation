// Checks a built server against keys made by the Node chat crypto core (S9):
// one seed person enrols a chat identity, and another's enrolment, with one
// byte of its PUK signature flipped, is refused.
//
//   npm run build
//   node scripts/chatCoreSmoke.mjs --api http://127.0.0.1:9100/api/v1 \
//     --seed <run dir>/seed.txt [--good Hc] [--bad C]
//
// The seed file is the table `npm run chat-seed` printed (scripts/
// chat-e2e-reset.sh keeps it), from a reset nobody has enrolled in since.
// Each person signs in with their seed password (never printed, and never
// sent: the client's Argon2id of it under the parameters the server gives,
// as the app does), registers a device, and sends `PUT /chat/identity` with an identity key, a PUK, the
// identity's signature over the PUK and the PUK boxed to the device, all from
// `lib/common/chatCrypto` — the code the server runs. The good enrolment
// must answer 201, the tampered one 400 `badSignature`. Each request is
// printed as a `$` line with its answer.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const lib = name => require(join(root, 'lib', 'common', 'chatCrypto', name))

function option(argv, name, fallback) {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}

const b64 = bytes => Buffer.from(bytes).toString('base64url')

/** The seed table's row for a person: key, names, user id, e-mail, password. */
function seedRow(text, key) {
  const row = text
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(cells => cells[0] === key)
  if (row == null) throw new Error(`${key} is not in the seed table`)
  return { userId: row[3], email: row[4], password: row[5] }
}

async function enrol(api, person, key, tamper) {
  const { newDeviceKeys, newIdentityKey, newPukKey } = lib('keys')
  const { signPuk } = lib('chain')
  const { hpkeSeal, pukAad } = lib('hpke')
  const { newIdentityId } = lib('messageIds')

  const { asArgonParameters, passwordBytes } = require(
    join(root, 'lib', 'common', 'passwordProtocol')
  )
  const { argon2id } = require('hash-wasm')
  const asked = await fetch(`${api}/auth/password/parameters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: person.email })
  })
  const parameters = asArgonParameters(await asked.json())
  const clientHash = await argon2id({
    password: passwordBytes(person.password),
    salt: Buffer.from(parameters.salt, 'hex'),
    memorySize: parameters.memoryKiB,
    iterations: parameters.iterations,
    parallelism: parameters.parallelism,
    hashLength: parameters.hashLength,
    outputType: 'hex'
  })
  const signIn = await fetch(`${api}/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: person.email, clientHash })
  })
  console.log(`$ POST /auth/password (${key}) -> ${signIn.status}`)
  if (signIn.status !== 200) throw new Error(`${key} could not sign in`)
  const cookie = signIn.headers
    .getSetCookie()
    .map(line => line.split(';')[0])
    .join('; ')
  const send = async (method, path, body) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    console.log(`$ ${method} ${path} (${key}) -> ${response.status} ${text}`)
    return {
      status: response.status,
      body: text === '' ? {} : JSON.parse(text)
    }
  }

  const keys = newDeviceKeys()
  const device = await send('POST', '/chat/devices', {
    name: 'chatCoreSmoke',
    platform: 'web',
    boxPublicKey: b64(keys.box.publicKey),
    signPublicKey: b64(keys.sign.publicKey)
  })
  if (device.status !== 201 && device.status !== 200) {
    throw new Error(`${key}'s device was not registered`)
  }

  const identityId = newIdentityId()
  const identity = newIdentityKey()
  const puk = newPukKey()
  const signature = signPuk(
    { userId: person.userId, generation: 1, publicKey: puk.publicKey },
    identity.secretKey
  )
  if (tamper) signature[0] ^= 1
  return await send('PUT', '/chat/identity', {
    identityId,
    identityPublicKey: b64(identity.publicKey),
    pukPublicKey: b64(puk.publicKey),
    pukSignature: b64(signature),
    box: b64(
      hpkeSeal(
        'puk',
        keys.box.publicKey,
        pukAad({
          userId: person.userId,
          identityId,
          generation: 1,
          deviceId: device.body.id
        }),
        puk.secretKey
      )
    )
  })
}

async function main(argv) {
  const api = option(argv, 'api', 'http://127.0.0.1:9100/api/v1').replace(
    /\/+$/,
    ''
  )
  const seedFile = option(argv, 'seed', undefined)
  if (seedFile == null) {
    console.error('usage: chatCoreSmoke.mjs --api <url> --seed <seed.txt>')
    return 2
  }
  const seed = readFileSync(seedFile, 'utf8')
  const good = option(argv, 'good', 'Hc')
  const bad = option(argv, 'bad', 'C')
  let failed = false

  const accepted = await enrol(api, seedRow(seed, good), good, false)
  if (accepted.status === 201) {
    console.log(`PASS ${good}'s identity, made by the Node core, was accepted`)
  } else {
    console.log(`FAIL ${good}'s identity answered ${accepted.status}`)
    failed = true
  }
  const refused = await enrol(api, seedRow(seed, bad), bad, true)
  const reason = refused.body?.details?.reason ?? refused.body?.reason
  if (refused.status === 400 && reason === 'badSignature') {
    console.log(`PASS ${bad}'s tampered PUK signature was refused`)
  } else {
    console.log(`FAIL ${bad}'s tampered identity answered ${refused.status}`)
    failed = true
  }
  return failed ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
