import React from 'react'
import { AppRegistry } from 'react-native'

import { App } from '../app/App'
import { changeTheme } from '../app/theme/ThemeContext'
import { tsBallpark } from '../app/theme/tsBallpark'
import { tsDark } from '../app/theme/tsDark'

// Test-only entry: the real application and API with selectable presentation.
const query = new URLSearchParams(location.search)
const base = query.get('fixtureTheme') === 'dark' ? tsDark : tsBallpark
const scale = query.get('fixtureLarge') === '1' ? 1.5 : 1
changeTheme({ ...base, rem: n => base.rem(n) * scale })
document.body.style.backgroundColor = base.backgroundColor
AppRegistry.registerComponent('SharedListCards', () => () => (
  <App apiBaseUrl="/api/v1" />
))
AppRegistry.runApplication('SharedListCards', {
  rootTag: document.getElementById('root')
})
