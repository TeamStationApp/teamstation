import { asUserId, type UserId } from '../common/userId'

/** A person who can sign in, as the chat seed's table prints them. */
export interface SeedTablePerson {
  userId: UserId
  /** First and last name. */
  name: string
  email: string
  password: string
}

/**
 * The people in `describeSeed`'s table (`npm run chat-seed`, kept as
 * `seed.txt`), by key, for the end-to-end runs to sign in as. Ids are the
 * canonical `usr_` strings, compared as they are; the person with no
 * account has no e-mail and is left out.
 */
export function readSeedTable(text: string): Record<string, SeedTablePerson> {
  const people: Record<string, SeedTablePerson> = {}
  for (const line of text.split('\n')) {
    const row = /^(\S+) +(.+?) +(usr_\S+) +(\S+@\S+) +(.+)$/.exec(line)
    if (row == null) continue
    people[row[1]] = {
      userId: asUserId(row[3]),
      name: row[2],
      email: row[4],
      password: row[5]
    }
  }
  return people
}
