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
