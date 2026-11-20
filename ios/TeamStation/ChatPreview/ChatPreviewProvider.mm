#import <Foundation/Foundation.h>
#import <ReactCommon/RCTTurboModule.h>
#import "../../../native/linkPreview/NativeChatPreview.h"

@interface ChatPreviewProvider : NSObject <RCTModuleProvider> {
  facebook::react::NativeChatPreview::Launch _launch;
}
- (instancetype)initWithWorkerLauncher:(facebook::react::NativeChatPreview::Launch)launch;
@end

@implementation ChatPreviewProvider
- (instancetype)initWithWorkerLauncher:(facebook::react::NativeChatPreview::Launch)launch
{
  if ((self = [super init])) _launch = std::move(launch);
  return self;
}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  if (_launch) return std::make_shared<facebook::react::NativeChatPreview>(params.jsInvoker, _launch);
  return std::make_shared<facebook::react::NativeChatPreview>(params.jsInvoker);
}
@end
