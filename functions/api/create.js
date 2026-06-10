// POST /api/create
// Orchestrates task creation:
//   1. If `tasklistMode === "new"`: create the tasklist (v1 endpoint).
//      Otherwise reuse the supplied existing `tasklistId`.
//   2. Create the parent task in that tasklist (v3 endpoint).
//   3. Create one subtask per item in the `subtasks` array (v3 endpoint).
//
// Returns the IDs/URLs of what was created. If a subtask write fails
// mid-flight we still report what got through — there is no transactional
// API and silent partial-success would be worse than surfacing the truth.
//
// Request body shape:
// {
//   "tasklistMode": "new" | "existing",
//   "tasklistName": "SEO. C. May 2026 Email Campaign",   // when "new"
//   "tasklistId": 123456,                                  // when "existing"
//   "projectId": 61030,                                    // when "new"
//   "parentTaskName": "May 2026 Email Campaign",
//   "subtasks": ["Develop text...", "Tag Andi...", ...],
//   "tags": [{"id": 81162, "name": "Email"}],              // optional
//   "resume": { "tasklistId": 123, "parentTaskId": 456 }   // optional — retry support
// }
//
// `resume` makes retries idempotent for the steps that already succeeded:
// resume.tasklistId skips tasklist creation; resume.parentTaskId additionally
// skips parent-task creation (subtasks are then created under it). The client
// sends only the subtasks that previously failed.

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

  const validation = validate(body);
  if (validation) return Response.json({ error: validation }, { status: 400 });

  const tw = new TeamworkClient(TEAMWORK_DOMAIN, TEAMWORK_API_TOKEN);
  const created = { tasklistId: null, tasklistUrl: null, parentTaskId: null, subtaskIds: [], partial: false, errors: [], warnings: [] };

  // Step 1 — tasklist (skipped when a retry resumes past it)
  try {
    if (body.resume?.tasklistId) {
      created.tasklistId = body.resume.tasklistId;
      created.tasklistUrl = `https://${TEAMWORK_DOMAIN}/tasklists/${body.resume.tasklistId}`;
    } else if (body.tasklistMode === 'new') {
      const tl = await tw.createTasklist(body.projectId, body.tasklistName);
      created.tasklistId = tl.id;
      created.tasklistUrl = tl.url;
    } else {
      created.tasklistId = body.tasklistId;
      created.tasklistUrl = `https://${TEAMWORK_DOMAIN}/tasklists/${body.tasklistId}`;
    }
  } catch (e) {
    return Response.json({ error: `Failed to create tasklist: ${e.message}` }, { status: 502 });
  }

  // Step 2 — parent task
  // In structured (v1 schema) mode the description is composed from the schema
  // (human rendering + acceptance checklist + machine-readable YAML), and the
  // schema's timing maps onto native Teamwork fields.
  const description = body.schema
    ? renderSchemaDescription(body.schema, body.parentTaskDescription ?? '')
    : (body.parentTaskDescription ?? '');
  const taskExtras = body.schema ? mapSchemaToTaskFields(body.schema) : {};

  let parentTaskId;
  if (body.resume?.parentTaskId) {
    // Retry resuming past parent-task creation — it already exists.
    parentTaskId = body.resume.parentTaskId;
    created.parentTaskId = parentTaskId;
  } else {
    try {
      const result = await tw.createTask(
        created.tasklistId,
        body.parentTaskName,
        description,
        body.tags ?? [],
        body.assigneeId ?? null,
        taskExtras
      );
      parentTaskId = result.id;
      created.parentTaskId = parentTaskId;
      // Assignment failure after a successful create is a warning, not a failure —
      // reporting it as a failure invites a retry that duplicates the task.
      if (result.assignError) {
        created.warnings.push(`Parent task created but could not be assigned: ${result.assignError}`);
      }
    } catch (e) {
      return Response.json(
        { error: `Tasklist created but parent task failed: ${e.message}`, created },
        { status: 502 }
      );
    }
  }

  // Step 3 — subtasks (sequential — the API rejects parallel writes from the same token)
  for (const subtask of body.subtasks) {
    const name = typeof subtask === 'string' ? subtask : subtask.name;
    const description = typeof subtask === 'string' ? '' : (subtask.description ?? '');
    const subtaskAssigneeId = typeof subtask === 'string' ? null : (subtask.assigneeId ?? null);
    try {
      const result = await tw.createSubtask(parentTaskId, name, description, subtaskAssigneeId);
      created.subtaskIds.push(result.id);
      if (result.assignError) {
        created.warnings.push(`"${name}" created but could not be assigned: ${result.assignError}`);
      }
    } catch (e) {
      created.partial = true;
      created.errors.push({ subtask: name, error: e.message });
    }
  }

  return Response.json({ ...created, success: !created.partial });
}

