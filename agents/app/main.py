import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from app import config, logredact
from app.review_store import start_purging
from app.routes import router
from app.security import SharedSecretMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logredact.install()

@asynccontextmanager
async def lifespan(_app: FastAPI):
    logredact.install()  # also covers the handlers that uvicorn added when it started
    stop = start_purging()  # waiting runs older than 30 minutes are deleted, now and every minute
    yield
    stop()


# The interactive documentation and the schema are not served: nothing outside the server needs them.
app = FastAPI(title="CrewAI agents service", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

# Applies to every route, including ones added later; only /health is exempt.
app.add_middleware(SharedSecretMiddleware)
app.include_router(router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    # uvicorn adds its own handlers when it starts, so the redaction is applied again from the lifespan below.
    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT)
