import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { db, vectorToBuffer } from '$lib/services/db';
import { blobToDataUrl, dataUrlToBlob } from '$lib/services/media';
import type { EvidenceEmbedding, EvidenceItem, OcrProvider } from '$lib/types/evidence';

type ExportedEvidence = Omit<EvidenceItem, 'imageBlob'> & {
	imageDataUrl?: string;
};

type ProjectExport = {
	version: 1;
	exportedAt: number;
	evidence: ExportedEvidence[];
	embeddings: Array<Omit<EvidenceEmbedding, 'id' | 'vector'> & { vector: number[] }>;
	scratchpad?: string;
	ocrProvider?: OcrProvider;
};

export async function exportProject() {
	const evidence = await db.evidence.orderBy('updatedAt').reverse().toArray();
	const embeddings = await db.embeddings.toArray();

	const project: ProjectExport = {
		version: 1,
		exportedAt: Date.now(),
		evidence: await Promise.all(
			evidence.map(async ({ imageBlob, ...item }) => ({
				...item,
				imageDataUrl: imageBlob ? await blobToDataUrl(imageBlob) : undefined
			}))
		),
		embeddings: embeddings.map(({ id, vector, ...embedding }) => ({
			...embedding,
			vector: Array.from(new Float32Array(vector))
		})),
		scratchpad: ((await db.settings.get('scratchpad'))?.value as string | undefined) ?? '',
		ocrProvider: (((await db.settings.get('ocrProvider'))?.value as OcrProvider | undefined) ?? 'tesseract')
	};

	const archive = zipSync({
		'blue-prince-project.json': strToU8(JSON.stringify(project))
	});

	const archiveCopy = new Uint8Array(archive.byteLength);
	archiveCopy.set(archive);

	return new Blob([archiveCopy], { type: 'application/zip' });
}

export async function importProject(file: File) {
	const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
	const projectFile = archive['blue-prince-project.json'];

	if (!projectFile) throw new Error('This archive does not contain a Blue Prince project.');

	const project = JSON.parse(strFromU8(projectFile)) as ProjectExport;
	if (project.version !== 1) throw new Error('Unsupported project export version.');

	await db.transaction('rw', db.evidence, db.embeddings, db.settings, async () => {
		for (const item of project.evidence) {
			const { imageDataUrl, ...evidence } = item;
			await db.evidence.put({
				...evidence,
				imageBlob: imageDataUrl ? await dataUrlToBlob(imageDataUrl) : undefined
			});
		}

		for (const embedding of project.embeddings) {
			await db.embeddings.add({
				...embedding,
				vector: vectorToBuffer(embedding.vector)
			});
		}

		if (typeof project.scratchpad === 'string') {
			await db.settings.put({ key: 'scratchpad', value: project.scratchpad });
		}

		if (project.ocrProvider === 'mistral' || project.ocrProvider === 'tesseract') {
			await db.settings.put({ key: 'ocrProvider', value: project.ocrProvider });
		}
	});
}
