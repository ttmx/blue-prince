import uvicorn

from .config import settings


def main() -> None:
    uvicorn.run(
        "spark_ai_backend.main:app",
        host=settings.host,
        port=settings.port,
        proxy_headers=True,
    )


if __name__ == "__main__":
    main()

