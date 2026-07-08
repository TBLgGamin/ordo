import { OrdoError } from "../../core/errors"
import type { TerminalBackend, WindowHandle } from "../types"

const MSG = "ordo could not find a terminal emulator to open a window on this platform"

export const unsupportedTerminal: TerminalBackend = {
	id: "unsupported",
	minWindowWidth: 200,
	async spawnWindow(): Promise<{ handle?: WindowHandle }> {
		throw new OrdoError(MSG)
	},
	async openSelfWindow(): Promise<void> {
		throw new OrdoError(MSG)
	},
}
