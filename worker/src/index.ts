import { AwsClient } from 'aws4fetch';
import { createFcmSender } from './fcm';
import { deliverUpdateNotifications, isPushToken, storePushSubscription } from './push';

interface Env {
  DB: D1Database;
  APKS: R2Bucket;
  OWNER_TOKEN: string;
  PUBLISH_TOKEN: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_READ_ACCESS_KEY_ID: string;
  R2_READ_SECRET_ACCESS_KEY: string;
  FCM_SERVICE_ACCOUNT?: string;
}

type Release = {
  packageId: string;
  versionCode: number;
  versionName: string;
  minSdk: number;
  notes: string;
  sha256: string;
  certificateSha256: string;
  size: number;
};

const apkMime = 'application/vnd.android.package-archive';
const packagePattern = /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maxApkBytes = 5 * 1024 ** 3;
const publicColumns = `version_code AS versionCode, version_name AS versionName,
  min_sdk AS minSdk, notes, size, sha256, expires_at AS expiresAt`;

type App = { packageId: string; name: string; icon: string; certificateSha256: string };
const appColumns = 'package_id AS packageId, name, icon, certificate_sha256 AS certificateSha256';

function reply(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

async function authorized(request: Request, secret: string | undefined) {
  const header = request.headers.get('Authorization');
  if (!secret || !header?.startsWith('Bearer ') || header.length > 1024) return false;
  const encoder = new TextEncoder();
  const supplied = await crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7)));
  const expected = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.timingSafeEqual(supplied, expected);
}

function validText(value: unknown, max: number, optional = false): value is string {
  return typeof value === 'string' && value.length <= max && (optional || !!value.trim());
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}

function validRelease(value: unknown): value is Release {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<Release>;
  return validText(r.packageId, 255) && packagePattern.test(r.packageId)
    && integer(r.versionCode) && validText(r.versionName, 120) && integer(r.minSdk, 10_000)
    && validText(r.notes, 20_000, true)
    && validText(r.sha256, 64) && digestPattern.test(r.sha256)
    && validText(r.certificateSha256, 64) && digestPattern.test(r.certificateSha256)
    && integer(r.size, maxApkBytes);
}

async function readJson(request: Request): Promise<unknown> {
  const limit = 256 * 1024;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let length = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch {
    return null;
  }
}

async function updateSubscription(request: Request, env: Env) {
  const body = await readJson(request) as {
    token?: unknown; sdk?: unknown; installed?: unknown; previousToken?: unknown;
  } | null;
  if (!body || !isPushToken(body.token)) return reply({ error: 'Invalid notification token.' }, 400);
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM push_devices WHERE token = ?').bind(body.token).run();
    return reply({ status: 'disabled' });
  }
  if (!env.FCM_SERVICE_ACCOUNT) return reply({ error: 'Update notifications are not configured for this store.' }, 503);
  if (!integer(body.sdk, 10_000) || !Array.isArray(body.installed) || body.installed.length > 1000
    || (body.previousToken !== undefined && !isPushToken(body.previousToken))
    || !body.installed.every(item => item && validText(item.packageId, 255)
      && packagePattern.test(item.packageId) && integer(item.versionCode))) {
    return reply({ error: 'Invalid notification subscription.' }, 400);
  }
  const installed = body.installed.map(({ packageId, versionCode }) => ({ packageId, versionCode }));
  await storePushSubscription(env.DB, body.token, body.sdk, installed, body.previousToken);
  return reply({ status: 'enabled' });
}

function validApp(value: unknown): value is App {
  if (!value || typeof value !== 'object') return false;
  const app = value as Partial<App>;
  return validText(app.packageId, 255) && packagePattern.test(app.packageId)
    && validText(app.name, 120)
    && validText(app.icon, 131_072) && app.icon.length % 4 === 0
    && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(app.icon)
    && validText(app.certificateSha256, 64) && digestPattern.test(app.certificateSha256);
}

function findApp(env: Env, packageId: string) {
  return env.DB.prepare(`SELECT ${appColumns} FROM apps WHERE package_id = ?`).bind(packageId).first<App>();
}

async function registerApp(request: Request, env: Env) {
  const app = await readJson(request);
  if (!validApp(app)) return reply({ error: 'Invalid app registration.' }, 400);
  const name = app.name.trim();
  const write = await env.DB.prepare(`
    INSERT INTO apps (package_id, name, icon, certificate_sha256) VALUES (?, ?, ?, ?)
    ON CONFLICT(package_id) DO NOTHING
  `).bind(app.packageId, name, app.icon, app.certificateSha256).run();
  if (write.meta.changes) return reply({ status: 'created', packageId: app.packageId, name }, 201);
  const existing = await findApp(env, app.packageId);
  if (existing?.name === name && existing.icon === app.icon && existing.certificateSha256 === app.certificateSha256) {
    return reply({ status: 'already-registered', packageId: app.packageId, name });
  }
  return reply({ error: 'This Android package ID is already registered with different details.' }, 409);
}

