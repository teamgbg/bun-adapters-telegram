/**
 * @system telegram
 * @status handwritten
 * @edit edit directly
 *
 * auth-status.ts — describe what this file does.
 */
import type { AuthStatus, TdlibAuthState } from "./types.ts";

export function mapTdlibAuthStatus(
	authState: TdlibAuthState,
): AuthStatus | null {
	switch (authState._) {
		case "authorizationStateWaitPhoneNumber":
			return "waiting_phone";
		case "authorizationStateWaitCode":
			return "waiting_code";
		case "authorizationStateWaitOtherDeviceConfirmation":
			return "waiting_qr";
		case "authorizationStateWaitPassword":
			return "waiting_password";
		case "authorizationStateReady":
			return "ready";
		case "authorizationStateClosed":
			return "closed";
		default:
			return null;
	}
}
