// A loopback-only API for exercising an Expo development build with local APKs.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { apkMime, bucketName, ownerToken, publishToken, s3Credentials, workerHarness } from './harness.mjs';

const { mf, bucket } = await workerHarness();
const signedLinks = new Map();
let failDownload = false;
let catalogDelay = 0;
const port = Number(process.argv[2] ?? 8974);
const origin = `http://127.0.0.1:${port}`;

const server = createServer(async (request, response) => {
  const path = new URL(request.url, origin);
  try {
    if (path.pathname === '/__fixture/fail-download' && request.method === 'POST') {
      failDownload = true;
      response.writeHead(204).end();
      return;
    }
    if (path.pathname === '/__fixture/delay-catalog' && request.method === 'POST') {
      catalogDelay = Math.min(10_000, Math.max(0, Number(path.searchParams.get('ms')) || 0));
      response.writeHead(204).end();
      return;
    }
    if (path.pathname.startsWith('/__fixture/apk/')) {
      const link = signedLinks.get(path.pathname);
      if (!link || Date.now() >= link.expiresAt) {
        response.writeHead(410).end();
        return;
      }
      if (failDownload) {
        failDownload = false;
        response.writeHead(503).end();
        return;
      }
      const object = await bucket.get(link.key);
      if (!object) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Length': object.size, 'Content-Type': apkMime, 'Cache-Control': 'no-store' });
      await pipeline(Readable.fromWeb(object.body), response);
      return;
    }
    if (catalogDelay && path.pathname === '/v1/catalog') {
      await new Promise(resolve => setTimeout(resolve, catalogDelay));
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > 256 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const result = await mf.dispatchFetch(path.href, {
      method: request.method,
      headers: { authorization: request.headers.authorization ?? '' },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const data = await result.json();
    if (result.ok && data.url) {
      for (const [key, link] of signedLinks) if (link.expiresAt <= Date.now()) signedLinks.delete(key);
      const key = new URL(data.url).pathname.slice(bucketName.length + 2);
      const localPath = `/__fixture/apk/${randomUUID()}`;
      signedLinks.set(localPath, { key, expiresAt: data.expiresAt });
      data.url = origin + localPath;
    }
    response.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(data));
  } catch (error) {
    console.error(error.message);
    if (!response.headersSent) response.writeHead(503);
    response.end();
  }
});

server.listen(port, '127.0.0.1', async () => {
  const s3 = new URL('/cdn-cgi/local/r2/s3', await mf.ready);
  console.log(`PAYLOAD_API_URL=${origin}
PAYLOAD_PUBLISH_TOKEN=${publishToken}
PAYLOAD_R2_LOCAL_ENDPOINT=${s3}
PAYLOAD_R2_BUCKET=${bucketName}
PAYLOAD_R2_WRITE_ACCESS_KEY_ID=${s3Credentials.accessKeyId}
PAYLOAD_R2_WRITE_SECRET_ACCESS_KEY=${s3Credentials.secretAccessKey}
Owner token: ${ownerToken}`);
});

process.on('SIGINT', async () => {
  server.close();
  await mf.dispose();
});
