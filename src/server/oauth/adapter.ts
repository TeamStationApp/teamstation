import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto'

import { asObject, asString, asUnknown } from 'cleaners'
import { type Kysely, sql } from 'kysely'
import { type Adapter, type AdapterPayload, errors } from 'oidc-provider'

import type { Database } from '../db/database'

export const oauthHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

export function sealPayload(
  payload: unknown,
  key: Buffer,
  context: string
): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(context))
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final()
  ])
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString(
    'base64url'
  )
}

export function openPayload(
  value: string,
  key: Buffer,
  context: string
): AdapterPayload {
  const bytes = Buffer.from(value, 'base64url')
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  cipher.setAAD(Buffer.from(context))
  cipher.setAuthTag(bytes.subarray(12, 28))
  const clear = Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final()
  ])
  // The provider owns the evolving payload schema; validate the JSON object
  // boundary, with authentication binding it to this model and identifier.
  return asObject(asUnknown)(JSON.parse(clear.toString()))
}

export async function liveGrant(
  db: Kysely<Database>,
  grantHash: string
): Promise<boolean> {
  const result = await sql`
    select 1 from oauth_grant_sessions g
    join auth_sessions s on s.id = g.session_id and s.user_id = g.user_id
    join users u on u.id = g.user_id
    where g.grant_hash = ${grantHash} and s.revoked_at is null and s.expires_at > now()
      and u.login_enabled and u.merged_into is null`.execute(db)
  return result.rows.length === 1
}

export function makeOAuthAdapter(
  db: Kysely<Database>,
  key: Buffer
): new (name: string) => Adapter {
  return class implements Adapter {
    constructor(private readonly model: string) {}

    async upsert(
      id: string,
      payload: AdapterPayload,
      expiresIn?: number
    ): Promise<void> {
      const idHash = oauthHash(id)
      const encrypted = sealPayload(payload, key, `${this.model}:${idHash}`)
      await sql`
        insert into oauth_records (model, id_hash, payload, expires_at, uid_hash, user_code_hash, grant_hash)
        values (${this.model}, ${idHash}, ${encrypted},
          ${expiresIn == null ? null : new Date(Date.now() + expiresIn * 1000)},
          ${payload.uid == null ? null : oauthHash(payload.uid)},
          ${payload.userCode == null ? null : oauthHash(payload.userCode)},
          ${payload.grantId == null ? null : oauthHash(payload.grantId)})
        on conflict (model, id_hash) do update set payload = excluded.payload,
          expires_at = excluded.expires_at, uid_hash = excluded.uid_hash,
          user_code_hash = excluded.user_code_hash, grant_hash = excluded.grant_hash`.execute(
        db
      )
    }

    private async lookup(
      column: 'id_hash' | 'uid_hash' | 'user_code_hash',
      value: string
    ): Promise<AdapterPayload | undefined> {
      const result = await sql`
        select id_hash, payload, consumed_at, grant_hash from oauth_records
        where model = ${this.model} and ${sql.ref(column)} = ${oauthHash(value)}
          and (expires_at is null or expires_at > now())`.execute(db)
      if (result.rows.length !== 1) return undefined
      const row = asObject({
        id_hash: asString,
        payload: asString,
        consumed_at: asUnknown,
        grant_hash: asUnknown
      })(result.rows[0])
      const grantHash = this.model === 'Grant' ? row.id_hash : row.grant_hash
      if (typeof grantHash === 'string' && !(await liveGrant(db, grantHash)))
        return undefined
      const payload = openPayload(
        row.payload,
        key,
        `${this.model}:${row.id_hash}`
      )
      if (row.consumed_at != null) payload.consumed = true
      return payload
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      return await this.lookup('id_hash', id)
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return await this.lookup('uid_hash', uid)
    }

    async findByUserCode(code: string): Promise<AdapterPayload | undefined> {
      return await this.lookup('user_code_hash', code)
    }

    async consume(id: string): Promise<void> {
      const result = await sql`update oauth_records set consumed_at = now()
        where model = ${this.model} and id_hash = ${oauthHash(id)} and consumed_at is null
        and (expires_at is null or expires_at > now()) returning id_hash`.execute(
        db
      )
      if (result.rows.length !== 1)
        throw new errors.InvalidGrant(
          'Authorization was already used or expired'
        )
    }

    async destroy(id: string): Promise<void> {
      await sql`delete from oauth_records where model = ${this.model} and id_hash = ${oauthHash(id)}`.execute(
        db
      )
    }

    async revokeByGrantId(id: string): Promise<void> {
      await db.transaction().execute(async tx => {
        await sql`delete from oauth_records where grant_hash = ${oauthHash(id)} or (model = 'Grant' and id_hash = ${oauthHash(id)})`.execute(
          tx
        )
        await sql`delete from oauth_grant_sessions where grant_hash = ${oauthHash(id)}`.execute(
          tx
        )
      })
    }
  }
}
