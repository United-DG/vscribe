"""Local Argos Translate microservice."""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List

from argostranslate import package, translate
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("translation")

ready = False
catalog_install_errors: List[str] = []


def install_catalog_packages() -> None:
    """Install the catalog snapshot once, preserving models and the chosen package versions."""
    package.update_package_index()
    available = package.get_available_packages()
    installed = package.get_installed_packages()
    installed_pairs = {(item.from_code, item.to_code) for item in installed}
    snapshot_path = Path.home() / ".local" / "share" / "argos-translate" / "catalog-snapshot.json"

    if snapshot_path.exists():
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        pinned_versions = {
            (item["from_code"], item["to_code"], item["package_version"])
            for item in snapshot["packages"]
        }
    else:
        pinned = {
            (item.from_code, item.to_code): {
                "from_code": item.from_code,
                "to_code": item.to_code,
                "package_version": item.package_version,
            }
            for item in installed
        }
        for item in available:
            pinned.setdefault(
                (item.from_code, item.to_code),
                {
                    "from_code": item.from_code,
                    "to_code": item.to_code,
                    "package_version": item.package_version,
                },
            )
        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        snapshot_path.write_text(
            json.dumps({"packages": list(pinned.values())}, indent=2),
            encoding="utf-8",
        )
        pinned_versions = {
            (item["from_code"], item["to_code"], item["package_version"])
            for item in pinned.values()
        }

    candidates = {}
    for item in available:
        key = (item.from_code, item.to_code, item.package_version)
        if key in pinned_versions and (item.from_code, item.to_code) not in installed_pairs:
            candidates[key] = item

    total = len(candidates)
    logger.info("Installing %s missing Argos language pairs", total)
    for index, item in enumerate(candidates.values(), start=1):
        label = f"{item.from_code}->{item.to_code}"
        try:
            package_path = package.download_package(item)
            package.install_from_path(package_path)
            installed_pairs.add((item.from_code, item.to_code))
            logger.info("Installed Argos pair %s (%s/%s)", label, index, total)
        except Exception as error:
            catalog_install_errors.append(f"{label}: {error}")
            logger.exception("Failed to install Argos pair %s", label)

    available_versions = {
        (item.from_code, item.to_code, item.package_version)
        for item in available
    }
    installed_versions = {
        (item.from_code, item.to_code, item.package_version)
        for item in installed
    }
    missing_snapshot_items = pinned_versions - available_versions - installed_versions
    for from_code, to_code, version in missing_snapshot_items:
        message = f"{from_code}->{to_code} version {version} is missing from the package index"
        catalog_install_errors.append(message)
        logger.error("Pinned Argos model unavailable: %s", message)

    if catalog_install_errors:
        logger.error(
            "%s Argos language pairs failed to install; remaining installed pairs remain available",
            len(catalog_install_errors),
        )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global ready
    await asyncio.to_thread(install_catalog_packages)
    ready = True
    logger.info("Argos translation service ready")
    yield


app = FastAPI(
    title="Local Translation Service",
    description="Self-hosted translation powered by Argos Translate.",
    version="1.0.0",
    lifespan=lifespan,
)


class TranslateRequest(BaseModel):
    source: str
    target: str
    texts: List[str]


@app.get("/health")
async def health():
    if not ready:
        raise HTTPException(status_code=503, detail="Argos language catalog is still initializing")
    return {
        "service": "local-translation",
        "status": "healthy",
        "catalog_install_errors": len(catalog_install_errors),
    }


@app.get("/languages")
async def languages(source: str = Query(..., min_length=2, max_length=16)):
    if not ready:
        raise HTTPException(status_code=503, detail="Argos language catalog is still initializing")

    source_code = source.lower()
    installed = translate.get_installed_languages()
    source_language = next((language for language in installed if language.code.lower() == source_code), None)
    if not source_language:
        raise HTTPException(status_code=422, detail=f"Source language '{source}' is not installed")

    targets = {
        translation.to_lang.code: translation.to_lang.name
        for translation in source_language.translations
    }
    return {
        "source": source_code,
        "languages": [
            {"code": code, "name": name}
            for code, name in sorted(targets.items(), key=lambda entry: entry[1].casefold())
        ],
    }


@app.post("/translate")
async def translate_text(request: TranslateRequest):
    if not ready:
        raise HTTPException(status_code=503, detail="Argos language catalog is still initializing")
    if not request.texts or len(request.texts) > 100:
        raise HTTPException(status_code=400, detail="Provide between 1 and 100 text chunks")
    if sum(len(text) for text in request.texts) > 250_000:
        raise HTTPException(status_code=413, detail="Translation batch is too large")
    if request.source.lower() == request.target.lower():
        return {"translations": request.texts}

    installed = translate.get_installed_languages()
    source_language = next(
        (language for language in installed if language.code.lower() == request.source.lower()),
        None,
    )
    target_language = next(
        (language for language in installed if language.code.lower() == request.target.lower()),
        None,
    )
    translation = source_language.get_translation(target_language) if source_language and target_language else None
    if not translation:
        raise HTTPException(status_code=422, detail="Requested language pair is not installed")

    try:
        return {"translations": [translation.translate(text) if text else text for text in request.texts]}
    except Exception as error:
        logger.exception("Argos translation failed")
        raise HTTPException(status_code=500, detail="Translation failed") from error


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("TRANSLATION_HOST", "127.0.0.1"),
        port=int(os.getenv("TRANSLATION_PORT", "8001")),
    )
