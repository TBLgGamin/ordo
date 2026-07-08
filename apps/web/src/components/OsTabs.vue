<script setup lang="ts">
import { computed, ref } from "vue"
import CopyCommand from "@/components/CopyCommand.vue"

const PS = "irm https://raw.githubusercontent.com/TBLgGamin/ordo/master/scripts/install.ps1 | iex"
const SH = "curl -fsSL https://raw.githubusercontent.com/TBLgGamin/ordo/master/scripts/install.sh | bash"

const tabs = [
	{ id: "windows", label: "Windows", command: PS, prompt: "PS>" },
	{ id: "macos", label: "macOS", command: SH, prompt: "$" },
	{ id: "linux", label: "Linux", command: SH, prompt: "$" },
]

function detectOs(): string {
	if (typeof navigator === "undefined") return "windows"
	const hint = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase()
	if (hint.includes("mac") || hint.includes("iphone") || hint.includes("ipad")) return "macos"
	if (hint.includes("linux") || hint.includes("android")) return "linux"
	return "windows"
}

const active = ref(detectOs())

const current = computed(() => tabs.find((t) => t.id === active.value) ?? tabs[0])
</script>

<template>
	<div class="w-full">
		<div class="mb-2 flex gap-1">
			<button
				v-for="t in tabs"
				:key="t.id"
				type="button"
				class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
				:class="t.id === active ? 'bg-pine-deep text-zinc-100' : 'text-stone hover:text-ink'"
				@click="active = t.id"
			>
				{{ t.label }}
			</button>
		</div>
		<CopyCommand :command="current.command" :prompt="current.prompt" />
	</div>
</template>
