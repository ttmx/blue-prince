import { bufferToVector, db } from '$lib/services/db';
import { IMAGE_MODEL, embedImageQuery, embedQuery } from '$lib/services/ai.svelte';
import type { EvidenceItem, SearchResult, SearchTelemetry } from '$lib/types/evidence';

export type SearchFilters = {
	kind: 'all' | 'screenshot' | 'note';
	tag: string;
	room: string;
	puzzle: string;
};

const emptyFilters: SearchFilters = {
	kind: 'all',
	tag: '',
	room: '',
	puzzle: ''
};

export function defaultFilters() {
	return { ...emptyFilters };
}

export function keywordSearchEvidence(
	items: EvidenceItem[],
	query: string,
	filters: SearchFilters
): SearchResult[] {
	const normalizedQuery = normalize(query);
	const filtered = applyFilters(items, filters);

	if (!normalizedQuery) {
		return filtered.map((item) => ({ item, score: 0, reasons: [] }));
	}

	const terms = normalizedQuery.split(/\s+/).filter(Boolean);

	const results = filtered
		.map((item) => {
			const haystack = searchableText(item);
			const matchedTerms = terms.filter((term) => haystack.includes(term));
			const keywordScore = terms.length ? matchedTerms.length / terms.length : 0;

			return {
				item,
				score: keywordScore,
				reasons: matchedTerms.length
					? [`${matchedTerms.length} keyword match${matchedTerms.length === 1 ? '' : 'es'}`]
					: []
			};
		})
		.filter((result) => result.score > 0 || result.reasons.length > 0)
		.sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt);

	return results;
}

export async function searchEvidence(
	items: EvidenceItem[],
	query: string,
	filters: SearchFilters,
	onTelemetry?: (telemetry: SearchTelemetry) => void
): Promise<SearchResult[]> {
	const telemetry: SearchTelemetry = {
		phase: 'Preparing search',
		startedAt: performance.now()
	};
	onTelemetry?.({ ...telemetry });

	const normalizedQuery = normalize(query);
	const filtered = applyFilters(items, filters);

	if (!normalizedQuery) {
		telemetry.phase = 'Ready';
		telemetry.finishedAt = performance.now();
		onTelemetry?.({ ...telemetry });
		return filtered.map((item) => ({ item, score: 0, reasons: [] }));
	}

	const terms = normalizedQuery.split(/\s+/).filter(Boolean);
	let queryVector: number[] | undefined;
	let imageQueryVector: number[] | undefined;

	telemetry.phase = 'Loading saved vectors';
	onTelemetry?.({ ...telemetry });
	const [textEmbeddings, imageEmbeddings] = await Promise.all([
		db.embeddings.where('modality').equals('text').toArray(),
		db.embeddings
			.where('modality')
			.equals('image')
			.filter((embedding) => embedding.modelId === IMAGE_MODEL)
			.toArray()
	]);

	telemetry.phase = 'Embedding query';
	onTelemetry?.({ ...telemetry });
	const [textQueryResult, imageQueryResult] = await Promise.allSettled([
		textEmbeddings.length ? timed('text', () => embedQuery(query)) : Promise.resolve(undefined),
		imageEmbeddings.length ? timed('image', () => embedImageQuery(query)) : Promise.resolve(undefined)
	]);

	if (textQueryResult.status === 'fulfilled') {
		queryVector = textQueryResult.value?.value;
		telemetry.textEmbeddingMs = textQueryResult.value?.durationMs;
	}
	if (imageQueryResult.status === 'fulfilled') {
		imageQueryVector = imageQueryResult.value?.value;
		telemetry.imageEmbeddingMs = imageQueryResult.value?.durationMs;
	}
	if (textQueryResult.status === 'rejected' || imageQueryResult.status === 'rejected') {
		telemetry.error = [textQueryResult, imageQueryResult]
			.filter((result) => result.status === 'rejected')
			.map((result) => (result as PromiseRejectedResult).reason)
			.map((reason) => (reason instanceof Error ? reason.message : String(reason)))
			.join(' ');
		console.warn('Search embedding failed', telemetry.error);
	}
	console.info('Search embedding timings', {
		query,
		textEmbeddingMs: telemetry.textEmbeddingMs,
		imageEmbeddingMs: telemetry.imageEmbeddingMs
	});

	telemetry.phase = 'Scoring evidence';
	onTelemetry?.({ ...telemetry });
	const vectorStartedAt = performance.now();
	const textVectorsByEvidence = new Map(
		textEmbeddings.map((embedding) => [embedding.evidenceId, bufferToVector(embedding.vector)])
	);
	const imageVectorsByEvidence = new Map(
		imageEmbeddings.map((embedding) => [embedding.evidenceId, bufferToVector(embedding.vector)])
	);

	const results = filtered
		.map((item) => {
			const haystack = searchableText(item);
			const matchedTerms = terms.filter((term) => haystack.includes(term));
			const keywordScore = terms.length ? matchedTerms.length / terms.length : 0;
			const textVector = textVectorsByEvidence.get(item.id);
			const imageVector = imageVectorsByEvidence.get(item.id);
			const semanticScore = queryVector && textVector ? cosine(queryVector, textVector) : 0;
			const imageScore = imageQueryVector && imageVector ? cosine(imageQueryVector, imageVector) : 0;
			const score =
				keywordScore * 0.45 + Math.max(0, semanticScore) * 0.3 + Math.max(0, imageScore) * 0.25;
			const reasons = [
				...(matchedTerms.length ? [`${matchedTerms.length} keyword match${matchedTerms.length === 1 ? '' : 'es'}`] : []),
				...(semanticScore > 0.25 ? ['semantic text'] : []),
				...(imageScore > 0.2 ? ['visual match'] : [])
			];

			return { item, score, reasons };
		})
		.filter((result) => result.score > 0 || result.reasons.length > 0)
		.sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt);

	telemetry.vectorSearchMs = performance.now() - vectorStartedAt;
	telemetry.finishedAt = performance.now();
	telemetry.phase = 'Ready';
	onTelemetry?.({ ...telemetry });

	return results;
}

