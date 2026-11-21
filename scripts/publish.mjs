import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { apkDetails } from './android-tools.mjs';
import { uploadProgress } from './upload-progress.mjs';
import { payloadHome, readWindowsCredentials } from './windows-credentials.mjs';

const apkMime = 'application/vnd.android.package-archive';
const maxApkBytes = 5 * 1024 ** 3;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

const packagePattern = /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/;
const publisherNames = ['PAYLOAD_API_URL', 'PAYLOAD_PUBLISH_TOKEN', 'PAYLOAD_R2_ACCOUNT_ID',
  'PAYLOAD_R2_BUCKET', 'PAYLOAD_R2_WRITE_ACCESS_KEY_ID', 'PAYLOAD_R2_WRITE_SECRET_ACCESS_KEY'];

export function validPackageId(id) {
  if (typeof id !== 'string' || id.length > 255 || !packagePattern.test(id)) {
    throw new Error('Supply a valid Android package ID, such as com.example.myapp.');
  }
  return id;
}

export function certificateFingerprint(value) {
  const digest = value?.trim().replaceAll(':', '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest ?? '')) throw new Error('Supply the expected certificate SHA-256 fingerprint.');
  return digest;
}

function signerDigests(verification) {
  return [...verification.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})\s*$/gmi)]
    .map(match => match[1].toLowerCase());
}

export function readApkMetadata(badging, manifest, verification, expected) {
  const expectedDigest = certificateFingerprint(expected);
  const signers = signerDigests(verification);
  if (signers.length !== 1 || signers[0] !== expectedDigest) {
    throw new Error('The APK signature does not match the expected signing certificate.');
  }
  if (/^application-debuggable\s*$/m.test(badging)) throw new Error('Use a release APK with debugging disabled.');
  if (/^\s*A: split(?:\(|=)|^\s*E: uses-split\b|isSplitRequired.*(?:0xffffffff|0x1|true)\s*$|com\.android\.vending\.splits\.required/m.test(manifest)) {
    throw new Error('Publish a standalone APK.');
  }
  const packageLine = badging.match(/^package: (.+)$/m)?.[1] ?? '';
  const packageId = packageLine.match(/\bname='([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)'/)?.[1];
  const code = Number(packageLine.match(/\bversionCode='(\d+)'/)?.[1]);
  const major = Number(manifest.match(/\bandroid:versionCodeMajor[^=]*=\(type 0x10\)(0x[\da-f]+|\d+)/i)?.[1] ?? 0);
  const versionCode = major * 2 ** 32 + code;
  const versionName = packageLine.match(/\bversionName='(.*?)'(?: platformBuildVersionName=| compileSdkVersion=|$)/)?.[1];
  const minSdk = Number(badging.match(/^sdkVersion:'(\d+)'$/m)?.[1]
    ?? (/^sdkVersion:/m.test(badging) ? NaN : 1));
  if (!packageId || !Number.isSafeInteger(versionCode) || versionCode <= 0
      || !versionName || !Number.isSafeInteger(minSdk) || minSdk <= 0) {
    throw new Error('Cannot read the APK package ID, version, or minimum Android SDK.');
  }
  return { packageId, versionCode, versionName, minSdk, certificateSha256: expectedDigest };
}

export async function inspectApk(path, expected) {
  const { badging, manifest, verification } = await apkDetails(resolve(path));
  const signers = signerDigests(verification);
  if (signers.length !== 1) throw new Error('Expected one verified APK signing certificate.');
  return {
    ...readApkMetadata(badging, manifest, verification, expected ?? signers[0]),
    name: badging.match(/^application-label:'(.*)'\r?$/m)?.[1] ?? null,
  };
}

async function digestApk(path) {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk);
    md5.update(chunk);
  }
  return { sha256: sha256.digest('hex'), md5: md5.digest('base64') };
}

