import type { Session } from 'electron';
import { net } from 'electron';

export interface HTTPRequest { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: Uint8Array | string; maximumResponseBytes: number; timeoutMs: number }
export interface HTTPResponse { status: number; headers: Record<string, string>; body: Uint8Array }
export type HTTPTransport = (request: HTTPRequest, signal: AbortSignal) => Promise<HTTPResponse>;
/** Main-owned network session, separate from the renderer's deny-by-default web requests. */
export function createHTTPTransport(network: Session, allowedEndpoint: (url: string) => boolean): HTTPTransport {
  return (request, signal) => new Promise((resolve, reject) => {
    let url: URL;
    try { url = new URL(request.url); } catch { reject(new Error('ENDPOINT_NOT_ALLOWED')); return; }
    if (!allowedEndpoint(url.href) || url.username || url.password || url.hash ||
      url.protocol !== 'https:' ||
      request.maximumResponseBytes <= 0 || request.maximumResponseBytes > 2_097_152 || request.timeoutMs < 100 || request.timeoutMs > 330_000) {
      reject(new Error('ENDPOINT_NOT_ALLOWED')); return;
    }
    if (signal.aborted) { reject(new Error('CANCELLED')); return; }
    const outgoing = net.request({ url: url.href, method: request.method, session: network, redirect: 'error', useSessionCookies: false, credentials: 'omit' });
    let settled = false, size = 0; const chunks: Buffer[] = [];
    const done = (error?: string, response?: HTTPResponse) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted);
      if (error) { outgoing.abort(); chunks.forEach((chunk) => chunk.fill(0)); reject(new Error(error)); }
      else resolve(response!);
    };
    const aborted = () => done('CANCELLED');
    const timer = setTimeout(() => done('REQUEST_TIMEOUT'), request.timeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
    outgoing.on('error', () => done('NETWORK_UNAVAILABLE'));
    outgoing.on('login', (_info, callback) => { callback(); done('PROXY_AUTH_REQUIRED'); });
    outgoing.on('redirect', () => done('ENDPOINT_NOT_ALLOWED'));
    outgoing.on('response', (response) => {
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > request.maximumResponseBytes) { done('RESPONSE_TOO_LARGE'); return; }
      response.on('error', () => done('NETWORK_UNAVAILABLE'));
      response.on('data', (data: Buffer) => {
        if (settled) return; size += data.length;
        if (size > request.maximumResponseBytes) done('RESPONSE_TOO_LARGE'); else chunks.push(Buffer.from(data));
      });
      response.on('end', () => {
        if (settled) return;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        const body = Buffer.concat(chunks); chunks.forEach((chunk) => chunk.fill(0));
        done(undefined, { status: response.statusCode, headers, body });
      });
    });
    try {
      for (const [name, value] of Object.entries(request.headers)) outgoing.setHeader(name, value);
      if (request.body !== undefined) outgoing.write(typeof request.body === 'string' ? request.body : Buffer.from(request.body)); outgoing.end();
    } catch { done('REQUEST_INVALID'); }
  });
}
