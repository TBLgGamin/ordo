import type { MergeOutcome } from "./agentSetup"

export interface GooseBlock {
	name: string
	cmd: string
	args: string[]
	timeout: number
}

function yamlDq(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function renderOrdoBlock(block: GooseBlock, indent: string): string[] {
	const argsInline = block.args.map(yamlDq).join(", ")
	return [
		`${indent}ordo:`,
		`${indent}  name: ${yamlDq(block.name)}`,
		`${indent}  cmd: ${yamlDq(block.cmd)}`,
		`${indent}  args: [${argsInline}]`,
		`${indent}  enabled: true`,
		`${indent}  type: stdio`,
		`${indent}  timeout: ${block.timeout}`,
	]
}

export function mergeGooseExtension(existing: string | null, block: GooseBlock): MergeOutcome {
	if (existing === null || existing.trim() === "") {
		return { action: "write", content: `extensions:\n${renderOrdoBlock(block, "  ").join("\n")}\n` }
	}
	if (/\t/.test(existing)) return { action: "skipped", detail: "tabs in goose config" }

	const lines = existing.split(/\r?\n/)
	const extIdx = lines.findIndex((l) => /^extensions:\s*$/.test(l))

	if (extIdx === -1) {
		if (/^extensions:/m.test(existing)) {
			return { action: "skipped", detail: "unrecognized extensions mapping" }
		}
		const sep = existing.endsWith("\n") ? "" : "\n"
		return {
			action: "write",
			content: `${existing}${sep}extensions:\n${renderOrdoBlock(block, "  ").join("\n")}\n`,
		}
	}

	let end = lines.length
	for (let i = extIdx + 1; i < lines.length; i++) {
		const l = lines[i]
		if (l === undefined || l.trim() === "") continue
		if (/^\S/.test(l)) {
			end = i
			break
		}
	}

	let childIndent = "  "
	for (let i = extIdx + 1; i < end; i++) {
		const l = lines[i]
		if (l && l.trim() !== "") {
			const m = l.match(/^(\s+)/)
			if (m?.[1]) childIndent = m[1]
			break
		}
	}

	const ordoRe = new RegExp(`^${childIndent}ordo:`)
	for (let i = extIdx + 1; i < end; i++) {
		const l = lines[i]
		if (l && ordoRe.test(l)) return { action: "unchanged" }
	}

	const insertion = renderOrdoBlock(block, childIndent)
	const out = [...lines.slice(0, extIdx + 1), ...insertion, ...lines.slice(extIdx + 1)]
	return { action: "write", content: out.join("\n") }
}
