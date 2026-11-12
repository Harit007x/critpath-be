import { spawn } from "child_process";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { r2 } from "./uploads";
import { describeError, notifyOps } from "./discord";

/**
 * Nightly database backups to R2, made with `pg_dump` in its compressed custom format, so
 * `pg_restore` restores one as it is. `pg_dump` must be on the PATH (or at `PG_DUMP_PATH`) and be
 * at least the server's major version. A backup is `backups/<id>/<database>.dump` and a
 * `manifest.json` written last: a backup without one did not finish and is not counted.
 */

const PREFIX = "backups/";
const MANIFEST = "manifest.json";

const intFromEnv = (name: string, fallback: number, min: number, max: number) => {
  // Number("") is 0, a valid hour: an empty variable must mean the default, not midnight.
  const value = process.env[name] ? Number(process.env[name]) : NaN;
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

/** Complete backups kept; older ones are deleted after each new one. */
const KEEP = intFromEnv("BACKUP_KEEP", 30, 1, 3650);
/** The UTC hour from which the day's backup is due (the hourly upkeep picks it up). */
const HOUR_UTC = intFromEnv("BACKUP_HOUR_UTC", 3, 0, 23);

/**
 * Login sessions and pending verification codes are live secrets nobody needs back: a restore
 * just signs everyone out. Their tables are kept, their rows left out, so no working
 * credentials reach the bucket.
 */
const SKIPPED = new Set(["session", "verification"]);

// Off unless asked for: a local `pnpm dev` (whose .env may name production) must not back up too.
// Only `true` or `false`: a typo such as `ture` would otherwise turn backups off without a word.
const enabledValue = (process.env.BACKUP_ENABLED ?? "").trim().toLowerCase() || "false";
if (enabledValue !== "true" && enabledValue !== "false")
  throw new Error(`BACKUP_ENABLED must be true or false, not "${process.env.BACKUP_ENABLED}"`);
const enabled = enabledValue === "true";
// Asked for but impossible would mean no backups and no error; refuse to start instead.
if (enabled && !r2) throw new Error("BACKUP_ENABLED needs the R2_* variables (backups go to R2)");

const bucket = () => process.env.BACKUP_BUCKET || r2!.bucket;

export const backupLabel = enabled
  ? `nightly from ${String(HOUR_UTC).padStart(2, "0")}:00 UTC to R2 bucket "${bucket()}", keeping ${KEEP}`
  : "off (BACKUP_ENABLED is not true)";

export type BackupInfo = { id: string; at: Date; complete: boolean; keys: string[] };

/** `2026-10-22T03-00-12Z`: sorts by time and is safe in a key. */
const idFor = (date: Date) => `${date.toISOString().slice(0, 19).replace(/:/g, "-")}Z`;
const dateOf = (id: string) => new Date(id.replace(/T(\d\d)-(\d\d)-(\d\d)Z$/, "T$1:$2:$3Z"));

const s3 = () => {
  if (!r2) throw new Error("Backups need the R2_* variables");
  return r2.client;
};

/** Every backup in the bucket, oldest first, with all of its object keys. */
export const listBackups = async (): Promise<BackupInfo[]> => {
  const byId = new Map<string, BackupInfo>();
  let ContinuationToken: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: PREFIX, ContinuationToken })
    );
    for (const { Key } of page.Contents ?? []) {
      const id = Key?.slice(PREFIX.length).split("/")[0];
      if (!Key || !id || Number.isNaN(dateOf(id).getTime())) continue;
      const backup = byId.get(id) ?? { id, at: dateOf(id), complete: false, keys: [] };
      backup.keys.push(Key);
      if (Key === `${PREFIX}${id}/${MANIFEST}`) backup.complete = true;
      byId.set(id, backup);
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return [...byId.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
};

const put = (Key: string, Body: Buffer, ContentType: string) =>
  s3().send(new PutObjectCommand({ Bucket: bucket(), Key, Body, ContentType }));

/**
 * `DATABASE_URL` as libpq takes it. Prisma's `?schema=` is not a libpq parameter (pg_dump would
 * refuse the URL), so it is taken out and returned on its own.
 */
const connection = () => {
  const url = new URL(process.env.DATABASE_URL!);
  const schema = url.searchParams.get("schema") || "public";
  url.searchParams.delete("schema");
  return { url: url.toString(), schema, database: decodeURIComponent(url.pathname.slice(1)) };
};

/** Runs pg_dump and resolves with the whole dump (custom format, already compressed). */
const pgDump = (url: string, schema: string) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = spawn(process.env.PG_DUMP_PATH || "pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--schema=${schema}`,
      ...[...SKIPPED].map(table => `--exclude-table-data=${schema}."${table}"`),
      `--dbname=${url}`,
    ]);
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", error =>
      reject(new Error(`Could not run pg_dump (${error.message}); install the Postgres client`))
    );
    child.on("close", code =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`pg_dump exited with ${code}: ${stderr.trim()}`))
    );
  });

