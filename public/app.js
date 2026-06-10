// Single-page state machine for the task creation flow.
// Screens: pick-project → form → preview → success.
//
// The email-campaign template is hardcoded here for Phase 1. When more
// templates are added it will move to its own module/JSON file.

const TEMPLATES = [
  {
    id: 'ai-generate',
    name: 'AI Generate',
    // Names and subtasks are produced by the AI — no patterns here.
    tasklistNamePattern: null,
    parentTaskNamePattern: null,
    defaultTags: [],
    subtasks: null,
  },
  {
    id: 'email-campaign',
    name: 'Email Campaign',
    tasklistNamePattern: 'SEO. {clientType}. {monthLabel} Email Campaign',
    parentTaskNamePattern: '{monthLabel} Email Campaign',
    defaultTags: [{ id: 81162, name: 'Email' }],
    subtasks: [
      'Develop text for email and share doc for internal review',
      'Tag Andi for review & model image options',
      'Proofread newsletter document & find model image options',
      'Test internally',
      '[Project manager] Check with client for email addresses to add',
      'Send test to practice for approval',
      'Update specials page, add to GBP, & notify Ashley for social clients',
      'Send newsletter during the first week of the month',
      'Send reminder newsletter during the third week of the month; change subject line',
    ],
  },
  {
    id: 'seo-blog-content',
    name: 'SEO Blog Content',
    tasklistNamePattern: 'SEO. {clientType}. {monthLabel} SEO Blog Content',
    parentTaskNamePattern: '[Copywriter] SEO. {clientType}. {monthLabel} SEO Blog Content',
    defaultTags: [{ id: 62460, name: 'Copywriting' }],
    subtasks: [
      '[Copywriter] Write the blog post using template, tag Madison for image options, and comment for internal review.',
      '[Copywriter] Are there any images we can include?',
      'Choose, prep, & upload blog image with appropriate title. Make sure all caption and stock photo file data has been removed.',
      'Send the internally approved blog post to client for approval. CC PM in email to the practice.',
      'Once we have final approval of all edits, draft the post, adding all metadata, one category, and all the tags. Ensure pull quote has been added & formatted correctly. Follow hub-style guidelines for appropriate blogs. Do not publish more than one post in a 24-hour period.',
      'Post the blog post to GMB.',
      'If this month\'s SEO content is a page update, run page through POP, update as needed, and notify Project & Content Manager',
    ],
  },
];

const state = {
  projectMode: 'existing',      // 'existing' (pick from list) | 'new' (create new project on confirm)
  selectedProject: null,        // { id, name } — set after picking (existing) or creating (new). For 'new', id is null until confirm.
  newProjectDraft: null,        // { name, description } — captured before preview when projectMode === 'new'
  existingTasklists: [],        // for the currently selected project
  projectMembers: [],           // [{ id, name }] — loaded when an existing project is selected
  preview: null,                // { tasklistName, parentTaskName, subtasks, tasklistMode, ... }
  batchItems: [],               // [{ description, clientType, assigneeId }] — one per prompt box
  batchPreviews: [],            // array of preview objects, one per batch item
  isBatchMode: false,
  selectedTemplate: TEMPLATES[0],
  pendingGeneration: null,      // AbortController | null — cancelled when user navigates back
  taskStructure: 'quick',       // 'quick' (lean output) | 'structured' (Cake Task v1 schema)
  lastBatchResults: null,       // [{ ok, result, payload, tasklistName, projectName }] — for Retry failed
  lastSingleAttempt: null,      // { payload, result, createdProject } — for Retry failed
};

// ===== screen routing =====

function showScreen(id) {
  for (const el of document.querySelectorAll('.screen')) {
    el.dataset.active = el.id === `screen-${id}` ? 'true' : 'false';
  }
  // Lazy-load projects the first time the picker is shown (or on re-entry).
  if (id === 'pick-project') {
    const term = searchInput?.value?.trim() ?? '';
    loadProjects(term);
  }
  const subtitleMap = {
    'form': '',
    'pick-project': 'Pick a project to assign tasks to.',
    'preview': 'Review and edit before creating tasks.',
    'success': '',
  };
  const titleMap = {
    'form': 'Task Builder — Configure',
    'pick-project': 'Task Builder — Pick Project',
    'preview': 'Task Builder — Preview',
    'success': 'Task Builder — Done',
  };
  const stepMap = { 'form': 1, 'pick-project': 2, 'preview': 3, 'success': 4 };
  const currentStep = stepMap[id] ?? 1;
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    const step = i + 1;
    if (step === currentStep) dot.dataset.state = 'active';
    else if (step < currentStep) dot.dataset.state = 'done';
    else delete dot.dataset.state;
  });
  document.getElementById('subtitle').textContent = subtitleMap[id] ?? '';
  document.title = titleMap[id] ?? 'Task Builder';
  // Persist the crash-recovery draft on every navigation (no-op until boot).
  saveDraft();
}

// ===== screen 2: project picker (existing OR new) =====

const searchInput = document.getElementById('search');
const projectResults = document.getElementById('project-results');
const searchStatus = document.getElementById('search-status');
const modeToggleBtns = document.querySelectorAll('.mode-toggle-btn');
const modePanels = document.querySelectorAll('.mode-panel');
const newProjectForm = document.getElementById('new-project-form');
const newProjectNameInput = document.getElementById('new-project-name');
const newProjectDescInput = document.getElementById('new-project-description');
const tasklistFieldset = document.getElementById('tasklist-fieldset');

function setProjectMode(mode) {
  state.projectMode = mode;
  for (const btn of modeToggleBtns) {
    btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
  }
  for (const panel of modePanels) {
    panel.dataset.active = String(panel.dataset.modePanel === mode);
  }
}

for (const btn of modeToggleBtns) {
  btn.addEventListener('click', () => setProjectMode(btn.dataset.mode));
  btn.addEventListener('keydown', (e) => {
    const buttons = [...modeToggleBtns];
    const i = buttons.indexOf(btn);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
      next.focus();
      setProjectMode(next.dataset.mode);
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0].focus();
      setProjectMode(buttons[0].dataset.mode);
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1].focus();
      setProjectMode(buttons[buttons.length - 1].dataset.mode);
    }
  });
}

let debounceTimer = null;
let activeProjectsRequestId = 0;

async function loadProjects(term) {
  const requestId = ++activeProjectsRequestId;
  setStatus(searchStatus, term ? `Searching for "${term}"…` : 'Loading projects…');

  const url = new URL('/api/projects', window.location.origin);
  if (term) url.searchParams.set('search', term);

  try {
    const res = await fetch(url);
    if (requestId !== activeProjectsRequestId) return;
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(searchStatus, `Error: ${body.error || res.statusText}`, true);
      projectResults.innerHTML = '';
      return;
    }
    const { projects, total } = await res.json();
    renderProjects(projects);
    setStatus(
      searchStatus,
      projects.length === 0 ? 'No projects matched.' : `Showing ${projects.length} of ${total}.`
    );
  } catch (err) {
    if (requestId !== activeProjectsRequestId) return;
    setStatus(searchStatus, `Network error: ${err.message}`, true);
  }
}

function renderProjects(projects) {
  projectResults.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.dataset.projectId = p.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    li.innerHTML = '<span class="project-name"></span><span class="project-id"></span>';
    li.querySelector('.project-name').textContent = p.name;
    li.querySelector('.project-id').textContent = `#${p.id}`;
    li.addEventListener('click', () => selectProject(p));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectProject(p); }
    });
    projectResults.appendChild(li);
  }
}

searchInput.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  const term = e.target.value.trim();
  debounceTimer = setTimeout(() => loadProjects(term), 200);
});

// ===== screen 1: configure form =====

// ===== DOM refs =====
const assigneeField = document.getElementById('assignee-field');
const assigneeSelect = document.getElementById('assignee-select');
const assigneeHint = document.getElementById('assignee-hint');
const batchPanel = document.getElementById('batch-panel');
const batchItemsContainer = document.getElementById('batch-items');
const batchAddItemBtn = document.getElementById('batch-add-item');
const batchStatus = document.getElementById('batch-status');

const monthInput = document.getElementById('month');
const tasklistNameSub = document.getElementById('preview-tasklist-name');
const existingSelect = document.getElementById('existing-tasklist');
const form = document.getElementById('campaign-form');
const projectSelectedPanel = document.getElementById('project-selected-panel');
const banner = document.getElementById('selected-project-banner');

// Default the month input to the current month.
{
  const now = new Date();
  monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function selectProject(project) {
  state.projectMode = 'existing';
  state.selectedProject = project;
  state.newProjectDraft = null;
  banner.innerHTML = `Selected project: <b></b> <span class="project-id">#${project.id}</span>`;
  banner.querySelector('b').textContent = project.name;
  projectSelectedPanel.hidden = false;
  tasklistFieldset.hidden = false;
  loadExistingTasklists(project.id);
  loadProjectMembers(project.id);
  assigneeField.hidden = false;
  updateTasklistPreview();
  // Stay on pick-project screen; user clicks Continue →
}

newProjectForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = newProjectNameInput.value.trim();
  if (!name) return;
  state.projectMode = 'new';
  state.newProjectDraft = {
    name,
    description: newProjectDescInput.value.trim(),
  };
  // The project doesn't exist yet — show its draft name as
  // the selected project. Final id is assigned at confirm time.
  state.selectedProject = { id: null, name };
  state.existingTasklists = [];
  state.projectMembers = [];
  banner.innerHTML = `Creating new project: <b></b> <span class="project-id">(new)</span>`;
  banner.querySelector('b').textContent = name;
  projectSelectedPanel.hidden = false;
  tasklistFieldset.hidden = true;
  const newRadio = document.querySelector('input[name="tasklistMode"][value="new"]');
  if (newRadio) newRadio.checked = true;
  // Assignee not available for new projects — project doesn't exist yet
  assigneeSelect.innerHTML = '<option value="">— Unassigned —</option>';
  assigneeSelect.disabled = true;
  assigneeHint.textContent = 'Assignee can be set after the project is created.';
  assigneeField.hidden = false;
  updateTasklistPreview();
  // Stay on pick-project screen; user clicks Continue →
});

// Request-id guards — selecting project A then quickly project B must not let
// A's slower response overwrite B's tasklists/members (same pattern as loadProjects).
let activeTasklistsRequestId = 0;
let activeMembersRequestId = 0;

