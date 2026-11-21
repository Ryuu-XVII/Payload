import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const windows = process.platform === 'win32';

export function androidEnvironment(env = process.env) {
  const fallbackSdk = windows && env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android', 'Sdk');
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (fallbackSdk && existsSync(fallbackSdk) && fallbackSdk);
  const localJava = windows && env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'jdk17');
  const studioJava = windows && env.ProgramFiles && join(env.ProgramFiles, 'Android', 'Android Studio', 'jbr');
  const java = env.JAVA_HOME || [localJava, studioJava].find(root => root && existsSync(join(root, 'bin', 'java.exe')));
  return { ...env, ...(sdk && { ANDROID_HOME: sdk }), ...(java && { JAVA_HOME: java }) };
}

export function javaTool(name, env) {
  return env.JAVA_HOME ? join(env.JAVA_HOME, 'bin', windows ? `${name}.exe` : name) : name;
}

export async function apkTools(env = androidEnvironment()) {
  const aapt = windows ? 'aapt.exe' : 'aapt';
  let candidates = [env.ANDROID_BUILD_TOOLS].filter(Boolean);
  if (!candidates.length) {
    if (!env.ANDROID_HOME) throw new Error('Set ANDROID_HOME or ANDROID_BUILD_TOOLS to your Android SDK.');
    const root = join(env.ANDROID_HOME, 'build-tools');
    const versions = (await readdir(root).catch(() => [])).filter(name => /^\d+\.\d+\.\d+$/.test(name));
    versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    candidates = versions.map(version => join(root, version));
  }
  const directory = candidates.find(path => existsSync(join(path, aapt)) && existsSync(join(path, 'lib', 'apksigner.jar')));
  if (!directory) throw new Error('Install Android SDK Build Tools with aapt and apksigner.');
  return { aapt: join(directory, aapt), signer: join(directory, 'lib', 'apksigner.jar'), java: javaTool('java', env) };
}

export async function apkDetails(path) {
  const tools = await apkTools();
  const options = { encoding: 'utf8', maxBuffer: 20 * 1024 ** 2, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    return {
      badging: execFileSync(tools.aapt, ['dump', 'badging', path], options),
      manifest: execFileSync(tools.aapt, ['dump', 'xmltree', path, 'AndroidManifest.xml'], options),
      verification: execFileSync(tools.java, ['-jar', tools.signer, 'verify', '--print-certs', path], options),
    };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Android tools could not start. Check your Java and SDK paths.');
    throw new Error(`Android could not inspect or verify the APK. ${String(error.stderr || '').trim()}`);
  }
}
