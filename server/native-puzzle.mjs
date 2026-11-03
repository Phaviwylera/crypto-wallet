import { timingSafeEqual } from 'node:crypto';
import {
  getNativePuzzleStatus,
  planNativePuzzle,
  resumeNativePuzzle,
  startNativePuzzle,
  stopNativePuzzle,
} from '../scripts/native-puzzle-api.mjs';
export { shutdownNativePuzzle } from '../scripts/native-puzzle-api.mjs';

async function jsonBody(context) {
  try {
    const body = await context.req.json();
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('not an object');
    return body;
  } catch {
    const error = new Error('Request body must be a JSON object.');
    error.statusCode = 400;
    throw error;
  }
}

function route(handler, successStatus = 200) {
  return async (context) => {
    try {
      const result = await handler(context);
      context.header('cache-control', 'no-store');
      context.header('x-content-type-options', 'nosniff');
      return context.json(result, successStatus);
    } catch (error) {
      const status = error.statusCode || 500;
      context.header('cache-control', 'no-store');
      context.header('x-content-type-options', 'nosniff');
      return context.json({ error: status < 500 ? error.message : 'Native puzzle API failed.' }, status);
    }
  };
}

function nativeControlAuthorized(context) {
  const expected = process.env.NATIVE_PUZZLE_API_TOKEN || '';
  if (!expected) return true;
  const authorization = context.req.header('authorization') || '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function controlRoute(handler, successStatus = 200) {
  const handle = route(handler, successStatus);
  return async (context) => {
    if (!nativeControlAuthorized(context)) {
      context.header('cache-control', 'no-store');
      context.header('x-content-type-options', 'nosniff');
      return context.json({ error: 'A valid native API bearer token is required for scanner controls.' }, 401);
    }
    return handle(context);
  };
}

export function registerNativePuzzleRoutes(app) {
  // Status is read-only and never includes FOUND.txt or private-key material.
  // Process controls can be locked down by setting NATIVE_PUZZLE_API_TOKEN.
  app.get('/api/native-puzzle/status', route(() => getNativePuzzleStatus()));
  app.post('/api/native-puzzle/plan', controlRoute(async (context) => planNativePuzzle(await jsonBody(context))));
  app.post('/api/native-puzzle/start', controlRoute(async (context) => startNativePuzzle(await jsonBody(context)), 202));
  app.post('/api/native-puzzle/resume', controlRoute(async (context) => resumeNativePuzzle(await jsonBody(context)), 202));
  app.post('/api/native-puzzle/stop', controlRoute(async (context) => stopNativePuzzle(await jsonBody(context)), 202));
}
