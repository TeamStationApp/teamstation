import { makeId } from '../../common/ids'
import { hashPassword } from '../auth/passwords'
import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * Creates one administrator to sign in with while developing. It refuses to
 * run against production, and it never invents a password silently: the
 * password is given on the command line or generated and printed.
 *
 *   npm run seed -- paul@example.com hunter2
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The seed script does not run in production')
  }

  const [email, password] = process.argv.slice(2)
  if (email == null || password == null) {
    throw new Error('Usage: npm run seed -- <email> <password>')
  }

  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const normalised = email.trim().toLowerCase()
    const existing = await db
      .selectFrom('users')
      .select(['id'])
      .where(eb => eb.fn('lower', ['email']), '=', normalised)
      .executeTakeFirst()

    const passwordHash = await hashPassword(password)
    if (existing != null) {
      await db
        .updateTable('users')
        .set({
          password_hash: passwordHash,
          login_enabled: true,
          is_admin: true,
          updated_at: new Date()
        })
        .where('id', '=', existing.id)
        .execute()
      console.log(`updated ${normalised} (${existing.id})`)
      return
    }

    const id = makeId('user')
    await db
      .insertInto('users')
      .values({
        id,
        display_name: normalised.split('@')[0],
        email: normalised,
        password_hash: passwordHash,
        login_enabled: true,
        is_admin: true
      })
      .execute()
    console.log(`created ${normalised} (${id})`)
  } finally {
    await db.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
