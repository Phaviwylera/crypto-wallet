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

export function registerNativePuzzleRoutes(app) {
  app.get('/api/native-puzzle/status', route(() => getNativePuzzleStatus()));
  app.post('/api/native-puzzle/plan', route(async (context) => planNativePuzzle(await jsonBody(context))));
  app.post('/api/native-puzzle/start', route(async (context) => startNativePuzzle(await jsonBody(context)), 202));
  app.post('/api/native-puzzle/resume', route(async (context) => resumeNativePuzzle(await jsonBody(context)), 202));
  app.post('/api/native-puzzle/stop', route(async (context) => stopNativePuzzle(await jsonBody(context)), 202));
}
