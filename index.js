/**
 * The native entry point, and the only file Metro is pointed at.
 *
 * It is `.js` rather than `.tsx` because the Xcode and Gradle build phases
 * name it literally; everything it pulls in is TypeScript. The work is in
 * `src2/app/native/index.tsx`, the native twin of `src2/app/web/index.tsx`.
 */
import { AppRegistry } from 'react-native'

import { name as appName } from './app.json'
import { Root } from './src2/app/native/index'

AppRegistry.registerComponent(appName, () => Root)
