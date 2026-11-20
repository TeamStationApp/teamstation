#import <ReactCommon/RCTTurboModule.h>
#import <SafariServices/SafariServices.h>
#import <XCTest/XCTest.h>

@interface NSObject (ChatBrowserModuleTests)
- (void)open:(NSString *)address
     resolve:(void (^)(id))resolve
      reject:(void (^)(NSString *, NSString *, NSError *))reject;
- (void)presentURL:(NSURL *)url from:(UIViewController *)presenter
           resolve:(void (^)(id))resolve reject:(void (^)(NSString *, NSString *, NSError *))reject;
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

@interface TransitioningChatPresenter : UIViewController
@property (nonatomic) BOOL reportingTransition;
@end
@implementation TransitioningChatPresenter
- (BOOL)isBeingPresented { return self.reportingTransition || [super isBeingPresented]; }
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

- (void)testRequiresAVisibleWindowAndSettledPresenter
{
  id module = [self module];
  NSURL *url = [NSURL URLWithString:@"https://example.org/path"];
  TransitioningChatPresenter *presenter = [TransitioningChatPresenter new];
  __block NSUInteger refusals = 0;
  void (^mustRefuse)(void) = ^{
    [module presentURL:url from:presenter resolve:^(id value) {
      XCTFail(@"An unavailable presenter opened Safari");
    } reject:^(NSString *code, NSString *message, NSError *error) {
      XCTAssertEqualObjects(code, @"browser_unavailable");
      refusals++;
    }];
  };
  mustRefuse();
  XCTAssertEqual(refusals, 1u);

  XCTestExpectation *done = [self expectationWithDescription:@"reopened after transition"];
  UIViewController *root = self.activeWindow.rootViewController;
  presenter.modalPresentationStyle = UIModalPresentationFullScreen;
  [root presentViewController:presenter animated:NO completion:nil];
  NSPredicate *settled = [NSPredicate predicateWithBlock:^BOOL(id object, NSDictionary *bindings) {
    return presenter.viewIfLoaded.window != nil && !presenter.isBeingPresented && presenter.transitionCoordinator == nil;
  }];
  XCTestExpectation *visible = [self expectationForPredicate:settled evaluatedWithObject:presenter handler:nil];
  [self waitForExpectations:@[visible] timeout:5];
  presenter.reportingTransition = YES;
  mustRefuse();
  XCTAssertEqual(refusals, 2u);
  presenter.reportingTransition = NO;
  [module presentURL:url from:presenter resolve:^(id value) {
    [presenter dismissViewControllerAnimated:NO completion:^{ [done fulfill]; }];
  } reject:^(NSString *code, NSString *message, NSError *error) {
    XCTFail(@"A settled presenter refused Safari: %@", message);
    [done fulfill];
  }];
  SFSafariViewController *browser = (SFSafariViewController *)presenter.presentedViewController;
  XCTAssertTrue([browser isKindOfClass:SFSafariViewController.class]);
  // UIKit calls the adaptive delegate after a user-initiated sheet dismissal.
  id<UIAdaptivePresentationControllerDelegate> delegate = browser.presentationController.delegate;
  UIPresentationController *sheet = browser.presentationController;
  void (^close)(void) = ^{
    [browser dismissViewControllerAnimated:NO completion:^{ [delegate presentationControllerDidDismiss:sheet]; }];
  };
  if (![browser.transitionCoordinator animateAlongsideTransition:nil completion:^(id context) { close(); }]) close();
  [self waitForExpectations:@[done] timeout:10];
}

- (void)testPresentsSafariAndRefusesRepeatedTap
{
  XCTestExpectation *done = [self expectationWithDescription:@"Safari dismissed"];
  id module = [self module];
  [module open:@"https://example.org/path?one=1#part" resolve:^(id value) {
    [done fulfill];
  } reject:^(NSString *code, NSString *message, NSError *error) {
    XCTFail(@"Safari presentation failed: %@", code);
    [done fulfill];
  }];
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = self.activeWindow;
    SFSafariViewController *browser = (SFSafariViewController *)window.rootViewController.presentedViewController;
    XCTAssertTrue([browser isKindOfClass:SFSafariViewController.class]);
    if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPhone) {
      UIApplication *app = UIApplication.sharedApplication;
      XCTAssertEqual([app.delegate application:app supportedInterfaceOrientationsForWindow:window],
                     UIInterfaceOrientationMaskPortrait);
    }
    [module open:@"http://example.org/other" resolve:^(id second) {
      XCTFail(@"A second browser opened over Safari");
    } reject:^(NSString *code, NSString *message, NSError *error) {
      XCTAssertEqualObjects(code, @"browser_unavailable");
      void (^close)(void) = ^{ [browser.delegate safariViewControllerDidFinish:browser]; };
      if (![browser.transitionCoordinator animateAlongsideTransition:nil completion:^(id context) { close(); }]) close();
    }];
  });
  [self waitForExpectations:@[done] timeout:10];
}
@end
