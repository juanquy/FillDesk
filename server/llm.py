"""LLM access with urllib only.

Providers: openai-compatible (OpenAI, OpenRouter, Groq, xAI, DeepSeek, LM Studio,
vLLM, Together...), anthropic, gemini, ollama (local, no key), none (rule-based).

`provider: auto` picks the first one that has credentials configured.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

from . import config

TIMEOUT = 120

# Cloudflare-fronted OpenAI-compatible gateways (this is how several of them ship)
# refuse the default `Python-urllib/3.x` signature outright with a 403/1010, which
# looks like a bad API key. Say who you are instead.
USER_AGENT = f"FillDesk/{config.VERSION} (local job application tool)"


class LLMError(RuntimeError):
    pass


def _post(url: str, payload: dict, headers: dict, timeout: int = TIMEOUT) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "accept": "application/json",
                 "user-agent": USER_AGENT, **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "ignore")[:600]
        raise LLMError(f"{exc.code} from {url}: {body}") from exc
    except urllib.error.URLError as exc:
        raise LLMError(f"cannot reach {url}: {exc.reason}") from exc
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise LLMError(f"non-JSON response from {url}: {raw[:300]}") from exc


def _env(key: str) -> str:
    return (os.environ.get(key) or "").strip()


def resolve(settings: dict | None = None) -> dict:
    """Return {provider, base_url, model, api_key, temperature, max_tokens, source}."""
    s = ((settings or config.load_settings()).get("llm") or {})
    env = config.env_llm()
    provider = (env["provider"] or s.get("provider") or "auto").lower()
    base_url = (env["base_url"] or s.get("base_url") or "").rstrip("/")
    model = (env["model"] or s.get("model") or "").strip()
    key = (env["api_key"] or s.get("api_key") or "").strip()

    if provider == "auto":
        if key:
            provider = "openai"
        elif _env("ANTHROPIC_API_KEY"):
            provider, key = "anthropic", _env("ANTHROPIC_API_KEY")
            base_url = base_url or "https://api.anthropic.com"
            model = model or "claude-sonnet-4-20250514"
        elif _env("OPENAI_API_KEY"):
            provider, key = "openai", _env("OPENAI_API_KEY")
            base_url = base_url or "https://api.openai.com/v1"
            model = model or "gpt-4o-mini"
        elif _env("GEMINI_API_KEY") or _env("GOOGLE_API_KEY"):
            provider, key = "gemini", _env("GEMINI_API_KEY") or _env("GOOGLE_API_KEY")
            base_url = base_url or "https://generativelanguage.googleapis.com"
            model = model or "gemini-2.0-flash"
        else:
            probe = dict(provider="ollama", base_url=base_url or "http://127.0.0.1:11434", model=model or "")
            if ollama_healthy(probe):
                probe["model"] = probe["model"] or ollama_default_model(probe)
                probe.update({"source": "ollama-auto", "temperature": s.get("temperature", 0.4), "max_tokens": s.get("max_tokens", 4000)})
                return probe
            provider = "none"

    if provider == "openai" and not base_url:
        base_url = "https://api.openai.com/v1"
    if provider == "openai" and not model:
        model = "gpt-4o-mini"
    if provider == "anthropic":
        base_url = base_url or "https://api.anthropic.com"
        model = model or "claude-sonnet-4-20250514"
    if provider == "gemini":
        base_url = base_url or "https://generativelanguage.googleapis.com"
        model = model or "gemini-2.0-flash"
    if provider == "ollama":
        base_url = base_url or "http://127.0.0.1:11434"
        model = model or ollama_default_model({"base_url": base_url}) or "llama3.1"

    return {
        "provider": provider,
        "base_url": base_url,
        "model": model,
        "api_key": key,
        "temperature": s.get("temperature", 0.4),
        "max_tokens": s.get("max_tokens", 8000),
        "no_thinking": bool(s.get("no_thinking", True)),
        "source": "configured",
    }


def ollama_healthy(cfg: dict) -> bool:
    try:
        with urllib.request.urlopen(cfg.get("base_url", "http://127.0.0.1:11434") + "/api/tags", timeout=2) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def ollama_default_model(cfg: dict) -> str:
    try:
        with urllib.request.urlopen(cfg["base_url"] + "/api/tags", timeout=4) as r:
            data = json.loads(r.read().decode("utf-8", "ignore"))
        models = [m.get("name") for m in data.get("models", []) if m.get("name")]
        return models[0] if models else ""
    except Exception:  # noqa: BLE001
        return ""


def status(settings: dict | None = None) -> dict:
    cfg = resolve(settings)
    usable = cfg["provider"] != "none"
    detail = ""
    if cfg["provider"] == "none":
        detail = (
            "No model configured. Packet generation falls back to templates + your boilerplate answers, "
            "which is still faster than typing everything. Set an API key in Settings to enable drafting."
        )
    elif cfg["provider"] == "ollama":
        detail = "local" if ollama_healthy(cfg) else "configured but not reachable right now"
    return {
        "provider": cfg["provider"],
        "model": cfg["model"],
        "base_url": cfg["base_url"],
        "usable": usable,
        "detail": detail,
        "has_key": bool(cfg["api_key"]),
    }


def _repair_json(text: str) -> Any | None:
    """Salvage a truncated JSON answer instead of throwing the whole call away.

    Reasoning models run out of output budget in the middle of long JSON objects
    far more often than people expect, and the cost of that call was already paid.
    """
    t = (text or "").strip()
    if not t:
        return None
    closers = {"{": "}", "[": "]"}
    stack: list[str] = []
    in_string = esc = False
    cuts: list[tuple[int, list[str]]] = []
    for i, ch in enumerate(t):
        if in_string:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in closers:
            stack.append(closers[ch])
        elif ch in "}]":
            if stack and stack[-1] == ch:
                stack.pop()
            if stack:
                cuts.append((i, list(stack)))
    for i, open_stack in reversed(cuts[-60:]):
        fragment = t[: i + 1].rstrip().rstrip(",") + "".join(reversed(open_stack))
        try:
            return json.loads(fragment)
        except ValueError:
            continue
    return None


def _extract_json(text: str) -> Any:
    """Models wrap JSON in prose or ``` fences far more often than documented."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"```\s*$", "", t)
    try:
        return json.loads(t)
    except ValueError:
        pass
    start = min([i for i in (t.find("{"), t.find("[")) if i >= 0], default=-1)
    end = max(t.rfind("}"), t.rfind("]"))
    if start >= 0 and end > start:
        chunk = t[start : end + 1]
        for candidate in (chunk, re.sub(r",\s*([}\]])", r"\1", chunk)):
            try:
                return json.loads(candidate)
            except ValueError:
                continue
    repaired = _repair_json(t)
    if repaired is not None:
        return repaired
    raise LLMError("model did not return parseable JSON")


