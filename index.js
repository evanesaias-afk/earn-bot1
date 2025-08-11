import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==== ENV ====
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const OWNER_IDS = (process.env.OWNER_IDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ==== CLIENT ====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ==== DATA DIRS ====
const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR);

// ==== LOG FILE ====
const EARN_LOG_FILE = path.join(DATA_DIR, 'earn_logs.json');
if (!fs.existsSync(EARN_LOG_FILE)) fs.writeFileSync(EARN_LOG_FILE, '[]');

// ==== USER FILE HELPERS ====
function userFile(userId) {
  return path.join(USERS_DIR, `${userId}.json`);
}

function ensureUserFields(u) {
  if (typeof u.givenTotal !== 'number') u.givenTotal = 0;
  if (typeof u.receivedTotal !== 'number') u.receivedTotal = 0;
  if (!Array.isArray(u.earnGiven)) u.earnGiven = [];
  if (!Array.isArray(u.earnReceived)) u.earnReceived = [];
  return u;
}

function loadUser(userId) {
  const f = userFile(userId);
  if (!fs.existsSync(f)) {
    const base = ensureUserFields({ id: userId, balance: 0, lastDaily: 0 });
    fs.writeFileSync(f, JSON.stringify(base, null, 2));
    return base;
  }
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  return ensureUserFields(data);
}

function saveUser(userData) {
  fs.writeFileSync(userFile(userData.id), JSON.stringify(userData, null, 2));
}

// ==== PERMISSIONS ====
function isOwner(userId) {
  return OWNER_IDS.includes(userId);
}

function canEarn(interaction) {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  return isAdmin || isOwner(interaction.user.id);
}

// ==== GLOBAL LOG ====
function logEarn(giverId, giverTag, targetId, targetTag, amount, whenISO) {
  const logs = JSON.parse(fs.readFileSync(EARN_LOG_FILE, 'utf8'));
  logs.push({ giverId, giverTag, targetId, targetTag, amount, date: whenISO });
  fs.writeFileSync(EARN_LOG_FILE, JSON.stringify(logs, null, 2));
}

// ==== APPLY ONE EARN (updates both users + global log) ====
function applyEarn(giverUser, targetUser, amount, when = new Date()) {
  const whenISO = when.toISOString();

  // receiver
  const recv = loadUser(targetUser.id);
  recv.balance += amount;
  recv.receivedTotal += amount;
  recv.earnReceived.push({
    fromId: giverUser.id,
    fromTag: giverUser.tag,
    amount,
    date: whenISO
  });
  saveUser(recv);

  // giver
  const giver = loadUser(giverUser.id);
  giver.givenTotal += amount;
  giver.earnGiven.push({
    toId: targetUser.id,
    toTag: targetUser.tag,
    amount,
    date: whenISO
  });
  saveUser(giver);

  // global log
  logEarn(giverUser.id, giverUser.tag, targetUser.id, targetUser.tag, amount, whenISO);

  return { recv, giver };
}

// ==== COMMANDS ====
const commands = [
  // 2-in-1 earn
  new SlashCommandBuilder()
    .setName('earn')
    .setDescription('Give coins to up to two users (admin/dev only).')
    .addUserOption(opt =>
      opt.setName('user1').setDescription('First user').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('amount1').setDescription('Amount for first user').setMinValue(1).setRequired(true))
    .addUserOption(opt =>
      opt.setName('user2').setDescription('Second user (optional)').setRequired(false))
    .addIntegerOption(opt =>
      opt.setName('amount2').setDescription('Amount for second user').setMinValue(1).setRequired(false)),

  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check a balance.')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Leave blank to check yourself').setRequired(false)),

  new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Pay another user from your balance.')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Who to pay').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('amount').setDescription('Amount to send').setMinValue(1).setRequired(true)),

  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily coins (24h cooldown).'),

  new SlashCommandBuilder()
    .setName('resetbalance')
    .setDescription('Reset a user balance to zero (dev only).')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User to reset').setRequired(true)),
].map(c => c.toJSON());

