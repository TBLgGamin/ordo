/** Message from an unknown thrown value, without assuming it's an Error. */
export function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

/** An expected, user-facing failure whose message should be shown without a stack. */
export class OrdoError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "OrdoError"
	}
}
