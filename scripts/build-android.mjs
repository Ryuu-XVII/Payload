import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { androidEnvironment, javaTool, windows } from './android-tools.mjs';
import { inspectApk } from './publish.mjs';
import { payloadHome, readWindowsCredentials, saveWindowsCredentials } from './windows-credentials.mjs';

const mobile = fileURLToPath(new URL('../mobile/', import.meta.url));
const credentialsFile = 'credentials.clixml';
const keyFile = 'payload.p12';
const passwordName = 'PAYLOAD_ANDROID_STORE_PASSWORD';
const defaultAlias = 'payload-release';

function run(program, args, cwd, env, interactive = false) {
  const result = spawnSync(program, args, { cwd, env, stdio: [interactive ? 'inherit' : 'ignore', 2, 2], windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.`);
  }
}

function keyFingerprint(keystore, alias, env) {
  try {
    const certificate = execFileSync(javaTool('keytool', env), [
      '-exportcert', '-keystore', keystore, '-alias', alias, '-storepass:env', passwordName,
    ], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return createHash('sha256').update(certificate).digest('hex');
  } catch {
    throw new Error('Could not open the signing key. Check the JDK, keystore path, alias, and password.');
  }
}

export async function createSigningKey() {
  if (!payloadHome) throw new Error('Automatic key storage requires Windows. Use your keystore and signing environment variables.');
  const destination = join(payloadHome, 'signing');
  if (existsSync(destination)) throw new Error('A local signing key already exists. Keep using that key for updates.');
  await mkdir(payloadHome, { recursive: true });
  const staging = await mkdtemp(join(payloadHome, 'signing-new-'));
  let moved = false;
  try {
    const password = randomBytes(32).toString('hex');
    const env = { ...androidEnvironment(), [passwordName]: password };
    const keystore = join(staging, keyFile);
    run(javaTool('keytool', env), ['-genkeypair', '-storetype', 'PKCS12', '-keyalg', 'RSA',
      '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Payload Android Release',
      '-alias', defaultAlias, '-keystore', keystore, '-storepass:env', passwordName], mobile, env);
    const certificateSha256 = keyFingerprint(keystore, defaultAlias, env);
    saveWindowsCredentials(join(staging, credentialsFile), { [passwordName]: password });
    await rename(staging, destination);
    moved = true;
    console.log(JSON.stringify({ keystore: join(destination, keyFile), alias: defaultAlias, certificateSha256 }));
  } finally {
    if (!moved) await rm(staging, { recursive: true, force: true });
  }
}

function signingEnvironment(env) {
  const explicit = ['PAYLOAD_ANDROID_KEYSTORE', 'PAYLOAD_ANDROID_KEY_ALIAS', passwordName,
    'PAYLOAD_ANDROID_KEY_PASSWORD'].some(name => env[name]);
  if (!explicit && payloadHome) {
    const directory = join(payloadHome, 'signing');
    if (existsSync(join(directory, keyFile))) {
      Object.assign(env, readWindowsCredentials(join(directory, credentialsFile), [passwordName]), {
        PAYLOAD_ANDROID_KEYSTORE: join(directory, keyFile), PAYLOAD_ANDROID_KEY_ALIAS: defaultAlias,
      });
    }
  }
  if (!env.PAYLOAD_ANDROID_KEYSTORE || !env.PAYLOAD_ANDROID_KEY_ALIAS || !env[passwordName]) {
    throw new Error('Run payload keygen once or set PAYLOAD_ANDROID_KEYSTORE, PAYLOAD_ANDROID_KEY_ALIAS, and PAYLOAD_ANDROID_STORE_PASSWORD.');
  }
  env.PAYLOAD_ANDROID_KEYSTORE = resolve(env.PAYLOAD_ANDROID_KEYSTORE);
  return env;
}

export async function buildAndroid(args) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' }, eas: { type: 'boolean' }, output: { type: 'string' },
  } });
  if (values.help) {
    console.log('payload build [--output FILE.apk] | payload build --eas');
    return;
  }
  if (values.eas) {
    if (values.output) throw new Error('--output applies to local builds.');
    const env = { ...process.env };
    const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: mobile, stdio: 'ignore' });
    if (git.status !== 0) {
      env.EAS_NO_VCS ??= '1';
      env.EAS_PROJECT_ROOT ??= mobile;
    }
    if (windows) run('cmd.exe', ['/d', '/c', 'npx.cmd --yes eas-cli build --platform android --profile production'], mobile, env, true);
    else run('npx', ['--yes', 'eas-cli', 'build', '--platform', 'android', '--profile', 'production'], mobile, env, true);
    return;
  }
  const env = signingEnvironment(androidEnvironment());
  if (values.output && !values.output.toLowerCase().endsWith('.apk')) throw new Error('--output must end in .apk.');
  if (!env.ANDROID_HOME) throw new Error('Install the Android SDK or set ANDROID_HOME.');
  const dotEnv = await readFile(join(mobile, '.env.local'), 'utf8').then(parseEnv, error => {
    if (error.code !== 'ENOENT') throw error;
    return {};
  });
  const url = env.EXPO_PUBLIC_PAYLOAD_API_URL || dotEnv.EXPO_PUBLIC_PAYLOAD_API_URL;
  if (!url || new URL(url).protocol !== 'https:') {
    throw new Error('Set EXPO_PUBLIC_PAYLOAD_API_URL to the HTTPS Worker URL in mobile/.env.local or your environment.');
  }
  env.EXPO_PUBLIC_PAYLOAD_API_URL = url;
  env.NODE_ENV = 'production';
  const expected = keyFingerprint(env.PAYLOAD_ANDROID_KEYSTORE, env.PAYLOAD_ANDROID_KEY_ALIAS, env);
  const expo = join(mobile, 'node_modules', 'expo', 'bin', 'cli');
  if (!existsSync(expo)) throw new Error('Run npm ci in mobile before building.');
  run(process.execPath, [expo, 'prebuild', '--platform', 'android', '--no-install'], mobile, env);
  const android = join(mobile, 'android');
  const gradle = ':app:assembleRelease --no-daemon --console=plain';
  const architectures = env.PAYLOAD_ANDROID_ABIS;
  if (architectures && !/^(?:arm64-v8a|armeabi-v7a|x86_64|x86)(?:,(?:arm64-v8a|armeabi-v7a|x86_64|x86))*$/.test(architectures)) {
    throw new Error('PAYLOAD_ANDROID_ABIS must be a comma-separated list of supported Android ABIs.');
  }
  const command = architectures ? `${gradle} -PreactNativeArchitectures=${architectures}` : gradle;
  if (windows) run('cmd.exe', ['/d', '/c', `.\\gradlew.bat ${command}`], android, env);
  else run(join(android, 'gradlew'), command.split(' '), android, env);
  const source = join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  const { packageId, versionCode, versionName, certificateSha256 } = await inspectApk(source, expected);
  const apk = resolve(values.output ?? join(mobile, 'dist', `Payload-${versionCode}.apk`));
  if (apk !== source) {
    await mkdir(dirname(apk), { recursive: true });
    await copyFile(source, apk);
  }
  console.log(JSON.stringify({ apk, packageId, versionCode, versionName, certificateSha256 }));
}
