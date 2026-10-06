import { request } from 'node:http';
import { decodeCodeResponse } from '../../protocol/index.js';

/** What `GET /api/identity` reports. */
export interface HubIdentity {
  version: string;
  instance: string;
}

interface Response {
  status: number;
  body: string;
}

const REQUEST_TIMEOUT_MS = 2000;
const MAX_RESPONSE = 64 * 1024;
const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

/** Sends one request to the hub on 127.0.0.1:`port`, authenticated with `token`. */
const call = (port: number, method: 'GET' | 'POST', path: string, token: string): Promise<Response> =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_RESPONSE) req.destroy(new Error(`the response to ${path} is too large`));
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no response to ${path} within ${String(REQUEST_TIMEOUT_MS)} ms`)));
    req.on('error', reject);
    req.end();
  });

const parseIdentity = (body: string): HubIdentity | null => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 2 || !('version' in value) || !('instance' in value)) return null;
  const { version, instance } = value;
  if (typeof version !== 'string' || version.length < 1 || version.length > 64) return null;
  return typeof instance === 'string' && INSTANCE.test(instance) ? { version, instance } : null;
};

/** The identity of the hub serving `port`, or null when none answers with a valid identity. */
export const hubIdentity = async (port: number, token: string): Promise<HubIdentity | null> => {
  try {
    const response = await call(port, 'GET', '/api/identity', token);
    return response.status === 200 ? parseIdentity(response.body) : null;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
};

/** A one-time code from the hub serving `port`. */
export const requestCode = async (port: number, token: string): Promise<string> => {
  const response = await call(port, 'POST', '/api/code', token);
  if (response.status !== 200) throw new Error(`the hub refused a code with status ${String(response.status)}`);
  return decodeCodeResponse(response.body).code;
};

/** Asks the hub serving `port` to shut down. */
export const requestShutdown = async (port: number, token: string): Promise<void> => {
  const response = await call(port, 'POST', '/api/shutdown', token);
  if (response.status < 200 || response.status > 299)
    throw new Error(`the hub refused to shut down with status ${String(response.status)}`);
};

/** Whether anything accepts connections on 127.0.0.1:`port`. */
export const portServed = async (port: number): Promise<boolean> => {
  try {
    await call(port, 'GET', '/', '');
    return true;
  } catch (error) {
    if (hasCode(error, 'ECONNREFUSED')) return false;
    return true;
  }
};
