import type { Command } from "commander";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../../config/io.js";
import type { DiscordAccountConfig } from "../../config/types.discord.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

function extractClientIdFromToken(token: string): string | undefined {
  try {
    const base64 = token.split(".")[0];
    if (!base64) {
      return undefined;
    }
    const decoded = Buffer.from(base64, "base64").toString("utf-8");
    return /^\d+$/.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

async function channelAddDiscord(opts: {
  token: string;
  accountName: string;
  agent?: string;
}): Promise<void> {
  const { token, accountName, agent } = opts;
  const runtime = defaultRuntime;

  const cfg = loadConfig();
  const { writeOptions } = await readConfigFileSnapshotForWrite();

  const accountPatch: DiscordAccountConfig = { token, enabled: true };

  const next: OpenClawConfig = {
    ...cfg,
    channels: {
      ...cfg.channels,
      discord: {
        ...cfg.channels?.discord,
        enabled: true,
        accounts: {
          ...cfg.channels?.discord?.accounts,
          [accountName]: {
            ...cfg.channels?.discord?.accounts?.[accountName],
            ...accountPatch,
          },
        },
      },
    },
  };

  if (agent) {
    const bindings = [...(next.bindings ?? [])];
    bindings.push({
      agentId: agent,
      match: { channel: "discord", accountId: accountName },
    });
    next.bindings = bindings;
  }

  await writeConfigFile(next, writeOptions);

  runtime.log?.(`${theme.success("✓")} Added Discord account "${accountName}"`);
  if (agent) {
    runtime.log?.(`  Bound to agent "${agent}"`);
  }

  const clientId = extractClientIdFromToken(token);
  if (clientId) {
    runtime.log?.(
      `  Invite URL: https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=274877991936`,
    );
  }
}

export function registerChannelCommands(program: Command) {
  const channel = program
    .command("channel")
    .description("Manage channel accounts and configuration");

  const add = channel.command("add").description("Add a channel account");

  add
    .command("discord")
    .description("Add a Discord bot account")
    .requiredOption("--token <token>", "Discord bot token")
    .requiredOption("--account-name <name>", "Account ID key in config")
    .option("--agent <agentId>", "Bind this account to an agent")
    .addHelpText(
      "after",
      () =>
        `
${theme.heading("Examples:")}
${formatHelpExamples([
  [
    'minion channel add discord --token "Bot..." --account-name my-bot',
    "Add a Discord bot account.",
  ],
  [
    'minion channel add discord --token "Bot..." --account-name my-bot --agent main',
    "Add and bind to an agent.",
  ],
])}
`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await channelAddDiscord({
          token: String(opts.token),
          accountName: String(opts.accountName),
          agent: opts.agent ? String(opts.agent) : undefined,
        });
      });
    });
}