async function loadExistingTasklists(projectId) {
  const requestId = ++activeTasklistsRequestId;
  existingSelect.disabled = true;
  existingSelect.innerHTML = '<option value="">Loading…</option>';
  try {
    const res = await fetch(`/api/projects/${projectId}/tasklists`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { tasklists } = await res.json();
    if (requestId !== activeTasklistsRequestId) return;
    state.existingTasklists = tasklists;
    existingSelect.innerHTML = '';
    if (tasklists.length === 0) {
      existingSelect.innerHTML = '<option value="">No existing tasklists</option>';
      return;
    }
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— select an existing tasklist —';
    existingSelect.appendChild(placeholder);
    for (const tl of tasklists) {
      const opt = document.createElement('option');
      opt.value = tl.id;
      opt.textContent = tl.name;
      existingSelect.appendChild(opt);
    }
    existingSelect.disabled = false;
  } catch (err) {
    if (requestId !== activeTasklistsRequestId) return;
    // textContent, not innerHTML — err.message must never reach an HTML sink.
    existingSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `Failed to load: ${err.message}`;
    existingSelect.appendChild(opt);
  }
}

async function loadProjectMembers(projectId) {
  const requestId = ++activeMembersRequestId;
  state.projectMembers = [];
  assigneeSelect.innerHTML = '<option value="">— Unassigned —</option>';
  assigneeSelect.disabled = true;
  assigneeHint.textContent = 'Loading team members…';
  try {
    const res = await fetch(`/api/projects/${projectId}/members`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { members } = await res.json();
    if (requestId !== activeMembersRequestId) return;
    state.projectMembers = members;
    for (const m of members) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      assigneeSelect.appendChild(opt);
    }
    assigneeSelect.disabled = false;
    assigneeHint.textContent = '';
  } catch (err) {
    if (requestId !== activeMembersRequestId) return;
    assigneeHint.textContent = `Could not load members: ${err.message}`;
  }
  renderBatchItems();
}

function fillPattern(pattern, vars) {
  let result = pattern.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
  // Collapse ". . " segments that result from an empty substitution (e.g. "SEO. . May" → "SEO. May")
  result = result.replace(/\.\s+\./g, '.').trim();
  return result;
}

function formatMonthLabel(monthValue) {
  if (!monthValue) return '';
  const [year, month] = monthValue.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function currentFormVars() {
  const clientType = form.querySelector('input[name="clientType"]:checked').value;
  const monthLabel = formatMonthLabel(monthInput.value);
  return { clientType, monthLabel };
}

const standardFields = document.getElementById('standard-fields');
const aiGeneratePanel = document.getElementById('ai-generate-panel');
const aiGeneratePrompt = document.getElementById('ai-generate-prompt');
const aiGenerateStatus = document.getElementById('ai-generate-status');
const templatePicker = document.getElementById('template-picker');

const clientTypeFieldset = form.querySelector('fieldset:has(input[name="clientType"])');

function setAiGenerateMode(isAi) {
  standardFields.hidden = isAi;
  // Disable the hidden required month input — browsers still run constraint
  // validation on display:none controls, which would block submit with no UI.
  monthInput.disabled = isAi;
  aiGeneratePanel.hidden = true; // batch panel replaces it for AI Generate
  batchPanel.hidden = !isAi;
  templatePicker.hidden = isAi;
  // AI Generate: per-item contract type inside each prompt box; templates: global fieldset
  if (clientTypeFieldset) clientTypeFieldset.hidden = isAi;
  assigneeField.hidden = isAi;
  state.isBatchMode = isAi;
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = isAi ? 'Generate preview →' : 'Preview tasks →';
  if (isAi) {
    tasklistNameSub.textContent = '(AI will generate)';
    if (state.batchItems.length === 0) addBatchItem();
    renderBatchItems();
  }
}

// ===== batch item management =====

function makeBatchItem() {
  return { description: '', clientType: 'C', assigneeId: null };
}

function addBatchItem() {
  state.batchItems.push(makeBatchItem());
  renderBatchItems();
}

function removeBatchItem(index) {
  state.batchItems.splice(index, 1);
  if (state.batchItems.length === 0) addBatchItem();
  else renderBatchItems();
}

function renderBatchItems() {
  batchItemsContainer.innerHTML = '';
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn && state.isBatchMode) {
    submitBtn.textContent = state.batchItems.length > 1 ? 'Generate previews →' : 'Generate preview →';
  }
  state.batchItems.forEach((item, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'batch-item';
    wrap.dataset.index = idx;

    // Header row — only shown for non-first items so the remove button
    // sits clearly above the textarea instead of overlapping it.
    if (idx > 0) {
      const itemHeader = document.createElement('div');
      itemHeader.className = 'batch-item-header';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'batch-item-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => removeBatchItem(idx));
      itemHeader.appendChild(removeBtn);
      wrap.appendChild(itemHeader);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'batch-item-textarea';
    textarea.rows = 6;
    textarea.placeholder = 'Describe the task, or paste content from an email, meeting notes, etc.';
    textarea.value = item.description;
    textarea.addEventListener('input', () => {
      state.batchItems[idx].description = textarea.value;
    });

    // Contract type radios only — assignee is picked per-card after project selection (step 3)
    const metaRow = document.createElement('div');
    metaRow.className = 'batch-item-meta';

    const ctWrap = document.createElement('div');
    ctWrap.className = 'batch-item-client-type';
    for (const [val, lbl] of [['C', 'Contract'], ['H', 'Hourly'], ['G', 'Gratis'], ['', 'None']]) {
      const radioLabel = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `batchClientType_${idx}`;
      radio.value = val;
      radio.checked = item.clientType === val;
      radio.addEventListener('change', () => { state.batchItems[idx].clientType = val; });
      radioLabel.appendChild(radio);
      radioLabel.appendChild(document.createTextNode(` ${lbl}`));
      ctWrap.appendChild(radioLabel);
    }

    wrap.appendChild(textarea);
    // Structured (v1) mode detects prefixes with AI and lets the PM edit them on
    // the preview screen — so the per-item contract-type radios are hidden here.
    if (state.taskStructure !== 'structured') {
      metaRow.appendChild(ctWrap);
      wrap.appendChild(metaRow);
    }
    batchItemsContainer.appendChild(wrap);
  });
}

function updateTasklistPreview() {
  if (state.selectedTemplate.id === 'ai-generate') return;
  const vars = currentFormVars();
  tasklistNameSub.textContent = fillPattern(state.selectedTemplate.tasklistNamePattern, vars);
}

// Task mode and template selection
form.addEventListener('change', (e) => {
  if (e.target.name === 'taskMode') {
    const isAi = e.target.value === 'ai-generate';
    if (isAi) {
      state.selectedTemplate = TEMPLATES[0];
    } else {
      const checkedTemplate = form.querySelector('input[name="template"]:checked');
      state.selectedTemplate = TEMPLATES.find((t) => t.id === (checkedTemplate?.value ?? 'email-campaign')) ?? TEMPLATES[1];
    }
    setAiGenerateMode(isAi);
    updateTasklistPreview();
  }
  if (e.target.name === 'template') {
    state.selectedTemplate = TEMPLATES.find((t) => t.id === e.target.value) ?? TEMPLATES[1];
    updateTasklistPreview();
  }
});

// Structured (v1) toggle. Structured mode generates the full Cake Task schema
// and is single-task only — it forces AI Generate, hides the template option,
// the "+ Add another" batch control, and the per-item contract-type radios.
function setTaskStructure(structured) {
  state.taskStructure = structured ? 'structured' : 'quick';
  const templateCard = form.querySelector('input[name="taskMode"][value="template"]')?.closest('.radio-card');

  if (structured) {
    const aiRadio = form.querySelector('input[name="taskMode"][value="ai-generate"]');
    if (aiRadio && !aiRadio.checked) aiRadio.checked = true;
    state.selectedTemplate = TEMPLATES[0];
    if (templateCard) templateCard.hidden = true;
    batchAddItemBtn.hidden = true;
    if (state.batchItems.length > 1) state.batchItems = [state.batchItems[0]];
    setAiGenerateMode(true);
    renderBatchItems();
  } else {
    if (templateCard) templateCard.hidden = false;
    batchAddItemBtn.hidden = false;
    const checked = form.querySelector('input[name="taskMode"]:checked')?.value ?? 'ai-generate';
    setAiGenerateMode(checked === 'ai-generate');
    if (checked === 'ai-generate') renderBatchItems();
  }
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'taskStructure') {
    setTaskStructure(e.target.value === 'structured');
  }
});

batchAddItemBtn.addEventListener('click', addBatchItem);

// React to form changes that affect the preview name
form.addEventListener('change', updateTasklistPreview);
monthInput.addEventListener('input', updateTasklistPreview);

// Enable/disable existing-tasklist dropdown based on mode.
// tasklistMode radios are now in project-selected-panel (not inside the form).
document.addEventListener('change', (e) => {
  if (e.target.name === 'tasklistMode') {
    const useExisting = e.target.value === 'existing';
    existingSelect.disabled = !useExisting || state.existingTasklists.length === 0;
  }
});

