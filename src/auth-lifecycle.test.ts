// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";

import { attachTdlibAuthLifecycle } from "./auth-lifecycle.ts";

type UpdateHandler = (update: Record<string, unknown>) => void;

function fakeClient() {
	const handlers: UpdateHandler[] = [];
	return {
		on: (event: string, handler: UpdateHandler) => {
			if (event === "update") handlers.push(handler);
		},
		invoke: () => Promise.resolve({}),
		emit: (update: Record<string, unknown>) => {
			for (const h of handlers) h(update);
		},
	};
}

const QR_UPDATE = {
	_: "updateAuthorizationState",
	authorization_state: {
		_: "authorizationStateWaitOtherDeviceConfirmation",
		link: "tg://login?token=AQ-fixture",
	},
};

describe("attachTdlibAuthLifecycle isMuted", () => {
	test("dispatches status changes while unmuted", () => {
		const client = fakeClient();
		const seen: string[] = [];
		attachTdlibAuthLifecycle({
			client: client as never,
			onError: () => {},
			onStatusChange: (status) => seen.push(status),
		});
		client.emit(QR_UPDATE);
		expect(seen).toEqual(["waiting_qr"]);
	});

	/*
	 * THE RESIDUAL-CHURN FIX. Measured 2026-07-28: after the autoloader closed 24
	 * abandoned sessions, QR lines still appeared roughly twice every 30s, because
	 * closed clients kept emitting and every update was still logged and
	 * dispatched. A muted client must produce nothing at all.
	 */
	test("drops every update once muted", () => {
		const client = fakeClient();
		const seen: string[] = [];
		let muted = false;
		attachTdlibAuthLifecycle({
			client: client as never,
			isMuted: () => muted,
			onError: () => {},
			onStatusChange: (status) => seen.push(status),
		});

		client.emit(QR_UPDATE);
		expect(seen).toHaveLength(1);

		muted = true;
		client.emit(QR_UPDATE);
		client.emit(QR_UPDATE);
		expect(seen).toHaveLength(1);
	});
});
