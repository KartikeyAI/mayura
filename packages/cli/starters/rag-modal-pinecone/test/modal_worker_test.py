"""Test the private worker's role and digest contract without Modal or Ollama."""
import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch


def load_worker():
    stub = Mock()
    stub.App.return_value.function.return_value = lambda function: function
    path = pathlib.Path(__file__).resolve().parents[1] / "modal-app.py"
    spec = importlib.util.spec_from_file_location("starter_worker", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"modal": stub}):
        spec.loader.exec_module(module)
    return module


class ModelWorkerTest(unittest.TestCase):
    def test_image_clears_the_ollama_entrypoint_for_modal_python(self):
        worker = load_worker()
        worker.modal.Image.from_registry.return_value.entrypoint.assert_called_once_with([])

    def test_roles_are_distinct_and_model_is_pinned(self):
        worker = load_worker()
        vector = [1.0] + [0.0] * 767
        worker.server = Mock()
        worker.server.poll.return_value = None
        with patch.object(worker, "request", return_value={"embeddings": [vector]}) as request:
            for role, prefix in [("document", "search_document: "), ("query", "search_query: ")]:
                self.assertEqual(worker.embed(role, ["incident"]), {
                    "role": role, "digest": worker.DIGEST, "embeddings": [vector],
                })
                request.assert_called_with("/api/embed", {
                    "model": worker.MODEL, "input": [prefix + "incident"], "truncate": False, "dimensions": 768,
                })

    def test_invalid_role_never_calls_ollama(self):
        worker = load_worker()
        with patch.object(worker, "request") as request:
            with self.assertRaises(ValueError):
                worker.embed("untrusted", ["incident"])
            request.assert_not_called()

    def test_wrong_model_stops_the_starting_worker(self):
        worker = load_worker()
        with patch.object(worker, "start_ollama") as start, patch.object(worker, "stop_ollama") as stop, \
             patch.object(worker, "request", return_value={"models": [{"name": worker.MODEL, "digest": "mismatch"}]}):
            with self.assertRaisesRegex(RuntimeError, "do not match"):
                worker.embed("query", ["incident"])
            stop.assert_called_once_with(start.return_value)
            self.assertIsNone(worker.server)
