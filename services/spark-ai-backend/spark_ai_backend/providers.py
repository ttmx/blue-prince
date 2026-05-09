import base64
from dataclasses import dataclass
from typing import Any

import httpx

from .config import Settings


PADDLEOCR_VL_VLLM_PROMPT = "OCR:"


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmbeddingResult:
    embeddings: list[list[float]]
    model: str


async def ocr_with_paddleocr_vl_vllm(
    image_bytes: bytes,
    mime_type: str,
    prompt: str | None,
    settings: Settings,
) -> str:
    image_base64 = base64.b64encode(image_bytes).decode("ascii")
    payload = {
        "model": settings.ocr_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{image_base64}"},
                    },
                    {"type": "text", "text": prompt or PADDLEOCR_VL_VLLM_PROMPT},
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": 2048,
    }

    data = await post_openai_compatible(
        base_url=settings.ocr_base_url,
        path="/chat/completions",
        api_key=settings.ocr_api_key.get_secret_value() if settings.ocr_api_key else None,
        payload=payload,
        timeout=settings.request_timeout_seconds,
    )

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise ProviderError("PaddleOCR-VL vLLM returned an unexpected response shape.") from error

    return str(content).strip()


async def embed_with_openai_compatible(
    inputs: list[str],
    model: str,
    settings: Settings,
) -> EmbeddingResult:
    payload = {"model": model, "input": inputs}
    data = await post_openai_compatible(
        base_url=settings.embedding_base_url,
        path="/embeddings",
        api_key=settings.embedding_api_key.get_secret_value() if settings.embedding_api_key else None,
        payload=payload,
        timeout=settings.request_timeout_seconds,
    )

    try:
        rows = sorted(data["data"], key=lambda item: item.get("index", 0))
        embeddings = [coerce_embedding(row["embedding"]) for row in rows]
    except (KeyError, TypeError) as error:
        raise ProviderError("Embedding provider returned an unexpected response shape.") from error

    return EmbeddingResult(embeddings=embeddings, model=str(data.get("model") or model))


async def post_openai_compatible(
    base_url: str,
    path: str,
    api_key: str | None,
    payload: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    url = f"{base_url.rstrip('/')}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as error:
        raise ProviderError(f"Could not reach model provider at {url}: {error}") from error

    if response.status_code >= 400:
        message = response.text.strip() or response.reason_phrase
        raise ProviderError(f"Model provider failed ({response.status_code}): {message}")

    try:
        return response.json()
    except ValueError as error:
        raise ProviderError("Model provider returned invalid JSON.") from error


def coerce_embedding(value: Any) -> list[float]:
    return [float(item) for item in value]
