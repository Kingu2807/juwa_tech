# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Extraction of supplier invoices (PDF + degraded scans/images) into validated JSON via
**OCR → LLM structured output → Zod validation**, plus a web UI to review the results.
Two **independent npm packages**, no root `package.json`:

- `pipeline/` — TypeScript CLI + a small HTTP server (the AI pipeline). All AI goes
  **exclusively through the Mistral API**.
- `web/` — React + Vite single-page review console (no auth, no DB, no routing).

The project language is **French** (UI, comments, docs). Match it. Code is written to be
read by a non-developer owner: keep comments dense and in French, in the existing style.

## Commands

Each package has its own `node_modules`; run `npm install` in **both** `pipeline/` and `web/`.

Pipeline (`cd pipeline`):
- `npm run extract` — process PDFs in `invoices/` (skips already-extracted; add `-- --force` to reprocess all)
- `npm run extract -- ./invoices/x.pdf` — process one file
- `npm test` — offline logic tests (coherence checks, null handling) — **no API key or PDF needed**
- `npm run typecheck` — `tsc --noEmit`
- `npm run serve` — start the extraction HTTP server on `:8787`

Web (`cd web`):
- `npm run dev` — starts Vite **and** auto-spawns the pipeline server (`:8787`) via a
  Vite plugin, proxying `/api` to it. One command runs the whole app.
- `npm run build` — `tsc -b && vite build`

There is no test runner in `web/`. The only tests are `pipeline/`'s `npm test` (a hand-rolled
harness in `src/verify.ts`, no framework); add cases there.

**Stale-server trap.** If `:8787` is already taken, the server the Vite plugin spawns dies
with `EADDRINUSE` **and the old process keeps answering** — so the UI silently runs against
pre-edit pipeline code (symptom: extractions missing fields you just added). The plugin
logs the error but `npm run dev` still looks healthy. When pipeline changes don't seem to
apply, check the owner of the port (`netstat -ano | grep :8787`) before debugging the code.
`PORT=8799 npm run serve` starts an independent instance when the default port is occupied.

## Secrets / setup

`MISTRAL_API_KEY` lives in **`.env` at the repo root** (git-ignored), not inside `pipeline/`.
Both `cli.ts` and `server.ts` load it by resolving `../../.env` relative to the source file,
so commands work regardless of cwd. Copy `.env.example` to `.env` to set the key.

## Architecture — the non-obvious wiring

**The data contract is duplicated and must stay in sync manually.** `pipeline/src/schema.ts`
(Zod) is the source of truth; `web/src/types.ts` is a hand-maintained TypeScript mirror.
Change one → change the other.

**Transcribe, never compute.** The model copies what is printed — including values that
are visibly wrong — because a recomputed figure hides the document's own errors. Hence
`lineItems[].lineTotal` is an **extracted** field (the "Total" column), not `quantity ×
unitPrice`. Real case (`facture_2_studio_botanica.pdf`): the invoice prints `4 × 95 € =
285 €`. Extract 285; `coherenceChecks` then reports the line mismatch, sums the *printed*
line totals (925) against the printed `totalHT` (1040), and cascades: a suspect HT makes
the TVA and TTC derived from it wrong too — all three totals get marked.

On a mismatching line, only the **lineTotal** cell is marked: quantity and unit price are
what the invoice states, the total is what derives from them. Quantity/price stay editable
(`alsoEditable`) without a marker, since the error may really live there.
**Never suggest a corrected value** — an earlier `suspectLines` helper guessed "100 €
would make it coherent" and was removed: inferring which figure is wrong is inventing.

Once validated, `.detail-inner` gets `is-validated`, which recolors every `.flagged` value
from amber to the calm validated green and drops the ⚠ icons and the alerts panel — the
review is over, but the colour remembers which points were checked.

**Every extracted field is `{ value, confidence, warning }`, never a bare value.** A field
that can't be read reliably is `{ value: null, confidence: "low", warning: "..." }` —
the model is prompted to **never fabricate**. This shape is what lets the UI separate
"trustworthy" from "needs human check". Preserve it everywhere.

**Core vs complementary fields.** Core (supplier, date, number, line items, totalHT,
totalTTC) are required; a null is always flagged. Complementary (`client`, `totalTVA`,
`paymentMethod`, `latePenalties`) are Zod-`.optional()` — both so pre-existing extractions
still validate, and because the info may genuinely be absent from an invoice. The prompt
encodes the distinction: absent from the document → `null` + `"high"` + no warning (UI
shows a neutral "non mentionné"); present but unreadable → `null` + `"low"` + warning (UI
flags it). `isFlaggedOptional`/`isAbsent` in `App.tsx` implement this. Without it, every
invoice lacking late-payment terms would wrongly read as "à vérifier".

