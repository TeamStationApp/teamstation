// Top-level build file. Everything the app needs is declared in app/build.gradle.kts; this exists
// to pin the plugin versions in one place.
//
// Deliberately not a React Native project: nothing in this app is shared with JavaScript, and a JS
// bridge between a camera and a socket would be a frame-rate problem with no upside.
plugins {
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.1.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.20" apply false
}
