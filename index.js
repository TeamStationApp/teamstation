/**
 * The native entry point, and the only file Metro is pointed at.
 *
 * It is `.js` rather than `.tsx` because the Xcode and Gradle build phases
 * name it literally; everything it pulls in is TypeScript. The work is in
 * `src/app/native/index.tsx`, the native twin of `src/app/web/index.tsx`.
 */
import { AppRegistry } from 'react-native'

import { name as appName } from './app.json'
import { Root } from './src/app/native/index'
import { registerPushTasks } from './src/app/push/chatWakeTask'

// The tasks Android runs for a push (push/PushHandler.kt), with the app open
// or not.
registerPushTasks(AppRegistry)
AppRegistry.registerComponent(appName, () => Root)
