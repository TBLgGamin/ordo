import { TITLE_DEBOUNCE_MS, TITLE_ENABLED } from "../core/config"
import { disposeTitleModel, generateTitle } from "./title"

/**
 * Debounced, auto-only session titling. Each new command resets the timer; when
 * activity settles we read the panes' recent scrollback and ask the local title
 * model for a name. Best-effort: failures leave the existing title (or id) in
 * place. Skips work when the activity is unchanged since the last title.
 */
export class SessionTitler {
	private timer?: ReturnType<typeof setTimeout>
	private busy = false
	/** Last activity text we titled, so we skip regenerating identical activity. */
	private lastTitledActivity?: string

	constructor(
		private readonly getActivity: () => string | null,
		private readonly onTitle: (title: string) => void,
	) {}

	schedule(): void {
		if (!TITLE_ENABLED) return
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => void this.regenerate(), TITLE_DEBOUNCE_MS)
	}

	private async regenerate(): Promise<void> {
		if (this.busy) return
		const activity = this.getActivity()
		if (!activity || activity === this.lastTitledActivity) return
		this.busy = true
		try {
			const title = await generateTitle(activity)
			this.lastTitledActivity = activity
			if (title) this.onTitle(title)
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