function required(settings, name) {
  const value = settings[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

async function publishRequest(origin, token, route, metadata) {
  const response = await fetch(new URL(route, origin), {
    method: metadata === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: metadata === undefined ? undefined : JSON.stringify(metadata),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Publish API (${response.status}) — ${result?.error ?? 'Request failed.'}`);
  if (!result) throw new Error('The server returned an invalid publishing response.');
  return result;
}

export function publisher() {
  const explicit = publisherNames.some(name => process.env[name]?.trim()) || process.env.PAYLOAD_R2_LOCAL_ENDPOINT;
  const settings = explicit ? process.env : readWindowsCredentials(
    payloadHome && join(payloadHome, 'cloudflare.credentials.clixml'), publisherNames,
  );
  const origin = new URL(required(settings, 'PAYLOAD_API_URL'));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) {
    throw new Error('PAYLOAD_API_URL must use HTTPS.');
  }
  const token = required(settings, 'PAYLOAD_PUBLISH_TOKEN');
  return { origin, local, settings, request: (path, data) => publishRequest(origin, token, path, data) };
}

export async function readAppIcon(path) {
  if ((await stat(path)).size > 98_304) throw new Error('Use an app icon PNG up to 96 KiB.');
  const icon = await readFile(path);
  if (!icon.subarray(0, 8).equals(pngSignature)) throw new Error('Use an app icon PNG.');
  return icon.toString('base64');
}

export async function projectApp(client, project, explicit) {
  const link = await readFile(resolve(project, 'payload-app.json'), 'utf8')
    .then(JSON.parse, error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (link !== undefined) {
    if (!link || typeof link !== 'object' || link.store !== client.origin.origin) {
      throw new Error('The project is linked to a different Payload store or has an invalid payload-app.json.');
    }
    validPackageId(link.packageId);
    if (explicit && explicit !== link.packageId) {
      throw new Error('The selected app conflicts with this project’s payload-app.json.');
    }
  }
  if (!explicit && !link) throw new Error('Select --app PACKAGE_ID or run payload app link for this project.');
  return validPackageId(explicit ?? link.packageId);
}

export async function publish(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      app: { type: 'string' },
      project: { type: 'string', default: '.' },
      notes: { type: 'string' },
      'progress-file': { type: 'string' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('payload publish ./app.apk [--app PACKAGE_ID] [--project DIRECTORY] [--notes FILE] [--progress-file PATH] [--dry-run] [--json]');
    return;
  }
  if (positionals.length !== 1) {
    throw new Error('Specify one signed release APK. See publish --help.');
  }
  const progress = uploadProgress({ json: values.json, file: values['progress-file'] });
  try {
    await publishApk(values, positionals[0], progress);
  } catch (error) {
    progress.update('failed');
    throw error;
  }
}

async function publishApk(values, path, progress) {
  const client = publisher();
  const target = await projectApp(client, values.project, values.app);
  const app = await client.request(`/v1/apps/${target}`);
  if (app.packageId !== target) throw new Error('The server returned a different app than requested.');
  const expected = certificateFingerprint(app.certificateSha256);
  const inputApk = resolve(path);
  const input = await stat(inputApk);
  if (!input.isFile() || !input.size || input.size > maxApkBytes) {
    throw new Error('The APK must be a file between 1 byte and 5 GiB.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'payload-publish-'));
  try {
    const apk = join(directory, 'release.apk');
    await copyFile(inputApk, apk);
    const { size } = await stat(apk);
    if (!size || size > maxApkBytes) throw new Error('The APK must be between 1 byte and 5 GiB.');

    const { name: _apkName, ...apkMetadata } = await inspectApk(apk, expected);
    if (apkMetadata.packageId !== target) throw new Error(`APK package ${apkMetadata.packageId} does not match app ${target}.`);
    progress.update('checking', { packageId: target, versionCode: apkMetadata.versionCode, totalBytes: size, percent: 0 });
    if (values.notes && (await stat(values.notes)).size > 80_000) throw new Error('Release notes are too large.');
    const notes = values.notes ? new TextDecoder('utf-8', { fatal: true }).decode(await readFile(values.notes)) : '';
    if (notes.length > 20_000) throw new Error('Release notes are too large.');
    const { sha256, md5 } = await digestApk(apk);
    const metadata = { ...apkMetadata, sha256, size, notes };
    const preflight = await client.request('/v1/publish/preflight', metadata);
    const display = status => {
      progress.update(status);
      const report = { status, name: app.name, packageId: target, versionCode: metadata.versionCode,
        versionName: metadata.versionName, sha256, size, store: client.origin.origin };
      console.log(values.json ? JSON.stringify(report) : `${app.name} (${target}) ${metadata.versionName} [${metadata.versionCode}] ${status} (${size} bytes).`);
    };
    if (preflight.status === 'already-published') {
      display('already-published');
      return;
    }

    const key = `apks/${metadata.packageId}/${metadata.versionCode}/${sha256}.apk`;
    if (preflight.status !== 'upload' || preflight.objectKey !== key) throw new Error('Unexpected publish response.');
    if (values['dry-run']) {
      display('ready-to-upload');
      return;
    }
    const endpoint = r2Endpoint(client);
    const bucket = required(client.settings, 'PAYLOAD_R2_BUCKET');
    const s3 = new S3Client({
      endpoint,
      region: 'auto',
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: required(client.settings, 'PAYLOAD_R2_WRITE_ACCESS_KEY_ID'),
        secretAccessKey: required(client.settings, 'PAYLOAD_R2_WRITE_SECRET_ACCESS_KEY'),
      },
    });
    progress.update('uploading');
    const body = Readable.from((async function* () {
      for await (const chunk of createReadStream(apk)) {
        progress.addBytes(chunk.length);
        yield chunk;
      }
    })(), { objectMode: false });
    let uploadSkipped = false;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: size,
        ContentMD5: md5,
        ContentType: apkMime,
        CacheControl: 'private, no-store',
        StorageClass: 'STANDARD',
        Metadata: { sha256 },
        IfNoneMatch: '*',
      }));
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 412) throw error;
      uploadSkipped = true;
    } finally {
      body.destroy();
      s3.destroy();
    }
    progress.update('publishing', { uploadSkipped });
    const result = await client.request('/v1/publish', metadata);
    if (!['published', 'already-published'].includes(result.status)) throw new Error('Unexpected publish response.');
    display(result.status);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function r2Endpoint({ local, settings }) {
  if (process.env.PAYLOAD_R2_LOCAL_ENDPOINT) {
    const endpoint = new URL(process.env.PAYLOAD_R2_LOCAL_ENDPOINT);
    if (!local || endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
      throw new Error('A local S3 endpoint requires a loopback API and a loopback HTTP endpoint.');
    }
    return endpoint.href;
  }
  const account = required(settings, 'PAYLOAD_R2_ACCOUNT_ID');
  if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('Invalid Cloudflare account ID.');
  return `https://${account}.r2.cloudflarestorage.com`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publish(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
