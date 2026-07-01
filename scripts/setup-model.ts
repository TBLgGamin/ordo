import { resolveModelFile } from "node-llama-cpp"
import { MODELS_DIR, TITLE_MODEL_URI } from "../src/core/config"

const modelPath = await resolveModelFile(TITLE_MODEL_URI, {
	directory: MODELS_DIR,
	cli: true,
})

console.log(`Title model ready at ${modelPath}`)