def _openai_chat(cfg: dict, system: str, user: str, expect_json: bool, image_data_url: str | None = None) -> str:
    """POST to an OpenAI-compatible endpoint, degrading gracefully.

    Gateways disagree about which optional fields they accept: some 400 on
    `response_format`, some on `temperature`, and reasoning models either want an
    explicit "think less" flag or spend the entire output budget thinking and return
    an empty answer. A red 400 in the dashboard is otherwise a mystery to the user.
    """
    user_content: Any = (
        [{"type": "text", "text": user}, {"type": "image_url", "image_url": {"url": image_data_url}}]
        if image_data_url
        else user
    )
    base = {
        "model": cfg["model"],
        "max_tokens": cfg["max_tokens"],
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user_content}],
        "temperature": cfg["temperature"],
    }
    if expect_json:
        base["response_format"] = {"type": "json_object"}

    no_format = {k: v for k, v in base.items() if k != "response_format"}
    variants: list[dict] = []
    if cfg.get("no_thinking"):
        # Two spellings of "stop thinking out loud", because gateways disagree: some
        # take enable_thinking at the top level, vLLM-style servers want it inside
        # chat_template_kwargs. Servers that do not know the field ignore it, and a
        # 400 simply moves on to the next variant below.
        variants.append({**base, "enable_thinking": False,
                         "chat_template_kwargs": {"enable_thinking": False}})
    variants += [base, no_format, {k: v for k, v in no_format.items() if k != "temperature"},
                 {**no_format, "enable_thinking": False}]
    if image_data_url:
        # Fallback without image in case the model/gateway rejects multimodal content
        variants.append({**no_format, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})

    last: LLMError | None = None
    i = 0
    while i < len(variants):
        payload = variants[i]
        i += 1
        try:
            data = _post(cfg["base_url"] + "/chat/completions", payload,
                         {"authorization": f"Bearer {cfg['api_key']}"})
        except LLMError as exc:
            last = exc
            continue
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or choice.get("delta") or {}
        text = (msg.get("content") or "").strip()
        finish = choice.get("finish_reason") or data.get("stop_reason") or ""
        if text and finish != "length":
            return text
        if text and finish == "length":
            # The answer was cut off -- usually the thinking, not the writing, ate
            # the budget. Ask for more room, then ask it not to think out loud.
            roomier = dict(payload)
            roomier["max_tokens"] = min(16000, int(payload.get("max_tokens") or 0) * 3 or 12000)
            variants.append(roomier)
            variants.append({**roomier, "enable_thinking": False})
            last = LLMError(
                f"{cfg['model']} ran out of output tokens mid-answer at "
                f"{payload.get('max_tokens')} tokens. Raise Max tokens in Settings → Writing "
                "model, or use a model that does not reason out loud."
            )
            continue
        if msg.get("reasoning_content"):
            bigger = dict(payload)
            bigger["max_tokens"] = min(16000, max(8000, int(cfg["max_tokens"]) * 2))
            bigger["enable_thinking"] = False
            variants.append(bigger)
            last = LLMError("the model spent the whole budget reasoning and returned no answer")
            continue
        last = last or LLMError(f"empty completion from {cfg['base_url']}")
    raise last or LLMError(f"no usable response from {cfg['base_url']}")


