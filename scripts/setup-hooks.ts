import { chmodSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

Bun.spawnSync(["git", "-C", root, "config", "core.hooksPath", ".githooks"], { stdout: "inherit", stderr: "inherit" })

if (process.platform !== "win32") {
	try {
		chmodSync(join(root, ".githooks", "pre-commit"), 0o755)
	} catch {}
}

console.log("Git hooks enabled from .githooks")
