import type { Delivery } from './fcm';

const minute = 60_000;
const day = 24 * 60 * minute;
const tokenPattern = /^[A-Za-z0-9_:=\-]{20,4096}$/;

export function isPushToken(value: unknown): value is string {
  return typeof value === 'string' && tokenPattern.test(value);
}

export async function storePushSubscription(db: D1Database, token: string, sdk: number,
  installed: { packageId: string; versionCode: number }[], previousToken?: string) {
  const statements = [
    db.prepare(`INSERT INTO push_devices (token, sdk) VALUES (?, ?)
      ON CONFLICT (token) DO UPDATE SET sdk = excluded.sdk`).bind(token, sdk),
    db.prepare('DELETE FROM push_installs WHERE token = ?').bind(token),
    db.prepare(`INSERT INTO push_installs (token, package_id, version_code)
      SELECT ?, a.package_id, MAX(json_extract(j.value, '$.versionCode'))
      FROM json_each(?) AS j JOIN apps AS a ON a.package_id = json_extract(j.value, '$.packageId')
      GROUP BY a.package_id`).bind(token, JSON.stringify(installed)),
  ];
  if (previousToken && previousToken !== token) {
    // Move outstanding work before removing the old address.
    statements.push(db.prepare('UPDATE OR IGNORE push_jobs SET token = ? WHERE token = ?').bind(token, previousToken));
    statements.push(db.prepare('DELETE FROM push_devices WHERE token = ?').bind(previousToken));
  }
  await db.batch(statements);
}

type Job = {
  id: number;
  token: string;
  packageId: string;
  versionCode: number;
  name: string;
  versionName: string;
};

async function claim(db: D1Database, now: number) {
  const { results: claims } = await db.prepare(`
    UPDATE push_jobs SET next_attempt_at = ?
    WHERE id IN (
      SELECT id FROM push_jobs WHERE next_attempt_at <= ?
      ORDER BY next_attempt_at, id LIMIT 40
    ) RETURNING id
  `).bind(now + 5 * minute, now).all<{ id: number }>();
  if (!claims.length) return [];

  const ids = JSON.stringify(claims.map(row => row.id));
  const { results } = await db.prepare(`
    SELECT j.id, j.token, j.package_id AS packageId, j.version_code AS versionCode,
      r.app_name AS name, r.version_name AS versionName
    FROM push_jobs AS j
    JOIN releases AS r USING (package_id, version_code)
    JOIN push_devices AS d USING (token)
    LEFT JOIN push_installs AS i ON i.token = j.token AND i.package_id = j.package_id
    WHERE j.id IN (SELECT value FROM json_each(?))
      AND i.version_code < j.version_code AND r.min_sdk <= d.sdk
      AND r.deleted_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > ?)
  `).bind(ids, now).all<Job>();
  const eligible = new Set(results.map(row => row.id));
  const skipped = claims.filter(row => !eligible.has(row.id));
  if (skipped.length) {
    await db.prepare('DELETE FROM push_jobs WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(skipped.map(row => row.id))).run();
  }
  return results;
}

export async function deliverUpdateNotifications(db: D1Database, send: (job: Job) => Promise<Delivery>, now = Date.now()) {
  await db.prepare(`DELETE FROM push_jobs WHERE EXISTS (
    SELECT 1 FROM releases AS r WHERE r.package_id = push_jobs.package_id
      AND r.version_code = push_jobs.version_code AND r.published_at <= ?
  )`).bind(now - day).run();

  const jobs = await claim(db, now);
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < jobs.length; offset += 5) {
    const batch = jobs.slice(offset, offset + 5);
    const results = await Promise.allSettled(batch.map(send));
    results.forEach((outcome, index) => {
      const job = batch[index];
      if (outcome.status === 'rejected') {
        console.warn('FCM delivery will be retried');
      } else if (outcome.value === 'sent') {
        statements.push(db.prepare('DELETE FROM push_jobs WHERE id = ? AND token = ?').bind(job.id, job.token));
      } else if (outcome.value === 'unregistered') {
        statements.push(db.prepare('DELETE FROM push_devices WHERE token = ?').bind(job.token));
      } else if ((outcome.value.retryAt ?? 0) > now + 5 * minute) {
        statements.push(db.prepare('UPDATE push_jobs SET next_attempt_at = ? WHERE id = ? AND token = ?')
          .bind(outcome.value.retryAt, job.id, job.token));
      }
    });
  }
  if (statements.length) await db.batch(statements);
}
