<script setup lang="ts">
import { ref } from "vue"
import { Check, Copy } from "lucide-vue-next"

const props = defineProps<{ text: string }>()

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function copyText() {
	await navigator.clipboard.writeText(props.text)
	copied.value = true
	if (timer) clearTimeout(timer)
	timer = setTimeout(() => {
		copied.value = false
	}, 1600)
}
</script>

<template>
	<button
		type="button"
		class="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none [&_svg]:size-4"
		:aria-label="copied ? 'Copied' : 'Copy command'"
		@click="copyText"
	>
		<Check v-if="copied" class="text-ring" />
		<Copy v-else />
	</button>
</template>
