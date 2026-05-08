import { db, getSetting, vectorToBuffer } from '$lib/services/db';
import { blobToDataUrl, createScaledImageBlob } from '$lib/services/media';
import type { EvidenceItem, ModelStatus, OcrProvider } from '$lib/types/evidence';

const TEXT_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const IMAGE_MODEL = 'onnx-community/siglip2-so400m-patch16-384-ONNX';
const OCR_LANG = 'eng';
const MISTRAL_OCR_MODEL = 'mistral-ocr-latest';

let ocrWorkerPromise: Promise<unknown> | undefined;
let textExtractorPromise: Promise<unknown> | undefined;
let imageExtractorPromise: Promise<unknown> | undefined;
let imageTextPromise:
	| Promise<{
			tokenizer: (text: string[], options: { padding: boolean; truncation: boolean }) => unknown;
			model: (inputs: unknown) => Promise<{ pooler_output: { data: Float32Array | number[] } }>;
	  }>
	| undefined;
let preferredDevice: 'webgpu' | 'wasm' | undefined;

export const modelStatus = $state<ModelStatus>({
	ocr: 'idle',
	ocrProvider: 'tesseract',
	text: 'idle',
	image: 'idle',
	backend: 'detecting',
	busy: false
});

function setBusy() {
	modelStatus.busy =
		modelStatus.ocr.startsWith('loading') ||
		modelStatus.ocr === 'processing' ||
		modelStatus.text.startsWith('loading') ||
		modelStatus.text === 'embedding' ||
		modelStatus.image.startsWith('loading') ||
		modelStatus.image === 'embedding' ||
		modelStatus.image === 'embedding query';
}

export function setOcrProvider(provider: OcrProvider) {
	modelStatus.ocrProvider = provider;
}

async function getPreferredDevice() {
	if (preferredDevice) return preferredDevice;

	preferredDevice = typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
	modelStatus.backend = preferredDevice;
	return preferredDevice;
}

async function withPreferredDevice<T>(load: (device: 'webgpu' | 'wasm') => Promise<T>) {
	const device = await getPreferredDevice();

	try {
		const result = await load(device);
		modelStatus.backend = device;
		return result;
	} catch (error) {
		if (device !== 'webgpu') throw error;

		console.warn('WebGPU model load failed; falling back to WASM.', error);
		preferredDevice = 'wasm';
		modelStatus.backend = 'wasm';
		return load('wasm');
	}
}

async function getOcrWorker() {
	if (!ocrWorkerPromise) {
		modelStatus.ocr = 'loading OCR';
		setBusy();
		ocrWorkerPromise = import('tesseract.js').then(async ({ createWorker }) => {
			const worker = await createWorker(OCR_LANG);
			modelStatus.ocr = 'ready';
			setBusy();
			return worker;
		});
	}

	return ocrWorkerPromise;
}

async function getTextExtractor() {
	if (!textExtractorPromise) {
		modelStatus.text = 'loading text model';
		setBusy();
		textExtractorPromise = import('@huggingface/transformers').then(async ({ pipeline }) => {
			const extractor = await withPreferredDevice((device) =>
				pipeline('feature-extraction', TEXT_MODEL, {
					device,
					progress_callback: (progress: { status?: string; progress?: number }) => {
						if (progress.progress) {
							modelStatus.text = `loading ${Math.round(progress.progress)}%`;
							setBusy();
						}
					}
				})
			);
			modelStatus.text = 'ready';
			setBusy();
			return extractor;
		});
	}

	return textExtractorPromise;
}

async function getImageExtractor() {
	if (!imageExtractorPromise) {
		modelStatus.image = 'loading image model';
		setBusy();
		imageExtractorPromise = import('@huggingface/transformers').then(async ({ pipeline }) => {
			const extractor = await withPreferredDevice((device) =>
				pipeline('image-feature-extraction', IMAGE_MODEL, {
					device,
					progress_callback: (progress: { status?: string; progress?: number }) => {
						if (progress.progress) {
							modelStatus.image = `loading ${Math.round(progress.progress)}%`;
							setBusy();
						}
					}
				})
			);
			modelStatus.image = 'ready';
			setBusy();
			return extractor;
		});
	}

	return imageExtractorPromise;
}

export async function processEvidence(item: EvidenceItem) {
	if (item.kind === 'note') {
		await embedEvidenceText(item);
		return;
	}

	if (!item.imageBlob) return;

	await db.evidence.update(item.id, {
		processingState: 'processing',
		processingMessage: 'Reading screenshot text',
		updatedAt: Date.now()
	});

	try {
		modelStatus.ocr = 'processing';
		setBusy();
		const ocrText = await runOcr(item.imageBlob);

		await db.evidence.update(item.id, {
			ocrText,
			processingMessage: 'Embedding clues',
			updatedAt: Date.now()
		});

		const latest = await db.evidence.get(item.id);
		if (latest) {
			await Promise.all([embedEvidenceText(latest), embedEvidenceImage(latest)]);
		}

		await db.evidence.update(item.id, {
			processingState: 'complete',
			processingMessage: 'Indexed',
			error: undefined,
			updatedAt: Date.now()
		});
		modelStatus.ocr = 'ready';
		setBusy();
	} catch (error) {
		await db.evidence.update(item.id, {
			processingState: 'failed',
			processingMessage: 'Processing failed',
			error: error instanceof Error ? error.message : 'Unknown processing error',
			updatedAt: Date.now()
		});
		modelStatus.ocr = 'failed';
		setBusy();
	}
}

