#import <XCTest/XCTest.h>
#import <UIKit/UIKit.h>

// The launch splash TeamStation TV's SceneDelegate puts over React Native, from
// inside the running app. The bundle cannot link TeamStationSplash without a
// second copy of it, so it reads the scene delegate's count and finds the
// splash by its accessibility identifier.
@interface SplashInstallTests : XCTestCase
@end

@implementation SplashInstallTests

- (UIWindowScene *)scene {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if ([scene isKindOfClass:UIWindowScene.class]) return (UIWindowScene *)scene;
  }
  return nil;
}

- (void)testTheLaunchPutUpOneSplash {
  NSObject *delegate = (NSObject *)self.scene.delegate;
  XCTAssertEqualObjects([delegate valueForKey:@"splashInstalls"], @1);
}

// The ServerOverride alert is presented on the root controller a second after
// launch, while the splash can still be up: it must sit above the splash, and
// be reachable once the splash has gone.
- (void)testAnAlertPresentedDuringTheSplashIsAboveIt {
  UIWindow *window = self.scene.keyWindow;
  XCTAssertNotNil(window);
  UIView *stand = [[UIView alloc] initWithFrame:window.bounds];
  stand.accessibilityIdentifier = @"tsSplash";
  stand.isAccessibilityElement = YES;
  stand.accessibilityViewIsModal = YES;
  [window addSubview:stand];
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:nil
                                                                 message:@"Server set"
                                                          preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
  XCTestExpectation *shown = [self expectationWithDescription:@"presented"];
  [window.rootViewController presentViewController:alert animated:NO completion:^{ [shown fulfill]; }];
  [self waitForExpectations:@[ shown ] timeout:5];
  NSUInteger splashAt = [window.subviews indexOfObject:stand];
  NSUInteger alertAt = NSNotFound;
  for (NSUInteger i = 0; i < window.subviews.count; i++) {
    if ([alert.view isDescendantOfView:window.subviews[i]]) alertAt = i;
  }
  XCTAssertNotEqual(alertAt, NSNotFound);
  XCTAssertGreaterThan(alertAt, splashAt);
  [stand removeFromSuperview];
  XCTAssertFalse([window.subviews containsObject:stand]);
  XCTAssertTrue([alert.view isDescendantOfView:window]);
  XCTestExpectation *gone = [self expectationWithDescription:@"dismissed"];
  [alert dismissViewControllerAnimated:NO completion:^{ [gone fulfill]; }];
  [self waitForExpectations:@[ gone ] timeout:5];
}

@end
