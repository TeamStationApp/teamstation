import { AppRegistry } from 'react-native'

import App from './App'

// Register the app
AppRegistry.registerComponent('gamestation', () => App)

// Run the app
AppRegistry.runApplication('gamestation', {
  rootTag: document.getElementById('root')
})
