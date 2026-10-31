#import <XCTest/XCTest.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>

typedef void (^TVResolve)(id);
typedef void (^TVReject)(NSString *, NSString *, NSError *);
@interface TVSession : NSObject
+ (BOOL)requiresMainQueueSetup;
- (NSMutableDictionary *)query;
- (void)load:(TVResolve)resolve reject:(TVReject)reject;
- (void)save:(NSString *)value resolve:(TVResolve)resolve reject:(TVReject)reject;
- (void)clear:(TVResolve)resolve reject:(TVReject)reject;
@end
@interface InvalidTVSession : TVSession
@end
@implementation InvalidTVSession
- (NSMutableDictionary *)query {return [@{(__bridge id)kSecClass:@"invalid-class"} mutableCopy];}
@end
@interface NSObject (TVBundleURL)
- (NSURL *)bundleURL;
- (NSURL *)sourceURLForBridge:(id)bridge;
@end
@interface TVSessionTests : XCTestCase
@end
@implementation TVSessionTests
- (void)testEmbeddedApiAddress {
  NSString *address = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"TVApiBaseUrl"];
  XCTAssertTrue([address isKindOfClass:[NSString class]]);
  NSURL *url = [NSURL URLWithString:address];
  XCTAssertEqualObjects(url.scheme, @"https");
  XCTAssertTrue(url.host.length > 0);
  XCTAssertEqualObjects(url.path, @"/api/v1");
  XCTAssertFalse([address containsString:@"$("]);
}
- (void)testDevelopmentBundleURL {
  id delegate = [NSClassFromString(@"TeamStationTV.ReactNativeDelegate") new];
  XCTAssertNotNil(delegate);
  const char *old = getenv("TV_METRO_URL");
  NSString *previous = old ? [NSString stringWithUTF8String:old] : nil;
  setenv("TV_METRO_URL", "http://localhost:8097/index.bundle", 1);
  XCTAssertEqualObjects([[delegate bundleURL] absoluteString], @"http://localhost:8097/index.bundle");
  XCTAssertEqualObjects([[delegate sourceURLForBridge:nil] absoluteString], @"http://localhost:8097/index.bundle");
  unsetenv("TV_METRO_URL");
  XCTAssertNotEqualObjects([[delegate bundleURL] absoluteString], @"http://localhost:8097/index.bundle");
  if (previous) setenv("TV_METRO_URL", previous.UTF8String, 1);
}
- (void)testPersistentSessionLifecycle {
  TVSession *store = [TVSession new];
  TVReject reject = ^(NSString *code, NSString *message, NSError *error) {XCTFail(@"%@ %@", code, message);};
  XCTAssertFalse([TVSession requiresMainQueueSetup]);
  [store clear:^(id value) {} reject:reject];
  [store load:^(id value) {XCTAssertNil(value);} reject:reject];
  [store save:@"fixture-first" resolve:^(id value) {} reject:reject];
  [store load:^(id value) {XCTAssertEqualObjects(value, @"fixture-first");} reject:reject];
  [store save:@"fixture-updated" resolve:^(id value) {} reject:reject];
  [[TVSession new] load:^(id value) {XCTAssertEqualObjects(value, @"fixture-updated");} reject:reject];
  [store clear:^(id value) {} reject:reject];
  [store clear:^(id value) {} reject:reject];
  [store load:^(id value) {XCTAssertNil(value);} reject:reject];
}
- (void)testKeychainFailuresReject {
  TVSession *store = [InvalidTVSession new];
  __block NSInteger failures = 0;
  TVResolve resolve = ^(id value) {XCTFail(@"Invalid Keychain query succeeded");};
  TVReject reject = ^(NSString *code, NSString *message, NSError *error) {XCTAssertEqualObjects(code,@"storage");XCTAssertTrue(message.length>0);failures++;};
  [store load:resolve reject:reject];
  [store save:@"fixture" resolve:resolve reject:reject];
  [store clear:resolve reject:reject];
  XCTAssertEqual(failures,3);
}
@end

