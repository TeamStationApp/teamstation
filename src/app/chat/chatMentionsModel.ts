import { MAX_BODY } from '../../common/chatContent'
import type { MessageView } from './engine/apply'
import type { MemberView } from './engine/engine'

export interface MentionToken {
  userId: number
  start: number
  end: number
  label: string
}
export interface ComposerSelection {
  start: number
  end: number
}
export interface ComposerChange {
  selection: ComposerSelection
  key?: string
}
export interface MentionRequest {
  text: string
  start: number
  end: number
}

/** DOM/native selection offsets are UTF-16; do not split a surrogate pair. */
const boundary = (text: string, offset: number): boolean =>
  !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  )

export function textEdit(
  before: string,
  after: string,
  change?: ComposerChange
): { start: number; beforeEnd: number; afterEnd: number } {
  const selection = change?.selection
  if (
    selection != null &&
    Number.isInteger(selection.start) &&
    Number.isInteger(selection.end) &&
    selection.start >= 0 &&
    selection.end >= selection.start &&
    selection.end <= before.length
  ) {
    const delta = after.length - before.length
    const ranges =
      selection.start !== selection.end || delta >= 0
        ? [{ start: selection.start, end: selection.end }]
        : change?.key === 'Delete'
          ? [{ start: selection.start, end: selection.start - delta }]
          : change?.key === 'Backspace'
            ? [{ start: selection.start + delta, end: selection.end }]
            : [
                { start: selection.start + delta, end: selection.end },
                { start: selection.start, end: selection.start - delta }
              ]
    const valid = ranges.filter(
      range =>
        range.start >= 0 &&
        range.end <= before.length &&
        boundary(before, range.start) &&
        boundary(before, range.end) &&
        before.slice(0, range.start) === after.slice(0, range.start) &&
        before.slice(range.end) === after.slice(range.end + delta)
    )
    if (valid.length > 0) {
      const start = Math.min(...valid.map(range => range.start))
      const beforeEnd = Math.max(...valid.map(range => range.end))
      return { start, beforeEnd, afterEnd: beforeEnd + delta }
    }
  }
  let start = 0
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start += 1
  while (start > 0 && (!boundary(before, start) || !boundary(after, start)))
    start -= 1
  let suffix = 0
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix += 1
  while (
    suffix > 0 &&
    (!boundary(before, before.length - suffix) ||
      !boundary(after, after.length - suffix))
  )
    suffix -= 1
  return {
    start,
    beforeEnd: before.length - suffix,
    afterEnd: after.length - suffix
  }
}

export function validMentionTokens(
  text: string,
  tokens: readonly MentionToken[] = []
): MentionToken[] {
  const valid = tokens
    .filter(
      token =>
        Number.isSafeInteger(token.userId) &&
        token.userId > 0 &&
        Number.isInteger(token.start) &&
        Number.isInteger(token.end) &&
        token.start >= 0 &&
        token.end > token.start &&
        token.end <= text.length &&
        token.label.startsWith('@') &&
        (token.start === 0 || /[\s([{]/u.test(text[token.start - 1])) &&
        (token.end === text.length ||
          !/[\p{L}\p{N}_]/u.test(text[token.end])) &&
        text.slice(token.start, token.end) === token.label &&
        boundary(text, token.start) &&
        boundary(text, token.end)
    )
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end))
  let end = -1
  return valid.filter((token, index) => {
    const overlaps =
      token.start < end || (valid[index + 1]?.start ?? Infinity) < token.end
    end = Math.max(end, token.end)
    return !overlaps
  })
}

/** Edits around a range move it; replacing any part of its label invalidates it. */
export function reconcileMentions(
  before: string,
  after: string,
  tokens: readonly MentionToken[] = [],
  change?: ComposerChange
): MentionToken[] {
  const current = validMentionTokens(before, tokens)
  if (before === after) return current
  const edit = textEdit(before, after, change)
  const delta = after.length - before.length
  return validMentionTokens(
    after,
    current.flatMap(token => {
      if (token.end <= edit.start) return [token]
      if (token.start >= edit.beforeEnd)
        return [
          { ...token, start: token.start + delta, end: token.end + delta }
        ]
      return []
    })
  )
}

/** Only a newly typed standalone at-sign opens the chooser; ordinary text stays text. */
export function mentionRequest(
  before: string,
  after: string,
  change?: ComposerChange
): MentionRequest | undefined {
  const edit = textEdit(before, after, change)
  if (after.slice(edit.start, edit.afterEnd) !== '@') return undefined
  if (edit.start > 0 && !/[\s([{]/u.test(after[edit.start - 1]))
    return undefined
  return { text: after, start: edit.start, end: edit.afterEnd }
}

export function insertMention(
  request: MentionRequest,
  current: string,
  tokens: readonly MentionToken[] | undefined,
  member: Pick<MemberView, 'userId' | 'shortName'>
):
  | { text: string; tokens: MentionToken[]; selection: ComposerSelection }
  | undefined {
  if (
    request.text !== current ||
    current.slice(request.start, request.end) !== '@'
  )
    return undefined
  const label = '@' + member.shortName
  const tail = current.slice(request.end)
  const space = tail === '' || !/^\s/u.test(tail) ? ' ' : ''
  const text = current.slice(0, request.start) + label + space + tail
  if (Array.from(text).length > MAX_BODY) return undefined
  const next = reconcileMentions(current, text, tokens, {
    selection: { start: request.start, end: request.end }
  })
  next.push({
    userId: member.userId,
    start: request.start,
    end: request.start + label.length,
    label
  })
  const caret =
    request.start +
    label.length +
    (space.length > 0 ? space.length : /^\s/u.test(tail) ? 1 : 0)
  return {
    text,
    tokens: next.sort((a, b) => a.start - b.start),
    selection: { start: caret, end: caret }
  }
}

export function sameMentionTokens(
  before: readonly MentionToken[] | undefined,
  after: readonly MentionToken[] | undefined
): boolean {
  if (before == null || after == null) return before === after
  return (
    before.length === after.length &&
    before.every((token, index) => {
      const next = after[index]
      return (
        token.userId === next.userId &&
        token.start === next.start &&
        token.end === next.end &&
        token.label === next.label
      )
    })
  )
}

/** Stable IDs come only from intact selected ranges and current membership. */
export function mentionIds(
  text: string,
  tokens: readonly MentionToken[] | undefined,
  members: ReadonlyArray<Pick<MemberView, 'userId'>>,
  editing?: MessageView
): number[] {
  const current = new Set(members.map(member => member.userId))
  // A legacy edit with untouched text may retain its authenticated IDs without guessing ranges.
  const ids =
    tokens == null && editing?.body.trim() === text.trim()
      ? editing.mentions
      : validMentionTokens(text, tokens).map(token => token.userId)
  return [...new Set(ids)].filter(id => current.has(id))
}
