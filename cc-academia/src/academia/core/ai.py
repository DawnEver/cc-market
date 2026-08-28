"""Unified AI client — wraps litellm for all model interactions.

Absorbed from:
- ReviewAgent ai_chat_response.py (chat interface)
- AeroWdgLiteratureReview ai_model.py (model registry)
- ReviewAgent config.py (model builder)
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen


@dataclass
class ModelSpec:
    """Descriptor for an AI model usable via litellm."""
    provider: str                     # e.g. "ollama", "gemini", "openai"
    model_name: str                   # e.g. "gpt-oss:20b", "gemini-2.5-flash"
    temperature: float = 0.1
    context_length: int = 64000
    think: str | None = None          # "low" | "medium" | "high" — model-dependent
    extra_options: dict[str, Any] = field(default_factory=dict)

    def to_litellm_model(self) -> str:
        """Return litellm-compatible model string like 'ollama/gpt-oss:20b'."""
        if "/" in self.model_name:
            return self.model_name
        return f"{self.provider}/{self.model_name}"

    def to_dict(self) -> dict:
        """Return the dict format used by legacy ReviewAgent chat_response."""
        result: dict[str, Any] = {
            "provider": self.provider,
            "model_name": self.model_name,
            "options": {"temperature": self.temperature, **self.extra_options},
            "context_length": self.context_length,
        }
        if self.think is not None:
            result["think"] = self.think
        return result


# ---------------------------------------------------------------------------
# Model resolution
#
# Model names age fast; a hard-coded registry is guaranteed to go stale. The
# design therefore keeps two layers:
#
#   PROVIDERS  — stable per-provider facts: the env var holding the API key
#                and the OpenAI-compatible /models endpoint for discovery.
#   MODELS     — a small set of *pinned aliases* for models we have actually
#                validated. Anything else is resolved dynamically against the
#                provider's live /models list (cached on disk).
#
# To use a new model: pass "<provider>/<model-id>" (e.g. "deepseek/deepseek-v4-flash")
# or a bare model id; get_model() validates it against the live list.
# ---------------------------------------------------------------------------


PROVIDERS: dict[str, dict[str, str]] = {
    "deepseek": {
        "api_key_env": "DEEPSEEK_API_KEY",
        "models_url": "https://api.deepseek.com/models",
    },
    "moonshot": {
        "api_key_env": "MOONSHOT_API_KEY",
        "models_url": "https://api.moonshot.cn/v1/models",
    },
    "gemini": {
        "api_key_env": "GEMINI_API_KEY",
        "models_url": "",  # discovery not wired; use pinned aliases
    },
    "ollama": {
        "api_key_env": "",
        "models_url": "http://localhost:11434/api/tags",
    },
}

# Pinned aliases for models validated in this codebase. These never go stale
# in the breaking sense — worst case the alias stops resolving upstream.
MODELS: dict[str, ModelSpec] = {
    # Ollama (local)
    "gpt-oss:20b": ModelSpec(provider="ollama", model_name="gpt-oss:20b", think="medium"),
    "gemma3:27b": ModelSpec(provider="ollama", model_name="gemma3:27b", think="medium"),
    # Gemini
    "gemini-2.5-flash-lite": ModelSpec(provider="gemini", model_name="gemini-2.5-flash-lite",
                                        context_length=128000, think="medium"),
    "gemini-2.5-flash": ModelSpec(provider="gemini", model_name="gemini-2.5-flash",
                                   context_length=128000, think="medium"),
    "gemini-2.5-pro": ModelSpec(provider="gemini", model_name="gemini-2.5-pro",
                                 context_length=128000, think="medium"),
}

_CACHE_PATH = Path.home() / ".cache" / "lit-review" / "models.json"
_CACHE_TTL_S = 24 * 3600


def _load_env_key(env_var: str) -> str:
    """Read an API key from the process env, falling back to the project .env."""
    if not env_var:
        return ""
    value = os.environ.get(env_var)
    if value:
        return value
    env_file = Path(__file__).resolve().parents[2] / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{env_var}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def _read_cache() -> dict[str, Any]:
    try:
        data = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
        if time.time() - data.get("fetched_at", 0) < _CACHE_TTL_S:
            return data
    except Exception:
        pass
    return {}


def _write_cache(data: dict[str, Any]) -> None:
    try:
        _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CACHE_PATH.write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass


def _ensure_provider_key(provider: str) -> None:
    """Populate os.environ with the provider's API key from the project .env.

    litellm authenticates from process env vars; the project keeps secrets in
    .env. Bridge the two, without ever clobbering a var the user set.
    """
    spec = PROVIDERS.get(provider)
    if not spec or not spec["api_key_env"]:
        return
    env_var = spec["api_key_env"]
    if os.environ.get(env_var):
        return
    key = _load_env_key(env_var)
    if key:
        os.environ[env_var] = key


def list_provider_models(provider: str, *, refresh: bool = False) -> list[str]:
    """Live model ids for a provider, from its /models endpoint (cached 24 h).

    Returns an empty list when discovery is unavailable (no key, no endpoint,
    or a network failure) — callers fall back to pinned aliases.
    """
    spec = PROVIDERS.get(provider)
    if not spec or not spec["models_url"]:
        return []
    if not refresh:
        cached = _read_cache().get(provider)
        if cached:
            return cached
    ids: list[str] = []
    try:
        headers = {}
        key = _load_env_key(spec["api_key_env"])
        if key:
            headers["Authorization"] = f"Bearer {key}"
        req = Request(spec["models_url"], headers=headers)
        with urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read())
        if provider == "ollama":
            ids = [m.get("name", "") for m in payload.get("models", [])]
        else:
            ids = [m.get("id", "") for m in payload.get("data", [])]
        ids = [i for i in ids if i]
    except Exception:
        return []
    cache = _read_cache()
    cache["fetched_at"] = time.time()
    cache[provider] = ids
    _write_cache(cache)
    return ids


def resolve_model(name: str) -> ModelSpec:
    """Resolve any model name to a ModelSpec.

    Accepts a pinned alias ("gemini-2.5-flash"), a provider-qualified id
    ("deepseek/deepseek-v4-flash"), or a bare id ("kimi-k3") resolved against
    the provider's live /models list. Raises KeyError when the id cannot be
    confirmed anywhere.
    """
    if name in MODELS:
        return MODELS[name]

    provider, _, bare = name.partition("/")
    if bare:  # explicit provider/model-id
        if provider not in PROVIDERS:
            raise KeyError(f"Unknown provider: {provider!r}. Known: {list(PROVIDERS)}")
        live = list_provider_models(provider)
        if live and bare not in live:
            raise KeyError(
                f"{bare!r} not in {provider}'s live model list. Available: {live}"
            )
        if not live:
            import warnings
            warnings.warn(
                f"could not verify {bare!r} against {provider}'s /models "
                f"(no API key or discovery failed); passing through unvalidated",
                stacklevel=2,
            )
        return ModelSpec(provider=provider, model_name=bare)

    # Bare id: find the single provider that serves it.
    matches = [p for p in PROVIDERS if name in list_provider_models(p)]
    if len(matches) == 1:
        return ModelSpec(provider=matches[0], model_name=name)
    if len(matches) > 1:
        raise KeyError(f"Ambiguous model id {name!r} served by {matches}; qualify it.")
    raise KeyError(
        f"Unknown model: {name!r}. Pinned: {list(MODELS)}; "
        f"or pass provider/model-id discoverable via /models."
    )


# ---------------------------------------------------------------------------
# Chat interface
# ---------------------------------------------------------------------------

def chat(model: ModelSpec | str, messages: list[dict[str, str]]) -> str | None:
    """Send messages to an LLM via litellm and return assistant text.

    Args:
        model: ModelSpec or registry key string.
        messages: List of {"role": "...", "content": "..."} dicts.

    Returns:
        Assistant response text, or None on failure.
    """
    from litellm import completion

    if isinstance(model, str):
        model = resolve_model(model)

    # litellm reads provider keys from the process environment only; make sure
    # the project's .env has been applied before the call (never overrides an
    # explicitly-set variable).
    _ensure_provider_key(model.provider)

    model_str = model.to_litellm_model()
    options = {"temperature": model.temperature, **model.extra_options}

    import os
    debug = os.environ.get("LIT_REVIEW_AI_DEBUG", "").lower() in ("1", "true", "yes")
    try:
        response = completion(model=model_str, messages=messages, stream=False, **options)
        content = response["choices"][0]["message"]["content"]
        return str(content).strip() if content else None
    except Exception as error:
        # Silent None used to swallow the reason entirely; with debug on, say why.
        if debug:
            import sys
            print(f"[ai.client] {model_str} call failed: {type(error).__name__}: {error}",
                  file=sys.stderr)
        return None


def chat_structured(
    model: ModelSpec | str,
    system: str,
    prompt: str,
) -> str | None:
    """Convenience wrapper: system + user message → chat."""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
    ]
    return chat(model, messages)


# ---------------------------------------------------------------------------
# Parsing model output
#
# Models wrap JSON in markdown fences often enough that every caller used to
# reimplement the unwrapping. It lives here, next to the client that produces
# the text, rather than in the text-normalisation module.
# ---------------------------------------------------------------------------




def normalize_text(value: Any) -> str:
    """Convert an arbitrary value to a compact single-line string."""
    if value is None:
        return ""
    text = str(value).strip()
    return " ".join(text.split())


def paper_key(item: dict[str, str]) -> str:
    """Build a stable deduplication key — DOI first, then title."""
    doi = normalize_text(item.get("DOI", "")).lower()
    if doi:
        return f"doi:{doi}"
    title = normalize_text(item.get("Title", "")).lower()
    return f"title:{title}"


def strip_markdown_code_fence(text: str) -> str:
    """Remove leading/trailing markdown code fences from model output."""
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        first_nl = cleaned.find("\n")
        cleaned = cleaned[first_nl + 1:] if first_nl != -1 else ""
        cleaned = cleaned.removesuffix("```").strip()
    return cleaned


def extract_json_object(text: str) -> dict[str, Any] | None:
    """Best-effort JSON object extraction from text (handles code fences)."""
    cleaned = strip_markdown_code_fence(text)
    try:
        data = json.loads(cleaned)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        pass
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        data = json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def extract_json_list(text: str) -> list[dict[str, Any]]:
    """Best-effort JSON list extraction from text (handles code fences)."""
    cleaned = strip_markdown_code_fence(text)
    try:
        data = json.loads(cleaned)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
    except json.JSONDecodeError:
        pass
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        data = json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError:
        return []
    return [x for x in data if isinstance(x, dict)] if isinstance(data, list) else []
