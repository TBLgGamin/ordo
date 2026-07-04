export type Resolution = { ok: true; pane: string } | { ok: false; candidates: string[] }

function isSubsequence(needle: string, hay: string): boolean {
	let i = 0
	for (let j = 0; j < hay.length && i < needle.length; j++) {
		if (hay[j] === needle[i]) i++
	}
	return i === needle.length
}

export function resolvePane(input: string, panes: string[]): Resolution {
	const q = input.trim()
	if (q === "") return { ok: false, candidates: [...panes] }
	if (panes.includes(q)) return { ok: true, pane: q }

	const lower = q.toLowerCase()

	const ciExact = panes.filter((p) => p.toLowerCase() === lower)
	if (ciExact.length === 1) return { ok: true, pane: ciExact[0] ?? q }
	if (ciExact.length > 1) return { ok: false, candidates: ciExact }

	const prefix = panes.filter((p) => p.toLowerCase().startsWith(lower))
	if (prefix.length === 1) return { ok: true, pane: prefix[0] ?? q }
	if (prefix.length > 1) return { ok: false, candidates: prefix }

	const subseq = panes.filter((p) => isSubsequence(lower, p.toLowerCase()))
	if (subseq.length === 1) return { ok: true, pane: subseq[0] ?? q }
	return { ok: false, candidates: subseq.length > 0 ? subseq : [...panes] }
}
