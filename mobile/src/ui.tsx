import { useState, type ReactNode } from 'react';
import {
  Image, Pressable, StyleSheet, Text, View, useColorScheme, useWindowDimensions,
} from 'react-native';
import { androidRequirement, apkAction, releaseAction, type CatalogApp, type Installed } from './client';

const light = {
  surface: '#F9F7FC', panel: '#F0ECF7', track: '#DFD7EE',
  ink: '#211D29', muted: '#5C5468', line: '#DED7E8',
  accent: '#493582', onAccent: '#FFFFFF', tonalInk: '#3F2C73',
  error: '#8B242F', errorPanel: '#FCE7E9',
};
const dark: typeof light = {
  surface: '#17141D', panel: '#24202F', track: '#3D3551',
  ink: '#EEE8F6', muted: '#C5BBD2', line: '#3C3549',
  accent: '#D0BEFF', onAccent: '#2E1B60', tonalInk: '#E0D3FF',
  error: '#FFB7BE', errorPanel: '#49242D',
};

export function useTheme() {
  const isDark = useColorScheme() === 'dark';
  return { colors: isDark ? dark : light, isDark };
}

export function Button({
  children, onPress, type = 'filled', disabled = false, label,
}: {
  children: string;
  onPress: () => void;
  type?: 'filled' | 'tonal' | 'text';
  disabled?: boolean;
  label?: string;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const backgroundColor = type === 'filled' ? colors.accent : type === 'tonal' ? colors.panel : 'transparent';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label ?? children}
      android_ripple={{ color: type === 'filled' ? '#80808055' : '#80808040' }}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      disabled={disabled}
      style={({ pressed }) => [styles.button, {
        backgroundColor,
        borderColor: focused ? colors.ink : 'transparent',
        opacity: disabled ? 0.55 : pressed ? 0.83 : 1,
      }]}
    >
      <Text style={[styles.label, { color: type === 'filled' ? colors.onAccent : colors.tonalInk }]}>{children}</Text>
    </Pressable>
  );
}

export function AppBar({ title, back, backLabel = 'Back to library', right, branded = false }: {
  title: string;
  back?: () => void;
  backLabel?: string;
  right?: ReactNode;
  branded?: boolean;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.bar, { backgroundColor: colors.surface }]}>
      {back && <Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        style={[styles.back, { borderColor: focused ? colors.ink : 'transparent' }]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        android_ripple={{ color: colors.track, borderless: true, radius: 24 }}
        onPress={back}
      >
        <View style={[styles.chevron, { borderColor: colors.ink }]} />
        <View style={[styles.arrowLine, { backgroundColor: colors.ink }]} />
      </Pressable>}
      {branded && <Image
        accessible={false}
        source={require('../assets/logo.png')}
        style={[styles.barLogo, { tintColor: colors.accent }]}
      />}
      <Text style={[styles.barTitle, { color: colors.ink }]}>{title}</Text>
      {right}
    </View>
  );
}

export function Icon({ app, large = false }: { app: CatalogApp; large?: boolean }) {
  const { colors } = useTheme();
  const size = large ? 76 : 50;
  return <Image accessible={false} source={{ uri: `data:image/png;base64,${app.icon}` }}
    style={{ width: size, height: size, borderRadius: large ? 19 : 13, backgroundColor: colors.panel }} />;
}

export function AppRow({ app, installed, downloaded, details, act, busy }: {
  app: CatalogApp;
  installed?: Installed | null;
  downloaded: boolean;
  details: () => void;
  act: () => void;
  busy: boolean;
}) {
  const { colors } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [focused, setFocused] = useState(false);
  const stacked = width < 350 || fontScale >= 1.4;
  const action = apkAction(app, installed, downloaded);
  const update = releaseAction(app, installed) === 'Update';
  const current = installed?.versionName || installed?.versionCode;
  const target = app.compatible?.versionName;
  let description = target ? `Version ${target}` : androidRequirement(app.latest.minSdk);
  if (installed) description = update ? `${current} installed · ${target} available` : `${current} installed`;
  return (
    <View style={[styles.row, stacked && styles.stackedRow, { borderBottomColor: colors.line }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${app.name}. ${description}. App details`}
        android_ripple={{ color: colors.track }}
        onPress={details}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.rowDetails, stacked && styles.stackedDetails, {
          backgroundColor: focused ? colors.panel : 'transparent',
        }]}
      >
        <Icon app={app} />
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, { color: colors.ink }]}>{app.name}</Text>
          <Text style={[styles.small, { color: update ? colors.tonalInk : colors.muted }]}>{description}</Text>
        </View>
      </Pressable>
      {action && <View style={stacked && styles.stackedButton}>
        <Button label={`${action} ${app.name}`} onPress={act} disabled={busy && action !== 'Open'}
          type={update ? 'filled' : 'tonal'}>{action}</Button>
      </View>}
    </View>
  );
}

export function Notice({ message, error = false }: { message: string; error?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.notice, { backgroundColor: error ? colors.errorPanel : colors.panel }]}>
      <Text accessibilityLiveRegion="polite" style={[styles.body, { color: error ? colors.error : colors.ink }]}>{message}</Text>
    </View>
  );
}

export function Skeleton() {
  const { colors } = useTheme();
  return <View accessible accessibilityLabel="Loading library" accessibilityState={{ busy: true }} style={{ paddingTop: 8 }}>
    {[0, 1, 2].map(index => <View key={index} style={[styles.row, { borderBottomColor: colors.line }]}>
      <View style={[styles.bone, { width: 50, height: 50, borderRadius: 13, backgroundColor: colors.track }]} />
      <View style={{ flex: 1, gap: 9 }}>
        <View style={[styles.bone, { width: '72%', backgroundColor: colors.track }]} />
        <View style={[styles.bone, { width: '47%', backgroundColor: colors.panel }]} />
      </View>
      <View style={[styles.bone, { height: 36, width: 72, borderRadius: 18, backgroundColor: colors.panel }]} />
    </View>)}
  </View>;
}

export const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { width: '100%', maxWidth: 640, alignSelf: 'center' },
  content: { paddingHorizontal: 22, paddingBottom: 30, flexGrow: 1 },
  bar: { minHeight: 58, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLogo: { width: 28, height: 28 },
  barTitle: { fontSize: 21, fontWeight: '600', flex: 1, paddingVertical: 7, marginStart: 6 },
  back: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, borderWidth: 2 },
  chevron: { width: 12, height: 12, borderLeftWidth: 2, borderBottomWidth: 2, transform: [{ rotate: '45deg' }], marginRight: 6 },
  arrowLine: { position: 'absolute', width: 19, height: 2 },
  button: { minHeight: 48, minWidth: 48, borderRadius: 25, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 8, borderWidth: 2, overflow: 'hidden' },
  label: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  title: { fontSize: 34, fontWeight: '700', letterSpacing: -0.8 },
  sectionTitle: { fontSize: 20, fontWeight: '600' },
  row: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  rowDetails: { flex: 1, minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, overflow: 'hidden' },
  stackedRow: { flexDirection: 'column', gap: 8 },
  stackedDetails: { width: '100%' },
  stackedButton: { alignSelf: 'flex-end', marginBottom: 10 },
  rowText: { flex: 1, gap: 4 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 23 },
  small: { fontSize: 14, lineHeight: 20 },
  notice: { paddingHorizontal: 15, paddingVertical: 12, borderRadius: 14 },
  bone: { height: 10, borderRadius: 5 },
});
