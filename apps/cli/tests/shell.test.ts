import { describe, expect, test } from "bun:test"
import { runShellArgv, runShellSyntaxName, shellKind } from "../src/platform/shell"

describe("shellKind", () => {
	test("classifies common shells by basename", () => {
		expect(shellKind("pwsh")).toBe("pwsh")
		expect(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh")
		expect(shellKind("powershell.exe")).toBe("pwsh")
		expect(shellKind("/bin/bash")).toBe("bash")
		expect(shellKind("/usr/bin/zsh")).toBe("zsh")
		expect(shellKind("/opt/homebrew/bin/fish")).toBe("fish")
		expect(shellKind("/bin/sh")).toBe("other")
	})
})

describe("runShellArgv / runShellSyntaxName", () => {
	test("matches the host platform", () => {
		const argv = runShellArgv("echo hi")
		if (process.platform === "win32") {
			expect(argv).toContain("-Command")
			expect(argv.at(-1)).toBe("echo hi")
			expect(runShellSyntaxName()).toBe("PowerShell")
		} else {
			expect(argv).toEqual(["/bin/sh", "-c", "echo hi"])
			expect(runShellSyntaxName()).toBe("POSIX sh")
		}
	})
})
