#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildAndroid, createSigningKey } from './build-android.mjs';
import { certificateFingerprint, inspectApk, projectApp, publish, publisher, readAppIcon, validPackageId } from './publish.mjs';

const commands = {
  'app list': 'app list [--json]',
  'app show': 'app show PACKAGE_ID [--json]',
  'app create': 'app create --package PACKAGE_ID --name NAME --icon PNG --cert SHA256 [--json]',
  'app link': 'app link PACKAGE_ID [--project DIRECTORY] [--json]',
  inspect: 'inspect FILE.apk [--json]',
  publish: 'publish FILE.apk [--app PACKAGE_ID] [--project DIRECTORY] [--notes FILE] [--progress-file PATH] [--dry-run] [--json]',
  keygen: 'keygen',
  build: 'build [--output FILE.apk] | build --eas',
  guide: 'guide [--json]',
};

function printReport(value, json, render) {
  console.log(json ? JSON.stringify(value) : render(value));
}

async function appCommand(command, args, json) {
  if (!commands[`app ${command}`] || args.includes('--help')) {
    console.log(Object.entries(commands).filter(([name]) => name.startsWith('app ')).map(([, usage]) => usage).join('\n'));
    if (!commands[`app ${command}`] && command && command !== '--help') process.exitCode = 1;
    return;
  }
  const options = { json: { type: 'boolean' } };
  if (command === 'create') Object.assign(options, {
    package: { type: 'string' }, name: { type: 'string' }, icon: { type: 'string' }, cert: { type: 'string' },
  });
  if (command === 'link') options.project = { type: 'string', default: '.' };
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  const wantsId = command === 'show' || command === 'link';
  if (positionals.length !== Number(wantsId)) throw new Error(`Usage: payload ${commands[`app ${command}`]}`);
  const client = publisher();
  if (command === 'list') {
    const result = await client.request('/v1/apps');
    printReport({ store: client.origin.origin, ...result }, json, ({ apps }) => apps.length ? apps
      .map(app => `${app.packageId}\t${app.name}\t${app.latestVersionName ?? 'No releases'}`).join('\n') : 'No apps are registered.');
    return;
  }
  if (command === 'create') {
    if (!values.name?.trim() || values.name.trim().length > 120 || !values.icon) {
      throw new Error('Specify an app name up to 120 characters and a PNG with --icon.');
    }
    const app = {
      packageId: validPackageId(values.package), name: values.name.trim(),
      certificateSha256: certificateFingerprint(values.cert), icon: await readAppIcon(values.icon),
    };
    const result = await client.request('/v1/apps', app);
    printReport({ store: client.origin.origin, ...result }, json, r => `${r.name} (${r.packageId}) ${r.status}.`);
    return;
  }
  const packageId = validPackageId(positionals[0]);
  const app = await client.request(`/v1/apps/${packageId}`);
  if (app.packageId !== packageId) throw new Error('The server returned a different app than requested.');
  const store = client.origin.origin;
  if (command === 'show') {
    printReport({ store, ...app }, json, a => `${a.name} (${a.packageId})\nStore: ${store}\nCertificate SHA-256: ${a.certificateSha256}`);
    return;
  }
  const path = resolve(values.project, 'payload-app.json');
  try {
    await writeFile(path, JSON.stringify({ store, packageId }, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await projectApp(client, values.project, packageId);
  }
  printReport({ store, packageId, name: app.name, path }, json, a => `Linked ${a.name} (${packageId}). ${path}`);
}

const [command, ...args] = process.argv.slice(2);
const json = args.includes('--json') || command === '--json';

async function main() {
  switch (command) {
    case 'app': return appCommand(args[0], args.slice(1), json);
    case 'publish': return publish(args);
    case 'build': return buildAndroid(args);
    case 'guide': {
      const { values } = parseArgs({ args, options: { help: { type: 'boolean' }, json: { type: 'boolean' } } });
      if (values.help) { console.log(commands.guide); return; }
      const instructions = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
      printReport({ instructions }, json, value => value.instructions.trimEnd());
      return;
    }
    case 'keygen':
      if (args.includes('--help')) { console.log(commands.keygen); return; }
      if (args.length) throw new Error(`Usage: payload ${commands.keygen}`);
      return createSigningKey();
    case 'inspect': {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
        help: { type: 'boolean' }, json: { type: 'boolean' },
      } });
      if (values.help) { console.log(commands.inspect); return; }
      if (positionals.length !== 1) throw new Error(`Usage: payload ${commands.inspect}`);
      const info = await inspectApk(positionals[0]);
      printReport(info, json, a => `${a.name ?? a.packageId} (${a.packageId}) ${a.versionName} [${a.versionCode}]\nMinimum Android SDK: ${a.minSdk}\nCertificate SHA-256: ${a.certificateSha256}`);
      return;
    }
    default:
      console.log(json ? JSON.stringify({ commands }) : Object.values(commands).map(usage => `payload ${usage}`).join('\n'));
      if (command && !['help', '--help', '--json'].includes(command)) process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(json ? JSON.stringify({ error: error.message }) : error.message);
  process.exitCode = 1;
});
