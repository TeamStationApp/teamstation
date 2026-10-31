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