/**
 * Dumps `DATABASE_URL`'s schema into a new backup, then prunes old ones. pg_dump reads from one
 * snapshot, so the backup is consistent even while the API writes.
 */
export const runBackup = async () => {
  s3();
  const started = new Date();
  const id = idFor(started);
  const { url, schema, database } = connection();
  const dump = await pgDump(url, schema);
  const file = `${database}.dump`;
  await put(`${PREFIX}${id}/${file}`, dump, "application/octet-stream");
  const manifest = {
    id,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    database,
    schema,
    file,
    skippedData: [...SKIPPED],
    bytes: dump.length,
    restore: `pg_restore --clean --if-exists --no-owner --dbname <target> <download>/${file}  (pnpm backup fetch ${id})`,
  };
  await put(
    `${PREFIX}${id}/${MANIFEST}`,
    Buffer.from(JSON.stringify(manifest, null, 2)),
    "application/json"
  );
  const pruned = await pruneBackups();
  return { ...manifest, pruned };
};

/**
 * Keeps the newest KEEP complete backups. An unfinished one goes once a complete one is newer
 * than it, so the one being written now is never touched.
 */
const pruneBackups = async () => {
  const backups = await listBackups();
  const complete = backups.filter(backup => backup.complete);
  const newest = complete.at(-1)?.at.getTime() ?? 0;
  const doomed = [
    ...complete.slice(0, Math.max(0, complete.length - KEEP)),
    ...backups.filter(backup => !backup.complete && backup.at.getTime() < newest),
  ];
  // One request per key: a few dozen a night, and it avoids DeleteObjects' checksum rules.
  for (const backup of doomed)
    for (const Key of backup.keys)
      await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key }));
  return doomed.map(backup => backup.id);
};

/** Reads one object of a backup (the manifest, or a file for `backup:fetch`). */
export const readBackupObject = async (Key: string) => {
  const object = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key }));
  return Buffer.from(await object.Body!.transformToByteArray());
};

let running = false;

/**
 * Called by the hourly upkeep: makes today's backup once it is due and none exists since. The
 * bucket is the record of what ran, so a restart or deploy neither skips a night nor repeats one.
 * A failure is logged and retried on the next tick.
 */
export const nightlyBackup = async () => {
  if (!enabled || running) return;
  running = true;
  try {
    const now = new Date();
    const due = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), HOUR_UTC)
    );
    if (due > now) due.setUTCDate(due.getUTCDate() - 1);
    const latest = (await listBackups()).filter(backup => backup.complete).at(-1);
    if (latest && latest.at >= due) return;
    const result = await runBackup();
    console.log(
      `💾 Backup ${result.id}: ${result.database}, ${Math.ceil(result.bytes / 1024)} KB` +
        (result.pruned.length ? `; removed ${result.pruned.length} old` : "")
    );
  } catch (error) {
    console.error("Backup failed:", error);
    void notifyOps(
      "backup",
      "The nightly backup failed",
      `${describeError(error)} (retried hourly)`
    );
  } finally {
    running = false;
  }
};
