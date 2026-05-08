from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


Provider = Literal["openai-compatible", "sentence-transformers", "disabled"]
OcrProvider = Literal["openai-compatible", "disabled"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    api_key: SecretStr | None = Field(default=None, alias="SPARK_AI_API_KEY")
    host: str = Field(default="0.0.0.0", alias="SPARK_AI_HOST")
    port: int = Field(default=8090, alias="SPARK_AI_PORT")
    request_timeout_seconds: float = Field(default=120, alias="REQUEST_TIMEOUT_SECONDS")

    ocr_provider: OcrProvider = Field(default="openai-compatible", alias="OCR_PROVIDER")
    ocr_base_url: str = Field(default="http://localhost:11434/v1", alias="OCR_BASE_URL")
    ocr_api_key: SecretStr | None = Field(default=None, alias="OCR_API_KEY")
    ocr_model: str = Field(default="qwen2.5vl:7b", alias="OCR_MODEL")

    embedding_provider: Provider = Field(default="openai-compatible", alias="EMBEDDING_PROVIDER")
    embedding_base_url: str = Field(default="http://localhost:11434/v1", alias="EMBEDDING_BASE_URL")
    embedding_api_key: SecretStr | None = Field(default=None, alias="EMBEDDING_API_KEY")
    embedding_model: str = Field(default="nomic-embed-text", alias="EMBEDDING_MODEL")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

