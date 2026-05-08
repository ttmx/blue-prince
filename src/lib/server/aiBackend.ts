import { env } from '$env/dynamic/private';
import { error, type RequestEvent } from '@sveltejs/kit';

export function ensureAiBackendUrl() {
	const backendUrl = env.AI_BACKEND_URL?.replace(/\/+$/, '');

	if (!backendUrl) {
		error(503, 'AI backend is not configured. Set AI_BACKEND_URL on the webapp server.');
	}

	return backendUrl;
}

export async function proxyAiBackend(event: RequestEvent, path: string) {
	const url = `${ensureAiBackendUrl()}${path}`;
	const headers = new Headers();
	const contentType = event.request.headers.get('content-type');
	const body = await event.request.arrayBuffer();

	if (contentType) {
		headers.set('content-type', contentType);
	}
	if (env.AI_BACKEND_API_KEY) {
		headers.set('authorization', `Bearer ${env.AI_BACKEND_API_KEY}`);
	}

	const response = await fetchAiBackend(() =>
		event.fetch(url, { method: event.request.method, headers, body })
	);

	return passThroughResponse(response);
}

export async function getAiBackend(path: string) {
	const headers = new Headers();

	if (env.AI_BACKEND_API_KEY) {
		headers.set('authorization', `Bearer ${env.AI_BACKEND_API_KEY}`);
	}

	const response = await fetchAiBackend(() => fetch(`${ensureAiBackendUrl()}${path}`, { headers }));
	return passThroughResponse(response);
}

async function fetchAiBackend(run: () => Promise<Response>) {
	try {
		return await run();
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : 'Unknown network error';
		error(502, `AI backend is unreachable: ${message}`);
	}
}

function passThroughResponse(response: Response) {
	const headers = new Headers(response.headers);
	headers.delete('content-encoding');
	headers.delete('content-length');
	headers.delete('transfer-encoding');

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
