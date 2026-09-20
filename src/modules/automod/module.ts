import { Events, SlashCommandBuilder, type Message } from 'discord.js';
import type { ModuleContext, SupreModule } from '../../core/module.js';
import { SupreError } from '../../utils/errors.js';
import { translate } from '../../utils/i18n/index.js';
import {
  detectBannedWords,
  detectCaps,
  detectCustomRegex,
  detectEmoji,
  detectInvite,
  detectMentions,
  detectNewAccount,
  detectSuspiciousUrl,
  duplicateSignal,
  floodSignal,
  type DetectorSignal,
  type MessageLike
} from './detectors.js';
import { decide, hashContent, MessageTracker } from './engine.js';
import { executePunishment } from '../moderation/actions.js';
import {
  automodSettingsDefaults,
  automodSettingsSchema,
  type AutoModSettings
} from './settings.js';

const tracker = new MessageTracker();

/**
 * Auto-moderation module.
 *
 * Policy: detectors emit confidence-scored signals; the engine decides
 * allow / delete / action. Weak signals (new account, short banned words)
 * can never, on their own, trigger a punishment — they only combine with
 * stronger evidence. Every decision is audit-logged; punishments reuse the
 * moderation case pipeline.
 */
export const automodModule: SupreModule = {
  name: 'automod',
  version: '0.1.0',
  description: 'Configurable auto-moderation with confidence-scored detectors',
  dependencies: ['core', 'logging', 'moderation'],

  startup(ctx: ModuleContext) {
    ctx.client.on(Events.MessageCreate, (message: Message) => {
      if (!message.inGuild()) return;
      void handleMessage(ctx, message);
    });
  },

  commands: [
    {
      module: 'automod',
      name: 'automod',
      description: 'Inspect and test auto-moderation',
      requiredPermission: 'ManageGuild',
      configure(builder: SlashCommandBuilder) {
        builder.addStringOption((o) =>
          o.setName('test').setDescription('Dry-run: analyze a sample message against current rules').setMaxLength(2000)
        );
      },
      async run(ctx, interaction) {
        const guild = interaction.guild;
        if (!guild) throw new SupreError('NOT_IN_GUILD', 'guild only');
        const loc = await guildLocale(ctx, guild.id);
        const sample = interaction.options.getString('test');

        if (!sample) {
          const s = await ctx.settings.get<AutoModSettings>(guild.id, 'automod');
          const lines = [
            `Flood: ${s.flood.enabled ? `${s.flood.maxMessages} msgs / ${s.flood.windowMs / 1000}s` : 'off'}`,
            `Duplicate: ${s.duplicate.enabled ? `${s.duplicate.maxDuplicates}x / ${s.duplicate.windowMs / 1000}s` : 'off'}`,
            `Mentions: ${s.mentions.enabled ? `>=${s.mentions.threshold}` : 'off'}`,
            `Caps: ${s.caps.enabled ? `ratio >=${s.caps.ratio} (min ${s.caps.minLength} chars)` : 'off'}`,
            `Emoji: ${s.emoji.enabled ? `ratio >=${s.emoji.ratio}` : 'off'}`,
            `Invites: ${s.invite.enabled ? 'on' : 'off'}`,
            `Suspicious URLs: ${s.suspiciousUrl.enabled ? `${s.suspiciousUrl.domains.length} domains` : 'off'}`,
            `Banned words: ${s.bannedWords.enabled ? `${s.bannedWords.words.length} words` : 'off'}`,
            `Custom regex: ${s.customRegex.enabled ? `${s.customRegex.patterns.length} patterns` : 'off'}`,
            `New account: ${s.newAccount.enabled ? `<${s.newAccount.minAccountAgeMinutes}min (weak signal)` : 'off'}`,
            ``,
            `Delete threshold: ${s.deleteThreshold} | Action threshold: ${s.actionThreshold} | Action: ${s.action}`,
            `Ignored channels: ${s.ignoreChannelIds.length} | Ignored roles: ${s.ignoreRoleIds.length}`
          ];
          await interaction.reply({ content: `🛡️ **AutoMod status** — ${guild.name}\n\`\`\`\n${lines.join('\n')}\n\`\`\``, ephemeral: true });
          return;
        }

        const s = await ctx.settings.get<AutoModSettings>(guild.id, 'automod');
        const msg: MessageLike = {
          content: sample,
          mentionUserIds: (sample.match(/<@!?(\d{10,20})>/g) ?? []).map((m: string) => m.replace(/<@!?|>/g, '')),
          mentionEveryone: sample.includes('<@!here>') || sample.includes('<@here>'),
          authorId: interaction.user.id,
          authorCreatedAt: new Date()
        };
        const signals: DetectorSignal[] = [];
        for (const sig of [
          detectCaps(sample, s.caps),
          detectEmoji(sample, s.emoji),
          detectMentions(msg, s.mentions),
          detectInvite(sample, s.invite),
          detectSuspiciousUrl(sample, s.suspiciousUrl),
          detectBannedWords(sample, s.bannedWords),
          detectCustomRegex(sample, s.customRegex),
          detectNewAccount(msg, s.newAccount)
        ]) {
          if (sig) signals.push(sig);
        }
        const decision = decide(signals, s);
        if (signals.length === 0) {
          await interaction.reply({ content: `🧪 ${translate(loc, 'automod.test_clean')}`, ephemeral: true });
          return;
        }
        const lines = signals.map((sig) => translate(loc, 'automod.test_signal', { signal: sig.type, confidence: sig.score.toFixed(2) }));
        lines.push(`\n**Decision:** ${decision.verdict.toUpperCase()} (confidence ${decision.confidence.toFixed(2)})`);
        await interaction.reply({
          content: `🧪 ${translate(loc, 'automod.test_title')}\n${lines.join('\n')}`,
          ephemeral: true
        });
      }
    }
  ]
};

