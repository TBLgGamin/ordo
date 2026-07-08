<script setup lang="ts">
import { ref } from "vue"
import { Check, Copy } from "lucide-vue-next"

const props = defineProps<{ command: string; prompt?: string }>()

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function copyCommand() {
	await navigator.clipboard.writeText(props.command)
	copied.value = true
	if (timer) clearTimeout(timer)
	timer = setTimeout(() => {
		copied.value = false
	}, 1600)
}
</script>

<template>
	<div
		class="flex w-full items-center gap-2 rounded-xl bg-pine-deep py-1.5 pr-1.5 pl-4 font-mono text-sm text-zinc-100 shadow-lg shadow-black/10"
	>
		<span class="select-none text-arch">{{ props.prompt ?? ">" }}</span>
		<code class="flex-1 overflow-x-auto py-1.5 whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{{ props.command }}</code>
		<button
			type="button"
			class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 [&_svg]:size-4"
			:aria-label="copied ? 'Copied' : 'Copy command'"
			@click="copyCommand"
		>
			<Check v-if="copied" class="text-arch" />
			<Copy v-else />
		</button>
	</div>
</template>
