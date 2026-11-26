import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

import { transform } from 'sucrase'

export function installedNativeUrl(): typeof URL {
  const path = require.resolve('react-native/Libraries/Blob/URL.js')
  const source = transform(readFileSync(path, 'utf8'), {
    transforms: ['flow', 'imports']
  }).code
  const module: { exports: Partial<{ URL: typeof URL }> } = { exports: {} }
  new Script(`(function(require,module,exports){${source}\n})`, {
    filename: path
  }).runInThisContext()(
    (name: string) => (name.endsWith('NativeBlobModule') ? null : {}),
    module,
    module.exports
  )
  return module.exports.URL!
}
