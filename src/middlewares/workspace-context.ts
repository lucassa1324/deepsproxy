/**
 * Middleware to extract dynamic workspace path from HTTP requests.
 * Priority: x-workspace-path header > body.workspace_path > USER_WORKSPACE_PATH env > process.cwd()
 */

import { Context, Next } from 'hono';
import path from 'path';

export async function workspaceContextMiddleware(c: Context, next: Next) {
  // 1. Try header first (highest priority)
  const headerPath = c.req.header('x-workspace-path');

  // 2. Try body JSON (workspace_path property)
  let bodyPath: string | undefined;
  try {
    const contentType = c.req.header('content-type');
    if (contentType?.includes('application/json')) {
      const body = await c.req.json();
      bodyPath = body?.workspace_path as string;
    }
  } catch (e) {
    // Failed to parse body - don't break the request
  }

  // 3. Fallback: USER_WORKSPACE_PATH env var or process.cwd()
  const rawPath = headerPath || bodyPath || process.env.USER_WORKSPACE_PATH || process.cwd();

  // Normalize path for Windows/Linux
  const resolvedWorkspace = path.normalize(path.resolve(rawPath)).replace(/\\/g, '/');

  // Store in request context
  c.set('requestWorkspaceRoot', resolvedWorkspace);

  await next();
}