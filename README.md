# API starter

The back end of a SaaS starter: Better Auth (email/password with verification, optional
Google), a user profile with photo upload, transactional email, rate limiting, Discord
ops/sign-up alerts, file storage (disk locally, Cloudflare R2 in production) and nightly
Postgres backups (`pg_dump`) to R2.

**Stack:** Node + Express 5 + TypeScript, Prisma on Postgres, Better Auth, zod validation,
Swagger docs, Resend.

## Schedule checker

Reads a Primavera P6 export (`.xer`), flags the rows it cannot use, and runs three checks.
The UI is in [critpath-fe](https://github.com/Harit007x/critpath-fe) (`/check`).

**The two public schedules** are in [`samples/`](samples/), unchanged from their sources (links,
licences and checksums in [`samples/README.md`](samples/README.md)).

| Sample | Activities | Links | Broken rows | Missing links | Negative float | High float |
| --- | --- | --- | --- | --- | --- | --- |
| `events-example.xer` | 83 | 86 | 0 | 4 | 0 | 5 |
| `groupdocs-sample.xer` | 70 | 0 | 70 (calendar `-1` does not exist) | 70 | 0 | 0 |

**How it works**

- `src/lib/xer/parse.ts` reads the file: `ERMHDR` header, `%T` tables, `%F` fields, `%R` rows.
  A row with the wrong number of values, or a line outside a table, is a **broken row**, reported
  with its line number in the file.
- `src/lib/xer/checks.ts` checks the values: bad numbers or dates, unknown status or link types,
  duplicate `task_id`s, and links to rows that do not exist (a `TASKPRED` link to a missing
  activity, a `TASK` with a calendar or WBS not in the file). Broken links are reported and left
  out of the checks.
- The checks cover the activities **not yet complete**, leaving out level-of-effort and WBS
  summary activities (the DCMA 14-point convention):

  | Check | Rule |
  | --- | --- |
  | Missing links | No predecessor, no successor, or neither |
  | Negative float | Total float below 0 working days |
  | High float | Total float above 44 working days (DCMA check 6) |

- Float is stored in hours. It is turned into days with **each activity's own calendar**
  (`CALENDAR.day_hr_cnt`), not a fixed 8 hours; a blank calendar means the project's default, as
  in P6.
- Every check is a plain function with unit tests on small handmade schedules and on both samples
  (`src/lib/xer/xer.test.ts`).

**Uploads are stored in Postgres** (`src/lib/xer/store.ts`, models under "Schedule checker" in
`prisma/schema.prisma`). The bundled samples are read from disk and not stored.

| Table | Holds |
| --- | --- |
| `xer_file` | The file as uploaded (`bytea`), its SHA-256, a summary (project, counts, failing activities per check) and the check report (`jsonb`) |
| `xer_table` | Each `%T` table in the file, its `%F` field names and row count |
| `xer_row` | Each readable `%R` row as `{ field: value }` in `jsonb`, with its line number |
| `xer_broken_row` | Each broken row: table, line, field, kind and reason |

- One upload is written in one transaction, rows in batches of 2,000. A file that is not an XER at
  all (422) is not stored.
- The same bytes uploaded again reopen the stored file instead of adding a copy (unique `sha256`).
- The report is kept as it was at upload, so reopening a file needs no parsing and shows the same
  result. `xer_row` keeps the parsed data for queries, e.g.
  `select values->>'task_code' from xer_row where "table" = 'TASK' and "fileId" = '…'`.
- P6 has dozens of tables whose fields vary by version, so row values are `jsonb` rather than a
  column per field.

| Route | Purpose |
| --- | --- |
| `GET /api/xer/samples` | The bundled samples |
| `GET /api/xer/samples/:id/check` | Check a sample (not stored) |
| `POST /api/xer/check` | Check and store an uploaded file (multipart field `file`, 25 MB) |
| `GET /api/xer/files` | The 50 most recent uploads |
| `GET /api/xer/files/:id` | A stored upload's report |
| `GET /api/xer/files/:id/content` | Download a stored upload as it was uploaded |

```sh
curl -F file=@samples/events-example.xer http://localhost:5000/api/xer/check
```

**Left out on purpose:** the start and finish milestones are flagged by the missing-links check
like any other activity (DCMA allows one of each; a reviewer can see them in the list); a file
with several projects is checked as one set of activities; P6 XML is not read. Sign-in is off, so
every visitor sees every upload and there is no delete; with sign-in on, uploads would belong to a
user (`userId`, `onDelete: Cascade`) and be listed only to them.

## Schedule assistant

`POST /api/ai/chat` answers questions about a stored upload ("how many rows are broken?"). The answer
comes from [critpath-ai](https://github.com/Harit007x/critpath-ai), a separate Python service; this API
validates the request, rate-limits it (6 a minute and 60 a day per address, since every question
costs model tokens) and passes the service's event stream through. The browser never talks to
critpath-ai directly.

- `src/lib/ai/schemas.ts` — the request: `{ fileId?, messages }`, starting and ending with the user
- `src/lib/ai/service.ts` — calls critpath-ai (`AI_SERVICE_URL`, `AI_SERVICE_TOKEN`); unset URL =
  `503 AI_DISABLED`
- `src/controllers/aiController.ts` — streams the answer, and stops it if the visitor goes away
- Migration `ai_views` defines the read-only views critpath-ai reads (`ai_xer_file`, `ai_xer_check`,
  `ai_xer_broken_row`): its contract with this database
- `pnpm db:seed` stores the two samples, so the assistant can answer about them; a sample's check then
  carries its stored copy's id

## Run locally

Prerequisites: Node 24, pnpm, and Postgres running locally (`brew install postgresql@18 &&
brew services start postgresql@18`). No Docker needed.

```sh
pnpm install
cp .env.example .env            # set DATABASE_URL and BETTER_AUTH_SECRET (openssl rand -base64 32)
pnpm db:migrate                 # create the database and apply prisma/migrations
pnpm dev                        # http://localhost:5000, docs at /api-docs
```

Without `RESEND_API_KEY`, emails such as password-reset links are printed to the
server console.

## Routes

| Route                       | Purpose                                     |
| --------------------------- | ------------------------------------------- |
| `GET /api/health`           | Health check (pings the database)           |
| `/api/auth/*`               | Better Auth (sign-up, sign-in, reset, …)    |
| `GET/PATCH/DELETE /api/users/me` | The signed-in user                     |
| `PUT/DELETE /api/users/me/image` | Profile photo                          |
| `GET /api/users/:id/image`  | Serves an uploaded photo                    |
| `/api/xer/*`                | Schedule checker (above); public            |
| `POST /api/ai/chat`         | Schedule assistant (above); public, rate-limited |

## Adding a feature

1. Add models to `prisma/schema.prisma` and run `pnpm db:migrate --name <change>`, which
   writes a migration to `prisma/migrations/` (commit it) and applies it. Deploys apply
   pending migrations with `pnpm db:deploy` (Railway's pre-deploy step).
2. Write a controller in `src/controllers/` and a router in `src/routes/`, guarding it
   with `protect` (`src/middlewares/authMiddleware.ts`) and validating input with
   `validate(zodSchema)`.
3. Mount the router in `src/routes/routes.ts`.
4. Relate per-user rows to `User` with `onDelete: Cascade`, so `deleteMe`
   (`src/controllers/userController.ts`) removes them with the account.

## Scripts

| Command              | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `pnpm dev`           | Start the API with auto-reload                       |
| `pnpm build`         | Generate Prisma client, compile                      |
| `pnpm start`         | Run the compiled build                               |
| `pnpm db:generate`   | Regenerate the Prisma client (also runs on install)  |
| `pnpm db:migrate`    | Create and apply a migration (development)           |
| `pnpm db:deploy`     | Apply pending migrations (production)                |
| `pnpm db:status`     | Show which migrations are applied                    |
| `pnpm db:reset`      | Drop the local database and re-apply all migrations  |
| `pnpm db:push`       | Sync the schema without a migration (prototyping)    |
| `pnpm db:studio`     | Browse the database in Prisma Studio                 |
| `pnpm db:seed`       | Store the two sample schedules (safe to re-run)      |
| `pnpm test`          | Unit tests (vitest)                                  |
| `pnpm typecheck`     | Type-check                                           |
| `pnpm smoke`         | End-to-end auth/profile checks against a running API |
| `pnpm email:preview` | Render every email to `.email-preview/`              |
| `pnpm discord:check` | Send a test Discord alert                            |
| `pnpm backup`        | Run, list or fetch database backups (needs `pg_dump`) |
