// GET /api/projects/:projectId/tasklists
// Returns existing tasklists in a project, so the PM can add to one
// instead of creating a new tasklist.

export async function onRequestGet({ params, env }) {
  const { TEAMWORK_DOMAIN, TEAMWORK_API_TOKEN } = env;
  if (!TEAMWORK_DOMAIN || !TEAMWORK_API_TOKEN) {
    return Response.json(
      { error: 'Server not configured.' },
      { status: 500 }
    );
  }

  const projectId = params.projectId;
  if (!/^\d+$/.test(projectId)) {
    return Response.json({ error: 'Invalid project id.' }, { status: 400 });
  }

  const tw = new URL(
    `https://${TEAMWORK_DOMAIN}/projects/api/v3/projects/${projectId}/tasklists.json`
  );
  tw.searchParams.set('pageSize', '100');
  tw.searchParams.set('orderBy', 'name');

  const auth = btoa(`${TEAMWORK_API_TOKEN}:x`);
  const res = await fetch(tw.toString(), {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    return Response.json(
      { error: 'Teamwork API error', upstreamStatus: res.status },
      { status: res.status === 401 ? 502 : res.status }
    );
  }

  const data = await res.json();
  const tasklists = (data.tasklists ?? []).map((tl) => ({
    id: tl.id,
    name: tl.name,
    status: tl.status,
  }));

  return Response.json({
    tasklists,
    total: data.meta?.page?.count ?? tasklists.length,
  });
}
