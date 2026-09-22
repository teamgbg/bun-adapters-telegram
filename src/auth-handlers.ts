/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * Per-account TDLib connect/auth handlers — the messaging-service-side surface
 * the OAuth gateway's /telegram/connect flow drives. Each function maps one
 * Telegram auth stage to the low-level auth-step actions (auth-actions.ts) bound
 * to a per-account client (resolveTdlibClient) whose auth state is tracked in the
 * client store (client.ts wires the lifecycle). accountId is the owning org or
 * user id — the session persists to <base>/<accountId>/, so one account = one
 * connected number. Returns the current auth status after each step.
 */
import { createLogger } from "@teamscala/logger/creator";

import {
	requestTdlibQrCode,
	submitTdlibAuthCode,
	submitTdlibPassword,
	submitTdlibPhoneNumber,
} from "./auth-actions.ts";
import { waitForTdlibAuthState } from "./auth-lifecycle.ts";
import { getTelegramClients, resolveTdlibClient } from "./client.ts";
import type { AuthStatus } from "./types.ts";

const logger = createLogger({ service: "telegram" });

export interface TelegramAuthResult {
	accountId: string;
	status: AuthStatus;
	qrLink?: string;
	error?: string;
}

function currentStatus(accountId: string, fallback: AuthStatus): TelegramAuthResult {
	const entry = getTelegramClients().get(accountId);
	return {
		accountId,
		status: entry?.state.status ?? fallback,
		qrLink: entry?.state.qrLink,
		error: entry?.state.error,
	};
}

/** Begin (or resume) the connect flow for an account; returns the initial auth status. */
export async function telegramConnectStart(accountId: string): Promise<TelegramAuthResult> {
	resolveTdlibClient(accountId);
	return currentStatus(accountId, "not_initialized");
}

export async function telegramSubmitPhone(
	accountId: string,
	phoneNumber: string,
): Promise<TelegramAuthResult> {
	const client = resolveTdlibClient(accountId);
	await submitTdlibPhoneNumber({
		client,
		clients: getTelegramClients(),
		key: accountId,
		phoneNumber,
	});
	return currentStatus(accountId, "waiting_code");
}

export async function telegramSubmitCode(
	accountId: string,
	code: string,
): Promise<TelegramAuthResult> {
	const clients = getTelegramClients();
	const client = resolveTdlibClient(accountId);
	// Wait for the auth state to reach waiting_code — the client may be freshly
	// recreated from the persisted volume session (the TDLib auth state loads async
	// after createClient). Without this wait, checkAuthenticationCode fires before
	// the session is ready → error.
	await waitForTdlibAuthState({ clients, key: accountId, targetStatus: "waiting_code", timeoutMs: 30000 });
	await submitTdlibAuthCode(client, code);
	return currentStatus(accountId, "waiting_password");
}

export async function telegramSubmitPassword(
	accountId: string,
	password: string,
): Promise<TelegramAuthResult> {
	const clients = getTelegramClients();
	const client = resolveTdlibClient(accountId);
	// Same: wait for waiting_password before submitting (client may be recreated).
	await waitForTdlibAuthState({ clients, key: accountId, targetStatus: "waiting_password", timeoutMs: 30000 });
	await submitTdlibPassword(client, password);
	return currentStatus(accountId, "ready");
}

export async function telegramGetStatus(accountId: string): Promise<TelegramAuthResult> {
	return currentStatus(accountId, "not_initialized");
}

async function waitForQrLink(accountId: string, timeoutMs = 10000): Promise<string | undefined> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const entry = getTelegramClients().get(accountId);
		if (entry?.state.qrLink) return entry.state.qrLink;
		const status = entry?.state.status;
		if (status === "ready" || status === "error" || status === "closed") return undefined;
		await Bun.sleep(100);
	}
	return undefined;
}