**Pipeline flow** (`extract.ts` orchestrates):
`runOcr` (mistral.ts) → `runExtraction` (LLM, JSON mode) → `ExtractedInvoiceSchema.safeParse`
→ `finalizeInvoice`. `finalizeInvoice` is **pure (no network)** and adds code-side
coherence warnings, in this order: per-line printed total vs quantity × price; sum of
lines vs `totalHT` (preferring the *printed* line totals, falling back to computed);
TTC ≥ HT; HT + TVA = TTC; the TVA/TTC cascade when HT is suspect; missing key fields; poor
OCR. It is what `npm test` exercises. OCR picks `document_url` for PDFs vs `image_url` for
images by file extension (mistral.ts).

**results.json is the bridge, and it is a committed artifact.** `cli.ts` writes each result
to `pipeline/output/<name>.json` and an aggregate to `web/src/data/results.json`, which the
web app imports statically as its default dataset. `pipeline/output/` is git-ignored but
`web/src/data/results.json` is committed (it's the demo data). Extraction is cached per file
in `output/`; only new invoices are processed unless `--force`.

**Server upload protocol** (`server.ts`, Node built-in `http`, zero deps): `POST /api/extract`
receives the file as the **raw request body** with the filename in an `x-filename` header
(no multipart parsing). The file is **saved into `pipeline/invoices/`** and the result JSON
into `pipeline/output/`, so a later `npm run extract` picks it up from cache into
`results.json` with no API call. If `output/<stem>.json` already exists the server answers
**409 `{ duplicate: true }`** instead of re-extracting — surfaced in the UI as "déjà
analysée" (`DuplicateError` in `api.ts`).
`GET /api/invoices` lists every extraction on disk, `GET /api/file/<name>` serves the
original invoice (side-by-side viewer), `PUT /api/invoice/<name>` saves a corrected or
validated one, `DELETE /api/invoice/<name>` removes it everywhere (file, output JSON, and
its entry in `web/src/data/results.json`), `GET /api/health` → `{ ok: true }`. The browser
never holds the API key.

**Human review** (`review` block, Zod-`.optional()` so old extractions stay valid):
`{ validated, validatedAt, corrections[] }`. Clicking a flagged value turns it into an
input (`Editable` in `App.tsx`); committing writes the field as
`{ value, confidence: "high", warning: null }` **and appends a correction entry**
(`path`, `label`, `from`, `to`) — the AI's original reading is never silently discarded.
`PUT /api/invoice/<name>` saves and re-runs `recheckInvoice` (exported from `extract.ts`,
same coherence checks as extraction), so fixing a line price can clear the "somme des
lignes ≠ total HT" warning by itself. `needsAttention` returns false when
`review.validated`, which is what moves an invoice from "À vérifier" to "Validées".
Editable = flagged OR already corrected OR `alsoEditable` (quantity/price of a mismatching
line); a validated invoice is read-only until "Reprendre la vérification".

**A re-extraction wipes the `review` block** — corrections and validation included — since
it is a fresh read of the document. Expected, but it means `--force` (or deleting the
output JSON and re-uploading) silently discards human work on that invoice.

**Persistence has no database — `pipeline/output/` is the store.** `GET /api/invoices`
lists every valid extraction found there, and `App.tsx` fetches it on mount, so uploaded
invoices survive a page reload until deleted. The server list is authoritative when
reachable; the statically imported `results.json` is only the fallback when it is not
(the `booting` state avoids flashing the empty screen in between).

**Web UI** (`web/src/App.tsx`, one page): a master-detail review console — a left queue
(grouped "à vérifier" / "validées") and a detail pane, selection via React state (no router).
Design principle: **signal by exception** — reliable fields are unstyled; only uncertain data
gets an amber marker + ⚠ icon, with all explanations grouped in one "Alertes détectées" panel.
Coherence warnings are mapped back to the totals they implicate (`coherenceFlags`) so a
fully-read-but-inconsistent field is still highlighted. `web/src/api.ts` holds the upload/JSON
helpers.

## Design system

`PRODUCT.md` and `DESIGN.md` (repo root) are the durable product/visual contract for the web
UI, maintained via the **impeccable** skill (installed under `.agents/skills/impeccable/`).
The mode is **Operate**: restrained color (oklch cool neutrals + one blue accent + one amber
"attention", no pure white/black on large surfaces), the system font stack (SF Pro style),
elevation via soft shadow OR hairline border (never both), motion only for state. After UI
edits, run the design detector:
`node .agents/skills/impeccable/scripts/detect.mjs --json <changed files>`.
