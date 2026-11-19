#import <ReactCommon/RCTTurboModule.h>
#import <SafariServices/SafariServices.h>
#import <XCTest/XCTest.h>

@interface NSObject (ChatBrowserModuleTests)
- (void)open:(NSString *)address
     resolve:(void (^)(id))resolve
      reject:(void (^)(NSString *, NSString *, NSError *))reject;
@end

@interface RefusingChatBrowserPresenter : UIViewController
@end

@implementation RefusingChatBrowserPresenter
- (void)presentViewController:(UIViewController *)controller animated:(BOOL)animated completion:(void (^)(void))completion
{
  if (![controller isKindOfClass:SFSafariViewController.class]) {
    [super presentViewController:controller animated:animated completion:completion];
  }
}
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

- (UIWindow *)activeWindow
{
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (scene.activationState == UISceneActivationStateForegroundActive && [scene isKindOfClass:UIWindowScene.class]) {
      return ((UIWindowScene *)scene).keyWindow;
    }
  }
  return nil;
}

- (void)testRegistersTheBrowserModuleForJavaScript
{
  id<RCTTurboModule, RCTBridgeModule> module = [self module];
  XCTAssertEqualObjects([NSClassFromString(@"RCTChatBrowser") moduleName], @"TSChatBrowser");
  facebook::react::ObjCTurboModule::InitParams params{};
  params.moduleName = "TSChatBrowser";
  params.instance = module;
  XCTAssertTrue([module getTurboModule:params] != nullptr);
}

- (void)testRejectsWhenUIKitDeclinesThePresentation
{
  UIViewController *root = self.activeWindow.rootViewController;
  XCTAssertNotNil(root);
  RefusingChatBrowserPresenter *presenter = [RefusingChatBrowserPresenter new];
  presenter.modalPresentationStyle = UIModalPresentationFullScreen;
  XCTestExpectation *done = [self expectationWithDescription:@"presentation declined"];
  [root presentViewController:presenter animated:NO completion:^{
    [[self module] open:@"https://example.org/" resolve:^(id value) {
      XCTFail(@"A declined presentation resolved");
      [presenter dismissViewControllerAnimated:NO completion:^{ [done fulfill]; }];
    } reject:^(NSString *code, NSString *message, NSError *error) {
      XCTAssertEqualObjects(code, @"browser_unavailable");
      XCTAssertEqualObjects(message, @"The browser could not be opened");
      [presenter dismissViewControllerAnimated:NO completion:^{ [done fulfill]; }];
    }];
  }];
  [self waitForExpectations:@[done] timeout:5];
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
    UIWindow *window = self.activeWindow;
    UIViewController *presenter = window.rootViewController;
    while (presenter.presentedViewController) presenter = presenter.presentedViewController;
    XCTAssertTrue([presenter isKindOfClass:SFSafariViewController.class]);
    if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPhone) {
      UIApplication *app = UIApplication.sharedApplication;
      XCTAssertEqual([app.delegate application:app supportedInterfaceOrientationsForWindow:window],
                     UIInterfaceOrientationMaskPortrait);
    }
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
