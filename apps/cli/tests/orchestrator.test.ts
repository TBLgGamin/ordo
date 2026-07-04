import { describe, expect, test } from "bun:test"
import { Orchestrator } from "../src/app/orchestrator"

describe("Orchestrator.stop", () => {
	test("is safe to call before start and idempotent", () => {
		const o = new Orchestrator()
		expect(() => {
			o.stop()
			o.stop()
		}).not.toThrow()
	})

	test("a fresh orchestrator tracks no panes", () => {
		const o = new Orchestrator()
		expect(o.list()).toHaveLength(0)
		o.stop()
	})
})
