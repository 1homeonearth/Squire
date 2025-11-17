"""
Sentry package marker.

Keeping `sentry/python` marked as a package allows relative imports once
features arrive. Leave this file in place so Sentry remains importable even when
nested inside an ecosystem’s `Discovery/` folder or another bot.
"""