// Clicking the nested select auto-selects its parent radio
existingSelect.addEventListener('focus', () => {
  const radio = document.querySelector('input[name="tasklistMode"][value="existing"]');
  if (radio && !radio.checked) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

// back-to-configure: pick-project → form
document.getElementById('back-to-configure').addEventListener('click', () => {
  projectSelectedPanel.hidden = true;
  state.selectedProject = null;
  state.projectMembers = [];
  state.existingTasklists = [];
  setStatus(pickProjectStatus, '');
  // Restore batch mode to match the form's task-mode radio — the single-result
  // batch path clears isBatchMode/batchItems before landing here, and returning
  // without restoring them breaks the form (empty batchItems + template path
  // crashing on TEMPLATES[0].subtasks being null). Mirrors back-to-form.
  const isAi = form.querySelector('input[name="taskMode"][value="ai-generate"]')?.checked ?? false;
  state.isBatchMode = isAi;
  if (isAi && state.batchItems.length === 0) addBatchItem();
  showScreen('form');
});

const pickProjectStatus = document.getElementById('pick-project-status');

// continue-to-preview: pick-project → preview (single-task / template)
document.getElementById('continue-to-preview').addEventListener('click', () => {
  const tlMode = state.projectMode === 'new'
    ? 'new'
    : document.querySelector('input[name="tasklistMode"]:checked')?.value ?? 'new';

  if (tlMode === 'existing' && !existingSelect.value) {
    setStatus(pickProjectStatus, 'Pick an existing tasklist or switch to "Create new".', true);
    return;
  }
  if (!state.preview) {
    setStatus(pickProjectStatus, 'Nothing to preview — go back and configure the task first.', true);
    return;
  }
  setStatus(pickProjectStatus, '');

  state.preview.projectMode = state.projectMode;
  state.preview.newProject = state.projectMode === 'new' ? { ...state.newProjectDraft } : null;
  state.preview.tasklistMode = tlMode;
  state.preview.existingTasklistId = tlMode === 'existing' ? Number(existingSelect.value) : null;
  state.preview.existingTasklistName = tlMode === 'existing'
    ? state.existingTasklists.find((tl) => tl.id === Number(existingSelect.value))?.name
    : null;
  state.preview.assigneeId = assigneeSelect.value ? Number(assigneeSelect.value) : null;

  // Structured mode: default the schema's client to the chosen project name.
  if (state.preview.structured && state.preview.schema && !state.preview.schema.client?.trim()) {
    state.preview.schema.client = state.projectMode === 'new'
      ? (state.newProjectDraft?.name ?? '')
      : (state.selectedProject?.name ?? '');
  }

  showScreen('preview');  // must come first — autoResize needs display:block to measure scrollHeight
  renderPreview();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const submitBtn = form.querySelector('button[type="submit"]');

  // ===== Batch AI path =====
  // No project selected yet — each card gets its own project selector on the preview screen.
  if (state.isBatchMode) {
    const validItems = state.batchItems.filter((item) => item.description.trim());
    if (validItems.length === 0) {
      setStatus(batchStatus, 'Add at least one action item description.', true);
      return;
    }
    // Cancel any previous in-flight generation (e.g. user went back mid-flight).
    if (state.pendingGeneration) state.pendingGeneration.abort();
    const abortCtrl = new AbortController();
    state.pendingGeneration = abortCtrl;

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = 'Generating…';
    setStatus(batchStatus, `Generating ${validItems.length} task${validItems.length === 1 ? '' : 's'}…`);
    try {
      // Per-item failures resolve to { ok: false } instead of rejecting the whole
      // batch — one flaky request or non-JSON error page must not discard the
      // other completed (and paid-for) generations. AbortError still rejects
      // everything: it's the shared controller's intentional bail-out.
      const results = await Promise.all(
        validItems.map((item) =>
          fetch('/api/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: 'design',
              description: item.description,
              clientType: item.clientType,
              existingTasklists: [],
              structured: state.taskStructure === 'structured',
            }),
            signal: abortCtrl.signal,
          })
            .then((r) =>
              r.json()
                .then((data) => ({ ok: r.ok, data }))
                .catch(() => ({ ok: false, data: { error: `Bad response (HTTP ${r.status})` } }))
            )
            .catch((err) => {
              if (err.name === 'AbortError') throw err;
              return { ok: false, data: { error: err.message } };
            })
        )
      );
      const failures = results.filter((r) => !r.ok);
      if (failures.length === results.length) {
        setStatus(batchStatus, `All generations failed: ${failures[0]?.data?.error ?? 'unknown error'}`, true);
        return;
      }
      const successResults = results.filter((r) => r.ok);

      if (failures.length > 0) {
        setStatus(batchStatus, `${failures.length} item${failures.length === 1 ? '' : 's'} failed to generate and were skipped.`, true);
      } else {
        setStatus(batchStatus, '');
      }

      if (successResults.length === 1) {
        // Single result — use single-task preview; go to pick-project for project assignment.
        const data = successResults[0].data;
        const item = validItems[results.indexOf(successResults[0])];
        state.preview = {
          // project fields filled in by continue-to-preview after project is picked
          tasklistMode: 'new',
          tasklistName: data.tasklistName,
          parentTaskName: data.parentTaskName,
          parentTaskDescription: data.structured ? '' : (data.parentTaskDescription ?? ''),
          subtasks: data.subtasks,
          templateId: 'ai-generate',
          templateName: data.structured ? 'AI Generate (Structured)' : 'AI Generate',
          tags: [],
          notes: item.description,
          monthLabel: '',
          clientType: data.structured ? '' : item.clientType,
          assigneeId: item.assigneeId,
          aiFallback: false,
          structured: !!data.structured,
          schema: data.structured ? buildSchemaFromResponse(data) : null,
        };
        state.isBatchMode = false;
        state.batchItems = [];
        showScreen('pick-project');
      } else {
        // Multiple results — go straight to preview with per-card project selectors.
        state.batchPreviews = results.map((r, i) => {
          if (!r.ok) return null;
          const result = r.data;
          return {
            // Per-card project (filled when PM picks a project on the preview card).
            // Batch always creates a new tasklist — no per-card tasklist mode.
            projectId: null,
            projectName: null,
            projectMembers: [],
            // AI-generated content
            tasklistName: result.tasklistName,
            parentTaskName: result.parentTaskName,
            parentTaskDescription: result.parentTaskDescription ?? '',
            subtasks: result.subtasks,
            templateId: 'ai-generate',
            templateName: 'AI Generate',
            tags: [],
            clientType: validItems[i].clientType,
            assigneeId: validItems[i].assigneeId,
            failed: false,
          };
        }).filter(Boolean);
        showScreen('preview');  // must come first — autoResize needs display:block to measure scrollHeight
        renderBatchPreview();
      }
    } catch (err) {
      // AbortError means the user navigated away — don't show an error.
      if (err.name !== 'AbortError') {
        setStatus(batchStatus, `Error: ${err.message}`, true);
      }
    } finally {
      if (state.pendingGeneration === abortCtrl) state.pendingGeneration = null;
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
    return;
  }

  // ===== Standard template path =====
  // Generate the preview content here; project is picked on the next screen.
  const vars = currentFormVars();
  const notes = document.getElementById('notes').value.trim();

  // Run the AI tune pass only when the PM actually wrote notes.
  let subtasks = state.selectedTemplate.subtasks.map((name) => ({ name, description: '' }));
  let aiFallback = false;
  if (notes) {
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = 'Tuning subtasks…';
    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'tune',
          subtasks: subtasks.map((s) => s.name),
          notes,
          templateName: state.selectedTemplate.name,
          monthLabel: vars.monthLabel,
          clientType: vars.clientType,
        }),
      });
      const result = await res.json();
      if (res.ok && Array.isArray(result.subtasks) && result.subtasks.length > 0) {
        subtasks = result.subtasks.map((name) => ({ name, description: '' }));
        aiFallback = !!result.fallback;
      } else {
        aiFallback = true;
      }
    } catch {
      aiFallback = true;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }

  // Build preview without project info — filled in by continue-to-preview.
  state.preview = {
    tasklistMode: 'new', // overridden by continue-to-preview
    tasklistName: fillPattern(state.selectedTemplate.tasklistNamePattern, vars),
    existingTasklistId: null,
    existingTasklistName: null,
    parentTaskName: fillPattern(state.selectedTemplate.parentTaskNamePattern, vars),
    parentTaskDescription: '',
    subtasks,
    templateId: state.selectedTemplate.id,
    templateName: state.selectedTemplate.name,
    tags: state.selectedTemplate.defaultTags,
    notes,
    monthLabel: vars.monthLabel,
    clientType: vars.clientType,
    assigneeId: null,
    aiFallback,
  };

  showScreen('pick-project');
});

// ===== screen 3: preview =====

const previewProject = document.getElementById('preview-project');
const previewTasklist = document.getElementById('preview-tasklist');
const previewParentTask = document.getElementById('preview-parent-task');
const previewParentDesc = document.getElementById('preview-parent-desc');
const previewAssigneeRow = document.getElementById('preview-assignee-row');
const previewAssigneeSelect = document.getElementById('preview-assignee-select');
const previewSubtasks = document.getElementById('preview-subtasks');
const previewStatus = document.getElementById('preview-status');
const previewNewProjectRow = document.getElementById('preview-new-project-row');
const previewNewProject = document.getElementById('preview-new-project');
const confirmBtn = document.getElementById('confirm-create');

// AbortControllers for per-card document click listeners — cleared on each re-render.
let batchCardDocListeners = [];

function autoResize(el) {
  el.style.height = '1px';
  const cssMax = parseFloat(window.getComputedStyle(el).maxHeight) || Infinity;
  const capped = Math.min(el.scrollHeight, cssMax);
  el.style.height = `${capped}px`;
  // Once content exceeds the cap, let CSS overflow-y handle scrolling.
  // For uncapped elements keep overflow hidden so no scrollbar flash.
  el.style.overflowY = el.scrollHeight > cssMax ? 'auto' : 'hidden';
}

