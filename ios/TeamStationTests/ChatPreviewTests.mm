#import <ReactCommon/RCTTurboModule.h>
#import <XCTest/XCTest.h>
#include "../../native/linkPreview/tests/PreviewModuleProbe.h"

@interface NSObject (ChatPreviewWorkerTests)
- (instancetype)initWithWorkerLauncher:(std::function<void(std::function<void()>)>)launch;
@end

@interface ChatPreviewTests : XCTestCase
@end

@implementation ChatPreviewTests
- (void)testRegisteredPreviewReadsAndCancelsThroughHermes
{
  id<RCTModuleProvider> provider = [NSClassFromString(@"ChatPreviewProvider") new];
  XCTAssertNotNil(provider);
  // Exercise each runtime’s teardown while the device also runs the host app.
  for (int attempt = 0; attempt < 8; ++attempt) {
    XCTAssertTrue(preview_test::exercisesPreview([&](const auto &invoker) {
      facebook::react::ObjCTurboModule::InitParams params{};
      params.moduleName = "NativeChatPreview";
      params.jsInvoker = invoker;
      return [provider getTurboModule:params];
    }));
  }
}

- (void)testAnUnavailableWorkerSettlesEachReadAndReleasesItsSlot
{
  int starts = 0;
  id<RCTModuleProvider> provider = [[NSClassFromString(@"ChatPreviewProvider") alloc]
      initWithWorkerLauncher:[&](std::function<void()>) {
        ++starts;
        throw std::system_error(std::make_error_code(std::errc::resource_unavailable_try_again));
      }];
  XCTAssertTrue(preview_test::exercisesPreview([&](const auto &invoker) {
    facebook::react::ObjCTurboModule::InitParams params{};
    params.jsInvoker = invoker;
    return [provider getTurboModule:params];
  }));
  XCTAssertEqual(starts, 3);
}
@end
