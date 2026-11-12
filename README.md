# API starter

The back end of a SaaS starter: Better Auth (email/password with verification, optional
Google), a user profile with photo upload, transactional email, rate limiting, Discord
ops/sign-up alerts, file storage (disk locally, Cloudflare R2 in production) and nightly
Postgres backups (`pg_dump`) to R2.

**Stack:** Node + Express 5 + TypeScript, Prisma on Postgres, Better Auth, zod validation,
Swagger docs, Resend.

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
