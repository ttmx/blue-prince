import { proxyAiBackend } from '$lib/server/aiBackend';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	return proxyAiBackend(event, '/v1/embeddings');
};
