# React Native's default app setup (cmake-utils/default-app-setup), plus the
# chat crypto core: the C++ TurboModule in native/chatCrypto and the Rust
# static library Gradle's buildChatCryptoRust builds for this ABI. OnLoad.cpp
# is React Native's default with the module added to cxxModuleProvider.
cmake_minimum_required(VERSION 3.13)

project(appmodules)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

get_filename_component(TS_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../../.. ABSOLUTE)

if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(TS_RUST_TARGET aarch64-linux-android)
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(TS_RUST_TARGET armv7-linux-androideabi)
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(TS_RUST_TARGET x86_64-linux-android)
elseif(ANDROID_ABI STREQUAL "x86")
  set(TS_RUST_TARGET i686-linux-android)
else()
  message(FATAL_ERROR "No Rust target for the ABI ${ANDROID_ABI}")
endif()

# Where cargo wrote it: CARGO_TARGET_DIR (from the crate) when set.
set(TS_RUST_TARGET_DIR ${TS_ROOT}/crates/chat-crypto/target)
if(DEFINED ENV{CARGO_TARGET_DIR} AND NOT "$ENV{CARGO_TARGET_DIR}" STREQUAL "")
  get_filename_component(TS_RUST_TARGET_DIR "$ENV{CARGO_TARGET_DIR}" ABSOLUTE
    BASE_DIR ${TS_ROOT}/crates/chat-crypto)
endif()

add_library(chat_crypto STATIC IMPORTED)
set_target_properties(chat_crypto PROPERTIES IMPORTED_LOCATION
  ${TS_RUST_TARGET_DIR}/${TS_RUST_TARGET}/release/libchat_crypto.a)

target_sources(${CMAKE_PROJECT_NAME} PRIVATE
  ${TS_ROOT}/native/chatCrypto/NativeChatCrypto.cpp)
target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${TS_ROOT}/native/chatCrypto
  ${TS_ROOT}/crates/chat-crypto/include)
target_link_libraries(${CMAKE_PROJECT_NAME} chat_crypto log)