async function guildLocale(ctx: ModuleContext, guildId: string): Promise<string> {
  try {
    return (await ctx.settings.get<{ locale?: string }>(guildId, 'core')).locale ?? 'en';
  } catch {
    return 'en';
  }
}

async function handleMessage(ctx: ModuleContext, message: Message): Promise<void> {
  const { guild } = message;
  if (!guild) return;
  const author = message.author;
  if (author.bot) {
    const s = await safeSettings(ctx, guild.id);
    if (s?.ignoreBots !== false) return;
  }

  const s = await safeSettings(ctx, guild.id);
  if (!s) return;
  if (!(await ctx.settings.isEnabled(guild.id, 'automod'))) return;
  if (s.ignoreChannelIds.includes(message.channelId)) return;
  const member = message.member;
  if (member && s.ignoreRoleIds.some((r) => member.roles.cache.has(r))) return;

  const msg: MessageLike = {
    content: message.content,
    mentionUserIds: [...message.mentions.users.keys()],
    mentionEveryone: message.mentions.everyone,
    authorId: author.id,
    authorCreatedAt: author.createdAt
  };

  const signals: DetectorSignal[] = [];
  for (const sig of [
    detectCaps(message.content, s.caps),
    detectEmoji(message.content, s.emoji),
    detectMentions(msg, s.mentions),
    detectInvite(message.content, s.invite),
    detectSuspiciousUrl(message.content, s.suspiciousUrl),
    detectBannedWords(message.content, s.bannedWords),
    detectCustomRegex(message.content, s.customRegex),
    detectNewAccount(msg, s.newAccount)
  ]) {
    if (sig) signals.push(sig);
  }

  // Stateful detectors
  const now = Date.now();
  const floodN = tracker.floodCount(`${guild.id}:${author.id}`, now, s.flood.windowMs);
  const floodSig = floodSignal(floodN, s.flood);
  if (floodSig) signals.push(floodSig);
  const dupHash = hashContent(message.content);
  const dupN = tracker.duplicateCount(`${guild.id}:${author.id}`, dupHash, now, s.duplicate.windowMs);
  const dupSig = duplicateSignal(dupN, s.duplicate);
  if (dupSig) signals.push(dupSig);

  const decision = decide(signals, s);
  if (decision.verdict === 'allow') return;

  const detail = decision.signals.map((sig) => sig.type).join(', ');

  if (decision.verdict === 'delete') {
    await message.delete().catch(() => undefined);
    await recordEvent(ctx, {
      guildId: guild.id,
      kind: 'automod_delete',
      severity: 'info',
      actorId: author.id,
      metadata: { types: decision.signals.map((sig) => sig.type), confidence: decision.confidence, detail }
    });
    await ctx.logs.log({
      kind: 'security',
      guildId: guild.id,
      actorId: author.id,
      targetId: author.id,
      data: { kind: 'automod_delete', severity: 'info', user: `${author.tag} (${author.id})`, types: detail, confidence: decision.confidence.toFixed(2) }
    });
    return;
  }

  // action verdict — enforce per-user action cooldown
  const cooldownSec = Math.ceil(s.actionCooldownMs / 1000);
  if (cooldownSec > 0) {
    const n = await ctx.cache.incr(`automod:act:${guild.id}:${author.id}`, Math.max(cooldownSec, 1)).catch(() => 1);
    if (n > 1) {
      // On cooldown: delete only, defer the punishment.
      await message.delete().catch(() => undefined);
      await ctx.logs.log({
        kind: 'security',
        guildId: guild.id,
        actorId: author.id,
        targetId: author.id,
        data: { kind: 'automod_cooldown_delete', user: author.id, types: detail, confidence: decision.confidence.toFixed(2) }
      });
      return;
    }
  }

  await message.delete().catch(() => undefined);
  await recordEvent(ctx, {
    guildId: guild.id,
    kind: `automod_action_${s.action}`,
    severity: decision.confidence >= s.actionThreshold + 0.1 ? 'critical' : 'warning',
    actorId: author.id,
    metadata: { types: decision.signals.map((sig) => sig.type), confidence: decision.confidence, detail }
  });

  try {
    const target = message.member;
    if (!target) {
      await ctx.logs.log({
        kind: 'security',
        guildId: guild.id,
        actorId: author.id,
        data: { kind: 'automod_action_skipped', reason: 'member not cached', types: detail }
      });
      return;
    }
    await executePunishment({
      ctx,
      guild,
      target,
      type: s.action,
      moderatorId: ctx.client.user?.id ?? 'automod',
      reason: `AutoMod: ${detail} (confidence ${decision.confidence.toFixed(2)})`,
      durationMs: s.action === 'timeout' ? 60 * 60_000 : undefined,
      recordCase: true
    });
  } catch (err) {
    ctx.logger.warn(
      { err: { message: err instanceof Error ? err.message : String(err) }, guildId: guild.id, userId: author.id },
      'automod action failed'
    );
  }
}

async function safeSettings(ctx: ModuleContext, guildId: string): Promise<AutoModSettings | undefined> {
  try {
    return await ctx.settings.get<AutoModSettings>(guildId, 'automod');
  } catch (err) {
    ctx.logger.debug({ err: { message: err instanceof Error ? err.message : String(err) } }, 'automod settings unavailable');
    return undefined;
  }
}

async function recordEvent(
  ctx: ModuleContext,
  ev: { guildId: string; kind: string; severity: string; actorId: string; metadata: Record<string, unknown> }
): Promise<void> {
  try {
    await ctx.settings.ensureGuild(ev.guildId);
    await ctx.db.query(
      `INSERT INTO security_events (guild_id, kind, severity, actor_id, metadata) VALUES ($1, $2, $3, $4, $5)`,
      [ev.guildId, ev.kind, ev.severity, ev.actorId, JSON.stringify(ev.metadata)]
    );
  } catch (err) {
    ctx.logger.warn({ err: { message: err instanceof Error ? err.message : String(err) } }, 'security event record failed');
  }
}

export { automodSettingsSchema, automodSettingsDefaults };
