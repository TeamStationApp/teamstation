#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * `DeclaredAge.swift`, declared by hand: the generated Swift header also
 * declares the app delegate, whose Objective-C superclass an Objective-C++
 * file cannot import as a module.
 */
@interface TSDeclaredAge : NSObject
+ (void)request:(void (^)(NSDictionary *body))resolve;
@end

NS_ASSUME_NONNULL_END

@interface RCTDeclaredAge : NSObject <RCTBridgeModule>
@end

@implementation RCTDeclaredAge

RCT_EXPORT_MODULE(TSDeclaredAge)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

RCT_EXPORT_METHOD(request:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  [TSDeclaredAge request:^(NSDictionary *body) {
    resolve(body);
  }];
}

@end
