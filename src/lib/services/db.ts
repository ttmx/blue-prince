import Dexie, { type Table } from 'dexie';
import type { AppSetting, EvidenceEmbedding, EvidenceItem } from '$lib/types/evidence';

export class BluePrinceDatabase extends Dexie {
	evidence!: Table<EvidenceItem, string>;
	embeddings!: Table<EvidenceEmbedding, number>;
	settings!: Table<AppSetting, string>;

	constructor() {
		super('blue-prince-evidence-board');

		this.version(1).stores({
			evidence: 'id, kind, updatedAt, createdAt, processingState, *tags, room, puzzle',
			embeddings: '++id, evidenceId, [evidenceId+modality], modality, modelId',
			settings: 'key'
		});
	}
}

export const db = new BluePrinceDatabase();

export function createId(prefix = 'ev') {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

export async function getAllEvidence() {
	return db.evidence.orderBy('updatedAt').reverse().toArray();
}

export async function saveEvidencePatch(id: string, patch: Partial<EvidenceItem>) {
	await db.evidence.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteEvidence(id: string) {
	await db.transaction('rw', db.evidence, db.embeddings, async () => {
		await db.evidence.delete(id);
		await db.embeddings.where('evidenceId').equals(id).delete();
	});
}

export function vectorToBuffer(vector: number[] | Float32Array) {
	const array = vector instanceof Float32Array ? vector : new Float32Array(vector);
	const copy = new ArrayBuffer(array.byteLength);
	new Uint8Array(copy).set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
	return copy;
}

export function bufferToVector(buffer: ArrayBuffer) {
	return new Float32Array(buffer);
}
