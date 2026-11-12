// Database backups by hand. Locally `pnpm backup [list | fetch <id> [dir]]`;
// on Railway, in `railway ssh`, `node dist/backup-cli.js …` (ts-node is not installed there).
// Needs DATABASE_URL and the R2_* variables. Never restores: that is pg_restore's job, on
// purpose, so nothing here can overwrite a database.
import "dotenv-flow/config";
import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { listBackups, readBackupObject, runBackup } from "./lib/backup";

const [command = "run", id, out] = process.argv.slice(2);

const main = async () => {
  if (command === "run") {
    console.log(JSON.stringify(await runBackup(), null, 2));
  } else if (command === "list") {
    const backups = await listBackups();
    if (!backups.length) console.log("No backups yet.");
    for (const backup of backups)
      console.log(
        `${backup.id}  ${backup.complete ? "complete  " : "unfinished"}  ${backup.keys.length} files`
      );
  } else if (command === "fetch" && id) {
    const backup = (await listBackups()).find(candidate => candidate.id === id);
    if (!backup?.complete) throw new Error(`No complete backup "${id}" (pnpm backup list)`);
    const dir = path.resolve(out || path.join(tmpdir(), "critpath-backups", id));
    for (const key of backup.keys) {
      const file = path.join(dir, key.slice(`backups/${id}/`.length));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, await readBackupObject(key));
    }
    console.log(`Downloaded ${backup.keys.length} files to ${dir}`);
    const dump = backup.keys.find(key => key.endsWith(".dump"));
    const file = path.join(dir, path.basename(dump ?? "<database>.dump"));
    console.log(
      `Restore with: pg_restore --clean --if-exists --no-owner --dbname <target> "${file}"`
    );
  } else {
    console.error("Usage: backup [run | list | fetch <id> [dir]]");
    process.exitCode = 1;
  }
};

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
