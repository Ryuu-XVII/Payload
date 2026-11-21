import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, BackHandler, Keyboard, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  androidMinimum, androidRequirement, apkAction, ApiError, device, fileSize, getCatalog, getDownload, installer,
  releaseAction, type CatalogApp, type Installed, type Release,
} from './src/client';
import { AppBar, AppRow, Button, Icon, Notice, Skeleton, styles, useTheme } from './src/ui';
import { useUpdateNotifications } from './src/update-notifications';
import { SettingsPage } from './src/settings';

const tokenKey = 'payload-owner-token';
const messages: Record<string, string> = {
  success: 'Installed successfully.',
  cancelled: 'Installation was cancelled.',
  signing: 'The signing certificate does not match the installed app. Publish an APK signed with a compatible key to update in place.',
  incompatible: 'This APK is incompatible with this phone.',
  storage: 'Android ran out of space. Free up some storage and retry.',
  blocked: 'Android blocked the installation. Check the install permission and any device restrictions.',
  interrupted: 'The installation was interrupted. Retry to start again.',
  failed: 'Android could not install this APK. Retry the installation.',
};
const nativeErrors: Record<string, string> = {
  ERR_PAYLOAD_DOWNLOAD: 'The download failed. Check your connection and retry.',
  ERR_PAYLOAD_INTEGRITY: 'The download did not match the published APK. Retry to download it again.',
  ERR_PAYLOAD_INCOMPATIBLE: 'This APK is incompatible with this phone or does not match the selected release.',
  ERR_PAYLOAD_MISSING_APK: 'The saved APK is unavailable. Download it before installing.',
  ERR_PAYLOAD_STAGING: 'Android could not prepare the APK. Check available storage and retry.',
  ERR_PAYLOAD_BUSY: 'An installation is already in progress.',
  ERR_PAYLOAD_OPEN: 'Android could not open this app.',
};

type Flow = {
  id: string;
  phase: 'permission' | 'allowed' | 'requesting' | 'downloading' | 'staging' | 'confirm' | 'installing' | 'result';
  received?: number;
  size?: number;
  progress?: number;
  outcome?: string;
  message?: string;
};

const releaseKey = (release: Release) => `${release.versionCode}:${release.sha256}`;

