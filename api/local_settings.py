"""File-based settings for local development mode.

Single JSON file on the mounted data volume — acts as the sole source
of truth for BQ project / dataset / table configuration when running
via docker-compose.
"""

import json
import os
from pathlib import Path

_CONFIG_PATH: Path | None = None


def _path() -> Path:
    global _CONFIG_PATH
    if _CONFIG_PATH is None:
        sqlite_path = os.environ.get("SQLITE_PATH")
        if sqlite_path:
            _CONFIG_PATH = Path(sqlite_path).parent / "local_settings.json"
        else:
            _CONFIG_PATH = Path(__file__).parent / "local_settings.json"
    return _CONFIG_PATH


def get_all() -> dict[str, str]:
    p = _path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def get(key: str) -> str | None:
    return get_all().get(key)


def put(key: str, value: str) -> None:
    data = get_all()
    data[key] = value
    _write(data)


def delete(key: str) -> bool:
    data = get_all()
    if key in data:
        del data[key]
        _write(data)
        return True
    return False


def _write(data: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2))