// ==== REGISTER SLASH COMMANDS (guild) ====
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registered to guild.');
}

// ==== EVENTS ====
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const { commandName } = interaction;

    // /earn (2-in-1)
    if (commandName === 'earn') {
      if (!canEarn(interaction)) {
        return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /earn.' });
      }

      const user1 = interaction.options.getUser('user1', true);
      const amount1 = interaction.options.getInteger('amount1', true);
      const user2 = interaction.options.getUser('user2', false);
      const amount2 = interaction.options.getInteger('amount2', false);

      const targets = [];
      if (user1.bot) return interaction.reply({ ephemeral: true, content: 'You cannot give coins to a bot (user1).' });
      targets.push({ user: user1, amount: amount1 });

      if (user2 || amount2) {
        if (!user2 || !amount2) {
          return interaction.reply({ ephemeral: true, content: 'If you use user2/amount2, you must provide BOTH.' });
        }
        if (user2.bot) return interaction.reply({ ephemeral: true, content: 'You cannot give coins to a bot (user2).' });
        targets.push({ user: user2, amount: amount2 });
      }

      const when = new Date();
      for (const t of targets) applyEarn(interaction.user, t.user, t.amount, when);

      const lines = targets.map(t => `✅ Gave **${t.amount}** coins to **${t.user.tag}**.`);
      return interaction.reply(lines.join('\n'));
    }

    // /balance
    if (commandName === 'balance') {
      const target = interaction.options.getUser('user') ?? interaction.user;
      const data = loadUser(target.id);
      return interaction.reply(
        target.id === interaction.user.id
          ? `💰 Your balance: **${data.balance}** coins.`
          : `💰 **${target.tag}** balance: **${data.balance}** coins.`
      );
    }

    // /pay
    if (commandName === 'pay') {
      const target = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);

      if (target.bot) {
        return interaction.reply({ ephemeral: true, content: 'You cannot pay a bot.' });
      }
      if (target.id === interaction.user.id) {
        return interaction.reply({ ephemeral: true, content: 'You cannot pay yourself.' });
      }

      const payer = loadUser(interaction.user.id);
      if (payer.balance < amount) {
        return interaction.reply({ ephemeral: true, content: `Not enough coins. You have **${payer.balance}**.` });
      }

      const payee = loadUser(target.id);
      payer.balance -= amount;
      payee.balance += amount;
      saveUser(payer);
      saveUser(payee);

      return interaction.reply(
        `➡️ **${interaction.user.tag}** paid **${target.tag}** **${amount}** coins.\n` +
        `Your new balance: **${payer.balance}**`
      );
    }

    // /daily
    if (commandName === 'daily') {
      const user = loadUser(interaction.user.id);
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;

      const remaining = user.lastDaily ? (user.lastDaily + DAY - now) : 0;
      if (remaining > 0) {
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
        return interaction.reply({
          ephemeral: true,
          content: `⏳ You already claimed daily. Come back in **${hours}h ${minutes}m**.`
        });
      }

      const DAILY_AMOUNT = 100;
      user.balance += DAILY_AMOUNT;
      user.lastDaily = now;
      saveUser(user);

      return interaction.reply(`🗓️ Daily claimed: **${DAILY_AMOUNT}** coins. New balance: **${user.balance}**.`);
    }

    // /resetbalance
    if (commandName === 'resetbalance') {
      if (!isOwner(interaction.user.id)) {
        return interaction.reply({ ephemeral: true, content: 'Dev-only command.' });
      }
      const target = interaction.options.getUser('user', true);
      const data = loadUser(target.id);
      data.balance = 0;
      saveUser(data);
      return interaction.reply(`🧹 Reset **${target.tag}** balance to **0**.`);
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({ ephemeral: true, content: '❌ Something went wrong.' });
    }
    return interaction.reply({ ephemeral: true, content: '❌ Something went wrong.' });
  }
});

// ==== START ====
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
