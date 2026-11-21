import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

export const ownerToken = 'local-owner-access';
export const publishToken = 'local-ci-access';
export const bucketName = 'payload-test';
export const apkMime = 'application/vnd.android.package-archive';
export const s3Credentials = { accessKeyId: 'local-test-access', secretAccessKey: 'local-test-secret' };

export async function workerHarness() {
  const program = await build({
    stdin: {
      contents: `
        import worker, { cleanup } from './src/index.ts';
        import { deliverUpdateNotifications } from './src/push.ts';
        export default {
          ...worker,
          async fetch(request, env) {
            const url = new URL(request.url);
            if (url.pathname === '/__test_push') {
              const deliveries = [];
              const mode = url.searchParams.get('mode');
              await deliverUpdateNotifications(env.DB, async job => {
                deliveries.push(job);
                if (mode === 'rate-limit') return {};
                return mode === 'unregistered' ? 'unregistered' : 'sent';
              }, Number(url.searchParams.get('now')));
              return Response.json({ deliveries });
            }
            // The local R2 binding omits storage class even for a Standard object.
            const bindings = {
              ...env,
              APKS: {
                async head(key) {
                  const object = await env.APKS.head(key);
                  return object && {
                    size: object.size, customMetadata: object.customMetadata,
                    httpMetadata: object.httpMetadata, storageClass: object.storageClass || 'Standard',
                  };
                },
                delete(keys) {
                  if (url.searchParams.has('fail')) throw new Error('Injected R2 deletion failure');
                  return env.APKS.delete(keys);
                },
              },
            };
            if (url.pathname !== '/__test_cleanup') return worker.fetch(request, bindings);
            await cleanup(bindings, Number(url.searchParams.get('now')));
            return new Response(null, { status: 204 });
          },
        };
      `,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true, write: false, format: 'esm',
  });
  const mf = new Miniflare({
    modules: true,
    script: program.outputFiles[0].text,
    compatibilityDate: '2026-07-30',
    bindings: {
      OWNER_TOKEN: ownerToken,
      PUBLISH_TOKEN: publishToken,
      R2_ACCOUNT_ID: '1234567890abcdef1234567890abcdef',
      R2_BUCKET_NAME: bucketName,
      R2_READ_ACCESS_KEY_ID: 'local-access-key',
      R2_READ_SECRET_ACCESS_KEY: 'local-signing-secret',
      FCM_SERVICE_ACCOUNT: 'local-test-credential',
    },
    d1Databases: ['DB'],
    r2Buckets: { APKS: { id: bucketName, s3Credentials } },
  });
  try {
    const db = await mf.getD1Database('DB');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      const migration = await readFile(new URL(file, migrations), 'utf8');
      // Keep trigger bodies intact while applying each migration as a batch.
      const statements = migration.replace(/^--.*$/gm, '')
        .split(/;\s*(?=CREATE|INSERT INTO apps|$)/i).map(s => s.trim()).filter(Boolean);
      await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const bucket = await mf.getR2Bucket('APKS');
    return { mf, db, bucket };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

export function call(mf, path, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  return mf.dispatchFetch(`http://payload.test${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function upload(bucket, key, bytes, sha256) {
  return bucket.put(key, bytes, {
    customMetadata: { sha256 },
    httpMetadata: { contentType: apkMime, cacheControl: 'private, no-store' },
    storageClass: 'Standard',
  });
}
