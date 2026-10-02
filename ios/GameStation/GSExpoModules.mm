// Installs the Expo modules (expo-gl's GLView and its WebGL context) into
// each new JavaScript runtime.
//
// The `expo` package does this from `EXReactNativeFactory`, its subclass of
// `RCTReactNativeFactory`. That package is not installed (src/MOBILE.md says
// why), so the same callback is added to the factory the app already uses.
// `RCTReactNativeFactory` is the `RCTHost`'s delegate and does not implement
// `host:didInitializeRuntime:` itself, so this category overrides nothing.

#import <objc/runtime.h>

#import <React-RCTAppDelegate/RCTReactNativeFactory.h>
#import <ReactCommon/RCTHost.h>
#import <react/renderer/runtimescheduler/RuntimeSchedulerBinding.h>

#import <ExpoModulesCore/EXHostWrapper.h>
#import <ExpoModulesCore/EXReactSchedulerDispatch.h>
#if __has_include(<ExpoModulesCore/ExpoModulesCore-Swift.h>)
#import <ExpoModulesCore/ExpoModulesCore-Swift.h>
#else
#import "ExpoModulesCore-Swift.h"
#endif

static char GSExpoAppContextKey;

@implementation RCTReactNativeFactory (GSExpoModules)

// [JS thread] Once per runtime, so a reload gets a context of its own.
- (void)host:(nonnull RCTHost *)host didInitializeRuntime:(facebook::jsi::Runtime &)runtime
{
  EXAppContext *appContext = [[EXAppContext alloc] init];
  // Held by the factory, as `EXReactNativeFactory` holds it in an ivar.
  objc_setAssociatedObject(self, &GSExpoAppContextKey, appContext, OBJC_ASSOCIATION_RETAIN);
  auto binding = facebook::react::RuntimeSchedulerBinding::getBinding(runtime);
  auto scheduler = binding ? binding->getRuntimeScheduler() : nullptr;
  void *schedulerHandle = expo::createReactSchedulerHandle(scheduler);
  [appContext setRuntime:&runtime
               scheduler:schedulerHandle
                dispatch:schedulerHandle ? reinterpret_cast<const void *>(&expo::dispatchOnReactScheduler) : nullptr];
  [appContext setHostWrapper:[[EXHostWrapper alloc] initWithHost:host]];
  [appContext registerNativeModules];
}

@end
