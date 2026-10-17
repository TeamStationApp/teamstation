import { asAccountEmail } from './accountSettings'

export function parseEmailList(text: string): {
  valid: string[]
  invalid: string[]
} {
  const valid = new Set<string>()
  const invalid = new Set<string>()
  for (const piece of text.split(/[,;\n]+/)) {
    const value = piece.trim().toLowerCase()
    if (value === '') continue
    try {
      valid.add(asAccountEmail(value))
    } catch {
      invalid.add(value)
    }
  }
  return { valid: [...valid], invalid: [...invalid] }
}
