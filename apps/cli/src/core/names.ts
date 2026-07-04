/**
 * Shared pool of Roman-era soldier types, used to name both sessions and panes.
 * Names are unique within their scope; on collision another soldier word is
 * appended in kebab-case (e.g. `centurion-optio`).
 */

export const ROMAN_SOLDIERS = [
	"legionary",
	"centurion",
	"optio",
	"tesserarius",
	"decanus",
	"signifer",
	"aquilifer",
	"cornicen",
	"buccinator",
	"evocatus",
	"immunis",
	"hastatus",
	"princeps",
	"triarius",
	"velite",
	"eques",
	"sagittarius",
	"funditor",
	"legate",
	"tribune",
	"decurion",
	"praetorian",
	"speculator",
	"cataphract",
	"vexillarius",
	"imaginifer",
	"ballistarius",
	"duplicarius",
	"cornicularius",
	"miles",
]

export function randomSoldier(): string {
	return ROMAN_SOLDIERS[Math.floor(Math.random() * ROMAN_SOLDIERS.length)] ?? "miles"
}

/** A soldier name not already in `taken`, extended with more words until free. */
export function pickUniqueName(taken: ReadonlySet<string>): string {
	let name = randomSoldier()
	while (taken.has(name)) name = `${name}-${randomSoldier()}`
	return name
}
