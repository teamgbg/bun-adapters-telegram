/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * client-store.ts — describe what this file does.
 */
import path from "node:path";
import { mapTdlibAuthStatus } from "./auth-status.ts";
import type {
	AuthStatus,
	ClientState,
	TdlibAuthState,
	TdlibClientEntry,
} from "./types.ts";

export function getTdlibClientMap<TClient>(
	globalKey: string = "tdlibClients",
): Map<string, TdlibClientEntry<TClient>> {
	const globalStore = globalThis as Record<string, unknown>;
	if (!(globalStore[globalKey] instanceof Map)) {
		globalStore[globalKey] = new Map<string, TdlibClientEntry<TClient>>();
	}
	return globalStore[globalKey] as Map<string, TdlibClientEntry<TClient>>;
}

export function registerTrackedTdlibClient<TClient>(options: {
	clients: Map<string, TdlibClientEntry<TClient>>;
	key: string;
	client: TClient;
	initialState?: ClientState;
}): TdlibClientEntry<TClient> {
	const entry: TdlibClientEntry<TClient> = {
		client: options.client,
		state: options.initialState ?? { status: "not_initialized" },
	};
	options.clients.set(options.key, entry);
	return entry;
}

export function setTdlibClientStatus<TClient>(
	clients: Map<string, TdlibClientEntry<TClient>>,
	key: string,
	status: AuthStatus,
	patch?: Omit<Partial<ClientState>, "status">,
): void {
	const entry = clients.get(key);
	if (!entry) return;
	entry.state = {
		...entry.state,
		...patch,
		status,
	};
}

export function syncTdlibAuthState<TClient>(options: {
	clients: Map<string, TdlibClientEntry<TClient>>;
	key: string;
	authState: TdlibAuthState;
	onClosed?: () => void;
}): AuthStatus | null {
	const status = mapTdlibAuthStatus(options.authState);
	if (!status) {
		return null;
	}
	setTdlibClientStatus(options.clients, options.key, status);
	if (status === "closed") {
		options.clients.delete(options.key);
		options.onClosed?.();
	}
	return status;
}

export async function getTdlibFilesystemAuthStatus(options: {
	clients: Map<string, TdlibClientEntry<unknown>>;
	key: string;
	sessionDir: string;
}): Promise<ClientState> {
	const entry = options.clients.get(options.key);
	if (entry) return entry.state;
	if (await Bun.file(path.join(options.sessionDir, "db")).exists()) {
		return { status: "ready" };
	}
	return { status: "waiting_phone" };
}
