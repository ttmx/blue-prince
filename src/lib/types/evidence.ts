export type EvidenceKind = 'screenshot' | 'note';
export type ProcessingState = 'idle' | 'queued' | 'processing' | 'complete' | 'failed';
export type EmbeddingModality = 'text' | 'image';
export type OcrProvider = 'tesseract' | 'mistral';

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

export type ModelStatus = {
	ocr: string;
	ocrProvider: OcrProvider;
	text: string;
	image: string;
	backend: 'detecting' | 'webgpu' | 'wasm';
	busy: boolean;
};
