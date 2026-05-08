# Spark AI Backend

Private OCR and embedding service for replacing hosted Mistral OCR and browser-side embedding work.

This service is meant to run on the server that can reach the NVIDIA Spark/DGX box. The public site backend calls this service, and this service calls the private model endpoint. The Spark never needs to be reachable from the internet.

## API

All non-health endpoints require `Authorization: Bearer $SPARK_AI_API_KEY` when `SPARK_AI_API_KEY` is set.

### `GET /health`

Returns service status and configured providers.

### `POST /v1/ocr`

Accepts either JSON:

```json
{
  "image_base64": "...",
  "mime_type": "image/png",
  "prompt": "Extract all readable text."
}
```

or multipart form data:

```sh
curl -X POST "$SPARK_AI_URL/v1/ocr" \
  -H "Authorization: Bearer $SPARK_AI_API_KEY" \
  -F "file=@screenshot.png"
```

Returns:

```json
{
  "text": "extracted text",
  "model": "qwen2.5-vl:7b",
  "provider": "openai-compatible"
}
```

### `POST /v1/embeddings`

Accepts:

```json
{
  "input": ["a clue about the pantry", "another clue"]
}
```

or:

```json
{
  "input": "a clue about the pantry"
}
```

Returns OpenAI-style embeddings:

```json
{
  "data": [
    {
      "index": 0,
      "embedding": [0.01, 0.02]
    }
  ],
  "model": "nomic-embed-text",
  "provider": "openai-compatible"
}
```

## Configuration

Copy `.env.example` to `.env` and adjust it for your deployment.

Important variables:

- `SPARK_AI_API_KEY`: shared secret expected from your site backend.
- `OCR_PROVIDER`: `openai-compatible` or `disabled`.
- `OCR_BASE_URL`: private Spark model API base URL, for example `http://10.0.0.42:11434/v1`.
- `OCR_API_KEY`: optional upstream API key for the Spark endpoint.
- `OCR_MODEL`: vision-capable model name exposed by the Spark endpoint.
- `EMBEDDING_PROVIDER`: `openai-compatible`, `sentence-transformers`, or `disabled`.
- `EMBEDDING_BASE_URL`: private Spark embedding API base URL.
- `EMBEDDING_API_KEY`: optional upstream API key.
- `EMBEDDING_MODEL`: embedding model name.

For an Ollama deployment on the Spark, expose Ollama only on the private network and use its OpenAI-compatible `/v1` API:

```env
OCR_BASE_URL=http://spark-private-ip:11434/v1
OCR_MODEL=qwen2.5vl:7b
EMBEDDING_BASE_URL=http://spark-private-ip:11434/v1
EMBEDDING_MODEL=nomic-embed-text
```

For vLLM, llama.cpp server, NIM, or another OpenAI-compatible runtime, point the base URLs at that runtime's `/v1` root.

## Local Development

```sh
cd services/spark-ai-backend
python -m venv .venv
. .venv/bin/activate
pip install -e ".[local]"
uvicorn spark_ai_backend.main:app --reload --host 0.0.0.0 --port 8090
```

## Docker

```sh
cd services/spark-ai-backend
docker build -t spark-ai-backend .
docker run --env-file .env -p 8090:8090 spark-ai-backend
```

Or with Compose:

```sh
cd services/spark-ai-backend
docker compose up -d --build
```

## Example Site Backend Calls

OCR:

```ts
const form = new FormData();
form.append('file', screenshotBlob, 'screenshot.png');

const response = await fetch(`${SPARK_AI_URL}/v1/ocr`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${SPARK_AI_API_KEY}` },
  body: form
});
const { text } = await response.json();
```

Embeddings:

```ts
const response = await fetch(`${SPARK_AI_URL}/v1/embeddings`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${SPARK_AI_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ input: ['some searchable text'] })
});
const { data, model } = await response.json();
```
