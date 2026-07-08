const decoder = new TextDecoder()

export function runOsa(script: string): string | null {
	try {
		const res = Bun.spawnSync(["osascript", "-e", script], { stdin: "ignore" })
		if (!res.success) return null
		return decoder.decode(res.stdout).replace(/\n$/, "")
	} catch {
		return null
	}
}

export function runJxa(script: string): string | null {
	try {
		const res = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", script], { stdin: "ignore" })
		if (!res.success) return null
		return decoder.decode(res.stdout).replace(/\n$/, "")
	} catch {
		return null
	}
}
