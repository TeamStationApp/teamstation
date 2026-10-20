import { addEmail, findUserByEmail } from '../auth/emails'
import { hashPassword } from '../auth/passwords'
import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'
import { insertUser } from '../users/insertUser'

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
    const existing = await findUserByEmail(db, normalised)

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

    const userId = await insertUser(db, {
      display_name: normalised.split('@')[0],
      password_hash: passwordHash,
      login_enabled: true,
      is_admin: true
    })
    await addEmail(db, userId, normalised, {
      isPrimary: true,
      source: 'manual'
    })
    console.log(`created ${normalised} (${userId})`)
  } finally {
    await db.destroy()
  }
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('/seed.ts') || entry.endsWith('/seed.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