def complete(system: str, user: str, expect_json: bool = True, settings: dict | None = None, image_data_url: str | None = None) -> Any:
    cfg = resolve(settings)
    provider = cfg["provider"]
    if provider == "none":
        raise LLMError("no LLM configured")

    if provider in ("openai",):
        text = _openai_chat(cfg, system, user, expect_json, image_data_url=image_data_url)
    elif provider == "anthropic":
        data = _post(
            cfg["base_url"] + "/v1/messages",
            {
                "model": cfg["model"],
                "max_tokens": cfg["max_tokens"],
                "temperature": cfg["temperature"],
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
            {"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01"},
        )
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    elif provider == "gemini":
        data = _post(
            cfg["base_url"] + f"/v1beta/models/{cfg['model']}:generateContent?key={cfg['api_key']}",
            {
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {
                    "temperature": cfg["temperature"],
                    "maxOutputTokens": cfg["max_tokens"],
                    **({"responseMimeType": "application/json"} if expect_json else {}),
                },
            },
            {},
        )
        cand = (data.get("candidates") or [{}])[0]
        text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []))
    elif provider == "ollama":
        data = _post(
            cfg["base_url"] + "/api/chat",
            {
                "model": cfg["model"],
                "stream": False,
                "format": "json" if expect_json else "",
                "options": {"temperature": cfg["temperature"]},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            },
            {},
            timeout=TIMEOUT * 2,
        )
        text = (data.get("message") or {}).get("content") or ""
    else:
        raise LLMError(f"unknown provider {provider!r}")

    if not text.strip():
        raise LLMError("model returned an empty response")
    if expect_json:
        return _extract_json(text)
    return text.strip()
