import argparse
import asyncio
import json
import os
import sys

import aiohttp
import discord


async def send_alert(payload):
    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if not webhook_url:
        raise RuntimeError("DISCORD_WEBHOOK_URL is not configured")

    content = str(payload.get("content", "")).strip()
    if not content:
        raise RuntimeError("Discord alert content is empty")

    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        webhook = discord.Webhook.from_url(webhook_url, session=session)
        await webhook.send(
            content=content[:2000],
            username=payload.get("username", "Target availability monitor"),
            allowed_mentions=discord.AllowedMentions.none(),
            wait=True,
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    if args.check:
        print(discord.__version__)
        return

    payload = json.load(sys.stdin)
    asyncio.run(send_alert(payload))


if __name__ == "__main__":
    main()
