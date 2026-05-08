import { getAiBackend } from '$lib/server/aiBackend';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return getAiBackend('/health');
};
