export type EvidenceKind = 'screenshot' | 'note';
export type ProcessingState = 'idle' | 'queued' | 'processing' | 'complete' | 'failed';
export type EmbeddingModality = 'text' | 'image';
export type OcrProvider = 'tesseract' | 'mistral' | 'server';
export type TextEmbeddingProvider = 'browser' | 'server';

export type EvidenceItem = {
	id: string;
	kind: EvidenceKind;
	title: string;
	createdAt: number;
	updatedAt: number;
	imageBlob?: Blob;
	thumbnail?: string;
	ocrText: string;
	manualNotes: string;
	tags: string[];
	room: string;
	puzzle: string;
	processingState: ProcessingState;
	processingMessage?: string;
	error?: string;
};

export type EvidenceEmbedding = {
	id?: number;
	evidenceId: string;
	modality: EmbeddingModality;
	modelId: string;
	vector: ArrayBuffer;
	dimensions: number;
	createdAt: number;
};

export type AppSetting = {
	key: string;
	value: unknown;
};

export type SearchResult = {
	item: EvidenceItem;
	score: number;
	reasons: string[];
};

export type SearchTelemetry = {
	phase: string;
	startedAt: number;
	finishedAt?: number;
	textEmbeddingMs?: number;
	imageEmbeddingMs?: number;
	vectorSearchMs?: number;
	error?: string;
};

export type ModelStatus = {
	ocr: string;
	ocrProvider: OcrProvider;
	textProvider: TextEmbeddingProvider;
	text: string;
	image: string;
	backend: 'detecting' | 'webgpu' | 'wasm' | 'server';
	busy: boolean;
};
