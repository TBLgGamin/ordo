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
		class="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 [&_svg]:size-4"
		:aria-label="copied ? 'Copied' : 'Copy command'"
		@click="copyText"
	>
		<Check v-if="copied" class="text-arch" />
		<Copy v-else />
	</button>
</template>