function LibraryApp() {
  const { colors, isDark } = useTheme();
  const [token, setToken] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [starting, setStarting] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [apps, setApps] = useState<CatalogApp[] | null>(null);
  const [installed, setInstalled] = useState<Record<string, Installed | null>>({});
  const [downloads, setDownloads] = useState<Record<string, string | undefined>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [screen, setScreen] = useState<'library' | 'settings' | 'access'>('library');
  const [checkedUpdates, setCheckedUpdates] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow>();
  const [openError, setOpenError] = useState<{ id: string; message: string }>();
  const currentFlow = useRef<Flow | undefined>(undefined);
  const currentApps = useRef<CatalogApp[]>([]);
  const catalogRun = useRef(0);
  const lookupRun = useRef(0);
  const checking = useRef(false);
  const startingInstall = useRef(false);

  const changeFlow = useCallback((value?: Flow) => {
    currentFlow.current = value;
    setFlow(value);
  }, []);

  const lookup = useCallback(async () => {
    const snapshot = currentApps.current;
    const run = ++lookupRun.current;
    const [packages, files] = await Promise.all([
      installer.lookup(snapshot.map(app => app.packageId)),
      Promise.all(snapshot.map(async ({ packageId, compatible }) => [
        packageId,
        compatible && await installer.hasDownload(packageId, compatible.versionCode, compatible.size, compatible.sha256)
          ? releaseKey(compatible) : undefined,
      ] as const)),
    ]);
    if (run === lookupRun.current && snapshot === currentApps.current) {
      setInstalled(packages);
      setDownloads(Object.fromEntries(files));
    }
  }, []);

  const loadCatalog = useCallback(async (key: string) => {
    const run = ++catalogRun.current;
    setError(undefined);
    setRefreshing(true);
    try {
      const catalog = await getCatalog(key);
      if (catalogRun.current !== run) return;
      currentApps.current = catalog;
      await lookup();
      if (catalogRun.current === run) {
        setApps(catalog);
        return catalog;
      }
    } catch (cause) {
      if (catalogRun.current !== run) return;
      if (cause instanceof ApiError && cause.status === 401) {
        setToken(null);
        setScreen('library');
        setApps(null);
        currentApps.current = [];
        setInstalled({});
        setDownloads({});
        await SecureStore.deleteItemAsync(tokenKey).catch(() => undefined);
      }
      setError(messageFrom(cause));
    } finally {
      if (catalogRun.current === run) setRefreshing(false);
    }
  }, [lookup]);

  const viewNotification = useCallback((packageId: string) => {
    setScreen('library');
    setSelected(packageId);
    if (token) void loadCatalog(token);
  }, [loadCatalog, token]);
  const notifications = useUpdateNotifications(token, apps, installed, viewNotification);

  useEffect(() => {
    SecureStore.getItemAsync(tokenKey).then(saved => {
      if (saved) {
        setToken(saved);
        void loadCatalog(saved);
      }
    }).catch(() => setError('Could not read the stored token. Enter it again to reconnect.'))
      .finally(() => setStarting(false));
  }, [loadCatalog]);

  const inspectInstall = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const pending = await installer.installState();
      if (pending?.stage === 'finished') {
        const outcome = pending.result ?? 'failed';
        await installer.clearResult(pending.sessionId);
        await lookup().catch(() => undefined);
        const message = pending.packageId === device.packageId && outcome === 'success'
          ? `Payload updated to version ${device.versionName ?? device.versionCode}.`
          : messages[outcome] ?? messages.failed;
        changeFlow({ id: pending.packageId, phase: 'result', outcome, message });
      } else if (pending && currentFlow.current?.phase !== 'downloading') {
        const phase = pending.stage === 'confirm' ? 'confirm' : pending.stage === 'preparing' ? 'staging' : 'installing';
        const previous = currentFlow.current;
        if (previous?.phase !== phase || previous.id !== pending.packageId || previous.progress !== pending.progress) {
          changeFlow({ id: pending.packageId, phase, progress: pending.progress });
        }
      }
    } finally {
      checking.current = false;
    }
  }, [changeFlow, lookup]);

  useEffect(() => {
    const check = () => void inspectInstall().catch(() => undefined);
    const foreground = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      void lookup().catch(() => undefined);
      check();
      const previous = currentFlow.current;
      if (previous?.phase === 'permission') {
        void installer.canInstall().then(allowed => {
          if (allowed && currentFlow.current === previous) changeFlow({ id: previous.id, phase: 'allowed' });
        }).catch(() => undefined);
      }
    });
    const progress = installer.addListener('downloadProgress', event => {
      const state = currentFlow.current;
      if (state?.id === event.packageId && state.phase === 'downloading') {
        changeFlow({ ...state, received: event.received });
      }
    });
    const poll = setInterval(() => {
      const phase = currentFlow.current?.phase;
      if (AppState.currentState === 'active' && (phase === 'confirm' || phase === 'staging' || phase === 'installing')) check();
    }, 250);
    check();
    return () => {
      foreground.remove();
      progress.remove();
      clearInterval(poll);
    };
  }, [changeFlow, inspectInstall, lookup]);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'access' && token) {
        setScreen('settings');
        setInput('');
        setError(undefined);
        return true;
      }
      if (selected) {
        setSelected(null);
        return true;
      }
      if (screen === 'settings') {
        setScreen('library');
        setError(undefined);
        return true;
      }
      return false;
    });
    return () => back.remove();
  }, [screen, selected, token]);

  async function connect() {
    const key = input.trim();
    if (!key || submitting) return;
    Keyboard.dismiss();
    setSubmitting(true);
    setError(undefined);
    try {
      const catalog = await getCatalog(key);
      await SecureStore.setItemAsync(tokenKey, key);
      ++catalogRun.current;
      currentApps.current = catalog;
      await lookup();
      setApps(catalog);
      setToken(key);
      setInput('');
      setScreen(token ? 'settings' : 'library');
      setRefreshing(false);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const busy = flow?.phase === 'requesting' || flow?.phase === 'downloading'
    || flow?.phase === 'staging' || flow?.phase === 'confirm' || flow?.phase === 'installing';
  const isDownloaded = (app: CatalogApp) => !!app.compatible && downloads[app.packageId] === releaseKey(app.compatible);

  function signOut() {
    if (!token || signingOut || busy) return;
    const key = token;
    Alert.alert('Sign out of Payload?', 'You’ll need the owner token to connect again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => {
        setSigningOut(true);
        setError(undefined);
        void (async () => {
          await notifications.revoke(key);
          await SecureStore.deleteItemAsync(tokenKey);
          ++catalogRun.current;
          ++lookupRun.current;
          currentApps.current = [];
          setApps(null);
          setInstalled({});
          setDownloads({});
          setRefreshing(false);
          setSelected(null);
          setScreen('library');
          setToken(null);
          changeFlow();
        })().catch(() => setError('Could not sign out. Check your connection and try again.'))
          .finally(() => setSigningOut(false));
      } },
    ]);
  }

  async function act(app: CatalogApp) {
    const id = app.packageId;
    const action = apkAction(app, installed[id], isDownloaded(app));
    setOpenError(undefined);
    if (action === 'Open') {
      try {
        await installer.openApp(id);
        const previous = currentFlow.current;
        if (previous?.id === id && previous.outcome === 'success') changeFlow();
      } catch (cause) {
        setSelected(id);
        setOpenError({ id, message: messageFrom(cause) });
      }
      return;
    }
    if (!action || !token || !app.compatible || busy || startingInstall.current) return;
    const release = app.compatible;
    startingInstall.current = true;
    setSelected(id);
    try {
      if (action === 'Download') {
        changeFlow({ id, phase: 'requesting' });
        const url = await getDownload(token, id, release.versionCode);
        changeFlow({ id, phase: 'downloading', received: 0, size: release.size });
        await installer.downloadApk(url, id, release.versionCode, release.size, release.sha256);
        ++lookupRun.current;
        setDownloads(previous => ({ ...previous, [id]: releaseKey(release) }));
        changeFlow({ id, phase: 'result', outcome: 'downloaded', message: 'APK downloaded and verified. Ready to install.' });
        return;
      }
      changeFlow({ id, phase: 'staging' });
      await installer.startInstall(id, release.versionCode, release.size, release.sha256);
      await inspectInstall();
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      if (code === 'ERR_PAYLOAD_PERMISSION') {
        changeFlow({ id, phase: 'permission' });
      } else {
        const missing = code === 'ERR_PAYLOAD_MISSING_APK' || code === 'ERR_PAYLOAD_INTEGRITY';
        if (missing) {
          ++lookupRun.current;
          setDownloads(previous => ({ ...previous, [id]: undefined }));
        }
        const message = action !== 'Download' && !missing ? `${messageFrom(cause)} The APK is still saved.` : messageFrom(cause);
        changeFlow({ id, phase: 'result', outcome: 'failed', message });
        if (cause instanceof ApiError && [401, 404, 410].includes(cause.status)) void loadCatalog(token);
      }
    } finally {
      startingInstall.current = false;
    }
  }

  function settings(id: string) {
    void installer.openInstallSettings().catch(() => {
      changeFlow({ id, phase: 'result', outcome: 'failed', message: 'Could not open Android settings. Retry or find Payload under Install unknown apps in Settings.' });
    });
  }

  function confirm(id: string) {
    void installer.launchConfirmation().then(() => inspectInstall())
      .catch(() => {
        changeFlow({ id, phase: 'confirm', message: 'Could not open the Android installer. Try again.' });
        void inspectInstall().catch(() => undefined);
      });
  }

  const app = apps?.find(item => item.packageId === selected);
  const flowApp = apps?.find(item => item.packageId === flow?.id);
  const self = apps?.find(item => item.packageId === device.packageId);
  const selfUpdate = self && releaseAction(self) === 'Update' ? self : undefined;
  const otherApps = apps?.filter(item => item.packageId !== device.packageId) ?? [];
  const groups = apps ? [
    { title: 'Payload update', items: selfUpdate ? [selfUpdate] : [] },
    { title: 'Updates available', items: otherApps.filter(item => releaseAction(item, installed[item.packageId]) === 'Update') },
    { title: 'Catalog', items: otherApps.filter(item => releaseAction(item, installed[item.packageId]) !== 'Update') },
  ] : [];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.surface }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {!token || screen === 'access' ? (
        <>
          <AppBar title={token ? 'Owner access' : 'Payload'} branded={!token} backLabel="Back to settings"
            back={token ? () => { setScreen('settings'); setInput(''); setError(undefined); } : undefined} />
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.center, styles.content, layout.access]}>
            {starting ? <Skeleton /> : <>
              <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{token ? 'Owner access' : 'Connect to Payload'}</Text>
              <Text style={[styles.body, { color: colors.muted }]}>
                {token ? 'Enter a new owner token to replace the one saved on this device.' : 'Enter your owner access token to open the private app library.'}
              </Text>
              <Text style={[styles.label, { color: colors.ink, textAlign: 'left' }]}>Owner access token</Text>
              <TextInput
                accessibilityLabel="Owner access token"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                value={input}
                onChangeText={setInput}
                placeholder="Paste token"
                placeholderTextColor={colors.muted}
                selectionColor={colors.accent}
                returnKeyType="go"
                onSubmitEditing={() => void connect()}
                style={[layout.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors.panel }]}
              />
              {error && <Notice message={error} error />}
              <Button onPress={() => void connect()} disabled={submitting || !input.trim()}>
                {submitting ? 'Connecting…' : token ? 'Save token' : 'Connect'}
              </Button>
            </>}
          </ScrollView>
        </>
      ) : app ? (
        <Details
          app={app}
          installed={app.packageId === device.packageId ? device : installed[app.packageId]}
          downloaded={isDownloaded(app)}
          flow={flow?.id === app.packageId ? flow : undefined}
          busy={busy}
          openError={openError?.id === app.packageId ? openError.message : undefined}
          back={() => setSelected(null)}
          backLabel={screen === 'settings' ? 'Back to settings' : undefined}
          act={() => void act(app)}
          settings={() => settings(app.packageId)}
          confirm={() => confirm(app.packageId)}
        />
      ) : screen === 'settings' ? (
        <SettingsPage
          back={() => { setScreen('library'); setError(undefined); }}
          updateVersion={selfUpdate?.compatible?.versionName}
          checkUpdates={() => {
            setCheckedUpdates(false);
            void loadCatalog(token).then(result => setCheckedUpdates(!!result));
          }}
          viewUpdate={() => setSelected(device.packageId)}
          checking={refreshing}
          checked={checkedUpdates}
          busy={busy}
          error={error}
          notifications={notifications}
          notificationsReady={!!apps}
          editAccess={() => { setScreen('access'); setError(undefined); }}
          signOut={signOut}
          signingOut={signingOut}
        />
      ) : (
        <>
          <AppBar title="Payload" branded right={<Button type="text" onPress={() => {
            setCheckedUpdates(false);
            setScreen('settings');
          }}>Settings</Button>} />
          <ScrollView
            refreshControl={<RefreshControl refreshing={refreshing && apps !== null}
              onRefresh={() => void loadCatalog(token)} colors={[colors.accent]} progressBackgroundColor={colors.panel} />}
            contentContainerStyle={[styles.center, styles.content, layout.library]}
          >
            <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>Library</Text>
            {!selfUpdate && <View style={layout.progressLabel}>
              <Text style={[styles.small, { color: colors.muted, flex: 1 }]}>
                Payload {device.versionName ?? device.versionCode}
              </Text>
              <Button type="text" disabled={refreshing || busy} onPress={() => void loadCatalog(token)}>Check for updates</Button>
            </View>}
            {error && <View style={layout.messageActions}>
              <Notice message={error} error />
              <Button type="tonal" onPress={() => void loadCatalog(token)}>Retry</Button>
            </View>}
            {flow && (busy || flow.phase === 'result') && (
              <View style={layout.messageActions}>
                <Notice error={flow.phase === 'result' && !['success', 'cancelled', 'downloaded'].includes(flow.outcome ?? '')}
                  message={flow.phase === 'result' ? flow.message ?? messages.failed
                    : `${flowApp?.name ?? flow.id} ${['requesting', 'downloading'].includes(flow.phase) ? 'download' : 'installation'} in progress.`} />
                {flowApp && (flow.id !== device.packageId || flow.outcome !== 'success')
                  && <Button type="tonal" onPress={() => setSelected(flow.id)}>View details</Button>}
              </View>
            )}
            {apps === null && !error && <Skeleton />}
            {apps && !otherApps.length && !selfUpdate && <View style={layout.empty}>
              <Text style={[styles.sectionTitle, { color: colors.ink }]}>No published apps</Text>
              <Text style={[styles.body, { color: colors.muted }]}>Publish your first APK from your computer or CI, then pull down to refresh.</Text>
              <Button type="tonal" onPress={() => void loadCatalog(token)}>Refresh library</Button>
            </View>}
            {groups.filter(group => group.items.length).map(group => (
              <View key={group.title} style={layout.group}>
                <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.ink }]}>{group.title}</Text>
                {group.items.map(item => <AppRow key={item.packageId} app={item}
                  installed={item.packageId === device.packageId ? device : installed[item.packageId]}
                  downloaded={isDownloaded(item)}
                  busy={busy}
                  details={() => setSelected(item.packageId)}
                  act={() => void act(item)} />)}
              </View>
            ))}
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}