// ----- helpers -----

function validate(body) {
  if (!body || typeof body !== 'object') return 'Body must be an object.';
  if (body.resume !== undefined) {
    if (typeof body.resume !== 'object' || body.resume === null) return 'resume must be an object when provided.';
    if (body.resume.tasklistId !== undefined && typeof body.resume.tasklistId !== 'number') {
      return 'resume.tasklistId must be a number.';
    }
    if (body.resume.parentTaskId !== undefined && typeof body.resume.parentTaskId !== 'number') {
      return 'resume.parentTaskId must be a number.';
    }
  }
  // When a retry resumes past the tasklist step, the tasklist fields are moot.
  if (!body.resume?.tasklistId) {
    if (!['new', 'existing'].includes(body.tasklistMode)) return 'tasklistMode must be "new" or "existing".';
    if (body.tasklistMode === 'new') {
      if (!body.projectId) return 'projectId required when creating a new tasklist.';
      if (!body.tasklistName?.trim()) return 'tasklistName required when creating a new tasklist.';
    } else {
      if (!body.tasklistId) return 'tasklistId required when adding to existing tasklist.';
    }
  }
  if (!body.resume?.parentTaskId && !body.parentTaskName?.trim()) return 'parentTaskName required.';
  if (!Array.isArray(body.subtasks) || body.subtasks.length === 0) return 'subtasks must be a non-empty array.';
  if (body.subtasks.some((s) => {
    const name = typeof s === 'string' ? s : s?.name;
    return !name?.trim();
  })) return 'each subtask must have a non-empty name.';
  if (body.tags && !Array.isArray(body.tags)) return 'tags must be an array.';
  if (body.assigneeId !== undefined && body.assigneeId !== null && typeof body.assigneeId !== 'number') {
    return 'assigneeId must be a number.';
  }
  if (body.schema !== undefined && (typeof body.schema !== 'object' || body.schema === null)) {
    return 'schema must be an object when provided.';
  }
  return null;
}

// ----- structured (Cake Task Template v1) rendering -----
//
// The v1 schema splits into native Teamwork fields (due date, priority,
// estimate) and a rich description. Everything that has no native home lives in
// the description: a human-readable rendering for staff, plus a collapsed
// machine-readable YAML block so the full schema survives a future platform
// move (Plane, etc.) with nothing lost.

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const PILLAR_LABELS = {
  '1': '1 — Dual-Audience Website',
  '2': '2 — Engineered Authority Signals',
  '3': '3 — Current and Best, Always',
  '4': '4 — AI-Powered Practice Operations',
  internal: 'Internal',
};
const STAGE_LABELS = {
  being_feeling: 'Being & Feeling',
  searching: 'Searching',
  visiting: 'Visiting',
  converting: 'Converting',
  internal: 'Internal',
};

function mapSchemaToTaskFields(schema) {
  const out = {};
  const t = schema.timing ?? {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(t.dueDate ?? '')) out.dueAt = t.dueDate;
  // Teamwork native priority is low | medium | high. Map urgent → high; normal stays unset.
  const priorityMap = { low: 'low', high: 'high', urgent: 'high' };
  if (priorityMap[t.priority]) out.priority = priorityMap[t.priority];
  // estimatedHours may be a single value or a range ("2-3"); take the largest number.
  const hours = String(t.estimatedHours ?? '').match(/\d+(\.\d+)?/g);
  if (hours?.length) {
    const max = Math.max(...hours.map(Number));
    if (max > 0) out.estimateMinutes = Math.round(max * 60);
  }
  return out;
}

