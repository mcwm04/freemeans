# Prompt: Professional admin dashboard, controls and logins for Freemeans

Read `AGENTS.md` first, then `docs/LIVE-SETUP.md`, `docs/DIRECTORY.md`, `docs/ELIGIBILITY-PRD.md`, and `services/admin/` (today: a small GitHub-sign-in review console, 575 lines, no framework). Obey every rule in AGENTS.md section 3 (no secrets in repo or chat, every number sourced and dated, append-only numbered migrations, free plans only, SEO and honesty rules).

## Goal
Turn `services/admin/` (admin.freemeans.com, Cloudflare Worker) into a professional admin dashboard where the owner and a small team run the whole site: review queue, catalog and directory content, eligibility offers, users and roles, click and signal analytics, and system health. Add proper logins with roles and an audit trail.

## Constraints
- Stay on Cloudflare Workers + Neon Postgres, free plans. No paid services, no heavy framework needing a build server. Server-rendered HTML with small progressive-enhancement JS (or htmx-style). Flag anything that needs a paid plan.
- Keep it inside the 100k requests/day and 10 ms CPU limits; `npm run check-bundle` must pass.
- Migrations: next free number after `005_learning.sql` (check `db/migrations/`), append-only. Update JSON Schema enums together with SQL CHECK lists where relevant.
- No secrets printed or committed. Secrets go through `wrangler secret put`.
- Give PowerShell commands first, then bash.

## 1. Authentication and sessions
- Keep GitHub sign-in (existing) and add email magic-link sign-in as a second option (use a free email sender; if none is free, say so and propose the cheapest option before building).
- Optional TOTP two-factor for admin/owner roles, with recovery codes (hashed).
- Sessions: signed, HttpOnly, Secure, SameSite=Lax cookies; server-side session table with expiry, "sign out everywhere", and device/IP list.
- CSRF tokens on every state-changing form; rate-limit login attempts; constant-time comparisons; no user enumeration.
- Invite-only: no open sign-up. Owner invites by email or GitHub login; replaces the single `ALLOWED_GITHUB_USERS` var (keep it as a bootstrap owner fallback).

## 2. Roles and permissions
Roles: `owner`, `admin`, `editor`, `viewer`. A permission matrix in one file (`permissions.js`) checked server-side on every route and hidden in the UI when not allowed.
- owner: everything, including roles, settings, danger zone.
- admin: users (not owners), all content, analytics, settings read.
- editor: review queue, create/edit/publish listings and offers.
- viewer: read-only dashboards.

## 3. Dashboard pages
1. **Overview**: KPI cards (live listings, pending reviews, clicks 7/30 days, stale sources, failed checks), sparkline trends, recent activity feed, quick actions.
2. **Review queue** (extend existing): filters, bulk approve/reject, diff view of changed numbers with source link and `verified_at`, reviewer notes.
3. **Catalog and directory**: searchable, sortable, paginated tables for free tiers and tools; create/edit/archive; inline validation against the JSON Schema; enforce `source_url` + `verified_at`, `unverified` flag, and the `auto_renews_paid` badge rule; sponsored flag with `rel="sponsored noopener"` preview.
4. **Eligibility offers** (student, teacher, nonprofit, startup): CRUD, expiry and re-verify dates, "needs re-check" list.
5. **Submissions and waitlist**: triage submit-form entries and crawler drafts, mark accepted/rejected/spam, export CSV.
6. **Analytics**: `/go/{slug}` clicks by tool, country, day; top pages; signal collector status. Date-range picker, CSV export.
7. **Pipeline and health**: last run of nightly source check, toolcheck, signals, crawler; failed items; DB size vs the 1 GB Neon cap; Worker request count vs 100k/day. Links to the GitHub Actions run.
8. **Users and roles**: invite, change role, deactivate, view sessions.
9. **Audit log**: append-only record of who did what, when, from which IP, with before/after for edits; filterable; export.
10. **Settings**: site flags (maintenance banner, featured ordering rules that never accept payment for ranking), allowed origins.

## 4. Controls
- Publish / unpublish / archive with confirm dialogs; undo via restore from audit log version.
- Trigger a rebuild of the static site (Cloudflare deploy hook) and a manual pipeline run (GitHub `workflow_dispatch`), owner/admin only.
- Danger zone (owner only): purge cache, delete record with typed confirmation. Prefer soft delete.

## 5. Design and UX
- Use `packages/brand` tokens (colors, fonts, Urdu Nastaliq support). Clean sidebar layout, top bar with search (Cmd/Ctrl+K), breadcrumbs, toast messages, empty/loading/error states.
- Responsive down to phone width; keyboard accessible; WCAG AA contrast; dark mode via `prefers-color-scheme`.
- Tables: sticky header, column sort, saved filters, pagination (no unbounded queries).

## 6. Quality
- Tests with `node --test` + PGlite for: every permission boundary (each role vs each route), CSRF rejection, session expiry, login rate limit, audit log written on every mutation, invite flow, and SEO/data rules enforced on publish.
- Run: `cd services/admin; npm ci; npm test; npm run check-bundle`, plus `cd db; npm test` for the migration.
- Update `services/admin/README.md`, `docs/LIVE-SETUP.md` and the AGENTS.md table.

## Working method
Plan first and show the plan (schema changes, routes, file layout). Build in this order, committing nothing until asked: migration + auth + roles + audit log, then Overview and Review queue, then catalog/offers CRUD, then analytics/health, then settings/controls. After each phase run the tests and report real results, including failures. Keep each file small and readable.
