/** Shape validation; the runtime cleaner also checks the positive 128-bit range. */
export const userIdSchema = {
  type: 'string',
  pattern: '^usr_[1-9A-HJ-NP-Za-km-z]{22}$',
  minLength: 26,
  maxLength: 26,
  description:
    'Case-sensitive canonical positive 128-bit Base58 account identity'
}

export const nullableGumboIdSchema = {
  type: ['integer', 'null'],
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: 'Independent scoring identity; null until one is allocated'
}
