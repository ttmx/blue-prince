export async function fileToEvidenceImage(file: File | Blob) {
	const imageBlob = file instanceof File ? file : new Blob([file], { type: file.type || 'image/png' });
	const thumbnail = await createThumbnail(imageBlob);
	return { imageBlob, thumbnail };
}

export async function createThumbnail(blob: Blob, maxEdge = 520) {
	return createScaledDataUrl(blob, maxEdge, 'image/jpeg', 0.82);
}

export async function createScaledImageBlob(blob: Blob, maxEdge = 1800) {
	const dataUrl = await createScaledDataUrl(blob, maxEdge, 'image/png');
	const response = await fetch(dataUrl);
	return response.blob();
}

async function createScaledDataUrl(blob: Blob, maxEdge: number, type: string, quality?: number) {
	const url = URL.createObjectURL(blob);

	try {
		const image = await loadImage(url);
		const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(image.width * scale));
		canvas.height = Math.max(1, Math.round(image.height * scale));
		const context = canvas.getContext('2d');

		if (!context) throw new Error('Canvas is unavailable in this browser.');
		context.imageSmoothingQuality = 'high';
		context.drawImage(image, 0, 0, canvas.width, canvas.height);

		return canvas.toDataURL(type, quality);
	} finally {
		URL.revokeObjectURL(url);
	}
}

function loadImage(url: string) {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error('Could not read that image.'));
		image.src = url;
	});
}

export async function blobToDataUrl(blob: Blob) {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('Could not read blob.'));
		reader.readAsDataURL(blob);
	});
}

export async function dataUrlToBlob(dataUrl: string) {
	const response = await fetch(dataUrl);
	return response.blob();
}