async function runOcr(blob: Blob) {
	if (modelStatus.ocrProvider === 'mistral') {
		return runMistralOcr(blob);
	}

	return runTesseractOcr(blob);
}

async function runTesseractOcr(blob: Blob) {
	const worker = (await getOcrWorker()) as {
		recognize: (image: Blob) => Promise<{ data: { text: string } }>;
	};
	const ocrImage = await createScaledImageBlob(blob);
	const result = await worker.recognize(ocrImage);
	return result.data.text.trim();
}

async function runMistralOcr(blob: Blob) {
	const apiKey = (await getSetting('mistralApiKey', '')).trim();
	if (!apiKey) {
		throw new Error('Mistral OCR is selected, but no Mistral API key is saved.');
	}

	const response = await fetch('https://api.mistral.ai/v1/ocr', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: MISTRAL_OCR_MODEL,
			document: {
				type: 'image_url',
				image_url: await blobToDataUrl(blob)
			}
		})
	});

	if (!response.ok) {
		const message = await response.text();
		throw new Error(`Mistral OCR failed (${response.status}): ${message || response.statusText}`);
	}

	const result = (await response.json()) as { pages?: Array<{ markdown?: string }> };
	return (result.pages ?? [])
		.map((page) => page.markdown?.trim())
		.filter(Boolean)
		.join('\n\n');
}

export async function embedEvidenceText(item: EvidenceItem) {
	const text = [item.title, item.room, item.puzzle, item.tags.join(' '), item.ocrText, item.manualNotes]
		.filter(Boolean)
		.join('\n')
		.trim();

	if (!text) return;

	modelStatus.text = 'embedding';
	setBusy();
	const vector = await embedText(text);
	await upsertEmbedding(item.id, 'text', TEXT_MODEL, vector);
	modelStatus.text = 'ready';
	setBusy();
}

export async function embedEvidenceImage(item: EvidenceItem) {
	if (!item.imageBlob) return;

	modelStatus.image = 'embedding';
	setBusy();
	const vector = await embedImage(item.imageBlob);
	await upsertEmbedding(item.id, 'image', IMAGE_MODEL, vector);
	modelStatus.image = 'ready';
	setBusy();
}

export async function embedQuery(query: string) {
	return embedText(query);
}

export async function embedImageQuery(query: string) {
	if (!imageTextPromise) {
		modelStatus.image = 'loading SigLIP text';
		setBusy();
		imageTextPromise = import('@huggingface/transformers').then(async ({ AutoTokenizer, SiglipTextModel }) => {
			const tokenizer = await AutoTokenizer.from_pretrained(IMAGE_MODEL);
			const model = await withPreferredDevice((device) =>
				SiglipTextModel.from_pretrained(IMAGE_MODEL, { device })
			);
			modelStatus.image = 'ready';
			setBusy();
			return { tokenizer, model };
		});
	}

	modelStatus.image = 'embedding query';
	setBusy();
	const { tokenizer, model } = await imageTextPromise;
	const inputs = tokenizer([query], { padding: true, truncation: true });
	const output = await model(inputs);
	modelStatus.image = 'ready';
	setBusy();
	return normalizeVector(Array.from(output.pooler_output.data));
}

async function embedText(text: string) {
	const extractor = (await getTextExtractor()) as (
		input: string,
		options: { pooling: string; normalize: boolean }
	) => Promise<{ data: Float32Array | number[] }>;
	const output = await extractor(text, { pooling: 'mean', normalize: true });
	return Array.from(output.data);
}

async function embedImage(blob: Blob) {
	const extractor = (await getImageExtractor()) as (
		input: string,
		options: { pool: boolean }
	) => Promise<{ data: Float32Array | number[] }>;
	const url = URL.createObjectURL(blob);

	try {
		const output = await extractor(url, { pool: true });
		return normalizeVector(Array.from(output.data));
	} finally {
		URL.revokeObjectURL(url);
	}
}

function normalizeVector(vector: number[]) {
	const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
	return magnitude ? vector.map((value) => value / magnitude) : vector;
}

async function upsertEmbedding(
	evidenceId: string,
	modality: 'text' | 'image',
	modelId: string,
	vector: number[]
) {
	await db.embeddings.where({ evidenceId, modality }).delete();
	await db.embeddings.add({
		evidenceId,
		modality,
		modelId,
		vector: vectorToBuffer(vector),
		dimensions: vector.length,
		createdAt: Date.now()
	});
}
