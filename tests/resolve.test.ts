import { describe, expect, test } from "bun:test"
import { resolvePane } from "../src/cli/resolve"

const panes = ["saggitarius", "optio", "legate", "velite"]

describe("resolvePane", () => {
	test("exact match wins", () => {
		expect(resolvePane("optio", panes)).toEqual({ ok: true, pane: "optio" })
	})

	test("case-insensitive exact match", () => {
		expect(resolvePane("OPTIO", panes)).toEqual({ ok: true, pane: "optio" })
	})

	test("unique prefix resolves", () => {
		expect(resolvePane("sag", panes)).toEqual({ ok: true, pane: "saggitarius" })
		expect(resolvePane("leg", panes)).toEqual({ ok: true, pane: "legate" })
	})

	test("ambiguous prefix lists candidates", () => {
		const res = resolvePane("o", ["optio", "opto", "legate"])
		expect(res.ok).toBe(false)
		if (!res.ok) expect(res.candidates).toEqual(["optio", "opto"])
	})

	test("unique subsequence resolves when no prefix matches", () => {
		expect(resolvePane("vlt", panes)).toEqual({ ok: true, pane: "velite" })
	})

	test("exact wins over a longer prefix sibling", () => {
		expect(resolvePane("opt", ["opt", "option", "optio"])).toEqual({ ok: true, pane: "opt" })
	})

	test("no match returns all panes as candidates", () => {
		const res = resolvePane("zzz", panes)
		expect(res.ok).toBe(false)
		if (!res.ok) expect(res.candidates).toEqual(panes)
	})

	test("empty input is not resolvable", () => {
		const res = resolvePane("   ", panes)
		expect(res.ok).toBe(false)
	})
})
