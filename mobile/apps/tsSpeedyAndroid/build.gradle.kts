// Top-level build file: the plugin versions, pinned to TS Cameraman's, because both apps compile
// the shared :streamcore library with the same toolchain.
plugins {
    id("com.android.application") version "9.2.1" apply false
    id("com.android.library") version "9.2.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.0" apply false
    id("org.jetbrains.kotlinx.kover") version "0.9.1" apply false
}
