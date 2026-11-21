/**
 * Sends the person to this device's own notification settings for the app,
 * and answers whether it could. A page cannot open the browser's site
 * settings, so the web answers false and the app says where to look instead.
 */
export async function openNotificationSettings(): Promise<boolean> {
  return false
}