#import <GameController/GameController.h>
@interface TVRemote : NSObject
+ (BOOL)requiresMainQueueSetup;
- (dispatch_queue_t)methodQueue;
- (NSArray *)supportedEvents;
- (void)startObserving;
- (void)stopObserving;
- (void)attachPad:(GCMicroGamepad *)pad;
- (void)samplePad:(GCMicroGamepad *)pad x:(float)x y:(float)y;
- (void)sendEventWithName:(NSString *)name body:(id)body;
@end
@interface CapturedTVRemote : TVRemote
@property(nonatomic, strong) NSMutableArray *events;
@end
@implementation CapturedTVRemote
- (void)sendEventWithName:(NSString *)name body:(id)body { [self.events addObject:body]; }
@end
@interface TVRemoteTests : XCTestCase
@end
@implementation TVRemoteTests
- (void)testAbsoluteTouchLifecycle {
  CapturedTVRemote *remote = [CapturedTVRemote new]; remote.events = [NSMutableArray new];
  XCTAssertTrue([TVRemote requiresMainQueueSetup]);
  XCTAssertEqual([remote methodQueue], dispatch_get_main_queue());
  XCTAssertEqualObjects([remote supportedEvents], (@[@"tvEdgeSwipe"]));
  [remote startObserving];
  [remote attachPad:nil];
  [remote samplePad:nil x:0 y:0];
  GCController *controller = [GCController controllerWithMicroGamepad];
  GCMicroGamepad *pad = controller.microGamepad;
  pad.reportsAbsoluteDpadValues = NO;
  [remote attachPad:pad]; [remote attachPad:pad];
  [[NSNotificationCenter defaultCenter] postNotificationName:GCControllerDidConnectNotification object:controller];
  XCTAssertTrue(pad.reportsAbsoluteDpadValues);
  pad.dpad.valueChangedHandler(pad.dpad, -0.95, 0.1);
  pad.dpad.valueChangedHandler(pad.dpad, -0.8, 0.1);
  pad.dpad.valueChangedHandler(pad.dpad, 0.1, 0.1);
  pad.dpad.valueChangedHandler(pad.dpad, 0.8, 0.1);
  XCTAssertEqual(remote.events.count, 1);
  XCTAssertLessThan([remote.events[0][@"start"][@"x"] doubleValue], 0.1);
  [remote samplePad:pad x:0 y:0];
  [remote samplePad:pad x:0.9 y:0.2];
  [remote samplePad:pad x:-0.1 y:0.2];
  XCTAssertEqual(remote.events.count, 2);
  [remote stopObserving];
  XCTAssertFalse(pad.reportsAbsoluteDpadValues);
  XCTAssertNil(pad.dpad.valueChangedHandler);
  __block NSInteger restored = 0;
  pad.dpad.valueChangedHandler = ^(GCControllerDirectionPad *dpad, float x, float y) { restored++; };
  [remote startObserving]; [remote attachPad:pad]; [remote stopObserving];
  pad.dpad.valueChangedHandler(pad.dpad, 0, 0);
  XCTAssertEqual(restored, 1);
}
@end

