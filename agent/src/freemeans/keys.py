"""Local key store. Keys never leave this machine (Chapter 4.3).

Lookup order: environment variable, then the OS keychain (via `keyring`).
"""

from __future__ import annotations

import os

SERVICE = "freemeans"


class MissingKeyError(RuntimeError):
    pass


def get_key(key_env: str) -> str:
    val = os.environ.get(key_env)
    if val:
        return val
    try:
        import keyring  # optional at runtime

        val = keyring.get_password(SERVICE, key_env)
    except Exception:  # no keychain backend available
        val = None
    if not val:
        raise MissingKeyError(
            f"No key found for {key_env}. Set the environment variable, or run: freemeans keys set {key_env}"
        )
    return val


def set_key(key_env: str, value: str) -> None:
    import keyring

    keyring.set_password(SERVICE, key_env, value)


def has_key(key_env: str) -> bool:
    try:
        get_key(key_env)
        return True
    except MissingKeyError:
        return False