async function listApps(env: Env) {
  const { results } = await env.DB.prepare(`
    SELECT a.package_id AS packageId, a.name, a.certificate_sha256 AS certificateSha256,
      r.version_code AS latestVersionCode, r.version_name AS latestVersionName
    FROM apps a LEFT JOIN releases r ON r.package_id = a.package_id AND r.expires_at IS NULL
    ORDER BY a.name COLLATE NOCASE, a.package_id
  `).all();
  return reply({ apps: results });
}

async function existingRelease(env: Env, r: Release) {
  const row = await env.DB.prepare(`
    SELECT version_code AS versionCode, sha256, expires_at AS expiresAt FROM releases
    WHERE package_id = ? AND (version_code = ? OR expires_at IS NULL)
    ORDER BY (version_code = ?) DESC LIMIT 1
  `).bind(r.packageId, r.versionCode, r.versionCode)
    .first<{ versionCode: number; sha256: string; expiresAt: number | null }>();
  if (row?.versionCode === r.versionCode) {
    return row.sha256 === r.sha256
      ? reply({ status: 'already-published', expiresAt: row.expiresAt })
      : reply({ error: 'This version code was already published with different bytes.' }, 409);
  }
  if (row && row.versionCode > r.versionCode) {
    return reply({ error: 'Version code must be higher than the current release.' }, 409);
  }
  return null;
}

async function publish(request: Request, env: Env, preflight: boolean) {
  const r = await readJson(request);
  if (!validRelease(r)) return reply({ error: 'Invalid release metadata.' }, 400);
  const existing = await existingRelease(env, r);
  if (existing) return existing;
  const app = await findApp(env, r.packageId);
  if (!app) return reply({ error: 'Register this app before publishing a release.' }, 404);
  if (app.certificateSha256 !== r.certificateSha256) {
    return reply({ error: 'The signing certificate does not match the registered app.' }, 409);
  }
  const objectKey = `apks/${r.packageId}/${r.versionCode}/${r.sha256}.apk`;
  if (preflight) return reply({ status: 'upload', objectKey });

  const object = await env.APKS.head(objectKey);
  if (object?.size !== r.size || object.customMetadata?.sha256 !== r.sha256
    || object.storageClass !== 'Standard' || object.httpMetadata?.contentType !== apkMime) {
    return reply({ error: 'The matching Standard APK object must be uploaded first.' }, 409);
  }

  const result = await env.DB.prepare(`
    INSERT INTO releases (
      package_id, version_code, version_name, min_sdk, app_name, icon, notes, sha256,
      certificate_sha256, size, object_key, published_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)
    WHERE NOT EXISTS (
      SELECT 1 FROM releases WHERE package_id = ? AND version_code >= ?
    )
  `).bind(r.packageId, r.versionCode, r.versionName, r.minSdk, app.name, app.icon, r.notes,
    r.sha256, r.certificateSha256, r.size, objectKey, r.packageId, r.versionCode).run();
  if (result.meta.changes === 0) {
    return await existingRelease(env, r) ?? reply({ error: 'Publication conflict.' }, 409);
  }
  return reply({ status: 'published' }, 201);
}

async function catalog(env: Env, sdk: number) {
  const { results } = await env.DB.prepare(`
    SELECT package_id AS packageId, app_name AS name, icon, ${publicColumns},
      CASE WHEN current.min_sdk > ? THEN (
        SELECT json_object(
          'versionCode', version_code, 'versionName', version_name, 'minSdk', min_sdk,
          'notes', notes, 'size', size, 'sha256', sha256, 'expiresAt', expires_at
        )
        FROM releases WHERE package_id = current.package_id AND min_sdk <= ?
          AND expires_at > ? AND deleted_at IS NULL
        ORDER BY version_code DESC LIMIT 1
      ) END AS fallback
    FROM releases AS current WHERE expires_at IS NULL ORDER BY app_name COLLATE NOCASE, package_id
  `).bind(sdk, sdk, Date.now()).all<{
    packageId: string;
    name: string;
    icon: string;
    versionCode: number;
    versionName: string;
    minSdk: number;
    notes: string;
    size: number;
    sha256: string;
    expiresAt: number | null;
    fallback: string | null;
  }>();
  return reply({ apps: results.map(({ packageId, name, icon, fallback, ...latest }) => ({
    packageId, name, icon, latest,
    compatible: latest.minSdk <= sdk ? latest : fallback ? JSON.parse(fallback) : null,
  })) });
}