// ===== shared subtask list renderer =====
//
// One renderer for both the single-task preview and each batch card: editable
// name/description textareas, optional per-subtask assignee select, remove
// button, and drag-to-reorder. The two call sites previously carried near-
// identical copies of this that had already drifted.
//
// opts:
//   subtasks: () => array — live getter so event handlers see current state
//   members:  () => array — project members; empty array hides the assignee select
//   rerender: () => void  — called after structural changes (remove, drop)
function renderSubtaskList(listEl, opts) {
  listEl.innerHTML = '';
  const toResize = [];
  let dragSrc = null; // shared across this render's li listeners only
  const subtasks = opts.subtasks();
  const members = opts.members();

  subtasks.forEach((subtask, idx) => {
    const li = document.createElement('li');
    li.setAttribute('draggable', 'true');

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'subtask-body';

    const input = document.createElement('textarea');
    input.className = 'subtask-input';
    input.value = subtask.name;
    input.rows = 1;
    input.addEventListener('input', () => {
      subtask.name = input.value;
      autoResize(input);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });

    const desc = document.createElement('textarea');
    desc.className = 'subtask-desc';
    desc.value = subtask.description ?? '';
    desc.rows = 1;
    desc.placeholder = 'Description…';
    desc.addEventListener('input', () => {
      subtask.description = desc.value;
      autoResize(desc);
    });
    desc.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.title = 'Remove subtask';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      opts.subtasks().splice(idx, 1);
      opts.rerender();
    });

    li.addEventListener('dragstart', (e) => {
      dragSrc = idx;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => li.classList.add('dragging'), 0);
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      listEl.querySelectorAll('li').forEach((el) => el.classList.remove('drag-over'));
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrc !== idx) {
        listEl.querySelectorAll('li').forEach((el) => el.classList.remove('drag-over'));
        li.classList.add('drag-over');
      }
    });
    li.addEventListener('dragleave', (e) => {
      if (!li.contains(e.relatedTarget)) li.classList.remove('drag-over');
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (dragSrc === null || dragSrc === idx) return;
      const arr = opts.subtasks();
      const [moved] = arr.splice(dragSrc, 1);
      arr.splice(idx, 0, moved);
      dragSrc = null;
      opts.rerender();
    });

    body.appendChild(input);
    body.appendChild(desc);

    if (members.length > 0) {
      const assignSel = document.createElement('select');
      assignSel.className = 'subtask-assignee';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '— Unassigned —';
      assignSel.appendChild(noneOpt);
      for (const m of members) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        opt.selected = subtask.assigneeId != null && subtask.assigneeId === m.id;
        assignSel.appendChild(opt);
      }
      assignSel.addEventListener('change', () => {
        subtask.assigneeId = assignSel.value ? Number(assignSel.value) : null;
      });
      body.appendChild(assignSel);
    }

    li.appendChild(handle);
    li.appendChild(body);
    li.appendChild(remove);
    listEl.appendChild(li);
    toResize.push(input, desc);
  });

  // Resize after layout — works whether listEl was visible or detached during build.
  requestAnimationFrame(() => toResize.forEach((el) => autoResize(el)));
}

// ===== structured (Cake Task v1) preview =====

