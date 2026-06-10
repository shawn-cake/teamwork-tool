# Cake Task Builder

> **Internal prototype** — built for Cake's internal team only. Not intended for external use or distribution.

Internal tool for Cake agency project managers to create Teamwork tasks from client emails or descriptions. PMs paste a client email (or write their own description), the AI generates a tasklist with a parent task and subtasks, and the PM reviews/edits before publishing directly to Teamwork.

## Stack

- **Runtime**: Cloudflare Workers (via Wrangler)
- **Frontend**: Vanilla JS, single-page state machine — no framework, no build step
- **AI**: Anthropic Claude (Haiku) via `@anthropic-ai/sdk` — runs server-side in the Worker
- **Project management**: Teamwork API (v1 for tasklists, v3 for tasks)

## Local dev

```bash
npm run dev    # starts wrangler dev server at localhost:8787
npm run deploy # deploys to Cloudflare
```

Secrets live in `.dev.vars` (gitignored). Copy `.dev.vars.example` and fill in:

```
ANTHROPIC_API_KEY=...
TEAMWORK_API_TOKEN=...
```

`TEAMWORK_DOMAIN` is set in `wrangler.jsonc` vars (not a secret).

## Key files

| File | Purpose |
|------|---------|
| `public/index.html` | 4-screen UI: configure → pick project → preview → success |
| `public/app.js` | All frontend logic — state machine, API calls, rendering |
| `public/styles.css` | All styles |
| `src/index.js` | Worker entry point — Access check, security headers, routes `/api/*` to function handlers |
| `src/access.js` | Cloudflare Access JWT verification (no-op until env vars set) |
| `functions/api/projects.js` | GET/POST Teamwork projects |
| `functions/api/projects/[projectId]/tasklists.js` | GET tasklists for a project |
| `functions/api/projects/[projectId]/members.js` | GET project team members (internal staff only) |
| `functions/api/preview.js` | Anthropic AI — tune/generate/design subtasks |
| `functions/api/create.js` | Creates tasklist + parent task + subtasks in Teamwork |

## Architecture

The app is a 4-step wizard:
1. **Configure** — choose task type (AI Generate or template) and fill details
2. **Pick project** — search existing Teamwork projects or create new; choose tasklist mode and assignee
3. **Preview** — review and edit AI-generated tasklist, parent task, subtasks, and descriptions before committing
4. **Success** — shows Teamwork links to what was created

Configure comes first so AI generation happens upfront. In batch mode (multiple AI prompts), each generated card gets its own per-card project picker on the preview screen instead of a single shared project.

### Task types
- **AI Generate** (default) — one or more prompt boxes; each gets its own per-item contract type. AI (`design` mode) produces the full tasklist name, parent task, subtasks, and descriptions. Single-item result → pick-project screen (Regenerate available on preview); multiple results → batch card preview with per-card project selectors.
- **Email Campaign / SEO Blog Content** — fixed hardcoded subtask lists with optional AI "tune" pass when the PM adds wording notes. Contract type defaults to 'C'; assignee is set globally on the pick-project screen.

### Multi-item (batch) flow in AI Generate
- PMs can add multiple prompt boxes ("+ Add another") to generate several tasks at once
- Each item has its own contract type radios; assignee is set per-card on the preview screen after a project is chosen
- AI calls are parallelised (`Promise.all`) — safe because they only hit `/api/preview`
- Each `Promise.all` is tied to an `AbortController` stored in `state.pendingGeneration`; navigating back aborts the in-flight requests so the button is never left stuck
- Teamwork writes are sequential — the API rejects parallel writes from the same token
- `state.batchItems` holds the form inputs; `state.batchPreviews` holds the generated previews
- `state.isBatchMode` is `true` during AI Generate; the confirm button routes to `confirmBatchCreate()`
- Each `batchPreview` item carries its own project fields: `projectId`, `projectName`, `projectMembers`, `assigneeId`. Batch always creates a **new** tasklist — there is no per-card tasklist mode
- Subtask editing (name/description textareas, per-subtask assignee, remove, drag-to-reorder) is rendered by the shared `renderSubtaskList()` in `app.js` — used by both the single-task preview and every batch card; change it once, both flows get it

