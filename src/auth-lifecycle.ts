/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * auth-lifecycle.ts — describe what this file does.
 */
import { createLogger } from "@teamscala/logger/creator";

import { mapTdlibAuthStatus } from "./auth-status.ts";
import type { AuthStatus, TdlibAuthState, TdlibClientEntry } from "./types.ts";

const logger = createLogger({ service: "telegram" });

export function attachTdlibAuthLifecycle<
	TClient extends {
		invoke: (request: Record<string, unknown>) => Promise<unknown>;
		on(event: "error", handler: (error: unknown) => void): void;
		on(
			event: "update",
			handler: (update: {
				_: string;
				authorization_state?: TdlibAuthState;
				connection_state?: { _: string };
			}) => void,
		): void;
	},
>(options: {
	client: TClient;
	/**
	 * Which account these updates belong to, for logging only.
	 *
	 * Without it the auth-transition line names a state but not an owner, so a
	 * recurring transition cannot be attributed to a session. Measured 2026-07-28:
	 * after the autoloader began closing unauthenticated sessions, QR tokens still
	 * appeared roughly twice every 30s and there was no way to tell WHICH accounts
	 * were still churning — the log recorded authState and nothing else.
	 */
	accountId?: string;
	/**
	 * Returns true once this client is dead and its updates are noise.
	 *
	 * tdl's close() is asynchronous and the update stream keeps running past the
	 * call, so a closed session goes on emitting QR refreshes. Logging those is
	 * the residual churn left after the autoloader started closing abandoned
	 * sessions; muting at the source is what actually silences it.
	 */
	isMuted?: () => boolean;
	onError: (error: unknown) => void;
	onStatusChange?: (status: AuthStatus, authState: TdlibAuthState) => void;
	onConnectionStateChange?: (ready: boolean) => void;
	onClosed?: () => void;
}): void {
	options.client.on("error", (error) => {
		options.onError(error);
	});

	options.client.on("update", (update) => {
		// A closed client's updates are dropped before anything is logged or acted
		// on — the check must come first, since the transition log is itself the
		// noise being removed.
		if (options.isMuted?.()) return;
		// Track TDLib's transport connection state — connectionStateReady means the
		// DC connection is established + ready for auth requests. requestQrCodeAuthentication
		// fired before connectionStateReady silently accepts ("ok") but never emits the QR.
		if (update._ === "updateConnectionState" && update.connection_state) {
			options.onConnectionStateChange?.(
				update.connection_state._ === "connectionStateReady",
			);
			return;
		}
		if (
			update._ !== "updateAuthorizationState" ||
			!update.authorization_state
		) {
			return;
		}

		const authState = update.authorization_state;
		// Permanent observability: log every TDLib auth-state transition with its raw
		// fields (queryable in GlitchTip). The QR-link drop is diagnosable here — does
		// authorizationStateWaitOtherDeviceConfirmation arrive, and does its `link` reach
		// the handler? A state machine's transitions are worth debug-logging always, not
		// only during a bug hunt.
		logger.info("tdlib auth state transition", {
			accountId: options.accountId,
			state: authState._,
			authState,
		});
		// Drive the TDLib auth state machine forward: when TDLib reaches
		// WaitEncryptionKey, submit the (empty) database encryption key so the state
		// advances to WaitPhoneNumber. Without this, the state stalls at
		// WaitEncryptionKey (mapTdlibAuthStatus returns null for it, so it's never
		// surfaced) and every QR/phone auth request 400s with
		// "Call to ... unexpected" — the precondition state is never reached.
		if (authState._ === "authorizationStateWaitEncryptionKey") {
			options.client
				.invoke({ _: "checkDatabaseEncryptionKey", encryption_key: "" })
				.catch((error) => options.onError(error));
			return;
		}

		const status = mapTdlibAuthStatus(authState);
		if (!status) {
			return;
		}

		options.onStatusChange?.(status, authState);
		if (status === "closed") {
			options.onClosed?.();
		}
	});
}

export async function waitForTdlibReady<TClient>(options: {
	clients: Map<string, TdlibClientEntry<TClient>>;
	key: string;
	description: string;
	timeoutMs?: number;
}): Promise<void> {
	const startTime = Date.now();
	const timeoutMs = options.timeoutMs ?? 10000;

	while (Date.now() - startTime < timeoutMs) {
		const entry = options.clients.get(options.key);
		if (!entry) {
			throw new Error(`TDLib client not found for ${options.description}`);
		}

		if (entry.state.status === "ready") {
			return;
		}

		if (
			entry.state.status === "waiting_phone" ||
			entry.state.status === "waiting_code" ||
			entry.state.status === "waiting_password" ||
			entry.state.status === "error" ||
			entry.state.status === "closed"
		) {
			throw new Error(
				`TDLib auth failed for ${options.description}: ${entry.state.status}`,
			);
		}

		await Bun.sleep(100);
	}

	throw new Error(
		`TDLib initialization timed out after ${timeoutMs}ms for ${options.description}`,
	);
}

export async function waitForTdlibAuthState<TClient>(options: {
	clients: Map<string, TdlibClientEntry<TClient>>;
	key: string;
	targetStatus: AuthStatus;
	timeoutMs?: number;
}): Promise<void> {
	const authOrder: AuthStatus[] = [
		"not_initialized",
		"waiting_phone",
		"waiting_code",
		"waiting_password",
		"ready",
		"closed",
		"error",
	];
	const targetIdx = authOrder.indexOf(options.targetStatus);
	const timeoutMs = options.timeoutMs ?? 10000;
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const entry = options.clients.get(options.key);
		const currentStatus = entry?.state.status;
		if (currentStatus === options.targetStatus) return;
		const currentIdx = currentStatus ? authOrder.indexOf(currentStatus) : -1;
		if (targetIdx >= 0 && currentIdx >= targetIdx) return;
		await Bun.sleep(100);
	}

	const entry = options.clients.get(options.key);
	throw new Error(
		`Timeout waiting for TDLib auth state '${options.targetStatus}' (current: ${entry?.state.status ?? "unknown"})`,
	);
}
