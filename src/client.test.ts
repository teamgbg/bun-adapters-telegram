// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { beforeEach, describe, expect, mock, test } from "bun:test";

type UpdateHandler = (update: Record<string, unknown>) => void;

const opened: Array<{
	sessionDir: string;
	closed: boolean;
	closeCount: number;
	emit: UpdateHandler;
}> = [];

mock.module("./client-lifecycle.ts", () => ({
	createTdlibClient: (opts: { sessionDir: string }) => {
		const handlers: UpdateHandler[] = [];
		const entry = {
			sessionDir: opts.sessionDir,
			closed: false,
			// Counted, not just flagged: the residual-churn bug was close() being
			// called AGAIN on every later update, which a boolean cannot detect.
			closeCount: 0,
			emit: (update: Record<string, unknown>) => {
				for (const h of handlers) h(update);
			},
		};
		opened.push(entry);
		return {
			invoke: () => Promise.resolve({}),
			on: (event: string, handler: UpdateHandler) => {
				if (event === "update") handlers.push(handler);
			},
			close: () => {
				entry.closed = true;
				entry.closeCount += 1;
				return Promise.resolve();
			},
		};
	},
}));

const { resolveTdlibClient, configure } = await import("./client.ts");

/** The update sequence a session with no resumable credentials produces. */
function driveToQrWait(entry: { emit: UpdateHandler }): void {
	entry.emit({
		_: "updateAuthorizationState",
		authorization_state: {
			_: "authorizationStateWaitOtherDeviceConfirmation",
			link: "tg://login?token=AQ-fixture",
		},
	});
}

beforeEach(() => {
	opened.length = 0;
	configure({ apiId: 1, apiHash: "fixture", sessionsBaseDir: "/tmp/tdlib-fixture" });
});

describe("resolveTdlibClient closeIfUnauthenticated", () => {
	/*
	 * THE REGRESSION. 24 abandoned session dirs were auto-started on every boot
	 * of scala-messaging-service; each landed here and TDLib then re-issued a
	 * tg://login token roughly every 15s forever, flooding the logs at ~8
	 * lines/second. The autoloader resumes AUTHENTICATED sessions, so a session
	 * that asks for a login has nothing to resume and must be closed.
	 */
	test("closes an autoloaded session that asks for a QR login", () => {
		resolveTdlibClient("org:abandoned", { closeIfUnauthenticated: true });
		const entry = opened.at(-1)!;
		expect(entry.closed).toBe(false);
		driveToQrWait(entry);
		expect(entry.closed).toBe(true);
	});

	/*
	 * The other half, and the reason this is a flag rather than blanket
	 * behaviour: the interactive connect flow MUST be able to sit in QR-wait,
	 * because a human is about to scan that code. Closing it there would break
	 * Telegram login entirely — a plausible over-correction this locks out.
	 */
	test("leaves an operator-initiated connect parked in QR-wait", () => {
		resolveTdlibClient("org:interactive");
		const entry = opened.at(-1)!;
		driveToQrWait(entry);
		expect(entry.closed).toBe(false);
	});

	test("does not close an autoloaded session that resumes successfully", () => {
		resolveTdlibClient("org:healthy", { closeIfUnauthenticated: true });
		const entry = opened.at(-1)!;
		entry.emit({
			_: "updateAuthorizationState",
			authorization_state: { _: "authorizationStateReady" },
		});
		expect(entry.closed).toBe(false);
	});
});

describe("autoloaded session goes silent after closing", () => {
	/*
	 * THE RESIDUAL CHURN. tdl's close() is async and the update stream keeps
	 * running past the call, so a closed session went on emitting QR refreshes —
	 * each one re-entering the close path and re-logging. Measured 2026-07-28:
	 * after 24 sessions were closed, QR lines still appeared ~2 every 30s. The
	 * client must act on the FIRST waiting state and ignore everything after.
	 */
	test("closes once and ignores every later update", () => {
		resolveTdlibClient("org:noisy", { closeIfUnauthenticated: true });
		const entry = opened.at(-1)!;

		driveToQrWait(entry);
		expect(entry.closed).toBe(true);
		const closesAfterFirst = entry.closeCount;

		// TDLib keeps refreshing the token after close() is called.
		driveToQrWait(entry);
		driveToQrWait(entry);
		expect(entry.closeCount).toBe(closesAfterFirst);
	});
});
