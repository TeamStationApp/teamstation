#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * `WalkUpMusic.swift`, declared by hand: the generated `TeamStation-Swift.h`
 * also declares the app delegate and Expo's module provider, whose Objective-C
 * superclasses an Objective-C++ file cannot import as modules.
 */
@interface TSWalkUpMusic : NSObject
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
- (void)prepareOffline:(NSArray<NSString *> *)providerIds
                  done:(void (^)(NSDictionary<NSString *, id> *report))done;
@end

NS_ASSUME_NONNULL_END

/**
 * The `WalkUpMusic` TurboModule on iOS: the codegen spec
 * (`src/app/walkup/NativeWalkUpMusic.ts`) over `TSWalkUpMusic`, where
 * MusicKit is, since MusicKit is Swift and a TurboModule is Objective-C++.
 * `codegenConfig.ios.modulesProvider` in package.json maps the name to this
 * class.
 *
 * React Native makes two of these: the module JavaScript talks to, and one
 * the generated `RCTModuleProviders` keeps for the life of the app and never
 * connects. So `TSWalkUpMusic`, which watches the app become active and
 * reports, is made only once JavaScript is attached — when the event emitter
 * arrives — and a report with no emitter is dropped: calling the empty
 * emitter throws `std::bad_function_call` and aborts the app.
 */
@interface RCTWalkUpMusic : NativeWalkUpMusicSpecBase <NativeWalkUpMusicSpec>
@end

@implementation RCTWalkUpMusic {
  TSWalkUpMusic *_music;
}

RCT_EXPORT_MODULE(WalkUpMusic)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (void)setEventEmitterCallback:(EventEmitterCallbackWrapper *)eventEmitterCallbackWrapper
{
  [super setEventEmitterCallback:eventEmitterCallbackWrapper];
  [self music];
}

- (TSWalkUpMusic *)music
{
  @synchronized(self) {
    if (_music == nil) {
      _music = [TSWalkUpMusic new];
      __weak RCTWalkUpMusic *weakSelf = self;
      _music.onState = ^(NSDictionary<NSString *, id> *state) {
        RCTWalkUpMusic *strongSelf = weakSelf;
        if (strongSelf == nil || !strongSelf->_eventEmitterCallback) {
          return;
        }
        [strongSelf emitOnWalkUpMusicState:state];
      };
    }
    return _music;
  }
}

- (void)access:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [[self music] access:^(NSString *answer) {
    resolve(answer);
  }];
}

- (void)search:(NSString *)term resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [[self music] search:term
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
  [[self music] play:handle
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
  [[self music] stop:fadeMs
          done:^{
            resolve(nil);
          }];
}

- (void)prepareOffline:(NSArray *)providerIds
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [[self music] prepareOffline:providerIds
                          done:^(NSDictionary<NSString *, id> *report) {
                            resolve(report);
                          }];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeWalkUpMusicSpecJSI>(params);
}

@end
