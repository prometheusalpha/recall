/**
 * The app's SQLite file.
 *
 * One `recall.db` under the OS data folder holds every piece of state the
 * backend owns; the handle is opened on first use and kept for the lifetime of
 * the Bun process. Tables live in `./appDbSchema` rather than in their feature
 * modules because `CREATE TABLE IF NOT EXISTS` is cheap; they are kept out of
 * this file so tests can run the migrations without the Electrobun import.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Utils from "electrobun/main/utils";
import { migrate, SCHEMA } from "./appDbSchema";

/**
 * Folder name under the OS data dir. Electrobun exposes no path helper for
 * the bundle identifier, so this is `app.identifier` from
 * `electrobun.config.ts` — keep the two in step.
 */
const APP_DIR = "app.recall.desktop";
const DB_FILE = "recall.db";

let db: Database | null = null;

/** Opens the database on first use, then holds it for the process lifetime. */
export function appDb(): Database {
	if (db) return db;
	const folder = join(Utils.paths.appData, APP_DIR);
	mkdirSync(folder, { recursive: true });
	db = new Database(join(folder, DB_FILE));
	db.run(SCHEMA);
	migrate(db);
	return db;
}