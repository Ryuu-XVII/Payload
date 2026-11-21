import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const payloadHome = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Payload')
  : null;

function powershell(script, input) {
  try {
    const utf8 = '[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8;';
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', utf8 + script], {
      input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Could not access Payload’s Windows-encrypted credentials for this user.');
  }
}

export function readWindowsCredentials(path, names) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(powershell(`
    $ErrorActionPreference = 'Stop'
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $saved = Import-Clixml -LiteralPath $request.path
    $values = @{}
    foreach ($name in $request.names) {
      if ($saved.ContainsKey($name)) {
        $values[$name] = [System.Net.NetworkCredential]::new('', $saved[$name]).Password
      }
    }
    $values | ConvertTo-Json -Compress
  `, { path, names }));
}

export function saveWindowsCredentials(path, values) {
  powershell(`
    $ErrorActionPreference = 'Stop'
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $saved = @{}
    foreach ($property in $request.values.PSObject.Properties) {
      $saved[$property.Name] = ConvertTo-SecureString $property.Value -AsPlainText -Force
    }
    $saved | Export-Clixml -LiteralPath $request.path -NoClobber
  `, { path, values });
}
