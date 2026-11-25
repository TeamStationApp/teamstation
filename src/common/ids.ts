import { randomBytes } from 'crypto'

import { type IdKind, idPrefixes } from './idPrefixes'

export { type IdKind, idPrefixes, isId } from './idPrefixes'

export function makeId(kind: IdKind): string {
  return `${idPrefixes[kind]}_${randomBytes(12).toString('base64url')}`
}
