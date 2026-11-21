import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { workerHarness, call, upload, ownerToken, publishToken } from './harness.mjs';

const retention = 30 * 24 * 60 * 60 * 1000;
const packageId = 'app.payload.fixture';
const catalogRoute = '/v1/catalog?sdk=34';
const downloadRoute = version => `/v1/downloads/${packageId}/${version}`;
const icon = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lO8AAAAASUVORK5CYII=';
const app = { packageId, name: 'Sample app', icon, certificateSha256: 'a'.repeat(64) };

function release(versionCode, minSdk, bytes = Buffer.from(`fixture-${versionCode}`)) {
  return {
    bytes,
    body: {
      packageId, versionCode, minSdk, versionName: String(versionCode),
      notes: `Version ${versionCode} notes`, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      certificateSha256: 'a'.repeat(64),
    },
  };
}

async function put({ mf, bucket }, { body, bytes }) {
  const preflight = await call(mf, '/v1/publish/preflight', { token: publishToken, body });
  assert.equal(preflight.status, 200);
  const { objectKey } = await preflight.json();
  await upload(bucket, objectKey, bytes, body.sha256);
  return objectKey;
}

const publish = (mf, body) => call(mf, '/v1/publish', { token: publishToken, body });
const register = (mf, body = app) => call(mf, '/v1/apps', { token: publishToken, body });
const readCatalog = async mf => (await (await call(mf, catalogRoute, { token: ownerToken })).json()).apps;
const rows = db => db.prepare('SELECT * FROM releases ORDER BY version_code').all().then(r => r.results);

test('update pushes target installed compatible versions and respect opt-out, retries and invalid tokens', async t => {
  const harness = await workerHarness();
  const { mf, db } = harness;
  t.after(() => mf.dispose());
  assert.equal((await register(mf)).status, 201);
  const first = release(1, 24);
  await put(harness, first);
  assert.equal((await publish(mf, first.body)).status, 201);

  const address = name => `fixture-fcm-registration:${name}`;
  const subscribe = (name, sdk, installed, auth = ownerToken, previousToken) => call(mf, '/v1/update-notifications', {
    method: 'PUT', token: auth,
    body: { token: address(name), previousToken, sdk, installed: installed === null ? [] : [{ packageId, versionCode: installed }] },
  });
  assert.equal((await subscribe('invalid', 36, 1, publishToken)).status, 401);
  for (const [name, sdk, version] of [
    ['eligible', 36, 1], ['opt-out', 36, 1], ['already-updated', 36, 1],
    ['old-android', 29, 1], ['current', 36, 2], ['not-installed', 36, null],
  ]) {
    assert.equal((await subscribe(name, sdk, version)).status, 200);
  }
  const second = release(2, 34);
  await put(harness, second);
  const pending = () => db.prepare('SELECT token FROM push_jobs ORDER BY token').all().then(r => r.results.map(row => row.token));
  assert.deepEqual(await pending(), []);
  assert.equal((await publish(mf, second.body)).status, 201);
  assert.equal((await publish(mf, second.body)).status, 200);
  assert.deepEqual(await pending(), ['already-updated', 'eligible', 'opt-out'].map(address));
  assert.equal((await call(mf, '/v1/update-notifications', {
    method: 'DELETE', token: ownerToken, body: { token: address('opt-out') },
  })).status, 200);
  assert.equal((await subscribe('already-updated', 36, 2)).status, 200);
  assert.equal((await subscribe('rotated', 36, 1, ownerToken, address('eligible'))).status, 200);

  const now = Date.now() + 1000;
  const pump = async (ms, mode = '') => {
    const response = await call(mf, `/__test_push?now=${ms}&mode=${mode}`);
    assert.equal(response.status, 200);
    return (await response.json()).deliveries;
  };
  const [push] = await pump(now, 'rate-limit');
  assert.equal(push.token, address('rotated'));
  assert.equal(push.packageId, packageId);
  assert.equal(push.name, 'Sample app');
  assert.deepEqual(await pump(now + 60_000), []);
  assert.deepEqual(await pump(now + 300_000, 'unregistered'), [push]);
  assert.deepEqual(await pump(now + 20 * 60_000), []);
  assert.deepEqual(await pending(), []);
  assert.equal(await db.prepare('SELECT token FROM push_devices WHERE token = ?').bind(address('rotated')).first(), null);
});

