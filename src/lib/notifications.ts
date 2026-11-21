import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

const CHANNEL_ID = 'screened-calls';

// Show the banner even while the app is open: the user may be on another tab.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Screened calls',
    importance: AndroidImportance.MAX,
  });
}

export async function ensurePermission(): Promise<boolean> {
  await ensureChannel();
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

export type PushRegistration = { token: string | null; problem: string | null };

/**
 * Gets the Expo push token Abhi's server uses to send "Unknown caller · Agent is screening".
 * Needs a real device and an EAS project id (run `npx eas-cli@latest init` once).
 */
export async function getPushToken(): Promise<PushRegistration> {
  if (!Device.isDevice) return { token: null, problem: 'Push needs a real phone, not a simulator.' };
  if (!(await ensurePermission())) return { token: null, problem: 'Notifications are turned off for Uno ReVoice.' };
  const projectId =
    (Constants.expoConfig?.extra?.eas?.projectId as string | undefined) ?? Constants.easConfig?.projectId;
  if (!projectId) return { token: null, problem: 'No EAS project id. Run `npx eas-cli@latest init`.' };
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: data, problem: null };
  } catch (e) {
    return { token: null, problem: `Could not get a push token: ${String(e)}` };
  }
}

/**
 * Local notification for demo calls. Real calls get theirs from the server through
 * Expo's push service, with the same title and `data.callId`.
 */
export async function notifyScreeningStarted(callId: string, demo: boolean) {
  try {
    if (!(await ensurePermission())) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Unknown caller',
        body: demo ? 'Agent is screening (demo)' : 'Agent is screening',
        data: { callId, screen: 'live' },
      },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch (e) {
    console.warn('Could not show notification', e);
  }
}

/** Scam verdict: tells the user even if the app is in the background. */
export async function notifyScam(callId: string, reason?: string) {
  try {
    if (!(await ensurePermission())) return;
    await Notifications.scheduleNotificationAsync({
      content: { title: 'This call is a scam', body: reason ?? 'Open Uno ReVoice to hang up or block it.', data: { callId, screen: 'live' } },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
    });
  } catch (e) {
    console.warn('Could not show notification', e);
  }
}

/** Tapping a "screening" notification opens the Live call screen. */
export function useOpenLiveOnNotificationTap() {
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    if (response.notification.request.content.data?.callId) {
      router.navigate('/');
      void Notifications.clearLastNotificationResponseAsync();
    }
  }, [response]);
}
