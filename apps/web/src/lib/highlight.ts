import { createHighlighter } from "shiki"

const theme = "github-dark"
const languages = ["shellscript", "powershell"] as const

let highlighterPromise: ReturnType<typeof createHighlighter> | undefined

function getHighlighter() {
	highlighterPromise ??= createHighlighter({
		langs: [...languages],
		themes: [theme],
	})

	return highlighterPromise
}

export async function highlightTerminalCode(code: string, lang: (typeof languages)[number] = "shellscript") {
	const highlighter = await getHighlighter()

	return highlighter.codeToHtml(code, {
		lang,
		theme,
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
