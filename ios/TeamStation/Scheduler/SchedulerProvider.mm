#import <Foundation/Foundation.h>
#import <ReactCommon/RCTTurboModule.h>

#import "NativeScheduler.h"

/**
 * The `NativeScheduler` C++ TurboModule's provider on iOS:
 * `codegenConfig.ios.modulesProvider` in package.json maps the module's name
 * to this class, and React Native asks it for the module.
 */
@interface SchedulerProvider : NSObject <RCTModuleProvider>
@end

@implementation SchedulerProvider

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeScheduler>(params.jsInvoker);
}

@end