function escapeHtmlClient(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Normalise the /api/preview structured response into the editable schema shape
// held on state.preview.schema.
function buildSchemaFromResponse(data) {
  return {
    prefixes: Array.isArray(data.prefixes) ? data.prefixes : [],
    client: data.client ?? '',
    strategy: data.strategy ?? { pillar: '', stage: '', businessGoal: '' },
    work: data.work ?? { summary: '', outOfScope: '', inputsNeeded: [], assumptions: [] },
    acceptance: Array.isArray(data.acceptance) ? data.acceptance : [],
    timing: data.timing ?? { dueDate: '', estimatedHours: '', priority: 'normal', dependencies: [] },
    billing: data.billing ?? { sowReference: '', notes: '' },
    ownership: data.ownership ?? { owner: '', reviewer: '', pm: '' },
    aiContext: data.aiContext ?? { relevantSkills: [], brandGuidelines: '', confidence: '', notes: '' },
    missing: Array.isArray(data.missing) ? data.missing : [],
  };
}

const PREFIX_VOCAB = ['SEO.', 'C.', 'H.', 'G.', 'Flat Fee', 'Bank', '?.'];

function renderReviewBanner(p) {
  const b = document.getElementById('structured-review-banner');
  if (!p?.structured || !p.schema) { b.hidden = true; b.innerHTML = ''; return; }
  const conf = p.schema.aiContext?.confidence ?? '';
  const missing = p.schema.missing ?? [];
  if (!conf && missing.length === 0) { b.hidden = true; b.innerHTML = ''; return; }
  b.hidden = false;
  b.className = `review-banner conf-${conf || 'na'}`;
  let html = '';
  if (conf) html += `<div class="rb-row"><strong>AI confidence:</strong> ${escapeHtmlClient(conf)} — review before publishing.</div>`;
  if (missing.length) {
    html += `<div class="rb-row"><strong>Needs your input:</strong><ul>${missing.map((m) => `<li>${escapeHtmlClient(m)}</li>`).join('')}</ul></div>`;
  }
  b.innerHTML = html;
}

function renderStructuredFields(p) {
  const root = document.getElementById('structured-fields');
  if (!p?.structured || !p.schema) { root.hidden = true; root.innerHTML = ''; return; }
  root.hidden = false;
  root.innerHTML = '';
  const sc = p.schema;

  const section = (title) => {
    const h = document.createElement('h3');
    h.className = 'sf-section';
    h.textContent = title;
    root.appendChild(h);
  };
  const field = (labelText) => {
    const w = document.createElement('div');
    w.className = 'sf-field';
    if (labelText) {
      const l = document.createElement('label');
      l.textContent = labelText;
      w.appendChild(l);
    }
    root.appendChild(w);
    return w;
  };
  const ta = (parent, value, onInput, ph = '') => {
    const t = document.createElement('textarea');
    t.className = 'sf-input';
    t.rows = 1;
    t.value = value ?? '';
    t.placeholder = ph;
    t.addEventListener('input', () => { onInput(t.value); autoResize(t); });
    parent.appendChild(t);
    autoResize(t);
    return t;
  };
  const txt = (parent, value, onInput, ph = '', type = 'text') => {
    const i = document.createElement('input');
    i.type = type;
    i.className = 'sf-input';
    i.value = value ?? '';
    i.placeholder = ph;
    i.addEventListener('input', () => onInput(i.value));
    parent.appendChild(i);
    return i;
  };
  const sel = (parent, value, options, onChange) => {
    const s = document.createElement('select');
    s.className = 'sf-input';
    for (const [v, lbl] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = lbl;
      o.selected = value === v;
      s.appendChild(o);
    }
    s.addEventListener('change', () => onChange(s.value));
    parent.appendChild(s);
    return s;
  };
  const linesToArr = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
  const csvToArr = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);

  // ----- Prefixes (AI-detected, editable multi-select) -----
  section('Prefixes');
  const pfWrap = field('');
  pfWrap.classList.add('sf-prefixes');
  for (const pf of PREFIX_VOCAB) {
    const lab = document.createElement('label');
    lab.className = 'sf-prefix';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (sc.prefixes ?? []).includes(pf);
    cb.addEventListener('change', () => {
      const set = new Set(sc.prefixes ?? []);
      if (cb.checked) set.add(pf); else set.delete(pf);
      sc.prefixes = PREFIX_VOCAB.filter((x) => set.has(x));
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(` ${pf}`));
    pfWrap.appendChild(lab);
  }

  // ----- Strategic anchor -----
  section('Strategic anchor');
  sc.strategy = sc.strategy ?? { pillar: '', stage: '', businessGoal: '' };
  sel(field('Pillar'), sc.strategy.pillar, [
    ['', '—'], ['1', '1 · Dual-Audience Website'], ['2', '2 · Engineered Authority Signals'],
    ['3', '3 · Current and Best, Always'], ['4', '4 · AI-Powered Practice Operations'], ['internal', 'Internal'],
  ], (v) => { sc.strategy.pillar = v; });
  sel(field('Stage'), sc.strategy.stage, [
    ['', '—'], ['being_feeling', 'Being & Feeling'], ['searching', 'Searching'],
    ['visiting', 'Visiting'], ['converting', 'Converting'], ['internal', 'Internal'],
  ], (v) => { sc.strategy.stage = v; });
  ta(field('Business goal'), sc.strategy.businessGoal, (v) => { sc.strategy.businessGoal = v; }, 'One sentence, in the client’s terms…');

  // ----- Work -----
  section('Work');
  sc.work = sc.work ?? { summary: '', outOfScope: '', inputsNeeded: [], assumptions: [] };
  ta(field('Summary'), sc.work.summary, (v) => { sc.work.summary = v; });
  ta(field('Out of scope'), sc.work.outOfScope, (v) => { sc.work.outOfScope = v; });
  ta(field('Inputs needed (one per line)'), (sc.work.inputsNeeded ?? []).join('\n'), (v) => { sc.work.inputsNeeded = linesToArr(v); });
  ta(field('Assumptions (one per line)'), (sc.work.assumptions ?? []).join('\n'), (v) => { sc.work.assumptions = linesToArr(v); });

  // ----- Definition of done (acceptance criteria) -----
  section('Definition of done');
  const accWrap = field('');
  accWrap.classList.add('sf-acceptance');
  function renderAcceptance() {
    accWrap.innerHTML = '';
    sc.acceptance = sc.acceptance ?? [];
    sc.acceptance.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'sf-acc-row';
      txt(row, a.observable, (v) => { sc.acceptance[i].observable = v; }, 'Observable criterion');
      txt(row, a.quantifiable, (v) => { sc.acceptance[i].quantifiable = v; }, 'Quantifiable (optional)');
      txt(row, a.verifier, (v) => { sc.acceptance[i].verifier = v; }, 'Verifier');
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.title = 'Remove criterion';
      rm.textContent = '×';
      rm.addEventListener('click', () => { sc.acceptance.splice(i, 1); renderAcceptance(); });
      row.appendChild(rm);
      accWrap.appendChild(row);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ghost small';
    add.textContent = '+ Add criterion';
    add.addEventListener('click', () => {
      sc.acceptance.push({ observable: '', quantifiable: '', verifier: '' });
      renderAcceptance();
    });
    accWrap.appendChild(add);
  }
  renderAcceptance();

  // ----- Timing -----
  section('Timing');
  sc.timing = sc.timing ?? { dueDate: '', estimatedHours: '', priority: 'normal', dependencies: [] };
  txt(field('Due date'), sc.timing.dueDate, (v) => { sc.timing.dueDate = v; }, '', 'date');
  txt(field('Estimated hours'), sc.timing.estimatedHours, (v) => { sc.timing.estimatedHours = v; }, 'e.g. 2-3');
  sel(field('Priority'), sc.timing.priority, [
    ['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent'],
  ], (v) => { sc.timing.priority = v; });
  ta(field('Dependencies (one per line)'), (sc.timing.dependencies ?? []).join('\n'), (v) => { sc.timing.dependencies = linesToArr(v); });

  // ----- Billing -----
  section('Billing');
  sc.billing = sc.billing ?? { sowReference: '', notes: '' };
  txt(field('SoW reference'), sc.billing.sowReference, (v) => { sc.billing.sowReference = v; });
  ta(field('Notes'), sc.billing.notes, (v) => { sc.billing.notes = v; });

  // ----- Ownership -----
  section('Ownership');
  sc.ownership = sc.ownership ?? { owner: '', reviewer: '', pm: '' };
  txt(field('Owner'), sc.ownership.owner, (v) => { sc.ownership.owner = v; });
  txt(field('Reviewer'), sc.ownership.reviewer, (v) => { sc.ownership.reviewer = v; });
  txt(field('PM'), sc.ownership.pm, (v) => { sc.ownership.pm = v; });

  // ----- AI context -----
  section('AI context');
  sc.aiContext = sc.aiContext ?? { relevantSkills: [], brandGuidelines: '', confidence: '', notes: '' };
  txt(field('Relevant skills (comma-separated)'), (sc.aiContext.relevantSkills ?? []).join(', '), (v) => { sc.aiContext.relevantSkills = csvToArr(v); });
  txt(field('Brand guidelines'), sc.aiContext.brandGuidelines, (v) => { sc.aiContext.brandGuidelines = v; });
  sel(field('Confidence'), sc.aiContext.confidence, [
    ['', '—'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'],
  ], (v) => { sc.aiContext.confidence = v; });
  ta(field('Notes'), sc.aiContext.notes, (v) => { sc.aiContext.notes = v; });
}

function renderPreview() {
  setBatchPreviewVisible(false);
  const p = state.preview;
  if (p.projectMode === 'new') {
    previewNewProjectRow.hidden = false;
    const desc = p.newProject.description
      ? ` — ${p.newProject.description}`
      : '';
    previewNewProject.textContent = `${p.newProject.name}  (new)${desc}`;
    previewProject.textContent = '(will be created above)';
  } else {
    previewNewProjectRow.hidden = true;
    previewProject.textContent = `${state.selectedProject.name} #${state.selectedProject.id}`;
  }
  previewTasklist.value = p.tasklistMode === 'new' ? p.tasklistName : (p.existingTasklistName ?? '');
  previewTasklist.disabled = p.tasklistMode !== 'new';
  autoResize(previewTasklist);
  previewParentTask.value = p.parentTaskName;
  autoResize(previewParentTask);
  // In structured mode the description is composed from the schema fields below,
  // so the freeform parent-description editor is hidden to avoid two sources.
  previewParentDesc.hidden = !!p.structured;
  previewParentDesc.value = p.parentTaskDescription ?? '';
  if (!p.structured) autoResize(previewParentDesc);

  // Structured (v1) review banner + editable schema fields.
  renderReviewBanner(p);
  renderStructuredFields(p);

  // Parent task assignee row
  if (state.projectMembers.length > 0) {
    previewAssigneeRow.hidden = false;
    previewAssigneeSelect.innerHTML = '<option value="">— Unassigned —</option>';
    for (const m of state.projectMembers) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      opt.selected = p.assigneeId != null && p.assigneeId === m.id;
      previewAssigneeSelect.appendChild(opt);
    }
    previewAssigneeSelect.onchange = () => {
      state.preview.assigneeId = previewAssigneeSelect.value ? Number(previewAssigneeSelect.value) : null;
    };
  } else {
    previewAssigneeRow.hidden = true;
  }

  renderSubtaskList(previewSubtasks, {
    subtasks: () => state.preview.subtasks,
    members: () => state.projectMembers,
    rerender: () => renderPreview(),
  });

  if (state.preview.aiFallback) {
    setStatus(
      previewStatus,
      'AI rewording was unavailable — showing default subtasks. You can still edit them or use "Regenerate from description".',
      true
    );
  } else {
    setStatus(previewStatus, '');
  }

  // Add subtask button (single-task mode)
  let addSubtaskBtn = document.getElementById('add-subtask-btn');
  if (!addSubtaskBtn) {
    addSubtaskBtn = document.createElement('button');
    addSubtaskBtn.type = 'button';
    addSubtaskBtn.id = 'add-subtask-btn';
    addSubtaskBtn.className = 'ghost small';
    addSubtaskBtn.textContent = '+ Add subtask';
    previewSubtasks.after(addSubtaskBtn);
  }
  addSubtaskBtn.onclick = () => {
    state.preview.subtasks.push({ name: '', description: '' });
    renderPreview();
    const inputs = previewSubtasks.querySelectorAll('.subtask-input');
    inputs[inputs.length - 1]?.focus();
  };

  // Confirmation summary line above the actions bar
  const confirmSummary = document.getElementById('confirm-summary');
  if (confirmSummary) {
    const p = state.preview;
    const count = p.subtasks.length;
    const noun = count === 1 ? 'subtask' : 'subtasks';
    const projectName = p.projectMode === 'new'
      ? `${p.newProject.name} (new project)`
      : state.selectedProject.name;
    const tasklistName = p.tasklistMode === 'new'
      ? `${p.tasklistName} (new)`
      : p.existingTasklistName;
    confirmSummary.textContent = `${count} ${noun} → ${projectName} · ${tasklistName}`;
  }
}

// ===== batch preview =====

const batchPreviewCards = document.getElementById('batch-preview-cards');
const singlePreviewSummary = document.querySelector('#screen-preview .preview-summary');
const subtasksHeaderEl = document.querySelector('#screen-preview .subtasks-header');
const regeneratePanelContainer = document.getElementById('regenerate-panel');
const subtasksHintEl = document.getElementById('subtasks-hint');

function setBatchPreviewVisible(isBatch) {
  batchPreviewCards.hidden = !isBatch;
  if (singlePreviewSummary) singlePreviewSummary.hidden = isBatch;
  if (subtasksHeaderEl) subtasksHeaderEl.hidden = isBatch;
  if (regeneratePanelContainer) regeneratePanelContainer.hidden = true;
  if (subtasksHintEl) subtasksHintEl.hidden = isBatch;
  previewSubtasks.hidden = isBatch;
  const addStBtn = document.getElementById('add-subtask-btn');
  if (addStBtn) addStBtn.hidden = isBatch;
  document.getElementById('confirm-create').textContent = isBatch ? 'Confirm & create all' : 'Confirm & create';
  const toggleBtn = document.getElementById('toggle-regenerate');
  if (toggleBtn) toggleBtn.hidden = isBatch;
}

function updateBatchConfirmSummary() {
  const confirmSummary = document.getElementById('confirm-summary');
  if (!confirmSummary) return;
  const total = state.batchPreviews.reduce((n, p) => n + p.subtasks.length, 0);
  const unassigned = state.batchPreviews.filter((p) => !p.projectId).length;
  let text = `${state.batchPreviews.length} task${state.batchPreviews.length === 1 ? '' : 's'} · ${total} subtask${total === 1 ? '' : 's'}`;
  if (unassigned > 0) text += ` · ⚠ ${unassigned} need a project`;
  confirmSummary.textContent = text;
}

function renderBatchPreview() {
  // Abort all document click listeners from the previous render before rebuilding.
  batchCardDocListeners.forEach(ctrl => ctrl.abort());
  batchCardDocListeners = [];
  setBatchPreviewVisible(true);
  batchPreviewCards.innerHTML = '';

  state.batchPreviews.forEach((p, cardIdx) => {
    const card = document.createElement('div');
    card.className = 'batch-preview-card';
    card.dataset.cardIndex = cardIdx;

    // ----- Header -----
    const header = document.createElement('div');
    header.className = 'batch-preview-card-header';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'batch-card-toggle ghost small';
    toggleBtn.setAttribute('aria-expanded', 'true');

    const titleSpan = document.createElement('span');
    titleSpan.className = 'batch-card-title';
    titleSpan.textContent = p.tasklistName;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'ghost small batch-card-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      state.batchPreviews.splice(cardIdx, 1);
      renderBatchPreview();
    });

    header.appendChild(toggleBtn);
    header.appendChild(titleSpan);
    header.appendChild(removeBtn);

    // ----- Body -----
    const body = document.createElement('div');
    body.className = 'batch-preview-card-body';

    // ----- Per-card project picker -----
    const projectRow = document.createElement('div');
    projectRow.className = 'preview-row batch-card-project-row';
    const projectLabel = document.createElement('span');
    projectLabel.className = 'preview-label';
    projectLabel.textContent = 'Project';

    const projectPicker = document.createElement('div');
    projectPicker.className = 'batch-card-project-picker';

    // Display when a project is already selected
    const projectSelectedEl = document.createElement('div');
    projectSelectedEl.className = 'batch-card-project-selected';
    projectSelectedEl.hidden = !p.projectId;

    // Search UI (shown when no project selected)
    const projectSearchWrap = document.createElement('div');
    projectSearchWrap.className = 'batch-card-project-search';
    projectSearchWrap.hidden = !!p.projectId;

    const projectSearchInput = document.createElement('input');
    projectSearchInput.type = 'search';
    projectSearchInput.placeholder = 'Search projects…';
    projectSearchInput.className = 'batch-card-project-search-input';

    const projectSearchStatus = document.createElement('div');
    projectSearchStatus.className = 'status';
    projectSearchStatus.setAttribute('aria-live', 'polite');

    const projectSearchResults = document.createElement('ul');
    projectSearchResults.className = 'results batch-card-project-results';
    projectSearchResults.setAttribute('role', 'listbox');

    projectSearchWrap.appendChild(projectSearchInput);
    projectSearchWrap.appendChild(projectSearchStatus);
    projectSearchWrap.appendChild(projectSearchResults);

    let cardDebounce = null;
    let cardReqId = 0;

    async function searchCardProjects(term) {
      const reqId = ++cardReqId;
      setStatus(projectSearchStatus, term ? `Searching for "${term}"…` : 'Loading…');
      const url = new URL('/api/projects', window.location.origin);
      if (term) url.searchParams.set('search', term);
      try {
        const res = await fetch(url);
        if (reqId !== cardReqId) return;
        if (!res.ok) { setStatus(projectSearchStatus, `Error: ${res.statusText}`, true); return; }
        const { projects } = await res.json();
        projectSearchResults.innerHTML = '';
        for (const proj of projects) {
          const li = document.createElement('li');
          li.tabIndex = 0;
          li.setAttribute('role', 'option');
          li.innerHTML = '<span class="project-name"></span><span class="project-id"></span>';
          li.querySelector('.project-name').textContent = proj.name;
          li.querySelector('.project-id').textContent = `#${proj.id}`;
          li.addEventListener('click', () => pickCardProject(proj));
          li.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pickCardProject(proj); }
          });
          projectSearchResults.appendChild(li);
        }
        setStatus(projectSearchStatus, projects.length === 0 ? 'No projects matched.' : '');
      } catch (err) {
        if (reqId !== cardReqId) return;
        setStatus(projectSearchStatus, `Network error: ${err.message}`, true);
      }
    }

    projectSearchInput.addEventListener('input', (ev) => {
      clearTimeout(cardDebounce);
      cardDebounce = setTimeout(() => searchCardProjects(ev.target.value.trim()), 200);
    });
    projectSearchInput.addEventListener('focus', () => {
      if (!projectSearchResults.children.length) searchCardProjects('');
    });

    function renderProjectSelectedEl() {
      projectSelectedEl.innerHTML = '';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'project-name';
      nameSpan.textContent = p.projectName;
      const changeBtn = document.createElement('button');
      changeBtn.type = 'button';
      changeBtn.className = 'ghost small';
      changeBtn.textContent = 'Change';
      changeBtn.addEventListener('click', () => {
        p.projectId = null;
        p.projectName = null;
        p.projectMembers = [];
        p.assigneeId = null;
        projectSelectedEl.hidden = true;
        projectSearchWrap.hidden = false;
        projectSearchInput.value = '';
        projectSearchResults.innerHTML = '';
        setStatus(projectSearchStatus, '');
        refreshCardAssignee();
        renderCardSubtasks();
        updateBatchConfirmSummary();
      });
      projectSelectedEl.appendChild(nameSpan);
      projectSelectedEl.appendChild(changeBtn);
    }
    if (p.projectId) renderProjectSelectedEl();

    async function pickCardProject(proj) {
      p.projectId = proj.id;
      p.projectName = proj.name;
      p.projectMembers = [];
      p.assigneeId = null;
      renderProjectSelectedEl();
      projectSelectedEl.hidden = false;
      projectSearchWrap.hidden = true;
      setStatus(projectSearchStatus, '');
      try {
        const res = await fetch(`/api/projects/${proj.id}/members`);
        if (res.ok) {
          const { members } = await res.json();
          // Stale-response guard: the PM may have hit "Change" and picked a
          // different project while this fetch was in flight.
          if (p.projectId === proj.id) {
            p.projectMembers = members;
            refreshCardAssignee();
            renderCardSubtasks();
          }
        }
      } catch { /* members stay empty */ }
      updateBatchConfirmSummary();
    }

    // Close dropdown when clicking outside the search wrap.
    // Use an AbortController so the listener is cleaned up when renderBatchPreview
    // rebuilds the cards — avoids unbounded listener accumulation on document.
    function onDocClickCard(e) {
      if (!projectSearchWrap.contains(e.target)) {
        projectSearchResults.innerHTML = '';
        setStatus(projectSearchStatus, '');
      }
    }
    const docListenerCtrl = new AbortController();
    batchCardDocListeners.push(docListenerCtrl);
    document.addEventListener('click', onDocClickCard, { signal: docListenerCtrl.signal });

    projectPicker.appendChild(projectSelectedEl);
    projectPicker.appendChild(projectSearchWrap);
    projectRow.appendChild(projectLabel);
    projectRow.appendChild(projectPicker);

    // ----- Tasklist name -----
    const tlRow = document.createElement('div');
    tlRow.className = 'preview-row';
    const tlLabel = document.createElement('span');
    tlLabel.className = 'preview-label';
    tlLabel.textContent = 'Tasklist';
    const tlInput = document.createElement('textarea');
    tlInput.className = 'inline-edit';
    tlInput.rows = 1;
    tlInput.value = p.tasklistName;
    tlInput.addEventListener('input', () => {
      state.batchPreviews[cardIdx].tasklistName = tlInput.value;
      titleSpan.textContent = tlInput.value || `Task ${cardIdx + 1}`;
      autoResize(tlInput);
    });
    tlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    tlRow.appendChild(tlLabel);
    tlRow.appendChild(tlInput);

    // ----- Parent task -----
    const ptRow = document.createElement('div');
    ptRow.className = 'preview-row preview-row--top';
    const ptLabel = document.createElement('span');
    ptLabel.className = 'preview-label';
    ptLabel.textContent = 'Parent task';
    const ptStack = document.createElement('div');
    ptStack.className = 'inline-stack';
    const ptInput = document.createElement('textarea');
    ptInput.className = 'inline-edit';
    ptInput.rows = 1;
    ptInput.value = p.parentTaskName;
    ptInput.addEventListener('input', () => {
      state.batchPreviews[cardIdx].parentTaskName = ptInput.value;
      autoResize(ptInput);
    });
    ptInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    const pdInput = document.createElement('textarea');
    pdInput.className = 'inline-edit inline-edit--desc';
    pdInput.rows = 1;
    pdInput.placeholder = 'Description…';
    pdInput.value = p.parentTaskDescription ?? '';
    pdInput.addEventListener('input', () => {
      state.batchPreviews[cardIdx].parentTaskDescription = pdInput.value;
      autoResize(pdInput);
    });
    ptStack.appendChild(ptInput);
    ptStack.appendChild(pdInput);
    ptRow.appendChild(ptLabel);
    ptRow.appendChild(ptStack);

    // ----- Assignee row (shown after members load) -----
    const asRow = document.createElement('div');
    asRow.className = 'preview-row';
    asRow.hidden = true;
    const asLabel = document.createElement('span');
    asLabel.className = 'preview-label';
    asLabel.textContent = 'Assignee';
    const asSel = document.createElement('select');
    asSel.className = 'preview-assignee-select';
    asSel.innerHTML = '<option value="">— Unassigned —</option>';
    asSel.addEventListener('change', () => {
      state.batchPreviews[cardIdx].assigneeId = asSel.value ? Number(asSel.value) : null;
    });
    asRow.appendChild(asLabel);
    asRow.appendChild(asSel);

    function refreshCardAssignee() {
      if (p.projectMembers.length > 0) {
        asSel.innerHTML = '<option value="">— Unassigned —</option>';
        for (const m of p.projectMembers) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          opt.selected = p.assigneeId != null && p.assigneeId === m.id;
          asSel.appendChild(opt);
        }
        asRow.hidden = false;
      } else {
        asRow.hidden = true;
      }
    }
    refreshCardAssignee();

    // ----- Subtasks -----
    const stHeader = document.createElement('div');
    stHeader.className = 'subtasks-header';
    const stTitle = document.createElement('h2');
    stTitle.className = 'section-label';
    stTitle.textContent = 'Subtasks';
    stHeader.appendChild(stTitle);

    const subtaskList = document.createElement('ol');
    subtaskList.className = 'subtasks';

    function renderCardSubtasks() {
      renderSubtaskList(subtaskList, {
        subtasks: () => state.batchPreviews[cardIdx].subtasks,
        members: () => p.projectMembers,
        rerender: renderCardSubtasks,
      });
    }
    renderCardSubtasks();

    const addStBtn = document.createElement('button');
    addStBtn.type = 'button';
    addStBtn.className = 'ghost small';
    addStBtn.textContent = '+ Add subtask';
    addStBtn.addEventListener('click', () => {
      state.batchPreviews[cardIdx].subtasks.push({ name: '', description: '' });
      renderCardSubtasks();
      const inputs = subtaskList.querySelectorAll('.subtask-input');
      inputs[inputs.length - 1]?.focus();
    });

    body.appendChild(projectRow);
    body.appendChild(tlRow);
    body.appendChild(ptRow);
    body.appendChild(asRow);
    body.appendChild(stHeader);
    body.appendChild(document.createRange().createContextualFragment('<p class="hint">Click to edit · clear to remove.</p>'));
    body.appendChild(subtaskList);
    body.appendChild(addStBtn);

    toggleBtn.addEventListener('click', () => {
      const isOpen = body.hidden;
      body.hidden = !isOpen;
      toggleBtn.setAttribute('aria-expanded', String(isOpen));
    });

    card.appendChild(header);
    card.appendChild(body);
    batchPreviewCards.appendChild(card);

    requestAnimationFrame(() => {
      autoResize(tlInput);
      autoResize(ptInput);
      autoResize(pdInput);
    });
  });

  updateBatchConfirmSummary();
}

