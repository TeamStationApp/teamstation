#import <React/RCTBridgeModule.h>
#import <Security/Security.h>

/** The TV bearer session never leaves the app's Keychain access group. */
@interface TVSession : NSObject <RCTBridgeModule>
@end
@implementation TVSession
RCT_EXPORT_MODULE(TVSession)
+ (BOOL)requiresMainQueueSetup { return NO; }
- (NSMutableDictionary *)query {
  return [@{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"app.teamstation.tv.session",
            (__bridge id)kSecAttrAccount: @"viewer"} mutableCopy];
}
RCT_EXPORT_METHOD(load:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSMutableDictionary *query = [self query];
  query[(__bridge id)kSecReturnData] = @YES;
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) { resolve(nil); return; }
  if (status != errSecSuccess) { reject(@"storage", @"Unable to read TV session", nil); return; }
  NSData *data = CFBridgingRelease(result);
  resolve([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}
RCT_EXPORT_METHOD(save:(NSString *)session resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSMutableDictionary *query = [self query];
  NSData *data = [session dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *attributes = @{(__bridge id)kSecValueData: data};
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
  if (status == errSecItemNotFound) {
    query[(__bridge id)kSecValueData] = data;
    query[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
    status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
  }
  if (status == errSecSuccess) resolve(nil);
  else reject(@"storage", @"Unable to save TV session", nil);
}
RCT_EXPORT_METHOD(clear:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)[self query]);
  if (status == errSecSuccess || status == errSecItemNotFound) resolve(nil);
  else reject(@"storage", @"Unable to clear TV session", nil);
}
@end
