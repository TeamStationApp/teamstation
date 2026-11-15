/** `*` within a path segment, `**` across them. Enough for `covers` globs. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (char === '*') {
      out += '[^/]*'
    } else {
      out += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some(glob => globToRegExp(glob).test(path))
}
