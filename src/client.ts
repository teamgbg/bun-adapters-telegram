/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * Per-account TDLib client resolver — the runtime glue the generated adapter
 * (src/generated/operations.gen.ts) calls. configure() injects the TDLib api
 * credentials + sessions base dir at boot (configured-primitives);
 * resolveTdlibClient(accountId) returns a get-or-create tdl client bound to that
 * account's session dir, so an already-authenticated session on disk reconnects
 * with no re-login. Operations + types are generated from td_api.tl.
 */
		/**
		 * Close this client instead of leaving it parked in an auth-waiting state.
		 *
		 * Set by the boot autoloader, whose contract is to RESUME already
		 * authenticated sessions. A session dir whose credentials are gone (an
		 * abandoned half-finished connect) instead lands in
		 * authorizationStateWaitOtherDeviceConfirmation, and TDLib then refreshes
		 * that QR token forever because nobody is ever going to scan it.
		 *
		 * Measured on scala-messaging-service 2026-07-28: 24 such sessions
		 * auto-started every boot (23 UUID dirs plus a `connect-…` one), each
		 * re-issuing a tg://login token roughly every 15s — a permanent
		 * ~8-lines-per-second log flood that drowned every other line in the
		 * service and burned CPU on 24 idle DC connections, for zero possible
		 * benefit. This is the `no-uncontrolled-repetition-or-cascade` shape:
		 * the loop is deleted by construction rather than throttled.
		 *
		 * The session directory is deliberately NOT removed — a session can be
		 * unauthenticated transiently, and destroying the only copy of its state
		 * is not recoverable. Closing is.
		 */

import { createLogger } from "@teamscala/logger/creator";
import { attachTdlibAuthLifecycle } from "./auth-lifecycle.ts";
import { createTdlibClient } from "./client-lifecycle.ts";
import {
	getTdlibClientMap,
	registerTrackedTdlibClient,
	setTdlibClientStatus,
} from "./client-store.ts";
import type { TdlibClientEntry } from "./types.ts";

const logger = createLogger({ service: "telegram" });

export interface TdlibClient {
	invoke(query: Record<string, unknown>): Promise<unknown>;
	close(): Promise<void>;
	on(event: "error", handler: (error: unknown) => void): void;
	on(
		event: "update",
		handler: (update: { _: string; authorization_state?: { _: string } }) => void,
	): void;
}

/** The process-global per-account client map (account id → tracked client + auth state). */
export function getTelegramClients(): Map<string, TdlibClientEntry<TdlibClient>> {
	return getTdlibClientMap<TdlibClient>();
}

export interface TelegramConfig {
	apiId: number;
	apiHash: string;
	/** Base dir holding per-account session dirs (`<base>/<accountId>/{db,files}`). */
	sessionsBaseDir: string;
}

let _config: TelegramConfig | null = null;

/** Bootloader injection (configured-primitives). Called once at service boot. */
export function configure(config: TelegramConfig): void {
	_config = config;
}

/**
 * Get-or-create the TDLib client for an account. Clients are keyed per account in
 * a process-global map; an existing session dir reconnects automatically (tdl
 * resumes the persisted TDLib session — no re-auth when the session is intact).
 */
export function resolveTdlibClient(
	accountId: string,
	options?: {
		closeIfUnauthenticated?: boolean;
	},
): TdlibClient {
	if (typeof accountId !== "string" || accountId.trim() === "") {
		throw new Error(
			"@teamscala/telegram: resolveTdlibClient(accountId) requires a non-empty string accountId — an undefined/empty value would stringify to a literal 'undefined' session dir (phantom-session bug class)",
		);
	}
	if (!_config) {
		throw new Error(
			"@teamscala/telegram: configure({ apiId, apiHash, sessionsBaseDir }) was not called — the service bootloader must inject TDLib config before resolveTdlibClient",
		);
	}
	const clients = getTdlibClientMap<TdlibClient>();
	const existing = clients.get(accountId);
	if (existing) return existing.client;
	const client = createTdlibClient({
		apiId: _config.apiId,
		apiHash: _config.apiHash,
		sessionDir: `${_config.sessionsBaseDir}/${accountId}`,
	}) as unknown as TdlibClient;
	registerTrackedTdlibClient({ clients, key: accountId, client, initialState: { status: "not_initialized" } });
	// Track this account's auth state from TDLib's own auth events, so the
	// connect handlers (auth-handlers.ts) can report status and the auth-step
	// actions can wait on state transitions. Applies to both resumed sessions
	// (reconnect → "ready") and fresh connects (→ "waiting_phone"/"waiting_code").
	// Once an autoloaded client has been closed, IGNORE everything it keeps
	// emitting. tdl's close() is asynchronous and the update stream does not stop
	// at the call, so without this latch the same dead session re-enters the
	// close path on every subsequent QR refresh — re-logging and re-closing
	// forever, which is the churn the first version of this fix left behind
	// (measured 2026-07-28: ~2 QR lines every 30s after 24 sessions were closed).
	let closedByAutoload = false;
	attachTdlibAuthLifecycle({
		client,
		accountId,
		isMuted: () => closedByAutoload,
		onError: (error) =>
			setTdlibClientStatus(clients, accountId, "error", { error: String(error) }),
		onStatusChange: (status, authState) => {
			const patch: { qrLink?: string } = {};
			if (status === "waiting_qr" && typeof authState?.link === "string") {
				patch.qrLink = authState.link;
			}
			setTdlibClientStatus(clients, accountId, status, patch);
			// An autoloaded session that asks for credentials has none to resume.
			// Close it on the FIRST waiting state, before TDLib starts its endless
			// QR-token refresh. An operator-initiated connect never passes this
			// flag, so the interactive login flow is untouched.
			if (options?.closeIfUnauthenticated && status.startsWith("waiting") && !closedByAutoload) {
				closedByAutoload = true;
				logger.warn(
					"closing autoloaded TDLib session with no resumable credentials — it would otherwise refresh a login token forever",
					{ accountId, status },
				);
				clients.delete(accountId);
				void client.close().catch(() => {});
			}
		},
		onConnectionStateChange: (ready) => {
			const entry = clients.get(accountId);
			if (entry) entry.state = { ...entry.state, connectionReady: ready };
		},
		onClosed: () => clients.delete(accountId),
	});
	return client;
}
