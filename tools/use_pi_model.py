#!/usr/bin/env python3
"""Point FillDesk at the LLM endpoint this machine is already configured for.

  python3 tools/use_pi_model.py --list                  # what is configured here
  python3 tools/use_pi_model.py --provider X --model Y  # adopt one of them
  python3 tools/use_pi_model.py                         # adopt the default
  python3 tools/use_pi_model.py --revert                # rule-based, no key

A developer convenience for people who already have an OpenAI-compatible endpoint
configured somewhere on the box. **End users do not need this** - they put their own
provider, model and key in the dashboard (Settings → Writing model), and nothing
works without their own key. FillDesk never bundles, proxies or resells inference.

Reads pi's models.json / settings.json, writes FillDesk's own data/settings.json at
0600. The key stays on this machine and is sent only to the endpoint you configured,
only when you build a packet.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import config  # noqa: E402

PI_DIR = Path(os.environ.get("PI_HOME", Path.home() / ".pi" / "agent"))


def pi_providers() -> dict:
    for name in ("models.json",):
        f = PI_DIR / name
        if not f.exists():
            continue
        try:
            return (json.loads(f.read_text(encoding="utf-8")) or {}).get("providers") or {}
        except (ValueError, OSError) as exc:
            raise SystemExit(f"cannot read {f}: {exc}")
    raise SystemExit(f"no pi provider config found at {PI_DIR}/models.json")


def pi_default() -> tuple[str, str]:
    try:
        s = json.loads((PI_DIR / "settings.json").read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return "", ""
    return s.get("defaultProvider", ""), s.get("defaultModel", "")


def compatible(prov: dict) -> bool:
    api = str(prov.get("api", "")).lower()
    return api in ("openai-completions", "openai", "openai-compatible", "")


def redact(key: str) -> str:
    return f"{key[:6]}…{key[-4:]} ({len(key)} chars)" if key else "(no key)"


def main() -> int:
    ap = argparse.ArgumentParser(description="Adopt an already-configured LLM endpoint for FillDesk.")
    ap.add_argument("--provider", default="", help="provider key in the local models.json")
    ap.add_argument("--model", default="", help="model id (default: pi's default model)")
    ap.add_argument("--list", action="store_true", help="list what pi has and exit")
    ap.add_argument("--revert", action="store_true", help="set FillDesk back to rule-based")
    args = ap.parse_args()

    providers = pi_providers()

    if args.revert:
        config.save_settings({"llm": {"provider": "none", "base_url": "", "model": "", "api_key": ""}})
        print("FillDesk is back to rule-based drafting: no model, nothing leaves this machine.")
        return 0

    default_provider, default_model = pi_default()
    wanted = args.provider or default_provider or next(iter(providers), "")
    if wanted not in providers:
        print(f"no provider called {wanted!r} here. Available: {', '.join(providers) or '(none)'}")
        return 1

    prov = providers[wanted]
    models = prov.get("models") or []
    model = args.model or (default_model if wanted == default_provider else "") or (models[0].get("id") if models else "")
    base_url = str(prov.get("baseUrl", "")).rstrip("/")
    key = str(prov.get("apiKey", ""))

    if args.list:
        for name, p in providers.items():
            ok = "ok" if compatible(p) else "unsupported api: " + str(p.get("api"))
            mark = " (pi default)" if name == default_provider else ""
            print(f"{name}{mark}: {p.get('baseUrl','')} [{ok}]")
            for m in p.get("models") or []:
                print(f"    - {m.get('id')}" + (" (pi default model)" if m.get("id") == default_model else ""))
        return 0

    if not compatible(prov):
        print(f"{wanted!r} uses api {prov.get('api')!r}; FillDesk speaks OpenAI-compatible "
              "chat/completions, Anthropic, Gemini and Ollama. Point it at an endpoint it knows instead.")
        return 1
    if not base_url:
        print(f"{wanted!r} has no baseUrl")
        return 1
    if not key:
        print(f"{wanted!r} has no apiKey in the local config (it may come from an env var). "
              "Set FILLDESK_LLM_API_KEY yourself in that case.")
        return 1

    config.save_settings({"llm": {
        "provider": "openai",
        "base_url": base_url,
        "model": model,
        "api_key": key,
        "temperature": 0.4,
        "max_tokens": 8000,
        "no_thinking": True,
    }})
    print(f"FillDesk will now draft with {wanted} / {model}")
    print(f"  endpoint: {base_url}/chat/completions")
    print(f"  key:      {redact(key)}  (stored in {config.SETTINGS_FILE}, mode 0600)")
    print("\ntest it:   dashboard → Settings → Test model")
    print("           or  python3 tools/dry_run.py --resume your_resume.pdf   (rebuilds a packet with the model)")
    print("undo it:   python3 tools/use_pi_model.py --revert")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
