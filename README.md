# CritPath: XER schedule checker (API)

Reads a Primavera P6 schedule export (`.xer`), flags the rows it cannot read, and runs three
checks: **missing links**, **negative float** and **high float**. Every upload is stored in
Postgres with its report.

**Live demo:** https://critpath-fe.harit-ptl-business.workers.dev

The project is split into two repos:

| Repo                                                    | What it is                                             |
| ------------------------------------------------------- | ------------------------------------------------------ |
| **critpath-be** (this one)                              | The API: parser, checks, storage, the two sample files |
| [critpath-fe](https://github.com/Harit007x/critpath-fe) | The web app: upload, report, tables, float chart       |

**Stack:** Node + Express 5 + TypeScript, Prisma on Postgres, zod, vitest.

## The two sample files

Both are public P6 exports, kept unchanged in [`samples/`](samples/). Sources, licences and
checksums are in [`samples/README.md`](samples/README.md).

| File                   | Activities | Links | Broken rows                       | Missing links | Negative float | High float |
| ---------------------- | ---------- | ----- | --------------------------------- | ------------- | -------------- | ---------- |
| `events-example.xer`   | 83         | 86    | 0                                 | 4             | 0              | 5          |
| `groupdocs-sample.xer` | 70         | 0     | 70 (calendar `-1` does not exist) | 70            | 0              | 0          |

## The checks

The checks cover activities **not yet complete**, leaving out level-of-effort and WBS summary
activities (the DCMA 14-point convention).

| Check          | Rule                                             |
| -------------- | ------------------------------------------------ |
| Missing links  | No predecessor, no successor, or neither         |
| Negative float | Total float below 0 working days                 |
| High float     | Total float above 44 working days (DCMA check 6) |

Float is stored in hours. It is turned into days using **each activity's own calendar**
(`CALENDAR.day_hr_cnt`), not a fixed 8 hours. A blank calendar means the project default, as in P6.

## How it works

All the checker code is in `src/lib/xer/`.

- **`parse.ts`** reads the file: the `ERMHDR` header, then `%T` tables, `%F` fields and `%R` rows.
  A row with the wrong number of values, or a line outside a table, is a **broken row**, reported
  with its line number. The rest of the file is still read.
- **`checks.ts`** validates values and runs the checks:
  - Bad values: numbers or dates that don't parse, and unknown status or link types.
  - Duplicate `task_id`s.
  - References to rows that don't exist, such as a link to a missing activity, or a calendar or
    WBS that isn't in the file. These broken rows are reported and left out of the checks.
- **`store.ts`** saves an upload in one transaction.
- **`xer.test.ts`** and **`store.test.ts`** test every check on small handmade schedules and on
  both samples.

### Storage

The tables are under "Schedule checker" in `prisma/schema.prisma`.

| Table            | Holds                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- |
| `xer_file`       | The file as uploaded (`bytea`), its SHA-256, a summary and the check report (`jsonb`) |
| `xer_table`      | Each `%T` table in the file, its field names and row count                            |
| `xer_row`        | Each readable row as `{ field: value }` in `jsonb`, with its line number              |
| `xer_broken_row` | Each broken row: table, line, field, kind and reason                                  |

- **Duplicates:** the same file uploaded again opens the stored copy instead of adding a second
  one (unique `sha256`).
- **Reports:** the report is saved at upload, so reopening a file needs no parsing.
- **Row values are `jsonb`:** P6 has dozens of tables whose fields change between versions, so
  there is no column per field.
- **Non-XER files:** a file that isn't an XER at all returns 422 and is not stored.

### Routes

| Route                            | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `GET /api/xer/samples`           | The bundled samples                                           |
| `GET /api/xer/samples/:id/check` | Check a sample (not stored)                                   |
| `POST /api/xer/check`            | Check and store an upload (multipart field `file`, 25 MB max) |
| `GET /api/xer/files`             | The 50 most recent uploads                                    |
| `GET /api/xer/files/:id`         | A stored upload's report                                      |
| `GET /api/xer/files/:id/content` | Download the file as uploaded                                 |
| `GET /api/health`                | Health check (pings the database)                             |

```sh
curl -F file=@samples/events-example.xer http://localhost:5000/api/xer/check
```

## Run locally

You need Node 22+, pnpm and Postgres. On a Mac, install Postgres with
`brew install postgresql@18 && brew services start postgresql@18`.

```sh
pnpm install
cp .env.example .env    # set DATABASE_URL and BETTER_AUTH_SECRET (openssl rand -base64 32)
pnpm db:migrate         # create the database and apply the migrations
pnpm db:seed            # store the two sample files (safe to re-run)
pnpm dev                # http://localhost:5000, API docs at /api-docs
```

Then start the web app ([critpath-fe](https://github.com/Harit007x/critpath-fe)).

| Command                     | Purpose                                    |
| --------------------------- | ------------------------------------------ |
| `pnpm dev`                  | Start the API with auto-reload             |
| `pnpm test`                 | Unit tests (vitest)                        |
| `pnpm typecheck`            | Type-check                                 |
| `pnpm db:migrate`           | Create and apply a migration (development) |
| `pnpm db:deploy`            | Apply pending migrations (production)      |
| `pnpm db:seed`              | Store the two sample files                 |
| `pnpm db:studio`            | Browse the database                        |
| `pnpm build` / `pnpm start` | Compile, then run the build                |

## Deployment

- **API:** runs on Railway. `pnpm db:deploy` runs as the pre-deploy step.
- **Database:** Postgres on Neon.
- **Web app:** a Cloudflare Worker serves it and forwards `/api` to the API, so both share one
  origin.
- **Rate limits:** the Worker passes the visitor's IP with a shared key (`EDGE_PROXY_SECRET`), so
  limits count real visitors rather than the Worker.

## Not covered yet

- **Start and finish milestones:** the missing-links check flags them like any other activity.
  DCMA allows one of each, and a reviewer can spot them in the list.
- **Several projects:** a file with more than one project is checked as one set of activities.
- **P6 XML:** not read, only `.xer`.
- **Sign-in:** off for the demo, so every visitor sees every upload and there is no delete. The
  sign-in, profile and email code is still in the repo. With it on, uploads would belong to a
  user and be listed only to them.
