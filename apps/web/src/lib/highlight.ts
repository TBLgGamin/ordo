import { createHighlighter } from "shiki"

const themes = { light: "github-light", dark: "github-dark" } as const
const languages = ["shellscript", "powershell"] as const

let highlighterPromise: ReturnType<typeof createHighlighter> | undefined

function getHighlighter() {
	highlighterPromise ??= createHighlighter({
		langs: [...languages],
		themes: [themes.light, themes.dark],
	})

	return highlighterPromise
}

export async function highlightTerminalCode(code: string, lang: (typeof languages)[number] = "shellscript") {
	const highlighter = await getHighlighter()

	return highlighter.codeToHtml(code, {
		lang,
		themes,
		defaultColor: false,
		transformers: [
			{
				pre(node) {
					node.properties.class = "terminal-highlight"
					delete node.properties.style
				},
			},
		],
	})
}
