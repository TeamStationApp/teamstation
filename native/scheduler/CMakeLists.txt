# The Auto-Scheduler engine (C++17) against a HiGHS built by
# scripts/schedulerBuild.mjs from the pinned source (native/highs/
# highs-source.json): the engine library, the Node addon, the doctest
# runner, and under Emscripten the web's WebAssembly module.
cmake_minimum_required(VERSION 3.16)
project(TeamStationScheduler CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(HIGHS_SOURCE "" CACHE PATH "The pinned HiGHS source")
set(HIGHS_BUILD "" CACHE PATH "Its static build")
set(NODE_ADDON_API "" CACHE PATH "node-addon-api's headers")
set(NODE_API_HEADERS "" CACHE PATH "node-api-headers' include directory")
option(SCHEDULER_COVERAGE "Instrument the engine for llvm-cov" OFF)

add_library(highs_static STATIC IMPORTED)
set_target_properties(highs_static PROPERTIES
  IMPORTED_LOCATION "${HIGHS_BUILD}/lib/libhighs.a")
add_library(highs_extras STATIC IMPORTED)
set_target_properties(highs_extras PROPERTIES
  IMPORTED_LOCATION "${HIGHS_BUILD}/lib/libhighs_extras.a")

add_library(scheduler_core STATIC
  Calendar.cpp
  Capacity.cpp
  Context.cpp
  Engine.cpp
  Input.cpp
  Json.cpp
  Matchups.cpp
  Model.cpp
  Placement.cpp)
target_include_directories(scheduler_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_include_directories(scheduler_core SYSTEM PUBLIC
  "${HIGHS_SOURCE}/highs" "${HIGHS_BUILD}")
target_link_libraries(scheduler_core PUBLIC highs_static highs_extras)
if(NOT MSVC)
  target_compile_options(scheduler_core PRIVATE -Wall -Wextra)
endif()
if(SCHEDULER_COVERAGE)
  target_compile_options(scheduler_core PRIVATE
    -fprofile-instr-generate -fcoverage-mapping -O0)
  target_link_options(scheduler_core INTERFACE -fprofile-instr-generate)
endif()
find_package(Threads)
if(Threads_FOUND)
  target_link_libraries(scheduler_core PUBLIC Threads::Threads)
endif()

if(NODE_API_HEADERS)
  add_library(scheduler_node MODULE node/SchedulerAddon.cpp)
  target_include_directories(scheduler_node SYSTEM PRIVATE
    "${NODE_ADDON_API}" "${NODE_API_HEADERS}")
  target_compile_definitions(scheduler_node PRIVATE
    NAPI_VERSION=8 NAPI_CPP_EXCEPTIONS NODE_ADDON_API_DISABLE_DEPRECATED)
  target_link_libraries(scheduler_node PRIVATE scheduler_core)
  set_target_properties(scheduler_node PROPERTIES PREFIX "" SUFFIX ".node"
    OUTPUT_NAME scheduler)
  if(APPLE)
    target_link_options(scheduler_node PRIVATE -undefined dynamic_lookup)
  endif()
endif()

file(GLOB SCHEDULER_TESTS CONFIGURE_DEPENDS
  "${CMAKE_CURRENT_SOURCE_DIR}/test/*.cpp")
if(SCHEDULER_TESTS AND NOT CMAKE_CROSSCOMPILING)
  add_executable(scheduler_tests ${SCHEDULER_TESTS})
  target_link_libraries(scheduler_tests PRIVATE scheduler_core)
  target_include_directories(scheduler_tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/test")
endif()
