<script setup lang="ts">
import { ref } from "vue"
import { Check, Copy } from "lucide-vue-next"
import { Button } from "@/components/ui/button"

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
	<div class="flex w-full items-center gap-2 rounded-lg border bg-card py-1.5 pr-1.5 pl-4 font-mono text-sm">
		<span class="select-none text-primary">{{ props.prompt ?? ">" }}</span>
		<code class="flex-1 overflow-x-auto py-1.5 whitespace-nowrap">{{ props.command }}</code>
		<Button
			variant="ghost"
			size="icon"
			:aria-label="copied ? 'Copied' : 'Copy command'"
			@click="copyCommand"
		>
			<Check v-if="copied" class="text-primary" />
			<Copy v-else />
		</Button>
	</div>
</template>