function searchableText(item: EvidenceItem) {
	return normalize([item.title, item.room, item.puzzle, item.tags.join(' '), item.ocrText, item.manualNotes].join(' '));
}

function applyFilters(items: EvidenceItem[], filters: SearchFilters) {
	return items.filter((item) => {
		if (filters.kind !== 'all' && item.kind !== filters.kind) return false;
		if (filters.tag && !item.tags.some((tag) => normalize(tag) === normalize(filters.tag))) return false;
		if (filters.room && normalize(item.room) !== normalize(filters.room)) return false;
		if (filters.puzzle && normalize(item.puzzle) !== normalize(filters.puzzle)) return false;
		return true;
	});
}

function normalize(value: string) {
	return value.toLowerCase().trim();
}

function cosine(query: number[], vector: Float32Array) {
	const length = Math.min(query.length, vector.length);
	let dot = 0;
	let queryMagnitude = 0;
	let vectorMagnitude = 0;

	for (let index = 0; index < length; index += 1) {
		dot += query[index] * vector[index];
		queryMagnitude += query[index] * query[index];
		vectorMagnitude += vector[index] * vector[index];
	}

	if (!queryMagnitude || !vectorMagnitude) return 0;
	return dot / (Math.sqrt(queryMagnitude) * Math.sqrt(vectorMagnitude));
}

async function timed<T>(label: string, run: () => Promise<T>) {
	const startedAt = performance.now();
	const value = await run();
	const durationMs = performance.now() - startedAt;
	console.info(`${label} embedding finished in ${Math.round(durationMs)}ms`);
	return { value, durationMs };
}
