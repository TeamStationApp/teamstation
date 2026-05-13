# React Native Web Migration Guide

## Overview

The GameStation front-end UI has been successfully ported to use **react-native-web**. This allows the React codebase to be written using React Native components while still rendering in a web browser.

## What Changed

### Dependencies Added

The following packages were added to support react-native-web:

- **react-native** (^0.76.6) - Core React Native library
- **react-native-web** (^0.19.13) - React Native for web implementation
- **react-native-linear-gradient** (^2.8.3) - Gradient support for React Native
- **react-native-web-linear-gradient** (^1.1.2) - Gradient support for web
- **react-router-dom** (^7.9.4) - React Router for web (kept for web compatibility)
- **@babel/core** (^7.26.0) - Babel core for transpilation
- **@babel/preset-env** (^7.26.0) - Babel preset for environment-specific transpilation
- **@babel/preset-react** (^7.26.3) - Babel preset for React
- **@babel/preset-typescript** (^7.26.0) - Babel preset for TypeScript
- **babel-loader** (^9.2.1) - Webpack loader for Babel
- **babel-plugin-react-native-web** (^0.19.12) - Babel plugin for react-native-web

### Configuration Files

#### 1. **babel.config.js** (New)
Added Babel configuration to support React Native transforms:
```javascript
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { browsers: ['last 2 versions'] } }],
    '@babel/preset-react',
    ['@babel/preset-typescript', { isTSX: true, allExtensions: true }]
  ],
  plugins: ['react-native-web']
}
```

#### 2. **webpack.config.js** (Updated)
Modified to support react-native-web:
- Added webpack aliases to map `react-native` to `react-native-web`
- Changed from `ts-loader` to `babel-loader` for TypeScript compilation
- Added `.web.tsx` and `.web.ts` to file extensions resolution
- Configured babel-loader to handle react-native transforms

Key changes:
```javascript
resolve: {
  extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.js', '.js'],
  alias: {
    'react-native$': 'react-native-web',
  }
}
```

### Component Conversions

All React components were converted from standard React DOM to React Native components:

#### **src/client/index.tsx**
- Changed from `ReactDOM.createRoot()` to React Native's `AppRegistry`
- Now uses `AppRegistry.registerComponent()` and `AppRegistry.runApplication()`

#### **src/client/App.tsx**
- Converted from HTML elements to React Native components:
  - `<div>` → `<View>`
  - `<img>` → `<Image>`
  - `<a>` / `<Link>` → `<Link>` with `<Pressable>`
- Replaced `BrowserRouter` with `NativeRouter` from `react-router-native`
- Converted CSS classes to StyleSheet API
- Removed `App.css` import

#### **src/client/Dashboard.tsx**
- Converted all HTML elements to React Native equivalents:
  - `<div>` → `<View>`
  - `<button>` → `<Pressable>`
  - `<span>` → `<Text>`
  - `<input type="checkbox">` → `<Switch>`
- Converted all CSS classes to `StyleSheet.create()`
- Removed `Dashboard.css` import
- Maintained all WebSocket functionality and state management

#### **src/client/Scoreboard.tsx**
- Converted all HTML elements to React Native components
- Converted CSS styling to StyleSheet API
- Removed `Scoreboard.css` import
- Maintained all WebSocket functionality and real-time updates

## Build Process

### Development Mode

To run the application in development mode with hot-reload:

```bash
npm run start.web
```

This will start the webpack dev server on http://localhost:8080

### Production Build

To build the application for production:

```bash
npm run build.web
```

This creates an optimized production build in the `dist/` directory.

### Server Build

The server-side code remains unchanged and can be built with:

```bash
npm run build.server
```

## CSS Files

The original CSS files (`App.css`, `Dashboard.css`, `Scoreboard.css`) are no longer imported or used. All styling is now done through React Native's `StyleSheet.create()` API, which provides:

- Type-safe styling
- Performance optimizations
- Consistent styling API across web and native platforms

These CSS files can be kept for reference or deleted:
- `src/client/App.css`
- `src/client/Dashboard.css`
- `src/client/Scoreboard.css`

## Styling Notes

React Native Web supports most React Native styling properties. Some CSS features were adapted:

1. **Gradients**: Converted to `backgroundImage` with `linear-gradient()` (supported in react-native-web)
2. **Flexbox**: React Native uses flexbox by default
3. **Shadows**: Converted to `shadowColor`, `shadowOffset`, `shadowOpacity`, `shadowRadius` (iOS-style) and `elevation` (Android-style)
4. **Transforms**: Converted to array format: `transform: [{ rotate: '45deg' }]`
5. **Text Styles**: Separated from container styles (must be applied to `<Text>` components)

## Router Changes

- **Before**: `react-router-dom` with `BrowserRouter`
- **After**: `react-router-native` with `NativeRouter`

The routing API remains largely the same (`Routes`, `Route`, `Link`), but components are React Native-based.

## Known Limitations

1. **React Version**: There are peer dependency warnings about React 19 compatibility. React Native Web and React Router Native officially support React 18, but they work with React 19 in most cases.

2. **Linear Gradients**: The `backgroundImage` property is a web-specific extension in react-native-web. For true cross-platform support (web + iOS + Android), consider using a library like `react-native-linear-gradient`.

3. **Some CSS Properties**: Not all CSS properties are supported in React Native. The codebase uses primarily the core React Native style properties that work across platforms.

## Future Enhancements

To support native mobile platforms (iOS/Android), you would need to:

1. Install React Native CLI or Expo
2. Replace web-specific code (like `window.location`, `WebSocket` direct usage)
3. Add platform-specific entry points
4. Replace gradient implementations with `react-native-linear-gradient`
5. Test and adjust styling for mobile devices

## Testing

After migration:
1. Test all routes: `/`, `/scoreboard`, `/dashboard`
2. Verify WebSocket connections work correctly
3. Test all interactive elements (buttons, switches, diamonds)
4. Verify responsive behavior on different screen sizes
5. Check that images load correctly

## Troubleshooting

### Build Errors

If you encounter build errors:

1. Clear build cache: `rm -rf dist node_modules/.cache`
2. Reinstall dependencies: `npm install`
3. Rebuild: `npm run build.web`

### Runtime Errors

If you see "React is not defined" or similar errors:
- Check that babel-loader is correctly configured in webpack
- Verify that the babel plugin `react-native-web` is installed

### Styling Issues

If styles don't appear correctly:
- Check browser console for style warnings
- Verify that all style properties are valid React Native styles
- Use browser dev tools to inspect applied styles

## Summary

The migration to react-native-web is complete and maintains all existing functionality while providing:

- ✅ Same component API across web (and potentially mobile)
- ✅ Type-safe styling with StyleSheet
- ✅ Performance optimizations
- ✅ Future-ready for native mobile development
- ✅ All original features preserved (WebSockets, routing, interactivity)

The application should build and run exactly as before, just using React Native components under the hood!

