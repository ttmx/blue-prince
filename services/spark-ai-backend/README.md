# Spark AI Backend

Private OCR and embedding service for the Blue Prince evidence board.

This backend intentionally has one model stack:

- OCR: PaddleOCR-VL served by vLLM's OpenAI-compatible `/v1/chat/completions` endpoint.
- Embeddings: `qwen3-embedding:8b` served by Ollama's OpenAI-compatible `/v1/embeddings` endpoint.

The public webapp calls this backend; this backend calls the private local model runtimes. No hosted OCR or browser embedding fallback lives in this service.

## API

All non-health endpoints require `Authorization: Bearer $SPARK_AI_API_KEY` when `SPARK_AI_API_KEY` is set.

### `GET /health`

Returns service status and model names.

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
  "model": "PaddlePaddle/PaddleOCR-VL",
  "provider": "paddleocr-vl-vllm"
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
  "model": "qwen3-embedding:8b",
  "provider": "ollama-openai-compatible"
}
```

## Configuration

Copy `.env.example` to `.env` and adjust it for your deployment.

Important variables:

- `SPARK_AI_API_KEY`: optional shared secret expected from your site backend.
- `OCR_BASE_URL`: vLLM `/v1` base URL, for example `http://127.0.0.1:18118/v1`.
- `OCR_API_KEY`: optional upstream API key for the vLLM endpoint.
- `OCR_MODEL`: PaddleOCR-VL model name served by vLLM.
- `EMBEDDING_BASE_URL`: Ollama OpenAI-compatible `/v1` base URL.
- `EMBEDDING_API_KEY`: optional upstream API key.
- `EMBEDDING_MODEL`: Ollama embedding model name.

Example:

```env
OCR_BASE_URL=http://127.0.0.1:18118/v1
OCR_MODEL=PaddlePaddle/PaddleOCR-VL
EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
EMBEDDING_MODEL=qwen3-embedding:8b
```

## Local Development

```sh
cd services/spark-ai-backend
python -m venv .venv
. .venv/bin/activate
pip install -e .
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
