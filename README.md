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

| Route | Purpose |
| --- | --- |
| `GET /api/xer/samples` | The bundled samples |
| `GET /api/xer/samples/:id/check` | Check a sample |
| `POST /api/xer/check` | Check an uploaded file (multipart field `file`, 25 MB); nothing is stored |

```sh
curl -F file=@samples/events-example.xer http://localhost:5000/api/xer/check
```

**Left out on purpose:** the start and finish milestones are flagged by the missing-links check
like any other activity (DCMA allows one of each; a reviewer can see them in the list); a file
with several projects is checked as one set of activities; P6 XML is not read.

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
| `pnpm test`          | Unit tests (vitest)                                  |
| `pnpm typecheck`     | Type-check                                           |
| `pnpm smoke`         | End-to-end auth/profile checks against a running API |
| `pnpm email:preview` | Render every email to `.email-preview/`              |
| `pnpm discord:check` | Send a test Discord alert                            |
| `pnpm backup`        | Run, list or fetch database backups (needs `pg_dump`) |
