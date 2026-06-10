// GET /api/projects/:projectId/members
// Returns non-client, non-deleted members of the given project.
// Used to populate the assignee picker in the task builder form.

export async function onRequestGet({ params, env }) {
  const { TEAMWORK_DOMAIN, TEAMWORK_API_TOKEN } = env;
  if (!TEAMWORK_DOMAIN || !TEAMWORK_API_TOKEN) {
    return Response.json({ error: 'Server not configured.' }, { status: 500 });
  }

  if (!/^\d+$/.test(params.projectId)) {
    return Response.json({ error: 'Invalid project id.' }, { status: 400 });
  }

  const auth = `Basic ${btoa(`${TEAMWORK_API_TOKEN}:x`)}`;
  const url = `https://${TEAMWORK_DOMAIN}/projects/api/v3/projects/${params.projectId}/people.json?pageSize=50`;

  const res = await fetch(url, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return Response.json({ error: `Teamwork error: ${res.status}` }, { status: 502 });
  }

  const data = await res.json();
  const members = (data.people ?? [])
    .filter((p) => !p.isClientUser && !p.deleted)
    .map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return Response.json({ members });
}
