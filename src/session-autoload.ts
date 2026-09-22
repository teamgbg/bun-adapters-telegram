/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * Boot-time TDLib session autoloader. Scans the sessions base dir for any
 * account directory holding a persisted TDLib database (`<accountId>/db`) and
 * calls resolveTdlibClient(accountId) for each — tdl reconnects the existing
 * authenticated session with no re-login. Account ids are the dir path relative
 * to the base (e.g. "<org>" or "<org>/<account>"), matching the layout
 * client.ts writes (`<base>/<accountId>/{db,files}`).
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveTdlibClient } from "./client.ts";

/**
 * Adopt a pre-per-account flat session into the per-account layout. A
 * deployment older than the per-account refactor wrote a single TDLib session
 * directly at `<base>/{db,files}` (no account dir). This moves it to
 * `<base>/<accountId>/{db,files}` so the autoloader and resolveTdlibClient(accountId)
 * find it — atomic rename, runs before any client opens the db, and is a no-op
 * once the per-account dir exists (idempotent across redeploys). Returns true
 * only when it actually migrated a flat session this call.
 */
export async function migrateFlatSession(sessionsBaseDir: string, accountId: string): Promise<boolean> {
	const flatDb = join(sessionsBaseDir, "db");
	if (!(await Bun.file(flatDb).exists())) return false; // no flat session to adopt
	const target = join(sessionsBaseDir, accountId);
	if (await Bun.file(join(target, "db")).exists()) return false; // already migrated
	await mkdir(target, { recursive: true });
	await rename(flatDb, join(target, "db"));
	const flatFiles = join(sessionsBaseDir, "files");
	if (await Bun.file(flatFiles).exists()) await rename(flatFiles, join(target, "files"));
	return true;
}

/** Recursively collect directories that contain a `db` subdirectory (a TDLib session). */
async function findSessionDirs(baseDir: string, dir: string, found: string[]): Promise<void> {
	if (await Bun.file(join(dir, "db")).exists()) {
		found.push(relative(baseDir, dir));
		return; // a session dir owns its subtree; don't descend further
	}
	for (const entry of await readdir(dir)) {
		const child = join(dir, entry);
		if ((await Bun.file(child).stat()).isDirectory()) await findSessionDirs(baseDir, child, found);
	}
}

/** JS-stringified sentinels that are never valid accountIds — skipped during autoload. */
const INVALID_ACCOUNT_ID_SENTINELS = new Set(["", "undefined", "null"]);

function isValidAccountId(accountId: string): boolean {
	return !INVALID_ACCOUNT_ID_SENTINELS.has(accountId);
}

/**
 * Preload every persisted session under `sessionsBaseDir`. Returns how many were
 * started. Safe to call when the dir is absent (returns 0) — a fresh host with
 * no sessions simply starts none. Removes dirs whose name is a JS-stringified
 * sentinel ("undefined"/"null"/"") — the phantom-session artifact from a prior
 * resolveTdlibClient(<undefined>) — so they don't accumulate on the volume.
 */
export async function autoStartExistingSessions(sessionsBaseDir: string): Promise<{ started: number; accountIds: string[] }> {
	if (!(await Bun.file(sessionsBaseDir).exists())) return { started: 0, accountIds: [] };
	const sessionDirs: string[] = [];
	for (const entry of await readdir(sessionsBaseDir)) {
		const child = join(sessionsBaseDir, entry);
		if ((await Bun.file(child).stat()).isDirectory()) await findSessionDirs(sessionsBaseDir, child, sessionDirs);
	}
	const accountIds: string[] = [];
	for (const accountId of sessionDirs) {
		if (!isValidAccountId(accountId)) {
			await rm(join(sessionsBaseDir, accountId), { recursive: true, force: true });
			continue;
		}
		// closeIfUnauthenticated: this loop RESUMES sessions. A dir whose
		// credentials are gone must not be left parked in TDLib's QR-wait, where
		// it re-issues a login token nobody will ever scan, forever (24 such
		// sessions were doing exactly that on scala-messaging-service).
		resolveTdlibClient(accountId, { closeIfUnauthenticated: true });
		accountIds.push(accountId);
	}
	return { started: accountIds.length, accountIds };
}