### AI modes (`/api/preview`)
- `design` — full generation from description/email → tasklist name + parent task + subtasks + descriptions
- `tune` — adjusts wording of fixed template subtasks based on PM notes
- `generate` — produces subtasks only from a description (used by regenerate panel)

### Failure recovery
- **Resumable creation** — `/api/create` accepts an optional `resume: { tasklistId, parentTaskId }`. `tasklistId` skips tasklist creation; `parentTaskId` additionally skips parent-task creation. Retries can never duplicate steps that already succeeded.
- **Retry failed** — the success screen shows a "Retry failed" button when any task failed or was partially created. `state.lastBatchResults` / `state.lastSingleAttempt` hold the original payloads plus responses; `buildRetryPayload()` re-sends only the failed subtasks with the right `resume` info.
- **Assignment failures are warnings, not failures** — a task that was created but couldn't be assigned is reported in `warnings`, never as an error (an error would invite a duplicating retry).
- **Draft persistence** — the serialisable slice of `state` is saved to sessionStorage (`taskBuilderDraft.v1`) on navigation and debounced edits, restored at boot, and cleared on publish or "Build another". A page refresh no longer destroys generated previews.

### Teamwork API notes
- Tasklist creation uses the **v1** endpoint (`/projects/:id/tasklists.json`) — v3 returns 405
- Task and subtask creation uses **v3** (`/projects/api/v3/...`)
- Task assignment uses **v1** PUT `/tasks/:id.json` with `{ "todo-item": { "responsible-party-id": "userId" } }` — v3 `assigneeIds`/`responsiblePartyIds` fields silently fail
- Subtasks are created sequentially — the API rejects parallel writes from the same token
- Task descriptions are passed as the `description` field on the task object (plain text or HTML)
- Members endpoint uses v3 `/projects/api/v3/projects/:id/people.json` — filters out client users and deleted members

## CSS Architecture

All styles are hand-authored in `public/styles.css` — **no Tailwind, no build step** (Tailwind CDN was removed June 2026; zero utility classes were in use).

- `styles.css` owns all base resets, design tokens (`:root` custom properties), and semantic component classes
- Use semantic classes (`.primary`, `.ghost`, `.inline-edit`, etc.); brand colors live as CSS custom properties in `:root`
- The Worker sets a strict CSP on served pages (`SECURITY_HEADERS` in `src/index.js`) — `script-src 'self'`, so **no inline `<script>` tags or new third-party scripts** without updating the CSP; styles/fonts are allowlisted for Fontshare only

Design context and token reference: `.impeccable.md` in the project root.

## Auth (Cloudflare Access)

Two layers, both inert until configured:

1. **Edge gate** — a Cloudflare Access application in Zero Trust covering the Worker's custom domain. The route lives in `wrangler.jsonc`, commented out until the `cakewebsites.com` zone is on the account.
2. **Worker-side JWT verification** (`src/access.js`) — verifies the `Cf-Access-Jwt-Assertion` header (signature via team JWKS, audience, issuer, expiry) on every request, pages and API alike. Activated by setting `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `wrangler.jsonc` vars; skipped when unset so local dev keeps working. This blocks direct hits on the workers.dev URL that would bypass the Access edge.

Setup order: uncomment the custom-domain route in `wrangler.jsonc` → in Zero Trust create a self-hosted Access application for that domain (policy: Allow emails ending in `@cakewebsites.com`, Google as IdP) → copy the app's Audience (AUD) tag into `CF_ACCESS_AUD` and set `CF_ACCESS_TEAM_DOMAIN` → deploy.

## Conventions
- No TypeScript, no bundler — keep it simple; the Worker runtime handles ES modules natively
- `state` in `app.js` is the single source of truth for all UI state
- `state.preview.subtasks` is an array of `{ name, description }` objects
- `state.pendingGeneration` holds the active `AbortController` for batch AI generation; always abort it before starting a new one or navigating away
- AI output is always validated against a JSON schema before use
- Partial Teamwork failures are surfaced to the user — never silently swallowed
- `autoResize(el)` is synchronous — **call `showScreen()` before calling any render function that uses `autoResize`**. If the screen is `display: none` when `autoResize` runs, `scrollHeight` returns 0 and textareas get `height: 0px`, clipping all content. The correct order is always: `showScreen('preview')` → `renderPreview()` (or `renderBatchPreview()`). Use `requestAnimationFrame` to defer if building detached nodes.