test('private catalog, publish-first upload, large objects, immutable retries and concurrent publishers', async t => {
  const harness = await workerHarness();
  const { mf, db, bucket } = harness;
  t.after(() => mf.dispose());
  for (const token of [undefined, 'invalid', publishToken]) {
    assert.equal((await call(mf, catalogRoute, { token })).status, 401);
    assert.equal((await call(mf, downloadRoute(1), { token, method: 'POST' })).status, 401);
  }

  const first = release(1, 24, Buffer.alloc(55 * 1024 ** 2, 0x73));
  assert.equal((await call(mf, '/v1/publish', { token: ownerToken, body: first.body })).status, 401);
  assert.equal((await publish(mf, first.body)).status, 404);
  assert.equal((await register(mf)).status, 201);
  assert.equal((await publish(mf, first.body)).status, 409);
  assert.deepEqual(await readCatalog(mf), []);

  const key = await put(harness, first);
  const object = await bucket.head(key);
  assert.equal(object.size, 55 * 1024 ** 2);
  assert.equal(object.customMetadata.sha256, first.body.sha256);
  assert.equal(object.httpMetadata.contentType, 'application/vnd.android.package-archive');
  const same = await Promise.all([publish(mf, first.body), publish(mf, first.body)]);
  assert.deepEqual(same.map(result => result.status).sort(), [200, 201]);
  assert.equal((await readCatalog(mf))[0].latest.size, first.bytes.length);

  const differentBytes = release(1, 24, Buffer.from('changed'));
  assert.equal((await publish(mf, differentBytes.body)).status, 409);
  assert.equal((await rows(db)).length, 1);
  const second = release(2, 24);
  const competing = release(2, 24, Buffer.from('another build'));
  await Promise.all([put(harness, second), put(harness, competing)]);
  const results = await Promise.all([publish(mf, second.body), publish(mf, competing.body)]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const [older, current] = await rows(db);
  assert.equal(older.expires_at, current.published_at + retention);
  assert.equal(current.expires_at, null);
});

test('successive releases keep separate deadlines, cap links, and retry expired object deletion', async t => {
  const harness = await workerHarness();
  const { mf, db, bucket } = harness;
  t.after(() => mf.dispose());
  assert.equal((await register(mf)).status, 201);
  const releases = [release(1, 24), release(2, 34), release(3, 36)];
  const keys = [];
  for (const candidate of releases) {
    keys.push(await put(harness, candidate));
    assert.equal((await publish(mf, candidate.body)).status, 201);
  }
  const [first, second, current] = await rows(db);
  assert.equal(first.expires_at, second.published_at + retention);
  assert.equal(second.expires_at, current.published_at + retention);
  assert.equal(current.expires_at, null);
  const repeat = await publish(mf, releases[0].body);
  assert.deepEqual(await repeat.json(), { status: 'already-published', expiresAt: first.expires_at });
  assert.equal((await rows(db))[0].expires_at, first.expires_at);
  assert.equal((await readCatalog(mf))[0].compatible.versionCode, 2);

  const deadline = Date.now() + 60_400;
  await db.prepare('UPDATE releases SET expires_at = ? WHERE version_code = 2').bind(deadline).run();
  const allowed = await call(mf, downloadRoute(2), { token: ownerToken, method: 'POST' });
  assert.equal(allowed.status, 200);
  const signed = await allowed.json();
  const url = new URL(signed.url);
  assert.equal(url.pathname, `/payload-test/${keys[1]}`);
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  const signedDate = url.searchParams.get('X-Amz-Date');
  const signedTime = Date.parse(signedDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
  assert.equal(signed.expiresAt, signedTime + 1000 * Number(url.searchParams.get('X-Amz-Expires')));
  assert.ok(signed.expiresAt <= deadline && signed.expiresAt > deadline - 1000);

  const expired = Date.now() - 1;
  await db.prepare('UPDATE releases SET expires_at = ? WHERE version_code = 2').bind(expired).run();
  assert.equal((await call(mf, downloadRoute(2), { token: ownerToken, method: 'POST' })).status, 410);
  assert.equal((await readCatalog(mf))[0].compatible.versionCode, 1);
  assert.ok(await bucket.head(keys[1]));

  await call(mf, `/__test_cleanup?now=${expired}&fail`);
  assert.ok(await bucket.head(keys[1]));
  const failed = (await rows(db))[1];
  assert.match(failed.cleanup_error, /Injected R2 deletion failure/);
  assert.equal(failed.deleted_at, null);
  assert.equal(failed.cleanup_attempted_at, expired);

  const nextRun = expired + 15 * 60 * 1000;
  await call(mf, `/__test_cleanup?now=${nextRun}`);
  assert.equal(await bucket.head(keys[1]), null);
  assert.equal((await rows(db))[1].deleted_at, nextRun);
  assert.equal((await rows(db))[1].cleanup_error, null);
  const expiredRetry = await call(mf, '/v1/publish/preflight', { token: publishToken, body: releases[1].body });
  assert.equal((await expiredRetry.json()).status, 'already-published');
  assert.equal(await bucket.head(keys[1]), null);
  assert.ok(await bucket.head(keys[0]));
  assert.ok(await bucket.head(keys[2]));
  assert.equal((await call(mf, downloadRoute(3), { token: ownerToken, method: 'POST' })).status, 200);

  await call(mf, `/__test_cleanup?now=${first.expires_at}`);
  assert.equal(await bucket.head(keys[0]), null);
  assert.ok(await bucket.head(keys[2]));
  assert.equal((await readCatalog(mf))[0].compatible, null);
  assert.equal((await rows(db))[0].notes, 'Version 1 notes');
});

test('publisher registration pins app identity and signing certificate', async t => {
  const { mf } = await workerHarness();
  t.after(() => mf.dispose());
  assert.equal((await call(mf, '/v1/apps', { token: ownerToken })).status, 401);
  assert.equal((await register(mf)).status, 201);
  assert.equal((await register(mf)).status, 200);
  assert.equal((await register(mf, { ...app, name: 'Other name' })).status, 409);
  const second = { ...app, packageId: 'app.payload.second', certificateSha256: 'b'.repeat(64) };
  assert.equal((await register(mf, second)).status, 201);
  const { apps } = await (await call(mf, '/v1/apps', { token: publishToken })).json();
  assert.deepEqual(apps.map(item => item.packageId), [packageId, second.packageId]);
  assert.ok(apps.every(item => item.latestVersionCode === null));
  assert.deepEqual(await readCatalog(mf), []);
  const { body } = release(1, 24);
  const wrongCert = await call(mf, '/v1/publish/preflight', {
    token: publishToken, body: { ...body, packageId: second.packageId },
  });
  assert.equal(wrongCert.status, 409);
  assert.match((await wrongCert.json()).error, /signing certificate/i);
});
