// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { sendMessageInvokeArgs, telegramSend } from "./send-handler.ts";
import { getTdlibClientMap, registerTrackedTdlibClient } from "./client-store.ts";
import type { TdlibClient } from "./client.ts";

function call(body: unknown): Promise<Response> | Response {
	return telegramSend(
		new Request("http://bridge.test/api/messaging/telegram/send", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		{},
	);
}

function callRaw(raw: string): Promise<Response> | Response {
	return telegramSend(
		new Request("http://bridge.test/api/messaging/telegram/send", {
			method: "POST",
			body: raw,
		}),
		{},
	);
}

function installFakeClient(accountId: string): { invocations: Record<string, unknown>[] } {
	const invocations: Record<string, unknown>[] = [];
	const client: TdlibClient = {
		invoke: async (query) => {
			invocations.push(query);
			return { _: "message", id: 42 };
		},
		close: async () => {},
		on: () => {},
	};
	registerTrackedTdlibClient({ clients: getTdlibClientMap<TdlibClient>(), key: accountId, client });
	return { invocations };
}

describe("telegramSend", () => {
	test("sends through the connected client with the proven invoke shape", async () => {
		const { invocations } = installFakeClient("send-ok");
		const response = await call({ accountId: "send-ok", chatId: 123456, text: "hello from the bridge" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
		expect(invocations).toHaveLength(1);
		expect(invocations[0]).toEqual(sendMessageInvokeArgs(123456, "hello from the bridge"));
		expect(invocations[0]?.chat_id).toBe(123456);
		expect(
			(invocations[0]?.input_message_content as { text: { text: string } }).text.text,
		).toBe("hello from the bridge");
	});

	test("a numeric-string chatId is accepted (gateway sends strings)", async () => {
		const { invocations } = installFakeClient("send-str");
		const response = await call({ accountId: "send-str", chatId: "987654", text: "hi" });
		expect(response.status).toBe(200);
		expect(invocations[0]?.chat_id).toBe(987654);
	});

	test("an unconnected account is a 409 naming the account", async () => {
		const response = await call({ accountId: "never-connected", chatId: 1, text: "hi" });
		expect(response.status).toBe(409);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("never-connected");
	});

	test("missing fields are 400s", async () => {
		expect((await call({ chatId: 1, text: "hi" })).status).toBe(400);
		expect((await call({ accountId: "a" })).status).toBe(400);
		expect((await call({ accountId: "a", chatId: "not-a-number", text: "" })).status).toBe(400);
	});

	test("invalid JSON is a 400", async () => {
		expect((await callRaw("not json")).status).toBe(400);
	});

	test("a failing invoke surfaces as 500 with the message", async () => {
		const accountId = "send-err";
		const client: TdlibClient = {
			invoke: async () => {
				throw new Error("PHRASE_INVALID");
			},
			close: async () => {},
			on: () => {},
		};
		registerTrackedTdlibClient({ clients: getTdlibClientMap<TdlibClient>(), key: accountId, client });
		const response = await call({ accountId, chatId: 1, text: "x" });
		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("PHRASE_INVALID");
	});
});
