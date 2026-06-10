// Worker entry point.
// Routes /api/* requests to the existing handlers under functions/.
// Everything else falls through to env.ASSETS, which serves the static
// frontend from public/.
//
// All requests (pages and API) pass Cloudflare Access JWT verification first —
// a no-op until CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are configured (see
// CLAUDE.md "Auth").

import { onRequestGet as getProjects, onRequestPost as createProject } from '../functions/api/projects.js';
import { onRequestGet as getTasklists } from '../functions/api/projects/[projectId]/tasklists.js';
import { onRequestGet as getMembers } from '../functions/api/projects/[projectId]/members.js';
import { onRequestPost as createTasks } from '../functions/api/create.js';
import { onRequestPost as previewSubtasks } from '../functions/api/preview.js';
import { verifyAccessJwt } from './access.js';

// Applied to served pages/assets. style-src needs 'unsafe-inline' for the
// style attributes autoResize sets; fonts come from Fontshare.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://api.fontshare.com",
    "font-src 'self' https://cdn.fontshare.com https://api.fontshare.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    const auth = await verifyAccessJwt(request, env);
    if (!auth.ok) {
      return pathname.startsWith('/api/')
        ? Response.json({ error: `Unauthorized: ${auth.reason}` }, { status: 403 })
        : new Response(`Unauthorized: ${auth.reason}`, { status: 403 });
    }

    if (pathname === '/api/projects' && method === 'GET') {
      return getProjects({ request, env });
    }

    if (pathname === '/api/projects' && method === 'POST') {
      return createProject({ request, env });
    }

    const tasklistsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/tasklists\/?$/);
    if (tasklistsMatch && method === 'GET') {
      return getTasklists({ params: { projectId: tasklistsMatch[1] }, env });
    }

    const membersMatch = pathname.match(/^\/api\/projects\/([^/]+)\/members\/?$/);
    if (membersMatch && method === 'GET') {
      return getMembers({ params: { projectId: membersMatch[1] }, env });
    }

    if (pathname === '/api/create' && method === 'POST') {
      return createTasks({ request, env });
    }

    if (pathname === '/api/preview' && method === 'POST') {
      return previewSubtasks({ request, env });
    }

    if (pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
