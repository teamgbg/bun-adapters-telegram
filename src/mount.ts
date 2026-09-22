/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * Service boot mount for @teamscala/telegram. Two surfaces:
 *  1. Boot hook "telegram-session-bootstrap" — configures the per-account client
 *     surface from the injected TDLib credentials and reconnects every persisted
 *     session on the volume.
 *  2. Connect/auth HTTP handlers (telegram-connect-*) — the messaging-side endpoints
 *     the OAuth gateway's /telegram/connect flow drives. Bound to paths via
 *     service_install.api_routes[]; X-API-Key gated — accepts TELEGRAM_ADAPTER_KEY
 *     for service-to-service calls over the Railway internal network.
 * Consumed by a service via service_install.server_packages + boot_hooks + api_routes.
 */
import type { ApiHandler, MountContext } from "@teamscala/os/runtime-contracts/mount-context";
import { createLogger } from "@teamscala/logger/creator";
import {
	telegramConnectQr,
	telegramConnectStart,
	telegramGetStatus,
	telegramSubmitCode,
	telegramSubmitPassword,
	telegramSubmitPhone,
} from "./auth-handlers.ts";
import { configure } from "./client.ts";
import { autoStartExistingSessions, migrateFlatSession } from "./session-autoload.ts";
import { telegramSend } from "./send-handler.ts";

const logger = createLogger({ service: "telegram" });

/**
 * The adapter key this mount authenticates against, captured from the mount
 * context at boot.
 *
 * Module-scoped because the handlers are registered as bare `ApiHandler`s and
 * do not receive the context per-request. It is written exactly once, by
 * `mount()`, before any handler can be reached — a handler cannot run until the
 * runtime has mounted it.
 */
let adapterKey: string | undefined;

/**
 * Reject service-to-service calls without the adapter key.
 *
 * The unset-key case is now denied EXPLICITLY. It was already denied before,
 * but only incidentally: `headers.get()` yields `null` and a missing env var
 * yields `undefined`, so the inequality happened to hold. Fail-closed by
 * accident is one refactor away from fail-open, and an auth check should state
 * the intent it depends on.
 */
function unauthorized(req: Request): Response | null {
	const provided = req.headers.get("X-API-Key");
	if (!adapterKey || provided !== adapterKey) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	return null;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
	try {
		return (await req.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function str(body: Record<string, unknown> | null, key: string): string {
	const v = body?.[key];
	return typeof v === "string" ? v : "";
}

/** Wrap a connect step: auth-gate, require accountId, run, return the auth status JSON. */
function connectStep(
	run: (accountId: string, body: Record<string, unknown>) => Promise<unknown>,
): ApiHandler {
	return async (req: Request) => {
		const denied = unauthorized(req);
		if (denied) return denied;
		const body = await readBody(req);
		const accountId = str(body, "accountId");
		if (!accountId) return Response.json({ error: "accountId required" }, { status: 400 });
		try {
			return Response.json(await run(accountId, body ?? {}));
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 500 },
			);
		}
	};
}

/** Read one string off the injected service config. */
function cfgStr(config: MountContext["config"], key: string): string | undefined {
	const value = config[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function mount(ctx: MountContext): Promise<void> {
	// Captured from the injected config, never the ambient environment
	// (`configured-primitives`: the bootloader is the only env-aware surface).
	// Assigned before any handler can run, since the runtime mounts before it
	// serves.
	adapterKey = cfgStr(ctx.config, "TELEGRAM_ADAPTER_KEY");

	ctx.registerBootHook("telegram-session-bootstrap", async () => {
		const apiId = Number(cfgStr(ctx.config, "TDLIB_API_ID"));
		const apiHash = cfgStr(ctx.config, "TDLIB_API_HASH") ?? "";
		if (!Number.isFinite(apiId) || apiId <= 0 || apiHash.length === 0) {
			// No TDLib credentials injected — run without Telegram (group sync
			// inactive) rather than crash-loop. Inject TDLIB_API_ID/TDLIB_API_HASH
			// into this service's config (from the telegram-app-credentials secret
			// row) to activate on next boot.
			logger.warn("no TDLib credentials (TDLIB_API_ID/TDLIB_API_HASH uninjected) — Telegram inactive");
			return;
		}
		const sessionsBaseDir = cfgStr(ctx.config, "TDLIB_SESSIONS_DIR") ?? ".tdlib-session";
		configure({ apiId, apiHash, sessionsBaseDir });

		// One-time adoption of a prior flat-session layout into the per-account layout
		// (set TDLIB_ADOPT_FLAT_SESSION_AS to the owning accountId; no-op once migrated).
		const adoptAs = cfgStr(ctx.config, "TDLIB_ADOPT_FLAT_SESSION_AS");
		if (adoptAs && (await migrateFlatSession(sessionsBaseDir, adoptAs))) {
			logger.info("adopted prior flat session", { accountId: adoptAs });
		}

		const { started, accountIds } = await autoStartExistingSessions(sessionsBaseDir);
		logger.info("session bootstrap", {
			apiId,
			sessionsBaseDir,
			started,
			accountIds,
		});
	});

	// Connect/auth flow (driven by the OAuth gateway over the Railway internal network).
	ctx.registerHandler("telegram-connect-start", connectStep((id) => telegramConnectStart(id)));
	ctx.registerHandler(
		"telegram-connect-phone",
		connectStep((id, b) => telegramSubmitPhone(id, str(b, "phoneNumber"))),
	);
	ctx.registerHandler("telegram-connect-qr", connectStep((id) => telegramConnectQr(id)));
	ctx.registerHandler(
		"telegram-connect-code",
		connectStep((id, b) => telegramSubmitCode(id, str(b, "code"))),
	);
	ctx.registerHandler(
		"telegram-connect-password",
		connectStep((id, b) => telegramSubmitPassword(id, str(b, "password"))),
	);
	ctx.registerHandler("telegram-connect-status", async (req: Request) => {
		const denied = unauthorized(req);
		if (denied) return denied;
		const accountId = new URL(req.url).searchParams.get("accountId") ?? "";
		if (!accountId) return Response.json({ error: "accountId required" }, { status: 400 });
		return Response.json(await telegramGetStatus(accountId));
	});

	// Outbound send (driven by scala-messaging-service's Telegram proxy).
	ctx.registerHandler("telegram-send", async (req: Request) => {
		const denied = unauthorized(req);
		if (denied) return denied;
		return telegramSend(req, {});
	});
}