function renderSchemaDescription(schema, base) {
  const s = schema;
  const blocks = [];
  const list = (arr) =>
    `<ul>${arr.filter((x) => String(x).trim()).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

  if (s.work?.summary || base) {
    blocks.push(`<p>${esc(s.work?.summary || base)}</p>`);
  }

  if (s.strategy) {
    const rows = [
      s.strategy.pillar && `<li><strong>Pillar:</strong> ${esc(PILLAR_LABELS[s.strategy.pillar] ?? s.strategy.pillar)}</li>`,
      s.strategy.stage && `<li><strong>Stage:</strong> ${esc(STAGE_LABELS[s.strategy.stage] ?? s.strategy.stage)}</li>`,
      s.strategy.businessGoal && `<li><strong>Business goal:</strong> ${esc(s.strategy.businessGoal)}</li>`,
    ].filter(Boolean);
    if (rows.length) blocks.push(`<h3>Strategic anchor</h3><ul>${rows.join('')}</ul>`);
  }

  if (s.work?.outOfScope?.trim()) blocks.push(`<h3>Out of scope</h3><p>${esc(s.work.outOfScope)}</p>`);
  if (s.work?.inputsNeeded?.length) blocks.push(`<h3>Inputs needed</h3>${list(s.work.inputsNeeded)}`);
  if (s.work?.assumptions?.length) blocks.push(`<h3>Assumptions</h3>${list(s.work.assumptions)}`);

  if (s.acceptance?.length) {
    const items = s.acceptance
      .filter((a) => a?.observable?.trim())
      .map((a) => {
        const q = a.quantifiable?.trim() ? ` <em>(${esc(a.quantifiable)})</em>` : '';
        const v = a.verifier?.trim() ? ` — verified by ${esc(a.verifier)}` : '';
        return `<li>☐ ${esc(a.observable)}${q}${v}</li>`;
      });
    if (items.length) blocks.push(`<h3>Definition of done</h3><ul>${items.join('')}</ul>`);
  }

  const billingRows = [
    s.prefixes?.length && `<li><strong>Prefix:</strong> ${esc(s.prefixes.join(' '))}</li>`,
    s.billing?.sowReference?.trim() && `<li><strong>SoW reference:</strong> ${esc(s.billing.sowReference)}</li>`,
    s.billing?.notes?.trim() && `<li><strong>Notes:</strong> ${esc(s.billing.notes)}</li>`,
  ].filter(Boolean);
  if (billingRows.length) blocks.push(`<h3>Billing</h3><ul>${billingRows.join('')}</ul>`);

  const ownRows = [
    s.ownership?.owner?.trim() && `<li><strong>Owner:</strong> ${esc(s.ownership.owner)}</li>`,
    s.ownership?.reviewer?.trim() && `<li><strong>Reviewer:</strong> ${esc(s.ownership.reviewer)}</li>`,
    s.ownership?.pm?.trim() && `<li><strong>PM:</strong> ${esc(s.ownership.pm)}</li>`,
  ].filter(Boolean);
  if (ownRows.length) blocks.push(`<h3>Ownership</h3><ul>${ownRows.join('')}</ul>`);

  const timeRows = [
    s.timing?.dueDate?.trim() && `<li><strong>Due:</strong> ${esc(s.timing.dueDate)}</li>`,
    s.timing?.estimatedHours?.trim() && `<li><strong>Estimate:</strong> ${esc(s.timing.estimatedHours)} hrs</li>`,
    s.timing?.priority && s.timing.priority !== 'normal' && `<li><strong>Priority:</strong> ${esc(s.timing.priority)}</li>`,
    s.timing?.dependencies?.length && `<li><strong>Dependencies:</strong> ${esc(s.timing.dependencies.join('; '))}</li>`,
  ].filter(Boolean);
  if (timeRows.length) blocks.push(`<h3>Timing</h3><ul>${timeRows.join('')}</ul>`);

  const aiRows = [
    s.aiContext?.relevantSkills?.length && `<li><strong>Relevant skills:</strong> ${esc(s.aiContext.relevantSkills.join(', '))}</li>`,
    s.aiContext?.brandGuidelines?.trim() && `<li><strong>Brand guidelines:</strong> ${esc(s.aiContext.brandGuidelines)}</li>`,
    s.aiContext?.confidence && `<li><strong>Confidence:</strong> ${esc(s.aiContext.confidence)}</li>`,
    s.aiContext?.notes?.trim() && `<li><strong>Notes:</strong> ${esc(s.aiContext.notes)}</li>`,
  ].filter(Boolean);
  if (aiRows.length) blocks.push(`<h3>AI context</h3><ul>${aiRows.join('')}</ul>`);

  // Machine-readable block — full schema as YAML, for round-trip / platform portability.
  blocks.push(
    `<hr><p><strong>Task schema (v1, machine-readable)</strong></p><pre>${esc(schemaToYaml(s))}</pre>`
  );

  return blocks.join('\n');
}

// Minimal hand-rolled YAML serializer (no dependency in the Worker runtime).
function schemaToYaml(s) {
  const lines = [];
  const q = (v) => {
    const str = String(v ?? '');
    return /[:#\-?{}\[\],&*!|>'"%@`\n]/.test(str) || str === '' ? JSON.stringify(str) : str;
  };
  const arr = (key, items, indent = '') => {
    if (!items?.length) { lines.push(`${indent}${key}: []`); return; }
    lines.push(`${indent}${key}:`);
    for (const it of items) lines.push(`${indent}  - ${q(it)}`);
  };

  lines.push(`title: ${q(s.parentTaskName)}`);
  arr('prefixes', s.prefixes);
  lines.push(`client: ${q(s.client)}`);
  lines.push('strategy:');
  lines.push(`  pillar: ${q(s.strategy?.pillar)}`);
  lines.push(`  stage: ${q(s.strategy?.stage)}`);
  lines.push(`  business_goal: ${q(s.strategy?.businessGoal)}`);
  lines.push('work:');
  lines.push(`  summary: ${q(s.work?.summary)}`);
  lines.push(`  out_of_scope: ${q(s.work?.outOfScope)}`);
  arr('inputs_needed', s.work?.inputsNeeded, '  ');
  arr('assumptions', s.work?.assumptions, '  ');
  if (s.acceptance?.length) {
    lines.push('acceptance:');
    for (const a of s.acceptance) {
      lines.push(`  - observable: ${q(a.observable)}`);
      lines.push(`    quantifiable: ${q(a.quantifiable)}`);
      lines.push(`    verifier: ${q(a.verifier)}`);
    }
  } else {
    lines.push('acceptance: []');
  }
  lines.push('timing:');
  lines.push(`  due_date: ${q(s.timing?.dueDate)}`);
  lines.push(`  estimated_hours: ${q(s.timing?.estimatedHours)}`);
  lines.push(`  priority: ${q(s.timing?.priority)}`);
  arr('dependencies', s.timing?.dependencies, '  ');
  lines.push('billing:');
  lines.push(`  prefix: ${q((s.prefixes ?? []).join(' '))}`);
  lines.push(`  sow_reference: ${q(s.billing?.sowReference)}`);
  lines.push(`  notes: ${q(s.billing?.notes)}`);
  lines.push('ownership:');
  lines.push(`  owner: ${q(s.ownership?.owner)}`);
  lines.push(`  reviewer: ${q(s.ownership?.reviewer)}`);
  lines.push(`  pm: ${q(s.ownership?.pm)}`);
  lines.push('ai_context:');
  arr('relevant_skills', s.aiContext?.relevantSkills, '  ');
  lines.push(`  brand_guidelines: ${q(s.aiContext?.brandGuidelines)}`);
  lines.push(`  confidence: ${q(s.aiContext?.confidence)}`);
  lines.push(`  notes: ${q(s.aiContext?.notes)}`);
  return lines.join('\n');
}

