import { requireNativeModule } from 'expo';

export type Release = {
  versionCode: number;
  versionName: string;
  minSdk: number;
  size: number;
  sha256: string;
  notes: string;
  expiresAt: number | null;
};

export type CatalogApp = {
  packageId: string;
  name: string;
  icon: string;
  latest: Release;
  compatible: Release | null;
};

export type Installed = { versionCode: number; versionName: string | null };
export type InstallState = {
  sessionId: number;
  packageId: string;
  stage: 'preparing' | 'confirm' | 'waiting' | 'finished';
  progress?: number;
  result?: string;
};

type Installer = {
  device(): Installed & { sdk: number; packageId: string };
  lookup(ids: string[]): Promise<Record<string, Installed | null>>;
  openApp(id: string): Promise<void>;
  canInstall(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  hasDownload(id: string, version: number, size: number, sha256: string): Promise<boolean>;
  downloadApk(url: string, id: string, version: number, size: number, sha256: string): Promise<void>;
  startInstall(id: string, version: number, size: number, sha256: string): Promise<void>;
  installState(): Promise<InstallState | null>;
  launchConfirmation(): Promise<void>;
  clearResult(id: number): Promise<void>;
  addListener(name: 'downloadProgress', listener: (event: { packageId: string; received: number }) => void): { remove(): void };
};

export const installer = requireNativeModule<Installer>('PayloadInstaller');
export const device = installer.device();
const origin = process.env.EXPO_PUBLIC_PAYLOAD_API_URL;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, token: string, method = 'GET', body?: object): Promise<T> {
  if (!origin) throw new Error('This build needs a catalog address. Set EXPO_PUBLIC_PAYLOAD_API_URL.');
  const url = new URL(path, origin);
  const local = ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(__DEV__ && local && url.protocol === 'http:')) {
    throw new Error('This build needs an HTTPS catalog address.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url.href, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
        ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 401) throw new ApiError('That access token was rejected. Check it and try again.', 401);
    if (response.status === 404 || response.status === 410) {
      throw new ApiError('This APK is no longer available. Refresh the library to see current releases.', response.status);
    }
    if (!response.ok) throw new ApiError('The catalog is temporarily unavailable. Try again.', response.status);
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('Could not reach the catalog. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}

export function syncNotificationSubscription(ownerToken: string, token: string,
  installed: { packageId: string; versionCode: number }[], previousToken?: string) {
  return request('/v1/update-notifications', ownerToken, 'PUT', { token, previousToken, sdk: device.sdk, installed });
}

export function removeNotificationSubscription(ownerToken: string, token: string) {
  return request('/v1/update-notifications', ownerToken, 'DELETE', { token });
}

export async function getCatalog(token: string) {
  return (await request<{ apps: CatalogApp[] }>(`/v1/catalog?sdk=${device.sdk}`, token)).apps;
}

export async function getDownload(token: string, id: string, version: number) {
  return (await request<{ url: string }>(`/v1/downloads/${id}/${version}`, token, 'POST')).url;
}

export function releaseAction(app: CatalogApp, installed?: Installed | null) {
  const release = app.compatible;
  if (app.packageId === device.packageId) return release && release.versionCode > device.versionCode ? 'Update' : null;
  if (installed && (!release || installed.versionCode >= release.versionCode)) return 'Open';
  if (!release) return null;
  return installed ? 'Update' : 'Install';
}

export function apkAction(app: CatalogApp, installed: Installed | null | undefined, downloaded: boolean) {
  const action = releaseAction(app, installed);
  if (!action || action === 'Open') return action;
  if (!downloaded) return 'Download';
  return action === 'Update' ? 'Install update' : 'Install';
}

const androidVersions: Record<number, string> = {
  21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9',
  29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16', 37: '17',
};

export function androidMinimum(sdk: number) {
  return androidVersions[sdk] ? `Android ${androidVersions[sdk]} or later` : `Android API level ${sdk} or later`;
}

export function androidRequirement(sdk: number) {
  return `Requires ${androidMinimum(sdk)}.`;
}

export function fileSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
