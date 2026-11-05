import {
	TITLE_DEBOUNCE_MS,
	TITLE_ENABLED,
	TITLE_FIRST_DELAY_MS,
	TITLE_MAX_WAIT_MS,
} from "../core/config"
import { disposeTitleModel, generateTitle } from "./title"

/**
 * Debounced, auto-only session titling. Each new command resets the trailing
 * timer; when activity settles we read the panes' recent scrollback and ask the
 * local title model for a name. Three timing rules make this feel responsive:
 *
 * - The FIRST title of a session fires after a short delay (TITLE_FIRST_DELAY_MS)
 *   so a fresh session doesn't sit on its id for a full debounce.
 * - Retitles use the trailing debounce (TITLE_DEBOUNCE_MS).
 * - Continuous activity can only postpone a retitle up to TITLE_MAX_WAIT_MS,
 *   so a busy session still refreshes its title periodically.
 *
 * Best-effort: failures leave the existing title (or id) in place. Skips work
 * when the activity is unchanged since the last title.
 */
export class SessionTitler {
	private timer?: ReturnType<typeof setTimeout>
	private busy = false
	/** Last activity text we titled, so we skip regenerating identical activity. */
	private lastTitledActivity?: string
	/** Whether this session has been titled at least once (first-title fast path). */
	private titled = false
	/** When the current burst of postponed activity started (max-wait cap). */
	private pendingSince?: number

	constructor(
		private readonly getActivity: () => string | null,
		private readonly onTitle: (title: string) => void,
	) {}

	schedule(): void {
		if (!TITLE_ENABLED) return
		const now = Date.now()
		if (this.pendingSince === undefined) this.pendingSince = now
		const delay = this.titled
			? Math.min(TITLE_DEBOUNCE_MS, Math.max(0, this.pendingSince + TITLE_MAX_WAIT_MS - now))
			: TITLE_FIRST_DELAY_MS
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => void this.regenerate(), delay)
	}

	private async regenerate(): Promise<void> {
		if (this.busy) return
		this.pendingSince = undefined
		const activity = this.getActivity()
		if (!activity || activity === this.lastTitledActivity) return
		this.busy = true
		try {
			const title = await generateTitle(activity)
			this.lastTitledActivity = activity
			if (title) {
				this.titled = true
				this.onTitle(title)
			}
		} finally {
			this.busy = false
		}
	}

	/** Cancel any pending timer and clear the dedupe/busy state (session closed). */
	reset(): void {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
		this.lastTitledActivity = undefined
		this.titled = false
		this.pendingSince = undefined
		this.busy = false
	}

	/** Cancel the pending timer and release the model (app teardown). */
	stopTimer(): void {
		if (this.timer) clearTimeout(this.timer)
		void disposeTitleModel()
	}

	/** Cancel the pending timer and await releasing the model (awaited teardown). */
	async dispose(): Promise<void> {
		if (this.timer) clearTimeout(this.timer)
		await disposeTitleModel()
	}
}
