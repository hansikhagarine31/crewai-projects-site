import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from app import config
from app.review_store import start_purging
from app.routes import router
from app.security import SharedSecretMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop = start_purging()  # waiting runs older than 30 minutes are deleted, now and every minute
    yield
    stop()


app = FastAPI(title="CrewAI agents service", lifespan=lifespan)

# Applies to every route, including ones added later; only /health is exempt.
app.add_middleware(SharedSecretMiddleware)
app.include_router(router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT)