async function confirmBatchCreate() {
  const confirmBtn = document.getElementById('confirm-create');
  const previewStatusEl = document.getElementById('preview-status');
  const confirmSummary = document.getElementById('confirm-summary');

  // Validate each card: needs a project, a parent task name, and at least one subtask.
  for (let i = 0; i < state.batchPreviews.length; i++) {
    const p = state.batchPreviews[i];
    if (!p.projectId) {
      setStatus(previewStatusEl, `Task ${i + 1}: select a project before creating.`, true);
      return;
    }
    p.subtasks = p.subtasks
      .map((s) => ({ name: s.name.trim(), description: (s.description ?? '').trim() }))
      .filter((s) => s.name);
    if (!p.parentTaskName.trim()) {
      setStatus(previewStatusEl, `Task ${i + 1}: parent task name cannot be empty.`, true);
      return;
    }
    if (p.subtasks.length === 0) {
      setStatus(previewStatusEl, `Task ${i + 1}: add at least one subtask before creating.`, true);
      return;
    }
  }

  confirmBtn.disabled = true;
  const results = [];

  // Create each task in sequence (Teamwork rejects parallel writes from the same token).
  for (let i = 0; i < state.batchPreviews.length; i++) {
    const p = state.batchPreviews[i];
    setStatus(previewStatusEl, `Creating task ${i + 1} of ${state.batchPreviews.length}…`);
    if (confirmSummary) confirmSummary.textContent = `Creating task ${i + 1} of ${state.batchPreviews.length}…`;

    const payload = {
      tasklistMode: 'new',        // batch mode always creates new tasklists
      projectId: p.projectId,
      tasklistName: p.tasklistName,
      parentTaskName: p.parentTaskName.trim(),
      parentTaskDescription: (p.parentTaskDescription ?? '').trim(),
      subtasks: p.subtasks,
      tags: p.tags ?? [],
    };
    if (p.assigneeId) payload.assigneeId = p.assigneeId;

    try {
      const res = await fetch('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      results.push({ ok: res.ok, result, payload, tasklistName: p.tasklistName, projectName: p.projectName });
    } catch (err) {
      results.push({ ok: false, result: { error: err.message }, payload, tasklistName: p.tasklistName, projectName: p.projectName });
    }
  }

  state.lastBatchResults = results;
  state.lastSingleAttempt = null;
  renderBatchSuccess(results);
  showScreen('success');
  clearDraft(); // the work is published — drop the crash-recovery draft
  // Re-enable for the next run — "Build another" reuses this same button.
  confirmBtn.disabled = false;
}

previewParentTask.addEventListener('input', () => {
  state.preview.parentTaskName = previewParentTask.value;
  autoResize(previewParentTask);
});
previewParentTask.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

previewParentDesc.addEventListener('input', () => {
  if (state.preview) state.preview.parentTaskDescription = previewParentDesc.value;
  autoResize(previewParentDesc);
});

previewTasklist.addEventListener('input', () => {
  if (state.preview) state.preview.tasklistName = previewTasklist.value;
  autoResize(previewTasklist);
});
previewTasklist.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

// ===== regenerate-from-description (AI generate mode) =====

const toggleRegenerateBtn = document.getElementById('toggle-regenerate');
const regeneratePanel = document.getElementById('regenerate-panel');
const regenerateDesc = document.getElementById('regenerate-description');
const regenerateSubmit = document.getElementById('regenerate-submit');
const regenerateCancel = document.getElementById('regenerate-cancel');
const regenerateStatus = document.getElementById('regenerate-status');

function setRegeneratePanelOpen(open) {
  regeneratePanel.hidden = !open;
  toggleRegenerateBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    setStatus(regenerateStatus, '');
    regenerateDesc.focus();
  }
}

