import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { removeNotificationSubscription, syncNotificationSubscription, type CatalogApp, type Installed } from './client';

const preferenceKey = 'payload-update-fcm-token';
const channelId = 'app-updates';
const configured = Constants.expoConfig?.extra?.updateNotifications === true;

if (configured) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
    }),
  });
}

export function useUpdateNotifications(ownerToken: string | null, apps: CatalogApp[] | null,
  installed: Record<string, Installed | null>, openDetails: (packageId: string) => void) {
  const address = useRef<string | null>(null);
  const work = useRef<Promise<unknown>>(Promise.resolve());
  const tokenChecked = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string>();
  const snapshot = useMemo(() => apps?.flatMap(({ packageId }) => {
    const versionCode = installed[packageId]?.versionCode;
    return versionCode ? [{ packageId, versionCode }] : [];
  }), [apps, installed]);

  const enqueue = useCallback((action: () => Promise<void>) => {
    const next = work.current.catch(() => undefined).then(action);
    work.current = next;
    return next;
  }, []);

  const unsubscribe = useCallback(async (key: string) => {
    if (!address.current) return;
    await removeNotificationSubscription(key, address.current);
    await SecureStore.deleteItemAsync(preferenceKey);
    address.current = null;
    setEnabled(false);
  }, []);

  function revoke(key: string) {
    return enqueue(() => unsubscribe(key));
  }

  useEffect(() => {
    if (!configured) return;
    void SecureStore.getItemAsync(preferenceKey).then(saved => {
      address.current = saved;
      setEnabled(!!saved);
    }).catch(() => setError('Could not read your notification settings.')).finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!configured) return;
    const handle = (response: Notifications.NotificationResponse) => {
      const { type, packageId } = response.notification.request.content.data ?? {};
      if (type === 'app-update' && typeof packageId === 'string') {
        openDetails(packageId);
        void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
      }
    };
    const listener = Notifications.addNotificationResponseReceivedListener(handle);
    void Notifications.getLastNotificationResponseAsync().then(response => {
      if (response) handle(response);
    }).catch(() => undefined);
    return () => listener.remove();
  }, [openDetails]);

  useEffect(() => {
    if (!ownerToken || !loaded || !enabled || !snapshot) return;
    const sync = (devicePushToken?: Notifications.DevicePushToken) => {
      void enqueue(async () => {
        const saved = address.current;
        if (!saved) return;
        const permissions = await Notifications.getPermissionsAsync();
        if (!permissions.granted) {
          await unsubscribe(ownerToken);
          return;
        }
        let token = saved;
        if (devicePushToken || !tokenChecked.current) {
          try {
            token = String((devicePushToken ?? await Notifications.getDevicePushTokenAsync()).data);
            tokenChecked.current = true;
          } catch {
            // Keep the existing subscription through temporary FCM token lookup failures.
            tokenChecked.current = false;
          }
        }
        await syncNotificationSubscription(ownerToken, token, snapshot, saved);
        if (token !== saved) {
          await SecureStore.setItemAsync(preferenceKey, token);
          address.current = token;
        }
        setError(undefined);
      }).catch(() => setError('Could not sync update notifications. Pull down to try again.'));
    };
    sync();
    const rotation = Notifications.addPushTokenListener(sync);
    return () => rotation.remove();
  }, [enqueue, enabled, loaded, ownerToken, snapshot, unsubscribe]);

  function toggle() {
    if (!configured || !loaded || !ownerToken || !snapshot || changing) return;
    setChanging(true);
    setError(undefined);
    void enqueue(async () => {
      if (address.current) {
        await unsubscribe(ownerToken);
        return;
      }
      await Notifications.setNotificationChannelAsync(channelId, {
        name: 'App updates',
        importance: Notifications.AndroidImportance.DEFAULT,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      });
      const permissions = await Notifications.requestPermissionsAsync();
      if (!permissions.granted) {
        setError('Allow Payload notifications in Android settings to receive update alerts.');
        return;
      }
      const token = String((await Notifications.getDevicePushTokenAsync()).data);
      await SecureStore.setItemAsync(preferenceKey, token);
      address.current = token;
      tokenChecked.current = true;
      setEnabled(true);
    }).catch(() => setError('Could not change update notifications. Try again.'))
      .finally(() => setChanging(false));
  }

  return { available: configured, ready: loaded, enabled, changing, error, toggle, revoke };
}
