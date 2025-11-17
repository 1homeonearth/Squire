# Discovery directory — ecosystem

This directory holds presence markers and queues exchanged with bots. The central hub writes `ecosystem_presence.txt` here for nested entities and expects message queues (`gateway_queue.log`) from bots that live inside this `Discovery/` folder. The main bots—Squire, Bard, and Sentry—now live inside this directory so the hub can coordinate them without extra setup. Do not store secrets here.
