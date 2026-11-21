#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * `Push.swift`, declared by hand: the generated Swift header also declares
 * the app delegate, whose Objective-C superclass an Objective-C++ file
 * cannot import as a module.
 */
@interface TSPushCenter : NSObject
@property (class, readonly) TSPushCenter *shared;
- (void)permissionState:(void (^)(NSString *state))done;
- (void)requestPermission:(void (^)(NSString *state))done;
- (void)token:(void (^)(NSString *_Nullable token))done;
- (void)unregister:(void (^)(void))done;
- (NSString *)environment;
- (void)show:(NSString *)title body:(NSString *)body url:(NSString *)url tag:(NSString *)tag seq:(int64_t)seq;
- (void)clear:(NSString *)tag done:(void (^)(void))done;
- (void)setActiveConversation:(nullable NSString *)conversation;
- (void)setUser:(nullable NSString *)userId;
- (nullable NSString *)sessionCookie:(NSString *)url;
- (void)clearSessionCookie:(NSString *)url;
- (void)openSettings:(void (^)(BOOL opened))done;
@end

NS_ASSUME_NONNULL_END

/**
 * `TSPush` (`src/app/push/NativePush.ts`), the same module the Android app
 * has: the permission, the APNs token, which APNs it is for, the
 * notifications a read takes down, the conversation on screen, who is
 * signed in, and the session cookie the app's networking keeps.
 */
@interface RCTPush : NativePushSpecBase <NativePushSpec>
@end

@implementation RCTPush
RCT_EXPORT_MODULE(TSPush)

RCT_EXPORT_METHOD(permissionState:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [TSPushCenter.shared permissionState:^(NSString *state) { resolve(state); }];
}

RCT_EXPORT_METHOD(requestPermission:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [TSPushCenter.shared requestPermission:^(NSString *state) { resolve(state); }];
}

RCT_EXPORT_METHOD(token:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [TSPushCenter.shared token:^(NSString *token) { resolve(token); }];
}

RCT_EXPORT_METHOD(unregister:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [TSPushCenter.shared unregister:^{ resolve(nil); }];
}

RCT_EXPORT_METHOD(environment:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  resolve([TSPushCenter.shared environment]);
}

RCT_EXPORT_METHOD(show:(NSString *)title
                  body:(NSString *)body
                  url:(NSString *)url
                  tag:(NSString *)tag
                  channel:(NSString *)channel
                  seq:(double)seq)
{
  (void)channel;
  [TSPushCenter.shared show:title body:body url:url tag:tag seq:(int64_t)seq];
}

RCT_EXPORT_METHOD(clear:(NSString *)tag)
{
  [TSPushCenter.shared clear:tag done:^{}];
}

RCT_EXPORT_METHOD(setActiveConversation:(NSString *_Nullable)conversationId)
{
  [TSPushCenter.shared setActiveConversation:conversationId];
}

RCT_EXPORT_METHOD(setUser:(NSString *_Nullable)userId)
{
  [TSPushCenter.shared setUser:userId];
}

RCT_EXPORT_METHOD(sessionCookie:(NSString *)url resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  resolve([TSPushCenter.shared sessionCookie:url]);
}

RCT_EXPORT_METHOD(clearSessionCookie:(NSString *)url resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [TSPushCenter.shared clearSessionCookie:url];
  resolve(nil);
}

RCT_EXPORT_METHOD(openSettings:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [TSPushCenter.shared openSettings:^(BOOL opened) { resolve(@(opened)); }];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativePushSpecJSI>(params);
}
@end