/**
 * Wait for TDLib's transport connection to reach connectionStateReady before
 * issuing auth requests (QR/phone). requestQrCodeAuthentication fired before the
 * DC connection was ready silently accepted ("ok") but never emitted the QR token.
 * Returns false on timeout/dead client (the caller proceeds; the QR will fail to
 * arrive, same as before, but now the transport has had time to establish).
 */
async function waitForConnectionReady(
	accountId: string,
	timeoutMs = 30000,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const entry = getTelegramClients().get(accountId);
		if (entry?.state.connectionReady) return true;
		const status = entry?.state.status;
		if (status === "error" || status === "closed") return false;
		await Bun.sleep(100);
	}
	return false;
}

/**
 * QR-code login: reset any in-progress phone/code auth on this accountId, then call
 * requestQrCodeAuthentication. Returns the tg://login QR link the operator scans from
 * an existing authorized device — the code-free path, required when Telegram delivers
 * codes to existing sessions (authenticationCodeTypeTelegramMessage) and next_type is null.
 */
export async function telegramConnectQr(accountId: string): Promise<TelegramAuthResult> {
	const clients = getTelegramClients();
	const existing = clients.get(accountId);
	// If the client is already in the QR-wait state, serve (or wait for) the
	// existing qrLink — do NOT re-drive the state machine. A repeat /qr request
	// while waiting_qr would otherwise stall: waitForTdlibAuthState("waiting_phone")
	// doesn't track "waiting_qr" (not in its authOrder), so it would time out the
	// full 30s + throw 500, even though TDLib already generated a valid QR.
	if (existing?.state.status === "waiting_qr") {
		const qrLink = existing.state.qrLink ?? (await waitForQrLink(accountId, 30000));
		return { accountId, status: "waiting_qr", qrLink };
	}
	// Reset ONLY when a different auth method is in progress (phone code/password)
	// or the session died. Preserve `not_initialized` (still connecting — the auth-key
	// handshake with Telegram DC1 takes a few seconds) AND `waiting_phone` (the QR
	// precondition itself), so a repeat /qr while the session is mid-init does NOT
	// close + recreate the client (which restarted the auth-key handshake every call
	// — the root cause of the QR-unavailable stall: TDLib never survived long enough
	// to advance Empty→NoAuth→WaitPhoneNumber→WaitQrCode).
	const priorStatus = existing?.state.status;
	if (
		existing &&
		(priorStatus === "waiting_code" ||
			priorStatus === "waiting_password" ||
			priorStatus === "error" ||
			priorStatus === "closed")
	) {
		await existing.client.close().catch(() => {});
		clients.delete(accountId);
	}
	const client = resolveTdlibClient(accountId);
	// Wait for the auth state to reach "waiting_phone" (the precondition for
	// requestQrCodeAuthentication) before firing. The lifecycle auto-advances
	// through WaitEncryptionKey (checkDatabaseEncryptionKey); this wait resolves
	// once TDLib is at WaitPhoneNumber so the QR request is accepted (not 400
	// "unexpected"). A resumed/ready session short-circuits (waitForTdlibAuthState
	// returns when currentStatus is already at/ past the target).
	await waitForTdlibAuthState({
		clients,
		key: accountId,
		targetStatus: "waiting_phone",
		timeoutMs: 30000,
	});
	// Gate on the transport connection being ready — requestQrCodeAuthentication
	// fired before connectionStateReady silently accepted ("ok") but never emitted
	// the QR token (the DC connection wasn't established). Wait for it first.
	await waitForConnectionReady(accountId, 30000);
	await requestTdlibQrCode(client);
	const qrLink = await waitForQrLink(accountId, 90000);
	// Permanent observability: log the outcome of a QR-request wait (final auth state
	// when no link is produced) — queryable in GlitchTip for diagnosing QR-login drops.
	if (!qrLink) {
		const diag = getTelegramClients().get(accountId)?.state;
		logger.warn("no qrLink after wait", {
			finalStatus: diag?.status,
			qrLinkSet: Boolean(diag?.qrLink),
		});
	}
	return { accountId, status: "waiting_qr", qrLink };
}
