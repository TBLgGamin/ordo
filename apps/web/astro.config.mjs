import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig } from "astro/config"
import vue from "@astrojs/vue"
import tailwindcss from "@tailwindcss/vite"

const root = realpathSync.native(fileURLToPath(new URL(".", import.meta.url)))

export default defineConfig({
	root,
	site: "https://ordo.example.com",
	integrations: [vue()],
	vite: {
		plugins: [tailwindcss()],
		ssr: {
			noExternal: ["reka-ui"],
		},
	},
})
