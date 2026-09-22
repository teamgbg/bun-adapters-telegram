/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * send-handler.ts — outbound message send handler for the bridge mount.
 * X-API-Key gated like the connect handlers; resolves the per-account TDLib
 * client from the boot-time session store and invokes sendMessage with the
 * exact field shape the previous TS messaging adapter used in production
 * (topic/messageSendOptions defaults proven live before the Rust port).
 */
import type { ApiHandler } from "@teamscala/os/runtime-contracts/mount-context";
import { getTelegramClients, type TdlibClient } from "./client.ts";

interface SendBody {
	accountId?: unknown;
	chatId?: unknown;
	text?: unknown;
}

function telegramText(text: string): Record<string, unknown> {
	return {
		_: "inputMessageText",
		text: { _: "formattedText", text },
	};
}

/** The sendMessage invocation for a plain chat send. `topic_id` is OMITTED:
 * this TDLib build's MessageTopic union (thread/forum/direct-messages/saved-messages)
 * has no root/main class, so the TS-era adapter's `messageTopicRoot` is an unknown
 * class the runtime rejects (observed live 2026-08-15); absent fields default server-side. */
export function sendMessageInvokeArgs(chatId: number, text: string): Record<string, unknown> {
	return {
		_: "sendMessage",
		chat_id: chatId,
		reply_to: { _: "inputMessageReplyToMessage", message_id: 0, quote: null },
		options: {
			_: "messageSendOptions",
			disable_notification: false,
			from_background: false,
			protect_content: false,
			update_order_of_installed_sticker_sets: false,
		},
		reply_markup: null,
		input_message_content: telegramText(text),
	};
}

export function resolveConnectedClient(accountId: string): TdlibClient | undefined {
	return getTelegramClients().get(accountId)?.client;
}

export const telegramSend: ApiHandler = async (req: Request) => {	let body: SendBody = {};
	try {
		body = (await req.json()) as SendBody;
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}
	const accountId = typeof body.accountId === "string" ? body.accountId : "";
	const chatId = Number(body.chatId);
	const text = typeof body.text === "string" ? body.text : "";
	if (!accountId) return Response.json({ error: "accountId required" }, { status: 400 });
	if (!Number.isFinite(chatId) || chatId === 0) {
		return Response.json({ error: "chatId required" }, { status: 400 });
	}
	if (!text) return Response.json({ error: "text required" }, { status: 400 });

	const client = resolveConnectedClient(accountId);
	if (!client) {
		return Response.json(
			{ error: `Telegram account ${accountId} is not connected` },
			{ status: 409 },
		);
	}
	try {
		const message = await client.invoke(sendMessageInvokeArgs(chatId, text));
		return Response.json({ ok: true, message });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 500 },
		);
	}
};
