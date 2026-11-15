/**
 * Every address a fixture or a test uses is a `+` address on one mailbox, named at
 * run time and never in this repository, so mail can only go where a test reads it.
 */
export function splitMailbox(mailbox: string): {
  local: string
  domain: string
} {
  const at = mailbox.indexOf('@')
  if (at < 1 || at === mailbox.length - 1 || mailbox.includes('+')) {
    throw new Error(`"${mailbox}" is not a plain mailbox address`)
  }
  return { local: mailbox.slice(0, at), domain: mailbox.slice(at + 1) }
}

export function testAddress(mailbox: string, label: string): string {
  const { local, domain } = splitMailbox(mailbox)
  return `${local}+${label}@${domain}`.toLowerCase()
}

export function isTestAddress(mailbox: string, email: string): boolean {
  const { local, domain } = splitMailbox(mailbox)
  const lower = email.toLowerCase()
  return (
    lower.startsWith(`${local.toLowerCase()}+`) &&
    lower.endsWith(`@${domain.toLowerCase()}`)
  )
}
