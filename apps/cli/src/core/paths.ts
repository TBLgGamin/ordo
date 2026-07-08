import { homedir } from "node:os"
import { join } from "node:path"

function windowsBaseDir(): string {
	const root =
		process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? process.env.HOME
	if (!root) {
		throw new Error(
			"cannot locate a data directory: none of APPDATA, LOCALAPPDATA, USERPROFILE, HOME are set",
		)
	}
	return join(root, "ordo")
}

function darwinBaseDir(): string {
	const home = process.env.HOME ?? homedir()
	if (!home) throw new Error("cannot locate a data directory: HOME is not set")
	return join(home, "Library", "Application Support", "ordo")
}

function linuxBaseDir(): string {
	const xdg = process.env.XDG_DATA_HOME
	if (xdg && xdg.trim() !== "") return join(xdg, "ordo")
	const home = process.env.HOME ?? homedir()
	if (!home) throw new Error("cannot locate a data directory: neither XDG_DATA_HOME nor HOME is set")
	return join(home, ".local", "share", "ordo")
}

export function ordoBaseDir(): string {
	if (process.platform === "win32") return windowsBaseDir()
	if (process.platform === "darwin") return darwinBaseDir()
	return linuxBaseDir()
}