toggleRegenerateBtn.addEventListener('click', () => {
  setRegeneratePanelOpen(regeneratePanel.hidden);
});

regenerateCancel.addEventListener('click', () => {
  setRegeneratePanelOpen(false);
});

regenerateSubmit.addEventListener('click', async () => {
  const description = regenerateDesc.value.trim();
  if (!description) {
    setStatus(regenerateStatus, 'Add a short description first.', true);
    return;
  }
  regenerateSubmit.disabled = true;
  regenerateCancel.disabled = true;
  setStatus(regenerateStatus, 'Generating subtasks…');
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'generate',
        description,
        projectName: state.selectedProject?.name ?? state.newProjectDraft?.name,
        monthLabel: state.preview.monthLabel,
        clientType: state.preview.clientType,
      }),
    });
    const result = await res.json();
    if (!res.ok || !Array.isArray(result.subtasks) || result.subtasks.length === 0) {
      setStatus(regenerateStatus, `Error: ${result.error || res.statusText}`, true);
      return;
    }
    state.preview.subtasks = result.subtasks.map((name) => ({ name, description: '' }));
    state.preview.aiFallback = false;
    renderPreview();
    setRegeneratePanelOpen(false);
    regenerateDesc.value = '';
  } catch (err) {
    setStatus(regenerateStatus, `Network error: ${err.message}`, true);
  } finally {
    regenerateSubmit.disabled = false;
    regenerateCancel.disabled = false;
  }
});

document.getElementById('back-to-form').addEventListener('click', () => {
  // Cancel any in-flight generation so it doesn't re-enable/disable the button
  // after the user has already navigated away.
  if (state.pendingGeneration) {
    state.pendingGeneration.abort();
    state.pendingGeneration = null;
  }
  // Clean up any batch-card document listeners from the batch preview screen.
  batchCardDocListeners.forEach(ctrl => ctrl.abort());
  batchCardDocListeners = [];
  // Defensively restore button + clear status in case we're going back mid-generate.
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = false;
  setStatus(batchStatus, '');

  // Batch mode skips pick-project, so go back to configure.
  // Single / template mode goes back to pick-project (project already set).
  if (state.isBatchMode || !state.selectedProject) {
    const isAi = form.querySelector('input[name="taskMode"][value="ai-generate"]')?.checked ?? false;
    state.isBatchMode = isAi;
    showScreen('form');
  } else {
    showScreen('pick-project');
  }
});

confirmBtn.addEventListener('click', async () => {
  if (state.isBatchMode) { confirmBatchCreate(); return; }
  const p = state.preview;
  // Trim and re-validate — subtask names required, descriptions optional
  p.subtasks = p.subtasks
    .map((s) => ({ name: s.name.trim(), description: (s.description ?? '').trim() }))
    .filter((s) => s.name);
  if (p.subtasks.length === 0) {
    setStatus(previewStatus, 'Add at least one subtask before creating.', true);
    return;
  }
  if (!p.parentTaskName.trim()) {
    setStatus(previewStatus, 'Parent task name cannot be empty.', true);
    return;
  }

  confirmBtn.disabled = true;

  // Step A — create the project, if this is "new project" mode.
  // Done as a separate request so the existing /api/create flow stays
  // untouched. If project creation fails, nothing downstream happens.
  let createdProject = null;
  if (p.projectMode === 'new') {
    setStatus(previewStatus, `Creating project "${p.newProject.name}"…`);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p.newProject),
      });
      const result = await res.json();
      if (!res.ok) {
        setStatus(previewStatus, `Error creating project: ${result.error || res.statusText}`, true);
        confirmBtn.disabled = false;
        return;
      }
      createdProject = result; // { id, name, url }
      state.selectedProject = { id: result.id, name: result.name };
    } catch (err) {
      setStatus(previewStatus, `Network error creating project: ${err.message}`, true);
      confirmBtn.disabled = false;
      return;
    }
  }

  // Step B — create tasklist + parent task + subtasks (existing flow, unchanged).
  setStatus(previewStatus, 'Creating tasklist, parent task, and subtasks…');

  const payload = {
    tasklistMode: p.tasklistMode,
    parentTaskName: p.parentTaskName.trim(),
    parentTaskDescription: (p.parentTaskDescription ?? '').trim(),
    subtasks: p.subtasks,
    tags: p.tags,
  };
  if (p.assigneeId) payload.assigneeId = p.assigneeId;
  // Structured mode: hand the full v1 schema to the server, which composes the
  // task description (human rendering + acceptance checklist + YAML) and maps
  // timing onto native Teamwork fields.
  if (p.structured && p.schema) payload.schema = p.schema;
  if (p.tasklistMode === 'new') {
    payload.projectId = state.selectedProject.id;
    payload.tasklistName = p.tasklistName;
  } else {
    payload.tasklistId = p.existingTasklistId;
  }

  try {
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (!res.ok) {
      const projectNote = createdProject
        ? ` (project "${createdProject.name}" was created — open it: ${createdProject.url})`
        : '';
      setStatus(previewStatus, `Error: ${result.error || res.statusText}${projectNote}`, true);
      confirmBtn.disabled = false;
      return;
    }
    state.lastSingleAttempt = { payload, result, createdProject };
    state.lastBatchResults = null;
    renderSuccess(result, createdProject);
    showScreen('success');
    clearDraft(); // the work is published — drop the crash-recovery draft
    // Re-enable for the next run — "Build another" reuses this same button.
    confirmBtn.disabled = false;
  } catch (err) {
    setStatus(previewStatus, `Network error: ${err.message}`, true);
    confirmBtn.disabled = false;
  }
});

// ===== screen 4: success =====

const successSummary = document.getElementById('success-summary');
const successPartial = document.getElementById('success-partial');
const successLink = document.getElementById('success-link');
const successProjectLink = document.getElementById('success-project-link');
const successLinks = document.getElementById('success-links');
const retryFailedBtn = document.getElementById('retry-failed');

function renderSuccess(result, createdProject) {
  retryFailedBtn.hidden = !result.partial;
  successLinks.innerHTML = ''; // batch-only list — clear any leftovers
  const subtaskCount = result.subtaskIds?.length ?? 0;
  const prefix = createdProject
    ? `Created project “${createdProject.name}”, plus 1 parent task and ${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}.`
    : `Created 1 parent task and ${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'} in “${state.selectedProject.name}”.`;
  successSummary.textContent = prefix;
  const notes = [];
  if (result.partial) {
    const lines = result.errors.map((e) => `• ${e.subtask}: ${e.error}`).join('\n');
    notes.push(`Some subtasks failed:\n${lines}`);
  }
  if (result.warnings?.length) {
    notes.push(`Warnings:\n${result.warnings.map((w) => `• ${w}`).join('\n')}`);
  }
  successPartial.textContent = notes.join('\n\n');
  successLink.href = result.tasklistUrl;
  successLink.textContent = 'Open tasklist in Teamwork ↗'; // reset after batch render
  successLink.hidden = false;
  if (createdProject?.url) {
    successProjectLink.href = createdProject.url;
    successProjectLink.hidden = false;
  } else {
    successProjectLink.hidden = true;
  }
}

function renderBatchSuccess(results) {
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  const totalSubtasks = succeeded.reduce((n, r) => n + (r.result.subtaskIds?.length ?? 0), 0);
  let summary = `Created ${succeeded.length} of ${results.length} task${results.length === 1 ? '' : 's'}`;
  if (totalSubtasks > 0) summary += ` (${totalSubtasks} subtask${totalSubtasks === 1 ? '' : 's'} total)`;

  // Show unique project names in summary
  const projectNames = [...new Set(succeeded.map((r) => r.projectName).filter(Boolean))];
  if (projectNames.length === 1) summary += ` in "${projectNames[0]}"`;
  else if (projectNames.length > 1) summary += ` across ${projectNames.length} projects`;
  summary += '.';
  successSummary.textContent = summary;

  // Surface every degraded outcome — fully failed tasks, partially created
  // tasks (some subtasks failed), and warnings (e.g. assignment failures).
  // A 200 with partial:true must never read as a clean success.
  const notes = [];
  if (failed.length > 0) {
    notes.push(`Failed tasks:\n${failed.map((r) => `• ${r.tasklistName}: ${r.result.error}`).join('\n')}`);
  }
  const partials = succeeded.filter((r) => r.result.partial);
  if (partials.length > 0) {
    notes.push(`Tasks with failed subtasks:\n${partials
      .map((r) => `• ${r.tasklistName}: ${r.result.errors.map((e) => `${e.subtask} (${e.error})`).join('; ')}`)
      .join('\n')}`);
  }
  const warned = succeeded.filter((r) => r.result.warnings?.length);
  if (warned.length > 0) {
    notes.push(`Warnings:\n${warned
      .flatMap((r) => r.result.warnings.map((w) => `• ${r.tasklistName}: ${w}`))
      .join('\n')}`);
  }
  successPartial.textContent = notes.join('\n\n');

  retryFailedBtn.hidden = failed.length === 0 && partials.length === 0;

  // One link per created tasklist — a batch can span several projects, and
  // linking only the last one forces the PM to hunt for the rest.
  successLinks.innerHTML = '';
  const linked = succeeded.filter((r) => r.result?.tasklistUrl);
  if (linked.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'success-links-list';
    for (const r of linked) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = r.result.tasklistUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = r.tasklistName || 'Open tasklist';
      li.appendChild(a);
      ul.appendChild(li);
    }
    successLinks.appendChild(ul);
  }
  successLink.hidden = true; // per-task links above replace the single link
  successProjectLink.hidden = true; // no single project link in multi-project batch
}