#import <UIKit/UIKit.h>
@interface TVPosterView : UIImageView
@property(nonatomic, copy) NSString *uri;
@property(nonatomic, strong) NSURLSessionDataTask *task;
- (void)updateMotion;
@end
@interface TVSearchCell : UICollectionViewCell
@property(nonatomic, strong) TVPosterView *icon;
@property(nonatomic, strong) UILabel *titleLabel;
@property(nonatomic, strong) UILabel *detailLabel;
- (void)configure:(NSDictionary *)item;
- (void)applyFocus:(BOOL)focused;
@end
@interface TVSearchResults : UICollectionViewController <UICollectionViewDelegateFlowLayout>
@property(nonatomic, copy) NSArray *items;
@property(nonatomic, copy) NSString *status;
@property(nonatomic, copy) void (^selection)(NSString *);
@property(nonatomic, strong) UILabel *message;
@end
@interface TVSearchContainer : UISearchContainerViewController
@property(nonatomic, copy) void (^closeSearch)(void);
@end
@interface TVSearchView : UIView <UISearchResultsUpdating, UISearchControllerDelegate, UIAdaptivePresentationControllerDelegate>
@property(nonatomic, copy) NSArray *items;
@property(nonatomic, copy) NSString *status;
@property(nonatomic, copy) void (^onQuery)(NSDictionary *);
@property(nonatomic, copy) void (^onSelect)(NSDictionary *);
@property(nonatomic, copy) void (^onDismiss)(NSDictionary *);
@property(nonatomic, strong) TVSearchResults *results;
@property(nonatomic, strong) UISearchController *search;
@property(nonatomic, strong) TVSearchContainer *container;
- (void)closeSearch;
@end
@interface TVFixtureProtocol : NSURLProtocol @end
@implementation TVFixtureProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return [request.URL.host isEqualToString:@"poster.example.test"]; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  if ([self.request.URL.path isEqualToString:@"/error"]) {
    [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCannotConnectToHost userInfo:nil]];
    return;
  }
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(10,10)];
  NSData *data = UIImagePNGRepresentation([renderer imageWithActions:^(UIGraphicsImageRendererContext *context) { [UIColor.greenColor setFill]; UIRectFill(CGRectMake(0,0,10,10)); }]);
  [self.client URLProtocol:self didReceiveResponse:[[NSURLResponse alloc] initWithURL:self.request.URL MIMEType:@"image/png" expectedContentLength:data.length textEncodingName:nil] cacheStoragePolicy:NSURLCacheStorageNotAllowed];
  [self.client URLProtocol:self didLoadData:data];
  [self.client URLProtocolDidFinishLoading:self];
}
- (void)stopLoading {}
@end
@interface TVMenuPress : UIPress @end
@implementation TVMenuPress
- (UIPressType)type { return UIPressTypeMenu; }
@end
@interface NSObject (TVManagedView)
- (UIView *)view;
@end
@interface TVGradientView : UIView
@property(nonatomic, copy) NSString *direction;
@end
@interface TVPresentationTests : XCTestCase @end
@implementation TVPresentationTests
- (void)testSystemSearchDismissalNotifiesReactOnce {
  TVSearchView *view = [TVSearchView new];
  __block NSInteger count = 0;
  view.onDismiss = ^(NSDictionary *event) { count++; };
  [view didDismissSearchController:view.search];
  [view closeSearch];
  [view presentationControllerDidDismiss:nil];
  XCTAssertEqual(count,1);
}
- (void)testGradientTracksPanelBounds {
  TVGradientView *view = (TVGradientView *)[[NSClassFromString(@"TVGradientManager") new] view];
  view.frame = CGRectMake(0,0,1920,216); view.direction = @"bottom";
  CAGradientLayer *layer = (CAGradientLayer *)view.layer;
  XCTAssertEqualObjects(layer.locations,(@[@0,@0.5,@1]));
  XCTAssertEqualWithAccuracy(CGColorGetAlpha((__bridge CGColorRef)layer.colors[0]),0.65,0.001);
  XCTAssertEqualWithAccuracy(CGColorGetAlpha((__bridge CGColorRef)layer.colors[1]),0.325,0.001);
  XCTAssertEqualWithAccuracy(CGColorGetAlpha((__bridge CGColorRef)layer.colors[2]),0,0.001);
  XCTAssertTrue(CGPointEqualToPoint(layer.startPoint,CGPointMake(0,1)));
  view.frame = CGRectMake(0,0,1920,356); XCTAssertEqual(layer.bounds.size.height,356);
  view.direction = @"right"; XCTAssertEqual(layer.startPoint.x,1); XCTAssertEqual(layer.endPoint.x,0);
  view.direction = @"left"; XCTAssertEqual(layer.startPoint.x,0); XCTAssertEqual(layer.endPoint.x,1);
}
- (void)testPosterReuseAndFailure {
  [NSURLProtocol registerClass:TVFixtureProtocol.class];
  TVPosterView *poster = [[TVPosterView alloc] initWithFrame:CGRectMake(0,0,300,180)];
  [poster updateMotion];
  XCTAssertEqual(poster.adjustsImageWhenAncestorFocused, !UIAccessibilityIsReduceMotionEnabled());
  poster.uri = @"file:///not-remote"; XCTAssertNil(poster.task);
  poster.uri = @"https://poster.example.test/first";
  NSURLSessionDataTask *first = poster.task;
  poster.uri = @"https://poster.example.test/first"; XCTAssertEqual(poster.task,first);
  poster.uri = @"https://poster.example.test/second";
  XCTestExpectation *loaded = [self expectationWithDescription:@"poster loaded"];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3*NSEC_PER_SEC)),dispatch_get_main_queue(),^{ XCTAssertNotNil(poster.image); [loaded fulfill]; });
  [self waitForExpectations:@[loaded] timeout:3];
  poster.uri = @"https://poster.example.test/error";
  XCTestExpectation *failed = [self expectationWithDescription:@"poster failure"];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3*NSEC_PER_SEC)),dispatch_get_main_queue(),^{ XCTAssertNil(poster.image); [failed fulfill]; });
  [self waitForExpectations:@[failed] timeout:3];
  poster.uri = nil; poster = nil;
  [NSURLProtocol unregisterClass:TVFixtureProtocol.class];
}
- (void)testMountedNativeSearchLifecycle {
  UIWindowScene *scene = (UIWindowScene *)UIApplication.sharedApplication.connectedScenes.anyObject;
  UIWindow *window = scene.windows.firstObject;
  UIViewController *parent = window.rootViewController;
  XCTAssertNotNil(parent);
  TVSearchView *view = [[TVSearchView alloc] initWithFrame:parent.view.bounds];
  __block NSInteger dismissed = 0; view.onDismiss = ^(NSDictionary *event) { dismissed++; };
  [parent.view addSubview:view];
  XCTestExpectation *presented = [self expectationWithDescription:@"native search presented"];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.8*NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    XCTAssertNotNil(view.container.presentingViewController);
    XCTAssertTrue(view.search.active);
    [view didMoveToWindow];
    [view.container pressesEnded:[NSSet setWithObject:[TVMenuPress new]] withEvent:nil];
    XCTAssertEqual(dismissed,1);
    [view removeFromSuperview];
    [presented fulfill];
  });
  [self waitForExpectations:@[presented] timeout:5];
}
- (void)testSearchModelsSelectionAndDismissal {
  TVSearchView *view = [[TVSearchView alloc] initWithFrame:CGRectMake(0,0,1920,1080)];
  __block NSString *query = nil; __block NSString *selection = nil; __block NSInteger dismissals = 0;
  view.onQuery = ^(NSDictionary *event) { query = event[@"query"]; };
  view.onSelect = ^(NSDictionary *event) { selection = event[@"id"]; };
  view.onDismiss = ^(NSDictionary *event) { dismissals++; };
  XCTAssertEqual(view.search.delegate,view);
  view.search.searchBar.text = @"Demo"; [view updateSearchResultsForSearchController:view.search]; XCTAssertEqualObjects(query,@"Demo");
  view.search.searchBar.text = nil; [view updateSearchResultsForSearchController:view.search]; XCTAssertEqualObjects(query,@"");
  view.status = @"Searching…";
  view.items = @[@{@"id":@"team:demo",@"title":@"Demo Hawks",@"detail":@"Autumn · Demo League",@"image":NSNull.null},@{@"id":@"player:demo",@"title":@"Babe R",@"detail":@"Demo Hawks",@"image":@""}];
  TVSearchResults *results = view.results; [results loadViewIfNeeded];
  results.collectionView.frame = CGRectMake(0,0,1920,600); [results.collectionView layoutIfNeeded];
  XCTAssertEqual([results collectionView:results.collectionView numberOfItemsInSection:0],2);
  NSIndexPath *index = [NSIndexPath indexPathForItem:0 inSection:0];
  CGSize size = [results collectionView:results.collectionView layout:results.collectionViewLayout sizeForItemAtIndexPath:index]; XCTAssertEqualWithAccuracy(size.width,(1920-188)/3.0,0.1);
  TVSearchCell *cell = (TVSearchCell *)[results collectionView:results.collectionView cellForItemAtIndexPath:index];
  cell.frame = CGRectMake(0,0,size.width,size.height); [cell layoutSubviews];
  XCTAssertEqualObjects(cell.titleLabel.text,@"Demo Hawks"); XCTAssertTrue([cell.accessibilityLabel containsString:@"Autumn"]);
  [cell configure:view.items[1]]; XCTAssertEqualObjects(cell.icon.uri,@"");
  [cell applyFocus:YES]; XCTAssertEqual(cell.contentView.layer.borderWidth,3);
  [cell applyFocus:NO]; XCTAssertEqual(cell.contentView.layer.borderWidth,0);
  [results collectionView:results.collectionView didSelectItemAtIndexPath:index]; XCTAssertEqualObjects(selection,@"team:demo");
  [results collectionView:results.collectionView didSelectItemAtIndexPath:[NSIndexPath indexPathForItem:9 inSection:0]];
  view.items = @[]; view.status = @"No accessible teams or players found."; XCTAssertEqualObjects(results.message.text,view.status);
  view.items = @[@{@"id":@"retry",@"title":@"Retry search",@"detail":@"",@"image":NSNull.null}];
  [results collectionView:results.collectionView didSelectItemAtIndexPath:index]; XCTAssertEqualObjects(selection,@"retry");
  [view closeSearch]; view.container.closeSearch(); [view presentationControllerDidDismiss:nil]; XCTAssertEqual(dismissals,1);
  [view didMoveToWindow];
  view.onQuery = nil; [view updateSearchResultsForSearchController:view.search];
  view.onSelect = nil; view.results.selection(@"stale"); view.onDismiss = nil; [view closeSearch];
  [view.container pressesEnded:[NSSet set] withEvent:nil];
  XCTAssertNotNil([[NSClassFromString(@"TVSearchManager") new] view]); XCTAssertNotNil([[NSClassFromString(@"TVPosterManager") new] view]);
}
@end