function Details({ app, installed, downloaded, flow, busy, openError, back, backLabel, act, settings, confirm }: {
  app: CatalogApp;
  installed?: Installed | null;
  downloaded: boolean;
  flow?: Flow;
  busy: boolean;
  openError?: string;
  back: () => void;
  backLabel?: string;
  act: () => void;
  settings: () => void;
  confirm: () => void;
}) {
  const { colors } = useTheme();
  const action = apkAction(app, installed, downloaded);
  const fallback = app.compatible && app.compatible.versionCode !== app.latest.versionCode ? app.compatible : null;
  const facts = [
    ['Installed', installed ? installed.versionName || String(installed.versionCode) : installed === null ? 'Not installed' : 'Checking…'],
    ['Latest', app.latest.versionName],
    ...(fallback ? [['For this phone', fallback.versionName]] : []),
    ['APK size', fileSize((fallback ?? app.latest).size)],
    ...(downloaded && action !== 'Open' ? [['Download', 'Ready to install']] : []),
  ];
  const phase = flow?.phase;
  const downloadProgress = phase === 'downloading' && flow?.size
    ? Math.min(100, Math.floor((flow.received ?? 0) / flow.size * 100)) : undefined;
  const installProgress = flow?.progress === undefined ? undefined
    : Math.max(0, Math.min(100, Math.floor(flow.progress * 100)));
  const installing = phase === 'staging' || phase === 'installing' || phase === 'confirm';
  const progress = phase === 'downloading' ? downloadProgress : installing ? installProgress : undefined;
  let status: string | undefined;
  let button: string | null = action;
  let press = act;
  let disabled = busy && action !== 'Open';
  switch (flow?.phase) {
    case 'permission':
      status = 'In Android settings, turn on Allow from this source for Payload. Then return here to continue.';
      button = 'Open Android settings';
      press = settings;
      break;
    case 'allowed':
      status = 'Android now allows installs from Payload.';
      break;
    case 'requesting':
      status = 'Preparing your download…';
      button = null;
      break;
    case 'downloading':
      status = downloadProgress === 100 ? 'Verifying the downloaded APK…'
        : `Downloading · ${fileSize(flow.received ?? 0)} of ${fileSize(flow.size ?? 0)}`;
      button = null;
      break;
    case 'confirm':
      status = flow.message ?? (app.packageId === device.packageId
        ? 'Confirm the update in Android, then reopen Payload.'
        : 'The APK is ready. Review and confirm the installation in Android.');
      button = 'Continue in Android';
      press = confirm;
      disabled = false;
      break;
    case 'staging':
      status = 'Preparing APK for Android…';
      button = null;
      break;
    case 'installing':
      status = progress === 100 ? 'Finalizing installation…' : 'Android is installing the app…';
      button = null;
      break;
    case 'result':
      status = flow.message;
      if (downloaded && !['success', 'downloaded'].includes(flow.outcome ?? '') && status && !status.includes('The APK is still saved.')) {
        status += ' The downloaded APK is ready to retry.';
      }
      break;
  }
  return (
    <>
      <AppBar title="App details" back={back} backLabel={backLabel} />
      <ScrollView contentContainerStyle={[styles.center, styles.content, layout.detail]}>
        <View style={layout.identity}>
          <Icon app={app} large />
          <Text accessibilityRole="header" style={[styles.title, layout.appName, { color: colors.ink }]}>{app.name}</Text>
        </View>
        <View style={[layout.facts, { borderColor: colors.line }]}>
          {facts.map(([label, value]) => <View key={label} style={layout.fact}>
            <Text style={[styles.small, layout.factLabel, { color: colors.muted }]}>{label}</Text>
            <Text style={[styles.body, layout.factValue, { color: colors.ink }]}>{value}</Text>
          </View>)}
        </View>
        {app.latest.minSdk > device.sdk && <Notice message={
          fallback ? `The latest release needs ${androidMinimum(app.latest.minSdk)}. You can install version ${fallback.versionName} on this phone.`
            : androidRequirement(app.latest.minSdk)
        } />}
        <View style={layout.notes}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.ink }]}>Release notes</Text>
          {fallback && <Text style={[styles.small, { color: colors.muted }]}>Version {app.latest.versionName} · Latest</Text>}
          <Text selectable style={[styles.body, { color: colors.ink }]}>{app.latest.notes.trim() || 'No release notes provided.'}</Text>
        </View>
        {fallback && <View style={layout.notes}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.ink }]}>Version {fallback.versionName} notes</Text>
          <Text selectable style={[styles.body, { color: colors.ink }]}>{fallback.notes.trim() || 'No release notes provided.'}</Text>
        </View>}
      </ScrollView>
      {(status || openError || button) && <View style={[layout.dock, { backgroundColor: colors.panel, borderColor: colors.line }]}>
        <ScrollView bounces={false} style={layout.dockScroll} contentContainerStyle={[styles.center, layout.dockContents]}>
          {openError && <Notice message={openError} error />}
          {status && (progress !== undefined ? (
            <View style={layout.progress}>
              <View style={layout.progressLabel}>
                <Text style={[styles.small, { color: colors.ink, flex: 1 }]}>{status}</Text>
                <Text style={[styles.small, { color: colors.ink }]}>{progress}%</Text>
              </View>
              <View accessibilityRole="progressbar" accessibilityLabel={installing ? 'APK installation' : 'APK download'}
                accessibilityValue={{ min: 0, max: 100, now: progress }}
                style={[layout.progressTrack, { backgroundColor: colors.track }]}>
                <View style={[layout.progressFill, { backgroundColor: colors.accent, width: `${progress}%` }]} />
              </View>
            </View>
          ) : installing && phase !== 'confirm' ? (
            <View style={[layout.progress, layout.progressLabel]}>
              <Text style={[styles.small, { color: colors.ink }]}>{status}</Text>
              <ActivityIndicator accessibilityLabel="APK installation" color={colors.accent} />
            </View>
          ) : <Notice message={status} error={phase === 'result' && !['success', 'cancelled', 'downloaded'].includes(flow?.outcome ?? '')} />)}
          {button && <Button onPress={press} disabled={disabled}>{button}</Button>}
        </ScrollView>
      </View>}
    </>
  );
}