// ===== retry failed creates =====
//
// Re-runs only what failed, resuming past the steps that succeeded so a retry
// can never duplicate an already-created tasklist, parent task, or subtask.
// (Exception: a network error that dropped the response leaves us blind to
// what was created — that retry is a plain re-run.)

// `result` is either a 200 body (possibly partial) or an error body whose
// partial progress lives under `.created`.
function buildRetryPayload(payload, result) {
  const created = result?.created ?? result ?? {};
  const resume = {};
  if (typeof created.tasklistId === 'number') resume.tasklistId = created.tasklistId;
  if (typeof created.parentTaskId === 'number') resume.parentTaskId = created.parentTaskId;

  const retry = { ...payload };
  if (resume.tasklistId !== undefined || resume.parentTaskId !== undefined) retry.resume = resume;
  if (resume.parentTaskId !== undefined) {
    // Parent task exists — only re-create the subtasks that failed.
    const failedNames = new Set((created.errors ?? []).map((e) => e.subtask));
    retry.subtasks = payload.subtasks.filter((s) => failedNames.has(typeof s === 'string' ? s : s.name));
    if (retry.subtasks.length === 0) return null; // nothing actionable
  }
  return retry;
}

function mergeCreateResults(prev, next) {
  return {
    ...prev,
    ...next,
    tasklistId: next.tasklistId ?? prev.tasklistId ?? null,
    tasklistUrl: next.tasklistUrl ?? prev.tasklistUrl ?? null,
    parentTaskId: next.parentTaskId ?? prev.parentTaskId ?? null,
    subtaskIds: [...(prev.subtaskIds ?? []), ...(next.subtaskIds ?? [])],
    errors: next.errors ?? [],
    partial: !!next.partial,
    warnings: [...(prev.warnings ?? []), ...(next.warnings ?? [])],
    success: !next.partial,
  };
}

async function retryCreate(payload, prevResult) {
  const retryPayload = buildRetryPayload(payload, prevResult);
  if (!retryPayload) return null;
  const res = await fetch('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(retryPayload),
  });
  return { ok: res.ok, body: await res.json() };
}

retryFailedBtn.addEventListener('click', async () => {
  retryFailedBtn.disabled = true;
  retryFailedBtn.textContent = 'Retrying…';
  try {
    if (state.lastBatchResults) {
      // Sequential — Teamwork rejects parallel writes from the same token.
      for (const r of state.lastBatchResults) {
        if (r.ok && !r.result.partial) continue;
        try {
          const attempt = await retryCreate(r.payload, r.result);
          if (!attempt) continue;
          if (attempt.ok) {
            // Merge onto prior progress (a failed attempt's progress is under .created).
            r.result = mergeCreateResults(r.ok ? r.result : (r.result.created ?? {}), attempt.body);
            r.ok = true;
          } else {
            r.result = attempt.body; // latest error, with .created progress for the next retry
          }
        } catch (err) {
          r.result = { ...r.result, error: err.message };
        }
      }
      renderBatchSuccess(state.lastBatchResults);
    } else if (state.lastSingleAttempt) {
      const a = state.lastSingleAttempt;
      try {
        const attempt = await retryCreate(a.payload, a.result);
        if (attempt?.ok) a.result = mergeCreateResults(a.result, attempt.body);
      } catch { /* keep previous result — the button stays visible */ }
      renderSuccess(a.result, a.createdProject);
    }
  } finally {
    retryFailedBtn.disabled = false;
    retryFailedBtn.textContent = 'Retry failed';
  }
});

document.getElementById('start-over').addEventListener('click', () => {
  batchCardDocListeners.forEach(ctrl => ctrl.abort());
  batchCardDocListeners = [];
  state.preview = null;
  state.batchPreviews = [];
  state.batchItems = [];
  state.isBatchMode = false;
  state.newProjectDraft = null;
  state.selectedProject = null;
  state.projectMembers = [];
  state.existingTasklists = [];
  document.getElementById('notes').value = '';
  newProjectNameInput.value = '';
  newProjectDescInput.value = '';
  regenerateDesc.value = '';
  searchInput.value = '';
  setRegeneratePanelOpen(false);
  state.selectedTemplate = TEMPLATES[0];
  if (aiGeneratePrompt) aiGeneratePrompt.value = '';
  setStatus(aiGenerateStatus, '');
  setStatus(batchStatus, '');
  assigneeSelect.innerHTML = '<option value="">— Unassigned —</option>';
  assigneeSelect.disabled = true;
  assigneeHint.textContent = '';
  setStatus(pickProjectStatus, '');
  setStatus(previewStatus, '');
  successLinks.innerHTML = '';
  state.lastBatchResults = null;
  state.lastSingleAttempt = null;
  retryFailedBtn.hidden = true;
  clearDraft();
  // Belt-and-braces: the confirm flows re-enable on completion, but a stale
  // disabled state here would dead-end every subsequent run.
  confirmBtn.disabled = false;
  projectSelectedPanel.hidden = true;
  setBatchPreviewVisible(false);
  batchPreviewCards.innerHTML = '';
  const taskModeRadio = form.querySelector('input[name="taskMode"][value="ai-generate"]');
  if (taskModeRadio) taskModeRadio.checked = true;
  const firstTemplateRadio = form.querySelector('input[name="template"][value="email-campaign"]');
  if (firstTemplateRadio) firstTemplateRadio.checked = true;
  const quickStructureRadio = form.querySelector('input[name="taskStructure"][value="quick"]');
  if (quickStructureRadio) quickStructureRadio.checked = true;
  setTaskStructure(false);
  setAiGenerateMode(true);
  setProjectMode('existing');
  showScreen('form');
});

// ===== shared helpers =====

function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.toggle('working', !isError && !!text);
}

// ===== draft persistence (crash / refresh recovery) =====
//
// Generated previews cost real AI spend and PM editing time — a reflexive ⌘R
// must not destroy them. The serialisable slice of `state` is saved to
// sessionStorage (per-tab, gone when the tab closes) on navigation and on a
// debounce after edits, restored at boot, and cleared on publish/start-over.

const DRAFT_KEY = 'taskBuilderDraft.v1';
let draftReady = false; // saves are no-ops until the boot restore has run

function draftHasWork() {
  return !!(
    state.preview ||
    state.batchPreviews.length > 0 ||
    state.batchItems.some((i) => i.description?.trim())
  );
}

function saveDraft() {
  if (!draftReady) return;
  try {
    if (!draftHasWork()) {
      sessionStorage.removeItem(DRAFT_KEY);
      return;
    }
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      v: 1,
      screen: document.querySelector('.screen[data-active="true"]')?.id?.replace('screen-', '') ?? 'form',
      projectMode: state.projectMode,
      selectedProject: state.selectedProject,
      newProjectDraft: state.newProjectDraft,
      existingTasklists: state.existingTasklists,
      projectMembers: state.projectMembers,
      preview: state.preview,
      batchItems: state.batchItems,
      batchPreviews: state.batchPreviews,
      isBatchMode: state.isBatchMode,
      taskStructure: state.taskStructure,
    }));
  } catch { /* quota exceeded / private mode — drafts are best-effort */ }
}

function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* best-effort */ }
}

let draftSaveTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraft, 400);
}
document.addEventListener('input', scheduleDraftSave);
document.addEventListener('change', scheduleDraftSave);

// Returns true if a draft was restored (and a screen rendered).
function restoreDraft() {
  let draft = null;
  try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null'); } catch { /* corrupt */ }
  if (!draft || draft.v !== 1) return false;
  const hasWork = draft.preview || draft.batchPreviews?.length > 0 ||
    draft.batchItems?.some((i) => i.description?.trim());
  if (!hasWork) return false;

  Object.assign(state, {
    projectMode: draft.projectMode ?? 'existing',
    selectedProject: draft.selectedProject ?? null,
    newProjectDraft: draft.newProjectDraft ?? null,
    existingTasklists: draft.existingTasklists ?? [],
    projectMembers: draft.projectMembers ?? [],
    preview: draft.preview ?? null,
    batchItems: draft.batchItems ?? [],
    batchPreviews: draft.batchPreviews ?? [],
    isBatchMode: !!draft.isBatchMode,
    taskStructure: draft.taskStructure ?? 'quick',
  });

  // Sync the form controls that drive mode logic.
  const structRadio = form.querySelector(`input[name="taskStructure"][value="${state.taskStructure}"]`);
  if (structRadio) structRadio.checked = true;
  if (state.isBatchMode) {
    const aiRadio = form.querySelector('input[name="taskMode"][value="ai-generate"]');
    if (aiRadio) aiRadio.checked = true;
  }

  const restoredNote = 'Restored your unsaved draft from this session.';

  if (draft.screen === 'preview' && state.batchPreviews.length > 0) {
    state.isBatchMode = true;
    showScreen('preview');
    renderBatchPreview();
    setStatus(previewStatus, restoredNote);
    return true;
  }
  if (draft.screen === 'preview' && state.preview?.projectMode) {
    showScreen('preview');
    renderPreview();
    setStatus(previewStatus, restoredNote);
    return true;
  }
  if (draft.screen === 'pick-project' && state.preview) {
    if (state.projectMode === 'existing' && state.selectedProject?.id) {
      // Re-runs the tasklist/member fetches so the picker shows fresh data.
      selectProject(state.selectedProject);
    } else if (state.projectMode === 'new' && state.newProjectDraft) {
      setProjectMode('new');
      newProjectNameInput.value = state.newProjectDraft.name ?? '';
      newProjectDescInput.value = state.newProjectDraft.description ?? '';
    }
    showScreen('pick-project');
    return true;
  }

  // Default: back to the configure form with batch items intact.
  setTaskStructure(state.taskStructure === 'structured');
  showScreen('form');
  if (state.isBatchMode) setStatus(batchStatus, restoredNote);
  return true;
}

// ===== boot =====

updateTasklistPreview();
setAiGenerateMode(true);
// Restore a crash-recovery draft if one exists; otherwise start on configure.
if (!restoreDraft()) showScreen('form');
draftReady = true;
