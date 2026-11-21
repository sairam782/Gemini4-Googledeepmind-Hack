import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { useServerConnection } from '@/lib/connection';
import { useOpenLiveOnNotificationTap } from '@/lib/notifications';
import { loadedStore, loadPersisted, useStore } from '@/lib/store';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const scheme = useColorScheme();
  const theme = useTheme();
  const loaded = useStore(loadedStore);

  useEffect(() => {
    void loadPersisted().finally(() => SplashScreen.hideAsync());
  }, []);
  useServerConnection();
  useOpenLiveOnNotificationTap();

  if (!loaded) return null;

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <NativeTabs
        backgroundColor={theme.background}
        indicatorColor={theme.cardStrong}
        labelStyle={{ selected: { color: theme.text } }}>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Label>Live call</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: 'phone', selected: 'phone.fill' }} md="call" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="history">
          <NativeTabs.Trigger.Label>History</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="clock" md="history" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="setup">
          <NativeTabs.Trigger.Label>Setup</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} md="settings" />
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
