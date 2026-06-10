// GET /api/projects?search=<term>
// Returns active projects, optionally filtered by name.
//
// POST /api/projects
// Creates a brand-new project from { name, description? }.
// Used by the "one project per client, SOW tracked via tags" mode.
// Secrets stay on the server — the browser never sees TEAMWORK_API_TOKEN.

export async function onRequestGet({ request, env }) {
  const { TEAMWORK_DOMAIN, TEAMWORK_API_TOKEN } = env;
  if (!TEAMWORK_DOMAIN || !TEAMWORK_API_TOKEN) {
    return Response.json(
      { error: 'Server not configured (missing TEAMWORK_DOMAIN or TEAMWORK_API_TOKEN).' },
      { status: 500 }
    );
  }

  const search = new URL(request.url).searchParams.get('search')?.trim() ?? '';

  const tw = new URL(`https://${TEAMWORK_DOMAIN}/projects/api/v3/projects.json`);
  tw.searchParams.set('pageSize', '25');
  tw.searchParams.set('projectStatuses', 'active,current');
  tw.searchParams.set('orderBy', 'name');
  if (search) tw.searchParams.set('searchTerm', search);

  const auth = btoa(`${TEAMWORK_API_TOKEN}:x`);
  const res = await fetch(tw.toString(), {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    return Response.json(
      { error: 'API error', upstreamStatus: res.status },
      { status: res.status === 401 ? 502 : res.status }
    );
  }

  const data = await res.json();
  const projects = (data.projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    subStatus: p.subStatus,
  }));

  return Response.json({
    projects,
    total: data.meta?.page?.count ?? projects.length,
  });
}

export async function onRequestPost({ request, env }) {
  const { TEAMWORK_DOMAIN, TEAMWORK_API_TOKEN } = env;
  if (!TEAMWORK_DOMAIN || !TEAMWORK_API_TOKEN) {
    return Response.json({ error: 'Server not configured.' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return Response.json({ error: 'Project name is required.' }, { status: 400 });
  }
  const description =
    typeof body?.description === 'string' ? body.description.trim() : '';

  // v1 endpoint — project create is not available on v3.
  // Same kebab/v1 pattern as tasklist creation.
  const auth = btoa(`${TEAMWORK_API_TOKEN}:x`);
  const payload = { project: { name } };
  if (description) payload.project.description = description;

  const res = await fetch(`https://${TEAMWORK_DOMAIN}/projects.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[projects] create failed', res.status, text);
    return Response.json(
      { error: `Project create failed (${res.status})` },
      { status: 502 }
    );
  }

  const data = await res.json().catch(() => ({}));
  const id = Number(data.id ?? res.headers.get('id'));
  if (!Number.isFinite(id)) {
    // The project may exist in Teamwork — tell the PM to check before retrying,
    // otherwise a retry creates a duplicate.
    console.error('[projects] create succeeded but no id in response', data);
    return Response.json(
      { error: 'Project may have been created but Teamwork returned no id — check Teamwork before retrying.' },
      { status: 502 }
    );
  }
  const url =
    res.headers.get('Location') ??
    `https://${TEAMWORK_DOMAIN}/projects/${id}`;

  return Response.json({ id, name, url }, { status: 201 });
}
