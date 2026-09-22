/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * types.ts — describe what this file does.
 */
export interface TdlibClientOptions {
	apiId: number;
	apiHash: string;
	sessionDir: string;
	deviceModel?: string;
	useMessageDatabase?: boolean;
	useSecretChats?: boolean;
	systemLanguageCode?: string;
	applicationVersion?: string;
	systemVersion?: string;
}

export type AuthStatus =
	| "not_initialized"
	| "waiting_phone"
	| "waiting_code"
	| "waiting_qr"
	| "waiting_password"
	| "ready"
	| "closed"
	| "error";

export interface ClientState {
	status: AuthStatus;
	phoneNumber?: string;
	qrLink?: string;
	error?: string;
	connectionReady?: boolean;
}

export interface TdlibAuthState {
	_: string;
	[key: string]: unknown;
}

export interface TdlibClientEntry<TClient> {
	client: TClient;
	state: ClientState;
}