async function download(env: Env, packageId: string, versionCode: number) {
  const row = await env.DB.prepare(`
    SELECT object_key AS objectKey, expires_at AS expiresAt
    FROM releases WHERE package_id = ? AND version_code = ? AND deleted_at IS NULL
  `).bind(packageId, versionCode).first<{ objectKey: string; expiresAt: number | null }>();
  if (!row) return reply({ error: 'This APK is no longer available.' }, 404);

  const now = Date.now();
  const signedAt = Math.floor(now / 1000) * 1000;
  // SigV4 uses whole seconds. Never round a retention deadline up.
  const expiresAt = Math.min(signedAt + 300_000, Math.floor((row.expiresAt ?? Infinity) / 1000) * 1000);
  if ((row.expiresAt !== null && now >= row.expiresAt) || expiresAt <= now) {
    return reply({ error: 'This APK is no longer available.' }, 410);
  }
  const endpoint = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${row.objectKey}`);
  endpoint.searchParams.set('X-Amz-Expires', String((expiresAt - signedAt) / 1000));
  const signer = new AwsClient({
    accessKeyId: env.R2_READ_ACCESS_KEY_ID,
    secretAccessKey: env.R2_READ_SECRET_ACCESS_KEY,
    region: 'auto',
    service: 's3',
  });
  const signed = await signer.sign(endpoint, {
    aws: { signQuery: true, datetime: new Date(signedAt).toISOString().replace(/[-:]|\.\d{3}/g, '') },
  });
  if (Date.now() >= expiresAt) return reply({ error: 'This APK is no longer available.' }, 410);
  return reply({ url: signed.url, expiresAt });
}

export async function cleanup(env: Env, now = Date.now()) {
  for (;;) {
    const { results } = await env.DB.prepare(`
      SELECT object_key AS objectKey FROM releases
      WHERE expires_at <= ? AND deleted_at IS NULL
        AND (cleanup_attempted_at IS NULL OR cleanup_attempted_at < ?)
      ORDER BY expires_at LIMIT 100
    `).bind(now, now).all<{ objectKey: string }>();
    if (!results.length) return;
    const keys = results.map(row => row.objectKey);
    let error: string | null = null;
    try {
      await env.APKS.delete(keys);
    } catch (cause) {
      error = String(cause).slice(0, 500);
    }
    await env.DB.prepare(`
      UPDATE releases SET cleanup_attempted_at = ?, cleanup_error = ?, deleted_at = ?
      WHERE object_key IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL
    `).bind(now, error, error === null ? now : null, JSON.stringify(keys)).run();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const publishRoute = url.pathname === '/v1/publish' || url.pathname === '/v1/publish/preflight';
    const appsRoute = url.pathname === '/v1/apps';
    const appRoute = /^\/v1\/apps\/([^/]+)$/.exec(url.pathname);
    const publishing = publishRoute || appsRoute || !!appRoute;
    const publishSecret = env.PUBLISH_TOKEN !== env.OWNER_TOKEN ? env.PUBLISH_TOKEN : undefined;
    if (!await authorized(request, publishing ? publishSecret : env.OWNER_TOKEN)) {
      return reply({ error: 'Invalid access token.' }, 401);
    }
    try {
      if (url.pathname === '/v1/update-notifications' && ['PUT', 'DELETE'].includes(request.method)) {
        return await updateSubscription(request, env);
      }
      if (publishRoute && request.method === 'POST') {
        return await publish(request, env, url.pathname.endsWith('/preflight'));
      }
      if (appsRoute && request.method === 'POST') return await registerApp(request, env);
      if (appsRoute && request.method === 'GET') return await listApps(env);
      if (appRoute && request.method === 'GET' && packagePattern.test(appRoute[1])) {
        const app = await findApp(env, appRoute[1]);
        return app ? reply({ packageId: app.packageId, name: app.name, certificateSha256: app.certificateSha256 })
          : reply({ error: 'This app is not registered.' }, 404);
      }
      if (request.method === 'GET' && url.pathname === '/v1/catalog') {
        const sdk = Number(url.searchParams.get('sdk'));
        return integer(sdk, 10_000) ? await catalog(env, sdk) : reply({ error: 'Invalid Android SDK.' }, 400);
      }
      const route = /^\/v1\/downloads\/([^/]+)\/(\d+)$/.exec(url.pathname);
      if (request.method === 'POST' && route && packagePattern.test(route[1]) && integer(Number(route[2]))) {
        return await download(env, route[1], Number(route[2]));
      }
      return reply({ error: 'Endpoint not found.' }, 404);
    } catch (cause) {
      console.error('Payload request failed', cause instanceof Error ? cause.name : 'Unknown error');
      return reply({ error: 'Payload is temporarily unavailable.' }, 503);
    }
  },
  async scheduled(controller: ScheduledController, env: Env) {
    if (controller.cron === '* * * * *') {
      if (env.FCM_SERVICE_ACCOUNT) await deliverUpdateNotifications(env.DB, createFcmSender(env.FCM_SERVICE_ACCOUNT));
    } else {
      await cleanup(env);
    }
  },
} satisfies ExportedHandler<Env>;
