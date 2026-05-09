import base64
import binascii
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import Settings, get_settings
from .providers import (
    EmbeddingResult,
    ProviderError,
    embed_with_openai_compatible,
    ocr_with_paddleocr_vl_vllm,
)
from .security import require_api_key

app = FastAPI(
    title="Spark AI Backend",
    description="Private OCR and embedding API for model runtimes reachable from this server.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_methods=["POST", "GET"],
    allow_headers=["Authorization", "Content-Type"],
)


class OcrRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded image bytes. Data URLs are accepted.")
    mime_type: str = "image/png"
    prompt: str | None = None


class OcrResponse(BaseModel):
    text: str
    model: str
    provider: str


class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str | None = None


class EmbeddingData(BaseModel):
    index: int
    embedding: list[float]


class EmbeddingResponse(BaseModel):
    data: list[EmbeddingData]
    model: str
    provider: str


class HealthResponse(BaseModel):
    ok: bool
    ocr_provider: str
    ocr_model: str
    embedding_provider: str
    embedding_model: str


Auth = Annotated[None, Depends(require_api_key)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


@app.get("/health", response_model=HealthResponse)
async def health(settings: SettingsDep) -> HealthResponse:
    return HealthResponse(
        ok=True,
        ocr_provider="paddleocr-vl-vllm",
        ocr_model=settings.ocr_model,
        embedding_provider="ollama-openai-compatible",
        embedding_model=settings.embedding_model,
    )


@app.post("/v1/ocr", response_model=OcrResponse)
async def ocr(
    request: Request,
    _: Auth,
    settings: SettingsDep,
    file: UploadFile | None = File(default=None),
    image_base64: str | None = Form(default=None),
    mime_type: str | None = Form(default=None),
    prompt: str | None = Form(default=None),
) -> OcrResponse:
    image_bytes: bytes
    resolved_mime_type = mime_type or "image/png"

    content_type = request.headers.get("content-type", "")
    if content_type.startswith("application/json"):
        body = OcrRequest.model_validate(await request.json())
        image_bytes = decode_base64_image(body.image_base64)
        resolved_mime_type = body.mime_type
        prompt = body.prompt
    elif file is not None:
        image_bytes = await file.read()
        resolved_mime_type = file.content_type or resolved_mime_type
    elif image_base64:
        image_bytes = decode_base64_image(image_base64)
    else:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="No image was provided.")

    if not image_bytes:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="The image is empty.")

    try:
        text = await ocr_with_paddleocr_vl_vllm(
            image_bytes=image_bytes,
            mime_type=resolved_mime_type,
            prompt=prompt,
            settings=settings,
        )
    except ProviderError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error

    return OcrResponse(text=text, model=settings.ocr_model, provider="paddleocr-vl-vllm")


@app.post("/v1/embeddings", response_model=EmbeddingResponse)
async def embeddings(body: EmbeddingRequest, _: Auth, settings: SettingsDep) -> EmbeddingResponse:
    inputs = [body.input] if isinstance(body.input, str) else body.input
    if not inputs or any(not item.strip() for item in inputs):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Input text is required.")

    model = body.model or settings.embedding_model

    try:
        result = await embed_with_openai_compatible(inputs, model, settings)
    except ProviderError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error

    return embedding_response(result, "ollama-openai-compatible")


def decode_base64_image(value: str) -> bytes:
    encoded = value.split(",", 1)[1] if value.startswith("data:") and "," in value else value
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid base64 image.") from error


def embedding_response(result: EmbeddingResult, provider: str) -> EmbeddingResponse:
    return EmbeddingResponse(
        data=[
            EmbeddingData(index=index, embedding=embedding)
            for index, embedding in enumerate(result.embeddings)
        ],
        model=result.model,
        provider=provider,
    )
