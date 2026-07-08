<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { Monitor, Moon, Sun } from "lucide-vue-next"
import { Button } from "@/components/ui/button"

type Theme = "light" | "dark" | "system"

const STORAGE_KEY = "ordo-theme"
const CYCLE: readonly Theme[] = ["light", "dark", "system"]

const LABELS: Record<Theme, string> = {
	light: "Light mode",
	dark: "Dark mode",
	system: "System mode",
}

const theme = ref<Theme>("system")

const media = typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)")

function apply(value: Theme) {
	const dark = value === "dark" || (value === "system" && (media?.matches ?? false))
	document.documentElement.classList.toggle("dark", dark)
}

function onSystemChange() {
	if (theme.value === "system") apply("system")
}

onMounted(() => {
	const stored = localStorage.getItem(STORAGE_KEY)
	if (stored === "light" || stored === "dark" || stored === "system") {
		theme.value = stored
	}
	apply(theme.value)
	media?.addEventListener("change", onSystemChange)
})

onBeforeUnmount(() => {
	media?.removeEventListener("change", onSystemChange)
})

function cycle() {
	const next = CYCLE[(CYCLE.indexOf(theme.value) + 1) % CYCLE.length] ?? "system"
	theme.value = next
	localStorage.setItem(STORAGE_KEY, next)
	apply(next)
}

const icon = computed(() => {
	if (theme.value === "light") return Sun
	if (theme.value === "dark") return Moon
	return Monitor
})
</script>

<template>
	<Button
		type="button"
		variant="ghost"
		size="icon"
		:aria-label="`Toggle theme — current: ${LABELS[theme]}`"
		:title="LABELS[theme]"
		@click="cycle"
	>
		<component :is="icon" aria-hidden="true" />
	</Button>
</template>
