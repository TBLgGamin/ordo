export type ReconnectAction = "resync" | "reopen" | "skip"

export const REOPEN_MIN_INTERVAL_MS = 5000

export function reconnectDecision(
	prevPid: number | undefined,
	newPid: number | undefined,
	lastReopenAt: number,
	now: number,
): ReconnectAction {
	if (prevPid !== undefined && newPid !== undefined && prevPid === newPid) return "resync"
	if (now - lastReopenAt < REOPEN_MIN_INTERVAL_MS) return "skip"
	return "reopen"
}
