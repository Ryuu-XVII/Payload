type Notification = {
  token: string;
  packageId: string;
  name: string;
  versionName: string;
};

export type Delivery = 'sent' | 'unregistered' | { retryAt?: number };

const oauth = 'https://oauth2.googleapis.com/token';
const base64url = (binary: string) => btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function createFcmSender(secret: string, request = fetch) {
  const credential = JSON.parse(secret) as { project_id: string; client_email: string; private_key: string };
  if (!/^[a-z][a-z0-9-]+$/.test(credential.project_id) || !credential.client_email || !credential.private_key) {
    throw new Error('Invalid FCM service account configuration');
  }
  const endpoint = `https://fcm.googleapis.com/v1/projects/${credential.project_id}/messages:send`;
  let accessToken: Promise<string> | undefined;

  async function authenticate() {
    const pkcs8 = atob(credential.private_key.replace(/-----[^-]+-----|\s/g, ''));
    const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(pkcs8, char => char.charCodeAt(0)),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: credential.client_email, aud: oauth, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      iat, exp: iat + 3600,
    };
    const assertion = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(assertion));
    const response = await request(oauth, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${assertion}.${base64url(String.fromCharCode(...new Uint8Array(signature)))}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`FCM authentication failed (${response.status})`);
    const { access_token } = await response.json<{ access_token?: string }>();
    if (!access_token) throw new Error('FCM authentication returned no access token');
    return access_token;
  }

  return async (job: Notification): Promise<Delivery> => {
    const token = await (accessToken ??= authenticate());
    const response = await request(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token: job.token,
        notification: {
          title: `Update available for ${job.name}`,
          body: `Version ${job.versionName} is ready in Payload.`,
        },
        android: { ttl: '86400s', notification: { channel_id: 'app-updates' } },
        data: { type: 'app-update', packageId: job.packageId },
      } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      await response.body?.cancel();
      return 'sent';
    }
    const failure = await response.json<{ error?: { details?: { errorCode?: string }[] } }>().catch(() => null);
    if (response.status === 404 && failure?.error?.details?.some(item => item.errorCode === 'UNREGISTERED')) {
      return 'unregistered';
    }
    const retryAfter = response.headers.get('Retry-After');
    const retryAt = retryAfter
      ? (/^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter))
      : undefined;
    console.warn('FCM send failed', response.status);
    return { retryAt };
  };
}
