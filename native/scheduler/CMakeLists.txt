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
option(SCHEDULER_ASYNCIFY "Let the web's build pause at its time limit (Asyncify)" ON)
set(SCHEDULER_ASYNCIFY_ADVISE OFF CACHE BOOL "Print what Asyncify instruments")

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

if(EMSCRIPTEN)
  # scheduler.js (the glue, which the worker bundle carries) and
  # scheduler.wasm, with no debug information: the module every browser
  # downloads. scripts/schedulerBuild.mjs wasm refuses it if a build-host
  # path is still inside.
  add_executable(scheduler_wasm wasm/SchedulerWasm.cpp)
  target_link_libraries(scheduler_wasm PRIVATE scheduler_core)
  set_target_properties(scheduler_wasm PROPERTIES OUTPUT_NAME scheduler
    SUFFIX ".js")
  target_link_options(scheduler_wasm PRIVATE
    -O3 -g0 -fwasm-exceptions
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_NAME=createSchedulerModule"
    "SHELL:-s ENVIRONMENT=worker"
    "SHELL:-s FILESYSTEM=0"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s MAXIMUM_MEMORY=4GB"
    "SHELL:-s STACK_SIZE=8MB"
    "SHELL:-s EXPORTED_FUNCTIONS=_scheduler_build,_scheduler_free,_malloc,_free"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=stringToNewUTF8,UTF8ToString,ccall"
    "SHELL:-s INCOMING_MODULE_JS_API=instantiateWasm,locateFile,print,printErr")
  # The pause at the time limit: `scheduler_decide` is the one import that
  # suspends the build, and only the chain from the export down to it is
  # instrumented. Indirect calls are not followed (that would instrument
  # most of HiGHS); wasm/asyncify-add.json names the functions on the chain
  # that reach the next link through one (std::function, HiGHS's callback,
  # the engine's solver), and Asyncify adds their direct callers itself.
  target_compile_definitions(scheduler_wasm PRIVATE
    SCHEDULER_ASYNCIFY=$<BOOL:${SCHEDULER_ASYNCIFY}>)
  if(SCHEDULER_ASYNCIFY)
    target_link_options(scheduler_wasm PRIVATE
      "SHELL:-s ASYNCIFY=1"
      "SHELL:-s ASYNCIFY_IMPORTS=scheduler_decide"
      "SHELL:-s ASYNCIFY_IGNORE_INDIRECT=1"
      "SHELL:-s ASYNCIFY_ADD=@${CMAKE_CURRENT_SOURCE_DIR}/wasm/asyncify-add.json"
      "SHELL:-s ASYNCIFY_STACK_SIZE=1048576")
    if(SCHEDULER_ASYNCIFY_ADVISE)
      target_link_options(scheduler_wasm PRIVATE "SHELL:-s ASYNCIFY_ADVISE=1")
    endif()
    set_property(TARGET scheduler_wasm APPEND PROPERTY LINK_DEPENDS
      "${CMAKE_CURRENT_SOURCE_DIR}/wasm/asyncify-add.json")
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
