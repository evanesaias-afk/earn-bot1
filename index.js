const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST } = require('discord.js');
const fs = require('fs');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const MONEY_FILE = 'money.json';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let money = {};
if (fs.existsSync(MONEY_FILE)) {
    money = JSON.parse(fs.readFileSync(MONEY_FILE));
}

const commands = [
    new SlashCommandBuilder()
        .setName('earn')
        .setDescription('Give money to a user')
        .addUserOption(option =>
            option.setName('user').setDescription('User to pay').setRequired(true))
        .addIntegerOption(option =>
            option.setName('amount').setDescription('Amount to give').setRequired(true)),

    new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Check your balance'),

    new SlashCommandBuilder()
        .setName('pay')
        .setDescription('Send money to another user')
        .addUserOption(option =>
            option.setName('user').setDescription('User to pay').setRequired(true))
        .addIntegerOption(option =>
            option.setName('amount').setDescription('Amount to send').setRequired(true)),

    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show the top users with the most money')
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands.map(command => command.toJSON()) }
        );
        console.log('Slash commands registered.');
    } catch (error) {
        console.error(error);
    }
})();

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    console.log(`Received command: ${interaction.commandName}`);

    const userId = interaction.user.id;
    if (!money[userId]) money[userId] = 0;

    switch (interaction.commandName) {
        case 'earn': {
            if (!interaction.memberPermissions.has('Administrator')) {
                return interaction.reply({ content: '❌ You must be an admin to use this command.', ephemeral: true });
            }

            const targetUser = interaction.options.getUser('user');
            const amount = interaction.options.getInteger('amount');
            if (!money[targetUser.id]) money[targetUser.id] = 0;
            money[targetUser.id] += amount;
            fs.writeFileSync(MONEY_FILE, JSON.stringify(money, null, 2));
            await interaction.reply(`${targetUser.username} has been given :coin:${amount}. Total: :coin:${money[targetUser.id]}`);
            break;
        }

        case 'balance': {
            await interaction.reply(`💰 You have :coin:${money[userId]}`);
            break;
        }

        case 'pay': {
            const targetUser = interaction.options.getUser('user');
            const amount = interaction.options.getInteger('amount');

            if (amount <= 0) {
                return interaction.reply({ content: '⚠️ Amount must be greater than 0.', ephemeral: true });
            }

            if (money[userId] < amount) {
                return interaction.reply({ content: '🚫 You don’t have enough money.', ephemeral: true });
            }

            if (!money[targetUser.id]) money[targetUser.id] = 0;
            money[userId] -= amount;
            money[targetUser.id] += amount;

            fs.writeFileSync(MONEY_FILE, JSON.stringify(money, null, 2));

            await interaction.reply(`💸 You paid :coin:${amount} to ${targetUser.username}. You now have :coin:${money[userId]}.`);
            break;
        }

        case 'leaderboard': {
            const sorted = Object.entries(money)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10);

            const lines = await Promise.all(sorted.map(async ([id, bal], i) => {
                try {
                    const user = await client.users.fetch(id);
                    return `${i + 1}. ${user.username} — :coin:${bal}`;
                } catch {
                    return `${i + 1}. [Unknown User] — :coin:${bal}`;
                }
            }));

            await interaction.reply(`🏆 **Leaderboard** 🏆\n${lines.join('\n')}`);
            break;
        }
    }
});

client.login(TOKEN);