function messageFrom(error: unknown) {
  if (!(error instanceof Error)) return 'Something went wrong. Try again.';
  const code = (error as Error & { code?: string }).code;
  return (code && nativeErrors[code]) || error.message;
}

export default function App() {
  return <SafeAreaProvider><LibraryApp /></SafeAreaProvider>;
}

const layout = StyleSheet.create({
  access: { paddingTop: 38, gap: 16 },
  input: { minHeight: 54, borderWidth: 1, borderRadius: 12, fontSize: 16, paddingHorizontal: 15, paddingVertical: 10 },
  library: { paddingTop: 20, gap: 25 },
  group: { gap: 2 },
  empty: { gap: 14, alignItems: 'flex-start' },
  messageActions: { gap: 8, alignItems: 'flex-start' },
  detail: { paddingTop: 26, gap: 24 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  appName: { flex: 1, fontSize: 30 },
  facts: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 13, gap: 9 },
  fact: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 14 },
  factLabel: { flex: 1 },
  factValue: { flex: 1, textAlign: 'right', fontWeight: '600', fontVariant: ['tabular-nums'] },
  notes: { gap: 9 },
  dock: { borderTopWidth: StyleSheet.hairlineWidth, maxHeight: '59%' },
  dockScroll: { flexGrow: 0 },
  dockContents: { paddingVertical: 10, paddingHorizontal: 22, gap: 8 },
  progress: { gap: 9, paddingVertical: 7 },
  progressLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  progressTrack: { height: 7, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 4 },
});
