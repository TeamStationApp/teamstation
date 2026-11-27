#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * `SponsorMedia.swift`, declared by hand: the generated Swift header also
 * declares the app delegate, whose Objective-C superclass an Objective-C++
 * file cannot import as a module.
 */
@interface TSSponsorMedia : NSObject
- (void)run:(NSDictionary *)request
 completion:(void (^)(NSDictionary *_Nullable answer, NSString *_Nullable problem))completion;
@end

NS_ASSUME_NONNULL_END

// `NativeModules.SponsorMedia`: the sponsor screens' logos, row pictures and
// reels, shrunk on the phone before they are uploaded. Each method is one
// request to `TSSponsorMedia`, which answers a new file or the sentence the
// screen shows.
@interface RCTSponsorMedia : NSObject <RCTBridgeModule>
@end

@implementation RCTSponsorMedia

RCT_EXPORT_MODULE(SponsorMedia)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

static void Run(NSDictionary *request, RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject)
{
  [[TSSponsorMedia new] run:request
                 completion:^(NSDictionary *answer, NSString *problem) {
                   if (answer != nil) {
                     resolve(answer);
                   } else {
                     reject(@"sponsor_media", problem, nil);
                   }
                 }];
}

RCT_EXPORT_METHOD(resizeImage:(NSString *)uri
                  maxWidth:(double)maxWidth
                  maxHeight:(double)maxHeight
                  format:(NSString *)format
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  Run(@{@"op" : @"resizeImage", @"uri" : uri, @"maxWidth" : @(maxWidth), @"maxHeight" : @(maxHeight),
        @"format" : format},
      resolve, reject);
}

RCT_EXPORT_METHOD(cropSquare:(NSString *)uri
                  size:(double)size
                  format:(NSString *)format
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  Run(@{@"op" : @"cropSquare", @"uri" : uri, @"size" : @(size), @"format" : format}, resolve, reject);
}

RCT_EXPORT_METHOD(cropCover:(NSString *)uri
                  width:(double)width
                  height:(double)height
                  format:(NSString *)format
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  Run(@{@"op" : @"cropCover", @"uri" : uri, @"width" : @(width), @"height" : @(height), @"format" : format},
      resolve, reject);
}

RCT_EXPORT_METHOD(encodeReel:(NSString *)uri
                  options:(NSDictionary *)options
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSMutableDictionary *request = [options mutableCopy];
  request[@"op"] = @"encodeReel";
  request[@"uri"] = uri;
  Run(request, resolve, reject);
}

@end
