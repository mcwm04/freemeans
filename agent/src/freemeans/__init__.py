"""Freemeans local agent (prototype).

Routes OpenAI-style chat requests across the user's *own* free-tier quotas,
filtered by project policy and ranked by remaining headroom.
Keys never leave this machine.
"""

__version__ = "0.1.0"
