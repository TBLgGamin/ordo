import { describe, expect, test } from "bun:test"
import { errMessage, OrdoError, reportError } from "../src/core/errors"

describe("OrdoError", () => {
	test("defaults to exit code 1 and no hint/code", () => {
		const e = new OrdoError("boom")
		expect(e.exitCode).toBe(1)
		expect(e.hint).toBeUndefined()
		expect(e.code).toBeUndefined()
		expect(e).toBeInstanceOf(Error)
	})
	test("carries hint, exitCode and code", () => {
		const e = new OrdoError("boom", { hint: "try again", exitCode: 2, code: "no-owner" })
		expect(e.exitCode).toBe(2)
		expect(e.hint).toBe("try again")
		expect(e.code).toBe("no-owner")
	})
})

describe("errMessage", () => {
	test("reads Error messages and stringifies the rest", () => {
		expect(errMessage(new Error("x"))).toBe("x")
		expect(errMessage("plain")).toBe("plain")
		expect(errMessage(42)).toBe("42")
	})
})

function captureReport(e: unknown): { lines: string[]; exit: number } {
	const lines: string[] = []
	const realError = console.error
	const realExit = process.exit
	console.error = (...args: unknown[]) => {
		lines.push(args.join(" "))
	}
	process.exit = ((code?: number) => {
		throw new Error(`__exit_${code ?? 0}`)
	}) as typeof process.exit
	let exit = -1
	try {
		reportError(e)
	} catch (thrown) {
		const m = /^__exit_(\d+)$/.exec(errMessage(thrown))
		if (m?.[1]) exit = Number(m[1])
		else throw thrown
	} finally {
		console.error = realError
		process.exit = realExit
	}
	return { lines, exit }
}

describe("reportError", () => {
	test("prints an OrdoError as a clean message with its exit code", () => {
		const { lines, exit } = captureReport(new OrdoError("no saved session", { exitCode: 2 }))
		expect(lines).toEqual(["ordo: no saved session"])
		expect(exit).toBe(2)
	})
	test("prints the hint on its own indented line", () => {
		const { lines, exit } = captureReport(new OrdoError("not reachable", { hint: "open ordo" }))
		expect(lines).toEqual(["ordo: not reachable", "  open ordo"])
		expect(exit).toBe(1)
	})
	test("dumps unexpected errors raw and exits 1", () => {
		const err = new Error("unexpected")
		const { lines, exit } = captureReport(err)
		expect(lines).toEqual([String(err)])
		expect(exit).toBe(1)
	})
})
