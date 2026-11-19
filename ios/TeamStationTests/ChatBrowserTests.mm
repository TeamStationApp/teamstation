#import <SafariServices/SafariServices.h>
#import <XCTest/XCTest.h>

@interface NSObject (ChatBrowserModuleTests)
- (void)open:(NSString *)address
     resolve:(void (^)(id))resolve
      reject:(void (^)(NSString *, NSString *, NSError *))reject;
@end

@interface ChatBrowserTests : XCTestCase
@end

@implementation ChatBrowserTests

- (id)module
{
  id module = [NSClassFromString(@"RCTChatBrowser") new];
  XCTAssertNotNil(module);
  return module;
}

- (void)testRefusesInvalidAddresses
{
  for (NSString *address in @[@"file:///document.pdf", @"https://user@example.org/", @"https:///page"]) {
    XCTestExpectation *done = [self expectationWithDescription:@"invalid web address"];
    [[self module] open:address resolve:^(id value) {
      XCTFail(@"An invalid address opened");
      [done fulfill];
    } reject:^(NSString *code, NSString *message, NSError *error) {
      XCTAssertEqualObjects(code, @"invalid_url");
      [done fulfill];
    }];
    [self waitForExpectations:@[done] timeout:2];
  }
}

- (void)testPresentsSafariAndRefusesRepeatedTap
{
  XCTestExpectation *done = [self expectationWithDescription:@"Safari sheet"];
  id module = [self module];
  [module open:@"https://example.org/path?one=1#part" resolve:^(id value) {
    UIWindowScene *active = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (scene.activationState == UISceneActivationStateForegroundActive &&
          [scene isKindOfClass:UIWindowScene.class]) {
        active = (UIWindowScene *)scene;
        break;
      }
    }
    UIViewController *presenter = active.keyWindow.rootViewController;
    while (presenter.presentedViewController) presenter = presenter.presentedViewController;
    XCTAssertTrue([presenter isKindOfClass:SFSafariViewController.class]);
    [module open:@"http://example.org/other" resolve:^(id second) {
      XCTFail(@"A second browser opened over Safari");
      [done fulfill];
    } reject:^(NSString *code, NSString *message, NSError *error) {
      XCTAssertEqualObjects(code, @"browser_unavailable");
      [presenter dismissViewControllerAnimated:NO completion:^{ [done fulfill]; }];
    }];
  } reject:^(NSString *code, NSString *message, NSError *error) {
    XCTFail(@"Safari presentation failed: %@", code);
    [done fulfill];
  }];
  [self waitForExpectations:@[done] timeout:10];
}
@end
