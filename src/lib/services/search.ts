import { bufferToVector, db } from '$lib/services/db';
import { IMAGE_MODEL, embedImageQuery, embedQuery } from '$lib/services/ai.svelte';
import type { EvidenceItem, SearchResult } from '$lib/types/evidence';

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

export async function searchEvidence(
	items: EvidenceItem[],
	query: string,
	filters: SearchFilters
): Promise<SearchResult[]> {
	const normalizedQuery = normalize(query);
	const filtered = applyFilters(items, filters);

	if (!normalizedQuery) {
		return filtered.map((item) => ({ item, score: 0, reasons: [] }));
	}

	const terms = normalizedQuery.split(/\s+/).filter(Boolean);
	let queryVector: number[] | undefined;
	let imageQueryVector: number[] | undefined;

	try {
		[queryVector, imageQueryVector] = await Promise.all([embedQuery(query), embedImageQuery(query)]);
	} catch {
		queryVector = undefined;
		imageQueryVector = undefined;
	}

	const [textEmbeddings, imageEmbeddings] = await Promise.all([
		queryVector ? db.embeddings.where('modality').equals('text').toArray() : [],
		imageQueryVector
			? db.embeddings
					.where('modality')
					.equals('image')
					.filter((embedding) => embedding.modelId === IMAGE_MODEL)
					.toArray()
			: []
	]);
	const textVectorsByEvidence = new Map(
		textEmbeddings.map((embedding) => [embedding.evidenceId, bufferToVector(embedding.vector)])
	);
	const imageVectorsByEvidence = new Map(
		imageEmbeddings.map((embedding) => [embedding.evidenceId, bufferToVector(embedding.vector)])
	);

	return filtered
		.map((item) => {
			const haystack = normalize(
				[item.title, item.room, item.puzzle, item.tags.join(' '), item.ocrText, item.manualNotes].join(' ')
			);
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
