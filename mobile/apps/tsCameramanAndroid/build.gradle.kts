// Top-level build file. Everything the app needs is declared in app/build.gradle.kts; this exists
// to pin the plugin versions in one place.
//
// Deliberately not a React Native project: nothing in this app is shared with JavaScript, and a JS
// bridge between a camera and a socket would be a frame-rate problem with no upside. It does build
// on the React Native app's toolchain (the Android Gradle plugin `@react-native/gradle-plugin`
// pins, its Kotlin, the same Gradle), because both apps compile the shared `:streamcore` library.
plugins {
    id("com.android.application") version "9.2.1" apply false
    id("com.android.library") version "9.2.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.0" apply false
    id("org.jetbrains.kotlinx.kover") version "0.9.1" apply false
}

// Coverage for the shared library is applied from here rather than in its own build file, so the
// React Native app, which has no Kover, includes the module unchanged.
project(":streamcore") {
    apply(plugin = "org.jetbrains.kotlinx.kover")
}
