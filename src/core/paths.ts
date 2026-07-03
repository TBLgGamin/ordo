import { join } from "node:path"

export function ordoBaseDir(): string {
	const root =
		process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? process.env.HOME
	if (!root) {
		throw new Error(
			"cannot locate a data directory: none of APPDATA, LOCALAPPDATA, USERPROFILE, HOME are set",
		)
	}
	return join(root, "ordo")
}
