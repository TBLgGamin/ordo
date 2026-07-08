/** Message from an unknown thrown value, without assuming it's an Error. */
export function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

export interface OrdoErrorOptions {
	hint?: string
	exitCode?: number
	code?: string
}

/** An expected, user-facing failure whose message should be shown without a stack. */
export class OrdoError extends Error {
	readonly hint?: string
	readonly exitCode: number
	readonly code?: string

	constructor(message: string, opts: OrdoErrorOptions = {}) {
		super(message)
		this.name = "OrdoError"
		this.hint = opts.hint
		this.exitCode = opts.exitCode ?? 1
		this.code = opts.code
	}
}

export function reportError(e: unknown): never {
	if (e instanceof OrdoError) {
		console.error(`ordo: ${e.message}`)
		if (e.hint) console.error(`  ${e.hint}`)
		process.exit(e.exitCode)
	}
	console.error(e)
	process.exit(1)
}
