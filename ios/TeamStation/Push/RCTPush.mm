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
@end

NS_ASSUME_NONNULL_END

/**
 * `TSPush` (`src/app/push/NativePush.ts`), the same module the Android app
 * has: the permission, the APNs token, which APNs it is for, the
 * notifications a read takes down, and the conversation on screen.
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

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativePushSpecJSI>(params);
}
@end
