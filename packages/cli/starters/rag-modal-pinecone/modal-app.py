"""Private Modal Nomic worker. The image fetches the pinned model during deployment."""
import atexit
import json
import math
import subprocess
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

import modal

MODEL = "nomic-embed-text:v1.5"
DIGEST = "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f"
DIMENSIONS = 768
PORT = "http://127.0.0.1:11434"
PREFIX = {"document": "search_document: ", "query": "search_query: "}


def request(path, payload=None):
    """Call only the local Ollama process, with a bounded JSON response."""
    data = None if payload is None else json.dumps(payload).encode()
    with urlopen(Request(PORT + path, data, {"Content-Type": "application/json"}), timeout=20) as reply:
        body = reply.read(512_001)
    if len(body) > 512_000:
        raise RuntimeError("Unexpected Ollama response size")
    return json.loads(body)


def start_ollama():
    process = subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline and process.poll() is None:
            try:
                request("/api/tags")
                return process
            except (URLError, TimeoutError):
                time.sleep(0.1)
        raise RuntimeError("Local Ollama did not become ready")
    except BaseException:
        stop_ollama(process)
        raise


def stop_ollama(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def verify_model():
    models = request("/api/tags")["models"]
    if not any(model["name"] == MODEL and model["digest"].removeprefix("sha256:") == DIGEST for model in models):
        raise RuntimeError("The bundled Nomic weights do not match the model pin")


def cache_model():
    process = start_ollama()
    try:
        subprocess.run(["ollama", "pull", MODEL], check=True, timeout=600)
        verify_model()
    finally:
        stop_ollama(process)


app = modal.App("mayura-rag-nomic-v1")
image = (
    modal.Image.from_registry(
        "ollama/ollama@sha256:dea72d1e22270fe095b68fdf756d2b489d615643c5a2eaebbc5f569181e322d8", add_python="3.12",
    )
    # Modal launches Python for image preparation and for the Function.
    .entrypoint([])
    .env({"OLLAMA_HOST": "127.0.0.1:11434", "OLLAMA_MODELS": "/opt/nomic", "OLLAMA_NO_CLOUD": "1",
          "OLLAMA_NUM_PARALLEL": "1", "OLLAMA_MAX_LOADED_MODELS": "1"})
    .run_function(cache_model, timeout=660)
)
server = None


@app.function(image=image, cpu=4, memory=6144, max_containers=1, scaledown_window=30,
              startup_timeout=120, timeout=30, retries=0)
def embed(role: str, texts: list[str]) -> dict:
    """Embed an explicit role over the Modal SDK. This function exposes no web endpoint."""
    if role not in PREFIX or not isinstance(texts, list) or not 1 <= len(texts) <= 8:
        raise ValueError("Invalid Nomic batch")
    if any(not isinstance(text, str) or not text.strip() or len(text) > 2_000 for text in texts):
        raise ValueError("Invalid Nomic input")
    global server
    if server is None or server.poll() is not None:
        process = start_ollama()
        try:
            verify_model()
        except BaseException:
            stop_ollama(process)
            raise
        server = process
        atexit.register(stop_ollama, process)
    response = request("/api/embed", {
        "model": MODEL, "input": [PREFIX[role] + text for text in texts], "truncate": False, "dimensions": DIMENSIONS,
    })
    vectors = response["embeddings"]
    if len(vectors) != len(texts) or any(
        len(vector) != DIMENSIONS or not all(math.isfinite(value) for value in vector) for vector in vectors
    ):
        raise RuntimeError("Unexpected Nomic vector shape")
    return {"role": role, "digest": DIGEST, "embeddings": vectors}
