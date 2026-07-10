import http from 'node:http';
import { createWorkerHandler } from './src/index.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8787);
const handler = createWorkerHandler({ fetch });

const server = http.createServer(async (req, res) => {
  try {
    const request = await toFetchRequest(req);
    const response = await handler(request, process.env);
    await writeNodeResponse(res, response);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'internal_error', message: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`Lampa Kinopoisk proxy listening on http://${host}:${port}`);
});

async function toFetchRequest(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const hostHeader = req.headers.host || `${host}:${port}`;
  const url = `${protocol}://${hostHeader}${req.url}`;
  const headers = new Headers();

  Object.entries(req.headers).forEach(([key, value]) => {
    if (Array.isArray(value)) headers.set(key, value.join(','));
    else if (value !== undefined) headers.set(key, value);
  });

  const body = ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : await readBody(req);
  return new Request(url, {
    method: req.method,
    headers,
    body
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function writeNodeResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  res.writeHead(response.status, headers);
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}
