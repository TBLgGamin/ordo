import { homedir } from "node:os"
import { join } from "node:path"

function windowsBaseDir(): string {
	const appData = process.env.APPDATA
	if (appData && appData.trim() !== "") return join(appData, "ordo")
	// Sanitized environments (some MCP clients strip most env vars) may lack
	// APPDATA. Derive the standard roaming dir from the home directory so we
	// resolve the SAME path as processes launched with a full environment —
	// falling back to USERPROFILE\ordo would silently split the data dir.
	const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
	if (!home) {
		throw new Error(
			"cannot locate a data directory: APPDATA, USERPROFILE, and HOME are all unset",
		)
	}
	return join(home, "AppData", "Roaming", "ordo")
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
	const override = process.env.ORDO_DATA_DIR
	if (override && override.trim() !== "") return override
	if (process.platform === "win32") return windowsBaseDir()
	if (process.platform === "darwin") return darwinBaseDir()
	return linuxBaseDir()
}
