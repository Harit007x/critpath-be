// Proves a Discord webhook is wired, without creating an account or breaking anything. Locally `pnpm discord:check [signups | ops]`; on Railway, in `railway ssh`,
// `node dist/discord-check.js …`. Posts one plainly-labelled test message to that channel.
import "dotenv-flow/config";
import { notify } from "./lib/discord";

const CHANNELS = { signups: "DISCORD_WEBHOOK_SIGNUPS", ops: "DISCORD_WEBHOOK_OPS" } as const;
const channel = (process.argv[2] ?? "signups") as keyof typeof CHANNELS;

const main = async () => {
  const env = CHANNELS[channel];
  if (!env) throw new Error(`Unknown channel "${channel}": signups or ops`);
  if (!process.env[env]?.trim())
    throw new Error(
      `${env} is not set. Make one under the channel's Edit Channel → Integrations → Webhooks.`
    );
  // Notices are production-only (lib/discord.ts); a check you cannot run locally is never run.
  process.env.DISCORD_NOTIFY_NON_PRODUCTION = "true";
  const sent = await notify(channel, {
    embeds: [
      {
        title: "✅ Webhook test",
        description: `If you can read this, ${env} is wired correctly. Nothing happened in CritPath.`,
        color: 0x22c55e,
        timestamp: new Date().toISOString(),
      },
    ],
  });
  if (!sent) throw new Error("Discord did not take it: the line above says why");
  console.log(`Posted a test message to the ${channel} channel.`);
};

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
