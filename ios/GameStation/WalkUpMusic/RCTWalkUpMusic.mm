#import <GameStationWalkUpMusicSpec/GameStationWalkUpMusicSpec.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * `WalkUpMusic.swift`, declared by hand: the generated `GameStation-Swift.h`
 * also declares the app delegate and Expo's module provider, whose Objective-C
 * superclasses an Objective-C++ file cannot import as modules.
 */
@interface GSWalkUpMusic : NSObject
@property (nonatomic, copy, nullable) void (^onState)(NSDictionary<NSString *, id> *state);
- (void)access:(void (^)(NSString *answer))done;
- (void)search:(NSString *)term
          done:(void (^)(NSArray<NSDictionary<NSString *, id> *> *_Nullable results, NSString *_Nullable message))done;
- (void)play:(NSString *)handle
      startMs:(double)startMs
        endMs:(double)endMs
     fadeInMs:(double)fadeInMs
    fadeOutMs:(double)fadeOutMs
         done:(void (^)(NSString *_Nullable message))done;
- (void)stop:(double)fadeMs done:(void (^)(void))done;
@end

NS_ASSUME_NONNULL_END

/**
 * The `WalkUpMusic` TurboModule on iOS: the codegen spec
 * (`src/app/walkup/NativeWalkUpMusic.ts`) over `GSWalkUpMusic`, where
 * MusicKit is, since MusicKit is Swift and a TurboModule is Objective-C++.
 * `codegenConfig.ios.modulesProvider` in package.json maps the name to this
 * class.
 */
@interface RCTWalkUpMusic : NativeWalkUpMusicSpecBase <NativeWalkUpMusicSpec>
@end

@implementation RCTWalkUpMusic {
  GSWalkUpMusic *_music;
}

RCT_EXPORT_MODULE(WalkUpMusic)

- (instancetype)init
{
  if (self = [super init]) {
    _music = [GSWalkUpMusic new];
    __weak RCTWalkUpMusic *weakSelf = self;
    _music.onState = ^(NSDictionary<NSString *, id> *state) {
      [weakSelf emitOnWalkUpMusicState:state];
    };
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (void)access:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_music access:^(NSString *answer) {
    resolve(answer);
  }];
}

- (void)search:(NSString *)term resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_music search:term
            done:^(NSArray<NSDictionary<NSString *, id> *> *results, NSString *message) {
              if (message != nil) {
                reject(@"search", message, nil);
              } else {
                resolve(results ?: @[]);
              }
            }];
}

- (void)pickFile:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  // An iPhone's songs are Apple Music's; there is no file to choose.
  resolve([NSNull null]);
}

- (void)play:(NSString *)handle
      startMs:(double)startMs
        endMs:(double)endMs
     fadeInMs:(double)fadeInMs
    fadeOutMs:(double)fadeOutMs
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  [_music play:handle
         startMs:startMs
           endMs:endMs
        fadeInMs:fadeInMs
       fadeOutMs:fadeOutMs
            done:^(NSString *message) {
              if (message != nil) {
                reject(@"play", message, nil);
              } else {
                resolve(nil);
              }
            }];
}

- (void)stop:(double)fadeMs resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_music stop:fadeMs
          done:^{
            resolve(nil);
          }];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeWalkUpMusicSpecJSI>(params);
}

@end
