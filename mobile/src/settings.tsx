import { useEffect, useState, type ReactNode } from 'react';
import { AppState, Linking, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { device, installer } from './client';
import { AppBar, Button, Notice, styles, useTheme } from './ui';
import type { useUpdateNotifications } from './update-notifications';

type Props = {
  back: () => void;
  updateVersion?: string;
  checkUpdates: () => void;
  viewUpdate: () => void;
  checking: boolean;
  checked: boolean;
  busy: boolean;
  error?: string;
  notifications: ReturnType<typeof useUpdateNotifications>;
  notificationsReady: boolean;
  editAccess: () => void;
  signOut: () => void;
  signingOut: boolean;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={layout.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.ink }]}>{title}</Text>
      <View style={[layout.panel, { backgroundColor: colors.panel, borderColor: colors.line }]}>{children}</View>
    </View>
  );
}

export function SettingsPage({
  back, updateVersion, checkUpdates, viewUpdate, checking, checked, busy, error, notifications,
  notificationsReady, editAccess, signOut, signingOut,
}: Props) {
  const { colors } = useTheme();
  const [canInstall, setCanInstall] = useState<boolean>();
  const [settingsError, setSettingsError] = useState<string>();

  useEffect(() => {
    let active = true;
    const refresh = () => void installer.canInstall().then(allowed => {
      if (active) setCanInstall(allowed);
    }).catch(() => undefined);
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    refresh();
    return () => {
      active = false;
      foreground.remove();
    };
  }, []);

  function openAndroidSettings(open: () => Promise<unknown>) {
    setSettingsError(undefined);
    void open().catch(() => setSettingsError('Could not open Android settings.'));
  }

  const appVersion = device.versionName ?? String(device.versionCode);
  const caption = [styles.small, { color: colors.muted }];
  return (
    <>
      <AppBar title="Settings" back={back} />
      <ScrollView contentContainerStyle={[styles.center, styles.content, layout.screen]}>
        {error && <Notice message={error} error />}
        {settingsError && <Notice message={settingsError} error />}
        <Section title="Payload updates">
          <Text style={[styles.rowTitle, { color: colors.ink }]}>Installed version {appVersion}</Text>
          {updateVersion && <Text accessibilityLiveRegion="polite" style={caption}>Version {updateVersion} is ready to download.</Text>}
          {!updateVersion && checked && !checking && <Text accessibilityLiveRegion="polite" style={caption}>Payload is up to date for this device.</Text>}
          <View style={layout.actions}>
            {updateVersion && <Button onPress={viewUpdate} disabled={busy}>View update</Button>}
            <Button type="text" disabled={checking || busy} onPress={checkUpdates}>{checking ? 'Checking…' : 'Check for updates'}</Button>
          </View>
        </Section>
        <Section title="Notifications">
          <View style={layout.switchRow}>
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: colors.ink }]}>App update alerts</Text>
              <Text style={caption}>
                {notifications.available ? 'Get alerts for new versions of apps installed on this device.'
                  : 'Alerts are unavailable in this build.'}
              </Text>
            </View>
            {notifications.available && <Switch accessibilityLabel="App update alerts"
              disabled={!notificationsReady || !notifications.ready || notifications.changing || signingOut}
              value={notifications.enabled}
              onValueChange={notifications.toggle}
              trackColor={{ false: colors.line, true: colors.accent }} />}
          </View>
          {notifications.error && <Notice message={notifications.error} error />}
          {notifications.available && <Button type="text" onPress={() => openAndroidSettings(Linking.openSettings)}>Open Android app settings</Button>}
        </Section>
        <Section title="Installations">
          <Text style={[styles.rowTitle, { color: colors.ink }]}>Install apps from Payload</Text>
          <Text accessibilityLiveRegion="polite" style={caption}>
            {canInstall === undefined ? 'View permission in Android settings.'
              : canInstall ? 'Allowed by Android.' : 'Android permission is off. Enable it to install downloaded APKs.'}
          </Text>
          <Button type="text" onPress={() => openAndroidSettings(() => installer.openInstallSettings())}>Manage install permission</Button>
        </Section>
        <Section title="Owner access">
          <Text style={[styles.rowTitle, { color: colors.ink }]}>Connected to the private library</Text>
          <View style={layout.actions}>
            <Button type="text" onPress={editAccess} disabled={signingOut || busy}>Replace owner token</Button>
            <Button type="text" onPress={signOut}
              disabled={signingOut || busy || notifications.changing || (notifications.available && !notifications.ready)}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </Button>
          </View>
        </Section>
      </ScrollView>
    </>
  );
}

const layout = StyleSheet.create({
  screen: { paddingTop: 15, gap: 23 },
  section: { gap: 9 },
  panel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, padding: 15, gap: 8, alignItems: 'flex-start' },
  switchRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 },
});
