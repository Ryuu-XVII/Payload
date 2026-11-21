import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export function uploadProgress({ json, file }) {
  const path = file === undefined ? undefined : resolve(file);
  const temporary = path && `${path}.${randomUUID()}.tmp`;
  const terminal = !json && process.stderr.isTTY;
  const state = { event: 'publish-progress', bytesUploaded: 0, totalBytes: null, percent: null };
  let lastUpdate = -Infinity;
  let lastPercent = 0;
  let barVisible = false;
  let fileWarning = false;

  function update(status, fields) {
    Object.assign(state, fields, { status, updatedAt: new Date().toISOString() });
    lastUpdate = performance.now();
    lastPercent = state.percent;
    const line = JSON.stringify(state);
    if (path) {
      if (status === 'preparing') {
        writeFileSync(path, `${line}\n`, { flag: 'wx' });
      } else {
        try {
          writeFileSync(temporary, `${line}\n`);
          renameSync(temporary, path);
          fileWarning = false;
        } catch {
          try { rmSync(temporary, { force: true }); } catch {}
          if (!fileWarning) {
            console.error(json
              ? JSON.stringify({ event: 'progress-file-warning', message: 'Could not update the progress file. Follow stderr for progress.' })
              : 'Could not update the progress file. Follow terminal output for progress.');
          }
          fileWarning = true;
        }
      }
    }
    if (json) {
      console.error(line);
      return;
    }
    if (status === 'uploading') {
      const filled = Math.floor(state.percent / 5);
      const bar = '#'.repeat(filled) + '-'.repeat(20 - filled);
      const mib = bytes => (bytes / 1024 ** 2).toFixed(1);
      const message = `Uploading APK [${bar}] ${state.percent}% (${mib(state.bytesUploaded)}/${mib(state.totalBytes)} MiB)`;
      barVisible = terminal && state.percent < 100;
      process.stderr.write(`${terminal ? '\r\x1b[2K' : ''}${message}${barVisible ? '' : '\n'}`);
      return;
    }
    if (barVisible) {
      process.stderr.write('\n');
      barVisible = false;
    }
    if (status === 'publishing') console.error('Confirming release with Payload...');
  }

  update('preparing');
  return {
    update,
    addBytes(bytes) {
      if (state.status !== 'uploading') return;
      state.bytesUploaded += bytes;
      state.percent = Math.floor(100 * state.bytesUploaded / state.totalBytes);
      const interval = (terminal || json || path) ? 250 : 1000;
      if (state.percent === 100 || performance.now() - lastUpdate >= interval
        || (!terminal && !json && state.percent >= lastPercent + 10)) {
        update('uploading');
      }
    },
  };
}
