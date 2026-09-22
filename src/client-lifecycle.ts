/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * TDLib client lifecycle: process-wide one-time tdjson configuration
 * (ensureTdlConfigured), per-account client construction
 * (createTdlibClient — calls ensureTdlConfigured internally), and bulk
 * close on shutdown (closeTrackedTdlibClients). One canonical "TDLib
 * client lifecycle" unit.
 */
import { createRequire } from "node:module";

import { createLogger } from "@teamscala/logger/creator";
import * as tdl from "tdl";

import type { TdlibClientEntry, TdlibClientOptions } from "./types.ts";

const logger = createLogger({ service: "telegram" });
const _require = createRequire(import.meta.url);

const globalForTdl = globalThis as { tdlConfigured?: boolean };

export function ensureTdlConfigured() {
	if (globalForTdl.tdlConfigured) return;
	try {
		const { getTdjson } = _require("prebuilt-tdlib");
		// TDLib auth/connection/code-type (sms/fragment/call) events surfaced via the setLogMessageCallback filter below — essential for diagnosing why an auth
		// code is/isn't delivered. verbosityLevel 2 (not 3): level-3 messages bypass
		// the callback and dump straight to stdout (the full app config — thousands
		// of updateOption/updateTrustedMiniAppBots lines), which tripped Railway's
		// 500 logs/sec rate limit and DROPPED the auth.sentCode code_type line we
		// need, AND stalled the service enough that the gateway's /connect/qr fetch
		// timed out ("Failed to reach messaging service"). At level 2 every emitted
		// message routes through the callback's auth/connection filter, so stdout
		// gets ONLY those lines — no app-config flood, no rate-limit drops, the
		// service stays responsive to /qr.
		tdl.configure({ tdjson: getTdjson(), verbosityLevel: 2 });
		tdl.setLogMessageCallback(2, (lvl, msg) => {
			// Filter to auth/connection/code-type lines ONLY. Verbosity 2 routes every
			// emitted message (level ≤2) through this callback; the regex below surfaces
			// only the code_type (authenticationCodeTypeSms/Fragment/Call) + auth-state
			// + connection lines, suppressing everything else.
			if (
				/auth\.sentCode|authenticationCodeType|authorizationState|connectionState|setAuthentication|checkAuthentication|FLOOD_WAIT|PHONE_NUMBER|Send auth|error/i.test(
					msg,
				)
			) {
				logger.info(
					"tdlib auth/connection/code-type event",
					{ tdlibLevel: lvl, tdlibMessage: msg },
				);
			}
		});
		globalForTdl.tdlConfigured = true;
	} catch (err: unknown) {
		if (err instanceof Error && err.message.includes("already initialized")) {
			globalForTdl.tdlConfigured = true;
			return;
		}
		throw err;
	}
}

export function createTdlibClient(options: TdlibClientOptions) {
	ensureTdlConfigured();
	return tdl.createClient({
		apiId: options.apiId,
		apiHash: options.apiHash,
		databaseDirectory: `${options.sessionDir}/db`,
		filesDirectory: `${options.sessionDir}/files`,
		tdlibParameters: {
			use_message_database: options.useMessageDatabase ?? true,
			use_secret_chats: options.useSecretChats ?? false,
			system_language_code: options.systemLanguageCode ?? "en",
			application_version: options.applicationVersion ?? "1.0",
			device_model: options.deviceModel ?? "scala Server",
			system_version: options.systemVersion ?? "Linux",
		},
	});
}

export async function closeTrackedTdlibClients<
	TClient extends { close(): Promise<void> },
>(options: {
	clients: Map<string, TdlibClientEntry<TClient>>;
	onError?: (key: string, error: unknown) => void;
}): Promise<void> {
	const closePromises: Promise<void>[] = [];

	for (const [key, entry] of options.clients) {
		closePromises.push(
			entry.client.close().catch((error) => {
				options.onError?.(key, error);
			}),
		);
	}

	await Promise.all(closePromises);
	options.clients.clear();
}