class TeamworkClient {
  constructor(domain, token) {
    this.domain = domain;
    this.auth = `Basic ${btoa(`${token}:x`)}`;
  }

  async createTasklist(projectId, name) {
    // v1 endpoint — v3 returns 405 for this resource.
    const res = await fetch(`https://${this.domain}/projects/${projectId}/tasklists.json`, {
      method: 'POST',
      headers: {
        Authorization: this.auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 'todo-list': { name } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('[create] tasklist create', res.status, await res.text());
      throw new Error(`Teamwork returned ${res.status} creating tasklist`);
    }
    const data = await res.json();
    return {
      id: Number(data.TASKLISTID),
      url: res.headers.get('Location') ?? `https://${this.domain}/tasklists/${data.TASKLISTID}`,
    };
  }

  async createTask(tasklistId, name, description, tags, assigneeId, extras = {}) {
    const task = { name, ...extras };
    if (description) task.description = description;
    const res = await fetch(
      `https://${this.domain}/projects/api/v3/tasklists/${tasklistId}/tasks.json`,
      {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, tags }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) {
      console.error('[create] task create', res.status, await res.text());
      throw new Error(`Teamwork returned ${res.status} creating task`);
    }
    const data = await res.json();
    const taskId = data.task.id;
    // The task exists at this point — an assignment failure must not bubble as
    // a create failure (the caller would retry and duplicate the task).
    let assignError = null;
    if (assigneeId) {
      try { await this.assignTask(taskId, assigneeId); }
      catch (e) { assignError = e.message; }
    }
    return { id: taskId, assignError };
  }

  async assignTask(taskId, assigneeId) {
    const res = await fetch(`https://${this.domain}/tasks/${taskId}.json`, {
      method: 'PUT',
      headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'todo-item': { 'responsible-party-id': String(assigneeId) } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('[create] assign task', res.status, await res.text());
      throw new Error(`Teamwork returned ${res.status} assigning task`);
    }
  }

  async createSubtask(parentTaskId, name, description, assigneeId = null) {
    const task = { name };
    if (description) task.description = description;
    const res = await fetch(
      `https://${this.domain}/projects/api/v3/tasks/${parentTaskId}/subtasks.json`,
      {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) {
      console.error('[create] subtask create', res.status, await res.text());
      throw new Error(`Teamwork returned ${res.status} creating subtask`);
    }
    const data = await res.json();
    const subtaskId = data.task.id;
    // Same warning-not-failure handling as createTask — the subtask exists.
    let assignError = null;
    if (assigneeId) {
      try { await this.assignTask(subtaskId, assigneeId); }
      catch (e) { assignError = e.message; }
    }
    return { id: subtaskId, assignError };
  }
}
