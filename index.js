const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    SlashCommandBuilder,
    REST,
    Routes,
    MessageFlags,
} = require("discord.js");

const express = require("express");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const boostTracking = require("./services/boostTracking");

const app = express();
app.use(express.json());

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_SECRET = process.env.API_SECRET || "change-this-secret";
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const BOOST_WEBHOOK_URL = process.env.BOOST_WEBHOOK_URL;
const ALLOWED_GUILD_ID = "1323274926198620180"; // hub cua ong

if (!DISCORD_TOKEN) {
    console.error("DISCORD_TOKEN not set in environment!");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
    ],
    partials: ["CHANNEL", "MESSAGE"],
    rest: { timeout: 60000 },
    ws: {
        timeout: 60000,
        large_threshold: 50
    }
});

let db;
let keysCollection;
let usersCollection;
let resetCodesCollection;
let isReady = false;

const pendingResets = new Map();

async function connectMongoDB() {
    try {
        const mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        db = mongoClient.db("whitelist");
        resetCodesCollection = db.collection('reset_codes');
        keysCollection = db.collection("keys");
        usersCollection = db.collection("users");
        await keysCollection.createIndex({ key: 1 }, { unique: true });
        await usersCollection.createIndex({ userId: 1 }, { unique: true });
        console.log("✅ MongoDB connected");
    } catch (err) {
        console.error("❌ MongoDB connection failed:", err);
        process.exit(1);
    }
}
async function getKey(key) {
    return await keysCollection.findOne({ key });
}
async function setKey(key, data) {
    return await keysCollection.updateOne(
        { key },
        { $set: data },
        { upsert: true },
    );
}
async function getAllKeys() {
    return await keysCollection.find({}).toArray();
}
async function getUser(userId) {
    return await usersCollection.findOne({ userId });
}
async function setUser(userId, data) {
    return await usersCollection.updateOne(
        { userId },
        { $set: data },
        { upsert: true },
    );
}
// ─── Key Generation (format: MEYYHUB-TYPE-YYMMDD-RAND5-UID5-SIGN6) ───────────
const SECRET = "fc3bd0f753714bf725e0e0b842caf04cac513c3741b873b6faae94e49e02c369";
const PREFIX = "AMETHYSTHUB";
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const KEY_TYPES = {
    "WEEK1": { label: "1 tuần", days: 7, maxKeys: 30 },
    "PRM01": { label: "Premium 1 tháng", days: 30, maxKeys: 10 },
    "LIFET": { label: "Lifetime", days: 99999, maxKeys: 5 },
};

function randStr(n) {
    let out = "";
    for (let i = 0; i < n; i++)
        out += CHARSET[Math.floor(Math.random() * CHARSET.length)];
    return out;
}

function makeSign(typeCode, date, rand, uid) {
    const raw = `${typeCode}${date}${rand}${uid}${SECRET}`;
    return crypto.createHash("sha256").update(raw).digest("hex").toUpperCase().slice(0, 6);
}

function generateKey(typeCode, uid) {
    if (!KEY_TYPES[typeCode]) throw new Error(`Invalid type code: ${typeCode}`);
    // Format mới: 14 ký tự random chữ hoa + số
    return randStr(14);
}

function validateKey(key) {
    const parts = key.trim().toUpperCase().split("-");
    if (parts.length !== 6) return { ok: false, reason: "Invalid format (need 6 segments)" };

    const [prefix, typeCode, dateStr, rand, uid, sign] = parts;
    if (prefix !== PREFIX) return { ok: false, reason: `Invalid prefix` };
    if (!KEY_TYPES[typeCode]) return { ok: false, reason: `Invalid key type '${typeCode}'` };
    if (rand.length !== 5 || uid.length !== 5 || sign.length !== 6)
        return { ok: false, reason: "Invalid segment length" };
    if (sign !== makeSign(typeCode, dateStr, rand, uid))
        return { ok: false, reason: "Invalid signature" };

    let expDate;
    try {
        const y = 2000 + parseInt(dateStr.slice(0, 2));
        const m = parseInt(dateStr.slice(2, 4)) - 1;
        const d = parseInt(dateStr.slice(4, 6));
        expDate = new Date(y, m, d);
        if (isNaN(expDate.getTime())) throw new Error();
    } catch {
        return { ok: false, reason: "Invalid date in key" };
    }

    const expired = KEY_TYPES[typeCode].days >= 99999 ? false : Date.now() > expDate.getTime();
    return {
        ok: true, expired,
        typeCode, typeLabel: KEY_TYPES[typeCode].label,
        expires: expDate.toLocaleDateString("vi-VN"),
        daysLeft: Math.ceil((expDate - Date.now()) / 86_400_000),
        uid, sign,
    };
}

function normalizeHwids(keyData) {
    if (!keyData) return [];
    if (Array.isArray(keyData.hwids)) return keyData.hwids;
    if (keyData.hwid) return [keyData.hwid];
    return [];
}

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    if (!message.guild || message.guild.id !== ALLOWED_GUILD_ID) {
        return message.reply({
            content: "❌ This bot can only be used in the authorized server.",
            flags: MessageFlags.Ephemeral
        });
    }

    if (message.content === "!panel") {
        try {
            await message.delete();
        } catch (e) {
        }

        const embed = new EmbedBuilder()
            .setColor("#5865F2")
            .setTitle("🔐 **Amethyst Hub Whitelist Panel**")
            .setDescription("Select an option from the dropdown menu below.")
            .setThumbnail(client.user?.displayAvatarURL?.() || null)
            .addFields({
                name: "Function",
                value: "Reset HWID / Redeem Key / Manager Key",
            })
            .setFooter({ text: "Amethyst Hub • Premium System" })
            .setTimestamp();

        const dropdown = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId("panel_dropdown")
                .setPlaceholder("Select an option")
                .addOptions([
                    { label: "Reset HWID", value: "dd_reset", emoji: "🔄" },
                    { label: "Redeem Key", value: "dd_redeem", emoji: "✅" },
                    { label: "Manage Key", value: "dd_manage", emoji: "🔑" },
                ]),
        );


        try {
            const dm = await message.author.createDM();
            await dm.send({ embeds: [embed], components: [dropdown] });


            const reply = await message.channel.send({
                content: `✅ <@${message.author.id}> Panel đã được gửi vào DM của bạn!`
            });

            setTimeout(() => reply.delete().catch(() => { }), 5000);
        } catch (error) {

            await message.channel.send({
                content: `<@${message.author.id}>`,
                embeds: [embed],
                components: [dropdown]
            }).then(msg => {

                setTimeout(() => msg.delete().catch(() => { }), 30000);
            });
        }
        return;
    }

    if (message.content.startsWith('!resethwid-key')) {
        if (!message.guild || message.guild.id !== ALLOWED_GUILD_ID) return
        const member = await message.guild.members.fetch(message.author.id)
        if (!member.roles.cache.some(r => r.name === 'Owner')) {
            return message.reply('❌ Chỉ Owner mới dùng được lệnh này.')
        }
        const args = message.content.split(' ')
        const targetKey = args[1]?.trim()
        if (!targetKey) return message.reply('❌ Dùng: `!resethwid-key <key>`')
        const kd = await getKey(targetKey)
        if (!kd) return message.reply('❌ Không tìm thấy key.')
        const hwids = normalizeHwids(kd)
        if (hwids.length === 0) return message.reply('⚠️ Key này chưa đăng ký HWID.')
        await setKey(targetKey, { ...kd, hwids: [], hwid: undefined })
        await db.collection('hwid_reset_logs').insertOne({
            userId: message.author.id, userTag: message.author.tag,
            key: targetKey, method: 'admin-force', resetAt: Date.now()
        })
        const embed = new EmbedBuilder()
            .setColor('#22dd22')
            .setTitle('✅ HWID Đã Reset')
            .addFields(
                { name: 'Key', value: `\`${targetKey}\`` },
                { name: 'Reset bởi', value: `<@${message.author.id}>` },
                { name: 'Owner cũ', value: kd.userId ? `<@${kd.userId}>` : 'N/A' }
            )
            .setTimestamp()
        return message.reply({ embeds: [embed] })
    }
    if (message.content.startsWith('!whitelist-resetcode')) {
        if (!message.guild || message.guild.id !== ALLOWED_GUILD_ID) return
        const member = await message.guild.members.fetch(message.author.id)
        if (!member.roles.cache.some(r => r.name === 'Whitelist') && !member.roles.cache.some(r => r.name === 'Owner')) {
            return message.reply('❌ Bạn không có quyền tạo reset code.')
        }
        const args = message.content.split(' ')
        const qty = parseInt(args[1]) || 1
        if (qty < 1 || qty > 50) return message.reply('❌ Số lượng phải từ 1-50.')

        const codes = []
        for (let i = 0; i < qty; i++) {
            const code = 'RC-' + crypto.randomBytes(4).toString('hex').toUpperCase()
            await resetCodesCollection.insertOne({
                code, used: false,
                createdBy: message.author.id, createdAt: Date.now()
            })
            codes.push(code)
        }


        try {
            const dm = await message.author.createDM()
            await dm.send(`**${qty} Reset Code(s) đã tạo:**\n\`\`\`\n${codes.join('\n')}\n\`\`\`\nDùng \`/reset-code <code>\` để reset HWID.`)
        } catch { }

        const embed = new EmbedBuilder()
            .setColor('#00cc88')
            .setTitle(`✅ Tạo ${qty} Reset Code`)
            .setDescription('Codes đã được gửi qua DM.')
            .setTimestamp()
        return message.reply({ embeds: [embed] })
    }

    if (message.content.startsWith('!checkkey')) {
        const member = await message.guild.members.fetch(message.author.id)
        if (!member.roles.cache.some(r => r.name === 'Owner' || r.name === 'Main Developer'))
            return message.reply('❌ Chỉ Owner hoặc Main Developer mới dùng được lệnh này.')

        const args = message.content.split(' ')
        const targetKey = args[1]?.trim().toUpperCase()
        if (!targetKey) return message.reply('❌ Dùng: `!checkkey <key>`')

        const kd = await getKey(targetKey)
        if (!kd) return message.reply('❌ Không tìm thấy key trong database.')

        // Validate signature & parse thời hạn từ key
        const validation = validateKey(targetKey)

        // Tính thời gian còn lại
        let timeLeft = '♾️ Lifetime'
        let expiredText = ''
        if (kd.expiresAt) {
            const remaining = kd.expiresAt - Date.now()
            if (remaining <= 0) {
                timeLeft = '⛔ Đã hết hạn'
                expiredText = '**[HẾT HẠN]**'
            } else {
                const days = Math.floor(remaining / 86_400_000)
                const hours = Math.floor((remaining % 86_400_000) / 3_600_000)
                const mins = Math.floor((remaining % 3_600_000) / 60_000)
                timeLeft = `⏳ **${days}** ngày **${hours}** giờ **${mins}** phút`
            }
        }

        const hwids = normalizeHwids(kd)
        const maxHwid = kd.maxHwid ?? 1
        const statusColor = !kd.active ? '#ff4444'
            : (kd.expiresAt && Date.now() > kd.expiresAt) ? '#ff8800'
                : '#00cc88'

        const embed = new EmbedBuilder()
            .setColor(statusColor)
            .setTitle(`🔑 Chi tiết Key ${expiredText}`)
            .addFields(
                { name: '🔑 Key', value: `\`${targetKey}\``, inline: false },
                { name: '📦 Loại', value: kd.typeLabel || validation.typeLabel || 'N/A', inline: true },
                { name: '🛡️ Trạng thái', value: kd.active ? '✅ Active' : '🚫 Blacklisted', inline: true },
                { name: '⏰ Còn lại', value: timeLeft, inline: false },
                { name: '📅 Tạo lúc', value: kd.createdAt ? `<t:${Math.floor(kd.createdAt / 1000)}:f>` : 'N/A', inline: true },
                { name: '📅 Hết hạn', value: kd.expiresAt ? `<t:${Math.floor(kd.expiresAt / 1000)}:f>` : '♾️ Không giới hạn', inline: true },
                { name: '👤 Tạo bởi', value: kd.createdBy ? `<@${kd.createdBy}>` : 'N/A', inline: true },
                { name: '🎁 Tạo cho', value: kd.createdFor ? `<@${kd.createdFor}>` : 'N/A', inline: true },
                { name: '✅ Redeemed bởi', value: kd.userId ? `<@${kd.userId}>` : '❌ Chưa redeem', inline: true },
                { name: '📆 Redeem lúc', value: kd.redeemedAt ? `<t:${Math.floor(kd.redeemedAt / 1000)}:f>` : 'N/A', inline: true },
                { name: `🖥️ HWID (${hwids.length}/${maxHwid})`, value: hwids.length > 0 ? hwids.map(h => `\`${h}\``).join('\n') : '*(chưa đăng ký)*', inline: false },
            )
            .setFooter({ text: 'Amethyst Hub • Key Inspector' })
            .setTimestamp()

        return message.reply({ embeds: [embed] })
    }

    // ─── !checkuserkey [user_mention / user_id] ───────────────────────────────
    if (message.content.startsWith('!checkuserkey')) {
        const member = await message.guild.members.fetch(message.author.id)
        if (!member.roles.cache.some(r => r.name === 'Owner' || r.name === 'Main Developer'))
            return message.reply('❌ Chỉ Owner hoặc Main Developer mới dùng được lệnh này.')

        const args = message.content.split(' ')
        const rawArg = args[1]?.trim()
        if (!rawArg) return message.reply('❌ Dùng: `!checkuserkey <@user hoặc userID>`')

        // Lấy userId dù là mention hay raw ID
        const userId = rawArg.replace(/[<@!>]/g, '')
        if (!/^\d+$/.test(userId)) return message.reply('❌ User không hợp lệ.')

        // Tìm tất cả key thuộc user (đã redeem hoặc được tạo cho)
        const allKeys = await getAllKeys()
        const ownedKeys = allKeys.filter(k => k.userId === userId)   // đã redeem
        const receivedKeys = allKeys.filter(k => k.createdFor === userId && !k.userId) // chưa redeem, tạo cho user này

        const total = ownedKeys.length + receivedKeys.length
        if (total === 0)
            return message.reply(`❌ Không tìm thấy key nào liên quan đến <@${userId}>.`)

        // Helper hiển thị 1 key ngắn gọn
        const formatKeyLine = (k) => {
            const label = k.typeLabel || 'N/A'
            const status = !k.active ? '🚫' : (k.expiresAt && Date.now() > k.expiresAt) ? '⛔' : '✅'
            const expStr = k.expiresAt
                ? `<t:${Math.floor(k.expiresAt / 1000)}:d>`
                : '♾️'
            return `${status} \`${k.key}\` — ${label} — hết hạn: ${expStr}`
        }

        // Discord field value max 1024 ký tự — chia chunk nếu cần
        const buildChunks = (keys, emptyText) => {
            if (keys.length === 0) return [emptyText]
            const lines = keys.map(formatKeyLine)
            const chunks = []
            let chunk = ''
            for (const line of lines) {
                if ((chunk + '\n' + line).length > 1000) { chunks.push(chunk); chunk = line }
                else chunk = chunk ? chunk + '\n' + line : line
            }
            if (chunk) chunks.push(chunk)
            return chunks
        }

        const redeemedChunks = buildChunks(ownedKeys, '*(không có)*')
        const pendingChunks = buildChunks(receivedKeys, '*(không có)*')

        let targetTag = `<@${userId}>`
        try {
            const u = await client.users.fetch(userId)
            targetTag = `**${u.username}** (<@${userId}>)`
        } catch { }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`🗂️ Keys của ${targetTag.replace(/\*\*/g, '')}`)
            .setDescription(`Tổng cộng: **${total}** key(s) — ✅ Đã redeem: **${ownedKeys.length}** — ⏳ Chưa redeem: **${receivedKeys.length}**`)
            .setFooter({ text: 'Amethyst Hub • Key Inspector' })
            .setTimestamp()

        // Thêm field cho từng chunk đã redeem
        redeemedChunks.forEach((chunk, i) => {
            embed.addFields({
                name: i === 0 ? `✅ Đã redeem (${ownedKeys.length})` : '​', // zero-width space cho tiêu đề tiếp theo
                value: chunk,
                inline: false
            })
        })

        // Thêm field cho từng chunk chưa redeem
        pendingChunks.forEach((chunk, i) => {
            embed.addFields({
                name: i === 0 ? `⏳ Chưa redeem / tạo cho user này (${receivedKeys.length})` : '​',
                value: chunk,
                inline: false
            })
        })

        return message.reply({ embeds: [embed] })
    }
});

const slashCommands = [
    new SlashCommandBuilder()
        .setName("stats")
        .setDescription("Show bot statistics"),

    new SlashCommandBuilder().setName('reset-code').setDescription('Reset HWID bằng reset code')
        .addStringOption(o => o.setName('code').setDescription('Reset code').setRequired(true)),

    new SlashCommandBuilder()
        .setName("blacklist")
        .setDescription("Blacklist a key")
        .addStringOption((o) =>
            o.setName("key").setDescription("Key to blacklist").setRequired(true),
        ),

    new SlashCommandBuilder()
        .setName("whitelist")
        .setDescription("Create keys and send to a user")
        .addUserOption((o) =>
            o
                .setName("user")
                .setDescription("User to receive the keys via DM")
                .setRequired(true),
        )
        .addIntegerOption((o) =>
            o.setName("quantity").setDescription("Number of keys").setRequired(true),
        )
        .addStringOption((o) =>
            o
                .setName("type_code")
                .setDescription("Loại key")
                .setRequired(true)
                .addChoices(
                    { name: "1 tuần         (WEEK1)", value: "WEEK1" },
                    { name: "Premium 1 tháng (PRM01)", value: "PRM01" },
                    { name: "Lifetime        (LIFET)", value: "LIFET" },
                ),
        )
        .addIntegerOption((o) =>
            o
                .setName("max_hwid")
                .setDescription(
                    "Max number of devices (HWIDs) allowed per key (default: 1)",
                )
                .setRequired(false),
        ),

    new SlashCommandBuilder()
        .setName("resethwid")
        .setDescription("Reset HWID for one of your keys"),

    new SlashCommandBuilder()
        .setName("redeem")
        .setDescription("Redeem a key to your account")
        .addStringOption((o) =>
            o.setName("key").setDescription("Key to redeem").setRequired(true),
        ),

    new SlashCommandBuilder()
        .setName("managekey")
        .setDescription("View your keys"),

    new SlashCommandBuilder()
        .setName("addhwid")
        .setDescription("[Owner] Add a HWID to an existing key")
        .addStringOption((o) =>
            o.setName("key").setDescription("Target key").setRequired(true),
        )
        .addStringOption((o) =>
            o.setName("hwid").setDescription("HWID to add").setRequired(true),
        ),

    new SlashCommandBuilder()
        .setName("removehwid")
        .setDescription("[Owner] Remove a specific HWID from a key")
        .addStringOption((o) =>
            o.setName("key").setDescription("Target key").setRequired(true),
        )
        .addStringOption((o) =>
            o.setName("hwid").setDescription("HWID to remove").setRequired(true),
        ),

    new SlashCommandBuilder()
        .setName("setmaxhwid")
        .setDescription("[Owner] Change the max HWID limit of a key")
        .addStringOption((o) =>
            o.setName("key").setDescription("Target key").setRequired(true),
        )
        .addIntegerOption((o) =>
            o.setName("max").setDescription("New max HWID count").setRequired(true),
        ),
];

async function registerSlashCommands() {
    try {
        const rest = new REST().setToken(DISCORD_TOKEN);

        // Xóa global commands cũ (nếu có) để tránh conflict
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [] }
        );
        console.log("🗑️ Cleared global slash commands");

        // Register guild commands (cập nhật ngay lập tức)
        const result = await rest.put(
            Routes.applicationGuildCommands(client.user.id, ALLOWED_GUILD_ID),
            { body: slashCommands.map((c) => c.toJSON()) },
        );
        console.log(`✅ Registered ${result.length} slash commands for guild ${ALLOWED_GUILD_ID}`);
        result.forEach(cmd => console.log(`   - /${cmd.name}`));
    } catch (err) {
        console.error("❌ Slash commands registration failed:", err.message);
        console.error(err);
    }
}

client.on("interactionCreate", async (interaction) => {
    try {
        if (!interaction.guild || interaction.guild.id !== ALLOWED_GUILD_ID) {
            if (
                interaction.isCommand() ||
                interaction.isButton() ||
                interaction.isStringSelectMenu()
            ) {
                return interaction.reply({
                    content: "❌ This bot can only be used in the authorized server.",
                    ephemeral: true,
                });
            }
            return;
        }


        if (interaction.isChatInputCommand()) {
            await interaction.deferReply({ ephemeral: true });
        }


        if (
            interaction.isStringSelectMenu() &&
            (interaction.customId === "slash_reset_select" ||
                interaction.customId === "slash_manage_select" ||
                interaction.customId === "panel_dropdown" ||
                interaction.customId.startsWith("reset_code_select_"))
        ) {
            await interaction.deferReply({ ephemeral: true });
        }

        if (interaction.isChatInputCommand()) {
            const commandName = interaction.commandName;

            // Phân quyền lệnh:
            // - Ai cũng dùng được: /redeem
            // - Premium: /redeem + /resethwid + /managekey
            // - Owner: tất cả
            const memberCheck = await interaction.guild.members.fetch(interaction.user.id);
            const isOwner = memberCheck.roles.cache.some(r => r.name === "Owner");
            const hasPremium = memberCheck.roles.cache.some(r => r.name === "Premium");

            const ownerOnlyCommands = ["genkey", "whitelist", "blacklist", "stats", "addhwid", "removehwid", "setmaxhwid", "reset-code"];
            const premiumCommands = ["resethwid", "managekey"];

            if (ownerOnlyCommands.includes(commandName) && !isOwner) {
                return interaction.editReply({
                    content: "❌ Chỉ **Owner** mới dùng được lệnh này!"
                });
            }

            if (premiumCommands.includes(commandName) && !hasPremium && !isOwner) {
                return interaction.editReply({
                    content: "❌ Bạn cần role **Premium** để dùng lệnh này! Dùng /redeem để kích hoạt key trước."
                });
            }

            if (commandName === "stats") {
                const totalKeys = await keysCollection.countDocuments();
                const totalUsers = await usersCollection.countDocuments();
                const activeKeys = await keysCollection.countDocuments({
                    active: true,
                });
                const expiredKeys = await keysCollection.countDocuments({
                    active: true,
                    expiresAt: { $ne: null, $lt: Date.now() },
                });

                const embed = new EmbedBuilder()
                    .setColor("#00FF00")
                    .setTitle("📊 Bot Statistics")
                    .addFields(
                        { name: "Total Keys", value: String(totalKeys), inline: true },
                        {
                            name: "Active Keys",
                            value: String(activeKeys - expiredKeys),
                            inline: true,
                        },
                        { name: "Expired Keys", value: String(expiredKeys), inline: true },
                        { name: "Total Users", value: String(totalUsers), inline: true },
                        {
                            name: "Uptime",
                            value: `${Math.floor(client.uptime / 1000 / 60)} minutes`,
                            inline: true,
                        },
                    )
                    .setTimestamp();
                return await interaction.editReply({ embeds: [embed] });
            }

            if (commandName === "blacklist") {
                const key = interaction.options.getString("key");
                const member = await interaction.guild.members.fetch(
                    interaction.user.id,
                );
                if (!member.roles.cache.some((r) => r.name === "Owner"))
                    return interaction.editReply({ content: "❌ Missing Owner role" });

                const keyData = await getKey(key);
                if (!keyData)
                    return interaction.editReply({ content: "❌ Key not found" });
                if (!keyData.active)
                    return interaction.editReply({
                        content: "❌ Key already blacklisted",
                    });

                await setKey(key, {
                    ...keyData,
                    active: false,
                    blacklistedAt: Date.now(),
                    blacklistedBy: interaction.user.id,
                });
                await db.collection("blacklist_logs").insertOne({
                    key,
                    blacklistedBy: interaction.user.id,
                    blacklistedByTag: interaction.user.tag,
                    blacklistedAt: Date.now(),
                    previousOwner: keyData.userId || null,
                });

                const embed = new EmbedBuilder()
                    .setColor("#ff4444")
                    .setTitle("🚫 Key Blacklisted")
                    .addFields(
                        { name: "Key", value: `${key}` },
                        { name: "Blacklisted By", value: `<@${interaction.user.id}>` },
                        {
                            name: "Previous Owner",
                            value: keyData.userId ? `<@${keyData.userId}>` : "Not redeemed",
                        },
                    )
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === "whitelist") {
                const targetUser = interaction.options.getUser("user");
                const quantity = interaction.options.getInteger("quantity");
                const typeCode = interaction.options.getString("type_code");
                const maxHwid = interaction.options.getInteger("max_hwid") ?? 1;

                const member = await interaction.guild.members.fetch(
                    interaction.user.id,
                );
                if (!member.roles.cache.some((r) => r.name === "Owner"))
                    return interaction.editReply({ content: "❌ Missing Owner role" });

                if (quantity < 1 || quantity > 100)
                    return interaction.editReply({
                        content: "❌ Quantity must be 1-100",
                    });

                if (maxHwid < 1 || maxHwid > 50)
                    return interaction.editReply({ content: "❌ max_hwid must be 1-50" });

                const typeInfo = KEY_TYPES[typeCode];
                const days = typeInfo.days;

                // UID lấy từ 5 ký tự đầu Discord ID của người nhận
                const uid = targetUser.id.slice(0, 5).toUpperCase().padEnd(5, "0");

                const createdKeys = [];
                for (let i = 0; i < quantity; i++) {
                    const key = generateKey(typeCode, uid);
                    const expiresAt = days >= 99999 ? null : Date.now() + days * 86_400_000;
                    await setKey(key, {
                        key,
                        typeCode,
                        typeLabel: typeInfo.label,
                        userId: null,
                        hwids: [],
                        maxHwid,
                        active: true,
                        expiresAt,
                        createdAt: Date.now(),
                        createdBy: interaction.user.id,
                        createdFor: targetUser.id,
                        redeemedAt: null,
                    });
                    createdKeys.push({ key, expiresAt });
                }

                await db.collection("key_creation_logs").insertOne({
                    createdBy: interaction.user.id,
                    createdByTag: interaction.user.tag,
                    createdFor: targetUser.id,
                    createdForTag: targetUser.tag,
                    quantity,
                    typeCode,
                    days,
                    maxHwid,
                    keys: createdKeys.map((k) => k.key),
                    createdAt: Date.now(),
                });

                let dmStatus = "✅ Keys sent to user via DM";
                try {
                    const dm = await targetUser.createDM();
                    const dmEmbed = new EmbedBuilder()
                        .setColor("#00cc88")
                        .setTitle("You receive 1 Premium key")
                        .setDescription(
                            `You get  **${quantity}** key(s) from <@${interaction.user.id}>`,
                        )
                        .addFields(
                            {
                                name: "Type of Key",
                                value: `**${typeInfo.label}** (\`${typeCode}\`)`,
                            },
                            {
                                name: "Expiration",
                                value: days >= 99999 ? "♾️ Lifetime" : ` ${days} days`,
                            },
                            {
                                name: " Devices allowed per key",
                                value: `**${maxHwid}** device(s)`,
                            },
                            {
                                name: "How to use",
                                value: "Use `/redeem <key>` command to activate your key",
                            },
                        )
                        .setFooter({ text: "Amethyst Hub • Premium System" })
                        .setTimestamp();
                    await dm.send({ embeds: [dmEmbed] });
                    await dm.send(
                        `**Your Keys:**\n\`\`\`${createdKeys.map((k) => k.key).join("\n")}\`\`\``,
                    );
                } catch {
                    dmStatus = "⚠️ Could not send DM to user (DMs might be closed)";
                }

                const embed = new EmbedBuilder()
                    .setColor("#00cc88")
                    .setTitle("✅ Keys Created Successfully")
                    .setDescription(
                        `Created **${quantity}** key(s) for <@${targetUser.id}>`,
                    )
                    .addFields(
                        {
                            name: "Loại key",
                            value: `**${typeInfo.label}** (\`${typeCode}\`)`,
                        },
                        {
                            name: "Thời hạn",
                            value: days >= 99999 ? "♾️ Lifetime" : `⏰ ${days} ngày`,
                        },
                        { name: "🖥️ Max Devices (HWID) per key", value: `**${maxHwid}**` },
                        { name: "Created By", value: `<@${interaction.user.id}>` },
                        { name: "Status", value: dmStatus },
                    )
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === "addhwid") {
                const member = await interaction.guild.members.fetch(
                    interaction.user.id,
                );
                if (!member.roles.cache.some((r) => r.name === "Owner"))
                    return interaction.editReply({ content: "❌ Missing Owner role" });

                const key = interaction.options.getString("key");
                const hwid = interaction.options.getString("hwid");
                const keyData = await getKey(key);
                if (!keyData)
                    return interaction.editReply({ content: "❌ Key not found" });
                if (!keyData.active)
                    return interaction.editReply({ content: "❌ Key is blacklisted" });

                const hwids = normalizeHwids(keyData);
                const maxHwid = keyData.maxHwid ?? 1;

                if (hwids.includes(hwid))
                    return interaction.editReply({
                        content: "❌ This HWID is already registered on this key.",
                    });

                if (hwids.length >= maxHwid)
                    return interaction.editReply({
                        content: `❌ Key already reached max HWID limit (**${maxHwid}**). Use \`/setmaxhwid\` to increase the limit first.`,
                    });

                hwids.push(hwid);
                await setKey(key, { ...keyData, hwids, hwid: undefined });
                await db.collection("hwid_register_logs").insertOne({
                    key,
                    hwid,
                    registeredAt: Date.now(),
                    registeredBy: interaction.user.id,
                    source: "addhwid_command",
                });

                const embed = new EmbedBuilder()
                    .setColor("#22dd99")
                    .setTitle("✅ HWID Added")
                    .addFields(
                        { name: "Key", value: `\`${key}\`` },
                        { name: "Added HWID", value: `\`${hwid}\`` },
                        { name: "Slots used", value: `**${hwids.length} / ${maxHwid}**` },
                    )
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'reset-code') {
                const code = interaction.options.getString('code').trim().toUpperCase()
                const codeData = await resetCodesCollection.findOne({ code, used: false })
                if (!codeData) return interaction.editReply({ content: '❌ Code không hợp lệ hoặc đã được dùng!' })


                const user = await getUser(interaction.user.id)
                if (!user || !user.keys || user.keys.length === 0) {
                    return interaction.editReply({ content: '❌ Bạn chưa có key nào.' })
                }

                const keysWithHwid = []
                for (const k of user.keys) {
                    const kd = await getKey(k)
                    const hwids = normalizeHwids(kd)
                    if (kd && hwids.length > 0) {
                        keysWithHwid.push({ key: k, hwids, maxHwid: kd.maxHwid ?? 1 })
                    }
                }

                if (keysWithHwid.length === 0) {
                    return interaction.editReply({ content: '❌ Bạn chưa có key nào có HWID để reset.' })
                }

                const menu = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`reset_code_select_${code}`)
                        .setPlaceholder('Chọn key để reset')
                        .addOptions(
                            keysWithHwid.map((item, idx) => ({
                                label: `Key #${idx + 1}`,
                                description: `${item.key.substring(0, 20)}... — ${item.hwids.length}/${item.maxHwid} HWIDs`,
                                value: item.key,
                            })),
                        ),
                )

                return interaction.editReply({
                    content: `✅ Chọn **1 key** để reset HWID bằng code \`${code}\`:`,
                    components: [menu],
                })
            }

            if (commandName === "removehwid") {
                const member = await interaction.guild.members.fetch(
                    interaction.user.id,
                );
                if (!member.roles.cache.some((r) => r.name === "Owner"))
                    return interaction.editReply({ content: "❌ Missing Owner role" });

                const key = interaction.options.getString("key");
                const hwid = interaction.options.getString("hwid");
                const keyData = await getKey(key);
                if (!keyData)
                    return interaction.editReply({ content: "❌ Key not found" });

                const hwids = normalizeHwids(keyData);
                if (!hwids.includes(hwid))
                    return interaction.editReply({
                        content: "❌ HWID not found on this key.",
                    });

                const updated = hwids.filter((h) => h !== hwid);
                await setKey(key, { ...keyData, hwids: updated, hwid: undefined });

                const embed = new EmbedBuilder()
                    .setColor("#ff9900")
                    .setTitle("🗑️ HWID Removed")
                    .addFields(
                        { name: "Key", value: `\`${key}\`` },
                        { name: "Removed HWID", value: `\`${hwid}\`` },
                        {
                            name: "Slots used",
                            value: `**${updated.length} / ${keyData.maxHwid ?? 1}**`,
                        },
                    )
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === "setmaxhwid") {
                const member = await interaction.guild.members.fetch(
                    interaction.user.id,
                );
                if (!member.roles.cache.some((r) => r.name === "Owner"))
                    return interaction.editReply({ content: "❌ Missing Owner role" });

                const key = interaction.options.getString("key");
                const max = interaction.options.getInteger("max");
                if (max < 1 || max > 50)
                    return interaction.editReply({ content: "❌ max must be 1-50" });

                const keyData = await getKey(key);
                if (!keyData)
                    return interaction.editReply({ content: "❌ Key not found" });

                const hwids = normalizeHwids(keyData);
                await setKey(key, { ...keyData, hwids, maxHwid: max, hwid: undefined });

                const embed = new EmbedBuilder()
                    .setColor("#5865F2")
                    .setTitle("✏️ Max HWID Updated")
                    .addFields(
                        { name: "Key", value: `\`${key}\`` },
                        { name: "New Max Devices", value: `**${max}**` },
                        { name: "Currently registered", value: `${hwids.length} HWID(s)` },
                    )
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === "redeem") {
                const key = interaction.options.getString("key");
                const keyData = await getKey(key);
                if (!keyData)
                    return interaction.editReply({ content: "❌ Invalid key" });
                if (!keyData.active)
                    return interaction.editReply({ content: "❌ Key is blacklisted" });
                if (keyData.userId)
                    return interaction.editReply({ content: "❌ Key already redeemed" });
                if (keyData.expiresAt && Date.now() > keyData.expiresAt)
                    return interaction.editReply({ content: "❌ Key expired" });

                await setKey(key, {
                    ...keyData,
                    userId: interaction.user.id,
                    redeemedAt: Date.now(),
                });

                const user = (await getUser(interaction.user.id)) || {
                    userId: interaction.user.id,
                    keys: [],
                };
                user.keys = user.keys || [];
                user.keys.push(key);
                await setUser(interaction.user.id, user);

                let roleMsg = "No role assigned";
                try {
                    const guild = interaction.guild;
                    if (guild) {
                        const role = guild.roles.cache.find((r) => r.name === "Premium");
                        if (role) {
                            const member = await guild.members.fetch(interaction.user.id);
                            await member.roles.add(role);
                            roleMsg = "✅ Premium role added";
                        } else {
                            roleMsg = "⚠️ Role Premium not found";
                        }
                    }
                } catch {
                    roleMsg = "❌ Error assigning role";
                }

                await db.collection("redeem_logs").insertOne({
                    userId: interaction.user.id,
                    userTag: interaction.user.tag,
                    key,
                    redeemedAt: Date.now(),
                });

                const hwids = normalizeHwids(keyData);
                const maxHwid = keyData.maxHwid ?? 1;
                let expireText = "♾️ Lifetime";
                if (keyData.expiresAt)
                    expireText = new Date(keyData.expiresAt).toLocaleString("vi-VN");

                const embed = new EmbedBuilder()
                    .setColor("#33aaee")
                    .setTitle("✅ Key Redeemed")
                    .addFields(
                        { name: "Key", value: `\`${key}\`` },
                        { name: "User", value: `<@${interaction.user.id}>` },
                        { name: "Role", value: roleMsg },
                        { name: "Expiration", value: expireText },
                        {
                            name: "🖥️ Device slots",
                            value: `${hwids.length} / ${maxHwid} used`,
                        },
                    )
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === "resethwid") {
                const user = await getUser(interaction.user.id);
                if (!user || !user.keys || user.keys.length === 0)
                    return interaction.editReply({
                        content: "❌ You don't have any keys.",
                    });

                const keysWithHwid = [];
                for (const k of user.keys) {
                    const kd = await getKey(k);
                    const hwids = normalizeHwids(kd);
                    if (kd && hwids.length > 0)
                        keysWithHwid.push({ key: k, hwids, maxHwid: kd.maxHwid ?? 1 });
                }
                if (keysWithHwid.length === 0)
                    return interaction.editReply({
                        content: "❌ You have no keys with HWID registered.",
                    });

                const menu = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId("slash_reset_select")
                        .setPlaceholder("Select a key to reset HWID")
                        .addOptions(
                            keysWithHwid.map((item, idx) => ({
                                label: `Key #${idx + 1}`,
                                description: `${item.key.substring(0, 20)}... — ${item.hwids.length}/${item.maxHwid} HWIDs`,
                                value: item.key,
                            })),
                        ),
                );

                return interaction.editReply({
                    content: `You have **${keysWithHwid.length}** key(s) with HWID. Select one to reset **all** HWIDs.`,
                    components: [menu],
                });
            }

            if (commandName === "managekey") {
                const user = await getUser(interaction.user.id);
                if (!user || !user.keys || user.keys.length === 0)
                    return interaction.editReply({ content: "❌ You don't have keys." });

                const menu = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId("slash_manage_select")
                        .setPlaceholder("Select key to view")
                        .addOptions(
                            user.keys.map((k, i) => ({
                                label: `Key #${i + 1}`,
                                description: `${k.substring(0, 20)}...`,
                                value: k,
                            })),
                        ),
                );

                const embed = new EmbedBuilder()
                    .setColor("#0099FF")
                    .setTitle("🔑 Your Keys")
                    .setDescription(
                        `You have **${user.keys.length}** key(s). Select one below.`,
                    )
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed], components: [menu] });
            }
        }


        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "panel_dropdown"
        ) {
            const val = interaction.values[0];
            if (val === "dd_reset")
                return interaction.editReply({
                    content: "Use /resethwid to proceed (slash).",
                });
            if (val === "dd_redeem")
                return interaction.editReply({
                    content: "Use /redeem <key> to redeem (slash).",
                });
            if (val === "dd_manage")
                return interaction.editReply({
                    content: "Use /managekey to view your keys (slash).",
                });
        }

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "slash_reset_select"
        ) {
            const selectedKey = interaction.values[0];
            const keyData = await getKey(selectedKey);
            const user = (await getUser(interaction.user.id)) || {};
            const member = interaction.guild
                ? await interaction.guild.members.fetch(interaction.user.id)
                : null;

            let cooldownTime = 0;
            let cooldownName = "";
            if (member && member.roles.cache.some((r) => r.name === "Reset Access")) {
                cooldownTime = 1000;
                cooldownName = "1 second";
            } else if (
                member &&
                member.roles.cache.some((r) => r.name === "Server Booster")
            ) {
                cooldownTime = 2 * 60 * 60 * 1000;
                cooldownName = "2 hours";
            } else if (
                member &&
                member.roles.cache.some((r) => r.name === "Premium")
            ) {
                cooldownTime = 2.5 * 24 * 60 * 60 * 1000;
                cooldownName = "2.5 days";
            } else {
                return interaction.editReply({
                    content: "❌ You need Premium role to reset HWID.",
                });
            }

            const last = user.lastHwidReset || 0;
            if (Date.now() - last < cooldownTime) {
                const left = cooldownTime - (Date.now() - last);
                const hours = Math.ceil(left / (60 * 60 * 1000));
                return interaction.editReply({
                    content: `⏰ Cooldown! Try again in approx ${hours} hour(s).`,
                });
            }

            const hwids = normalizeHwids(keyData);
            if (!keyData || hwids.length === 0)
                return interaction.editReply({
                    content: "❌ Selected key has no HWID registered.",
                });

            const maxHwid = keyData.maxHwid ?? 1;

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`slash_confirm_reset_${selectedKey}`)
                    .setLabel("Confirm Reset ALL HWIDs")
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId("slash_cancel_reset")
                    .setLabel("Cancel")
                    .setStyle(ButtonStyle.Secondary),
            );

            const embed = new EmbedBuilder()
                .setColor("#ff4444")
                .setTitle("⚠️ Confirm HWID Reset")
                .setDescription(
                    `Key: \`${selectedKey}\`\n` +
                    `Registered HWIDs (**${hwids.length}/${maxHwid}**):\n` +
                    hwids.map((h, i) => `\`${i + 1}.\` \`${h}\``).join("\n") +
                    `\n\nCooldown after reset: **${cooldownName}**\n⚠️ This will remove **all** HWIDs from this key.`,
                )
                .setTimestamp();

            return interaction.editReply({ embeds: [embed], components: [row] });
        }


        if (
            interaction.isStringSelectMenu() &&
            interaction.customId.startsWith("reset_code_select_")
        ) {
            const code = interaction.customId.replace("reset_code_select_", "");
            const selectedKey = interaction.values[0];
            const keyData = await getKey(selectedKey);

            if (!keyData || keyData.userId !== interaction.user.id) {
                return interaction.editReply({
                    content: "❌ Key không tìm thấy hoặc không phải của bạn.",
                });
            }

            const hwids = normalizeHwids(keyData);
            if (hwids.length === 0) {
                return interaction.editReply({
                    content: "❌ Key này không có HWID để reset.",
                });
            }

            const maxHwid = keyData.maxHwid ?? 1;


            const pendingKey = `${interaction.user.id}_${code}`;
            pendingResets.set(pendingKey, {
                selectedKey,
                expiresAt: Date.now() + 30 * 60 * 1000
            });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_reset_code_${pendingKey}`)
                    .setLabel("✅ Xác nhận Reset")
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId("cancel_reset_code")
                    .setLabel("❌ Hủy")
                    .setStyle(ButtonStyle.Secondary),
            );

            const embed = new EmbedBuilder()
                .setColor("#ff4444")
                .setTitle("⚠️ Xác nhận Reset HWID")
                .setDescription(
                    `Key: \`${selectedKey}\`\n` +
                    `HWIDs sẽ bị xóa (**${hwids.length}/${maxHwid}**):\n` +
                    hwids.map((h, i) => `\`${i + 1}.\` \`${h}\``).join("\n"),
                )
                .setTimestamp();

            return interaction.editReply({ embeds: [embed], components: [row] });
        }

        if (
            interaction.isButton() &&
            interaction.customId.startsWith("slash_confirm_reset_")
        ) {
            const key = interaction.customId.replace("slash_confirm_reset_", "");
            const keyData = await getKey(key);
            if (!keyData)
                return interaction.reply({
                    content: "❌ Key not found.",
                    ephemeral: true,
                });

            const oldHwids = normalizeHwids(keyData);
            await setKey(key, { ...keyData, hwids: [], hwid: undefined });

            const user = (await getUser(interaction.user.id)) || {
                userId: interaction.user.id,
            };
            await setUser(interaction.user.id, {
                ...user,
                lastHwidReset: Date.now(),
                hwidResetCount: (user.hwidResetCount || 0) + 1,
            });

            await db.collection("hwid_reset_logs").insertOne({
                userId: interaction.user.id,
                userTag: interaction.user.tag,
                key,
                oldHwids,
                resetAt: Date.now(),
            });

            const embed = new EmbedBuilder()
                .setColor("#22dd22")
                .setTitle("✅ HWID Reset Successful")
                .setDescription(
                    `Key: \`${key}\`\n**${oldHwids.length}** HWID(s) removed.`,
                )
                .setTimestamp();

            return interaction.reply({
                embeds: [embed],
                ephemeral: true,
            });
        }

        if (
            interaction.isButton() &&
            interaction.customId === "slash_cancel_reset"
        ) {
            return interaction.reply({
                content: "❌ HWID reset cancelled.",
                ephemeral: true,
            });
        }


        if (
            interaction.isButton() &&
            interaction.customId.startsWith("confirm_reset_code_")
        ) {
            const pendingKey = interaction.customId.replace("confirm_reset_code_", "");
            const reset = pendingResets.get(pendingKey);

            if (!reset) {
                return interaction.reply({
                    content: "❌ Reset code đã hết hạn, vui lòng thử lại.",
                    ephemeral: true,
                });
            }


            if (Date.now() > reset.expiresAt) {
                pendingResets.delete(pendingKey);
                return interaction.reply({
                    content: "❌ Reset code đã hết hạn, vui lòng thử lại.",
                    ephemeral: true,
                });
            }

            const selectedKey = reset.selectedKey;
            const code = pendingKey.split('_')[1];
            const keyData = await getKey(selectedKey);

            if (!keyData || keyData.userId !== interaction.user.id) {
                pendingResets.delete(pendingKey);
                return interaction.reply({
                    content: "❌ Key không hợp lệ.",
                    ephemeral: true,
                });
            }

            const hwids = normalizeHwids(keyData);
            await setKey(selectedKey, { ...keyData, hwids: [], hwid: undefined });


            await resetCodesCollection.updateOne(
                { code },
                { $set: { used: true, usedBy: interaction.user.id, usedAt: Date.now() } }
            );

            await db.collection("hwid_reset_logs").insertOne({
                userId: interaction.user.id,
                userTag: interaction.user.tag,
                key: selectedKey,
                code,
                method: "reset-code",
                resetCount: 1,
                resetAt: Date.now(),
            });


            pendingResets.delete(pendingKey);

            const embed = new EmbedBuilder()
                .setColor("#22dd22")
                .setTitle("✅ HWID Reset Thành Công")
                .addFields(
                    { name: "Code", value: `\`${code}\`` },
                    { name: "Key", value: `\`${selectedKey}\`` },
                    { name: "HWIDs Reset", value: String(hwids.length) },
                )
                .setTimestamp();

            return interaction.reply({
                embeds: [embed],
                ephemeral: true,
            });
        }

        if (
            interaction.isButton() &&
            interaction.customId === "cancel_reset_code"
        ) {
            return interaction.reply({
                content: "❌ Reset code bị hủy bỏ.",
                ephemeral: true,
            });
        }

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "slash_manage_select"
        ) {
            const key = interaction.values[0];
            const data = await getKey(key);
            if (!data) return interaction.editReply({ content: "❌ Key not found." });

            let statusText = "✅ Active";
            let statusColor = "#22dd99";
            const isExpired = data.expiresAt && Date.now() > data.expiresAt;
            if (!data.active) {
                statusText = "❌ Blacklisted";
                statusColor = "#dd4444";
            } else if (isExpired) {
                statusText = "⏰ Expired";
                statusColor = "#ff9900";
            }

            const hwids = normalizeHwids(data);
            const maxHwid = data.maxHwid ?? 1;
            const hwidDisplay =
                hwids.length > 0
                    ? hwids.map((h, i) => `\`${i + 1}.\` \`${h}\``).join("\n")
                    : "None registered";

            const embed = new EmbedBuilder()
                .setColor(statusColor)
                .setTitle("🔑 Key Details")
                .addFields(
                    { name: "Key", value: `\`\`\`${key}\`\`\`` },
                    { name: "Status", value: statusText, inline: true },
                    {
                        name: "Expires",
                        value: data.expiresAt
                            ? new Date(data.expiresAt).toLocaleString()
                            : "♾️ Lifetime",
                        inline: true,
                    },
                    {
                        name: `🖥️ Devices (${hwids.length}/${maxHwid} slots used)`,
                        value: hwidDisplay,
                    },
                    {
                        name: "Redeemed",
                        value: data.redeemedAt
                            ? new Date(data.redeemedAt).toLocaleString()
                            : "Not redeemed",
                    },
                )
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("slash_manage_back")
                    .setLabel("⬅ Back")
                    .setStyle(ButtonStyle.Secondary),
            );

            if (!data.active || isExpired) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`slash_delete_key_${key}`)
                        .setLabel("🗑️ Delete Key")
                        .setStyle(ButtonStyle.Danger),
                );
            }

            return interaction.editReply({
                embeds: [embed],
                components: [row]
            });
        }

        if (
            interaction.isButton() &&
            interaction.customId === "slash_manage_back"
        ) {
            const user = await getUser(interaction.user.id);
            if (!user || !user.keys || user.keys.length === 0)
                return interaction.update({
                    content: "❌ You don't have keys.",
                    embeds: [],
                    components: [],
                });

            const menu = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("slash_manage_select")
                    .setPlaceholder("Select key to view")
                    .addOptions(
                        user.keys.map((k, i) => ({
                            label: `Key #${i + 1}`,
                            description: `${k.substring(0, 20)}...`,
                            value: k,
                        })),
                    ),
            );

            const embed = new EmbedBuilder()
                .setColor("#0099FF")
                .setTitle("🔑 Your Keys")
                .setDescription(
                    `You have **${user.keys.length}** key(s). Select one below.`,
                )
                .setTimestamp();

            return interaction.update({ embeds: [embed], components: [menu] });
        }

        if (
            interaction.isButton() &&
            interaction.customId.startsWith("slash_delete_key_")
        ) {
            const key = interaction.customId.replace("slash_delete_key_", "");
            const data = await getKey(key);
            if (!data)
                return interaction.reply({
                    content: "❌ Key not found.",
                    ephemeral: true,
                });

            await setKey(key, {
                ...data,
                userId: null,
                redeemedAt: null,
                hwids: [],
                hwid: undefined,
            });

            const user = (await getUser(interaction.user.id)) || {
                userId: interaction.user.id,
                keys: [],
            };
            user.keys = (user.keys || []).filter((k) => k !== key);
            await setUser(interaction.user.id, user);

            return interaction.reply({
                content: `🗑️ **Key deleted from your account:**\n\`\`\`${key}\`\`\``,
                ephemeral: true,
            });
        }
    } catch (err) {
        console.error("❌ Error:", err.message);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: `❌ Error: ${err.message}` });
            } else {
                await interaction.reply({
                    content: `❌ Error: ${err.message}`,
                    ephemeral: true,
                });
            }
        } catch { }
    }
});


function authenticate(req, res, next) {
    if (req.headers["x-api-key"] !== API_SECRET)
        return res.status(401).json({ error: "Unauthorized" });
    next();
}

app.get("/", async (req, res) => {
    const totalKeys = await keysCollection.countDocuments();
    const totalUsers = await usersCollection.countDocuments();
    res.json({
        status: "OK",
        bot: isReady ? client.user.tag : "Not ready",
        uptime: Math.floor(process.uptime()),
        keys: totalKeys,
        users: totalUsers,
    });
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        botReady: isReady,
        botUser: isReady ? client.user.tag : "Not ready",
    });
});

app.post("/api/keys/create", authenticate, async (req, res) => {
    const { duration, quantity = 1, maxHwid = 1 } = req.body;
    if (quantity > 100)
        return res.status(400).json({ error: "Maximum 100 keys per request" });
    if (maxHwid < 1 || maxHwid > 50)
        return res.status(400).json({ error: "maxHwid must be 1-50" });

    const createdKeys = [];
    for (let i = 0; i < quantity; i++) {
        const key = generateKey();
        const expiresAt = duration
            ? Date.now() + duration * 24 * 60 * 60 * 1000
            : null;
        await setKey(key, {
            key,
            userId: null,
            hwids: [],
            maxHwid,
            active: true,
            expiresAt,
            createdAt: Date.now(),
            redeemedAt: null,
        });
        createdKeys.push({
            key,
            expires: expiresAt ? new Date(expiresAt).toISOString() : "Never",
        });
    }

    await db.collection("key_creation_logs").insertOne({
        createdBy: "api",
        quantity,
        duration,
        maxHwid,
        createdAt: Date.now(),
        keys: createdKeys.map((k) => k.key),
    });

    res.json({ success: true, count: quantity, keys: createdKeys });
});

app.get("/api/keys/check/:key", authenticate, async (req, res) => {
    const { key } = req.params;
    const keyData = await getKey(key);
    if (!keyData) return res.status(404).json({ error: "Key not found" });
    const hwids = normalizeHwids(keyData);
    res.json({
        key,
        ...keyData,
        hwids,
        maxHwid: keyData.maxHwid ?? 1,
        hwidSlots: `${hwids.length}/${keyData.maxHwid ?? 1}`,
        isExpired: keyData.expiresAt && Date.now() > keyData.expiresAt,
    });
});

app.get("/api/keys/list", authenticate, async (req, res) => {
    const allKeys = await getAllKeys();
    const keysWithStatus = allKeys.map((k) => {
        const hwids = normalizeHwids(k);
        return {
            ...k,
            hwids,
            maxHwid: k.maxHwid ?? 1,
            hwidSlots: `${hwids.length}/${k.maxHwid ?? 1}`,
            isExpired: k.expiresAt && Date.now() > k.expiresAt,
        };
    });
    res.json({
        success: true,
        total: keysWithStatus.length,
        keys: keysWithStatus,
    });
});

app.post("/api/verify", async (req, res) => {
    const { key, hwid } = req.body;

    if (!key || !hwid)
        return res
            .status(400)
            .json({ success: false, message: "Key and HWID are required" });

    const keyData = await getKey(key);

    if (!keyData)
        return res
            .status(200)
            .json({ success: false, message: "Invalid key - Key does not exist" });

    if (!keyData.active)
        return res.status(200).json({
            success: false,
            message: "Key is blacklisted and cannot be used",
        });

    if (keyData.expiresAt && Date.now() > keyData.expiresAt)
        return res.status(200).json({ success: false, message: "Key has expired" });

    if (!keyData.userId)
        return res.status(200).json({
            success: false,
            message:
                "Key not redeemed yet - Please redeem key first using Discord bot",
        });

    const hwids = normalizeHwids(keyData);
    const maxHwid = keyData.maxHwid ?? 1;

    if (hwids.includes(hwid)) {
        return res.status(200).json({
            success: true,
            message: `HWID verified - Access granted (${hwids.length}/${maxHwid} slots used)`,
        });
    }

    if (hwids.length < maxHwid) {
        hwids.push(hwid);
        await setKey(key, { ...keyData, hwids, hwid: undefined });
        await db.collection("hwid_register_logs").insertOne({
            key,
            hwid,
            registeredAt: Date.now(),
            source: "api_verify",
        });
        return res.status(200).json({
            success: true,
            message: `New device registered - Access granted (${hwids.length}/${maxHwid} slots used)`,
        });
    }

    return res.status(200).json({
        success: false,
        message: `Device limit reached (${maxHwid}/${maxHwid} slots full). Please reset HWID via Discord or contact Owner.`,
    });
});

app.post('/api/keys/redeem', authenticate, async (req, res) => {
    const { key, userId } = req.body
    if (!key || !userId) return res.status(400).json({ error: 'Missing key or userId' })

    const keyData = await getKey(key)
    if (!keyData) return res.status(404).json({ error: 'Key not found' })
    if (!keyData.active) return res.status(403).json({ error: 'Key is blacklisted' })
    if (keyData.userId) return res.status(400).json({ error: 'Key already redeemed' })
    if (keyData.expiresAt && Date.now() > keyData.expiresAt) return res.status(400).json({ error: 'Key expired' })

    await setKey(key, { ...keyData, userId, redeemedAt: Date.now() })

    const user = await getUser(userId) || { userId, keys: [] }
    user.keys = user.keys || []
    if (!user.keys.includes(key)) user.keys.push(key)
    await setUser(userId, user)


    let roleMsg = 'No role assigned'
    try {
        const guild = client.guilds.cache.get(ALLOWED_GUILD_ID)
        if (guild) {
            const role = guild.roles.cache.find(r => r.name === 'Premium')
            if (role) {
                const member = await guild.members.fetch(userId)
                await member.roles.add(role)
                roleMsg = 'Premium role added'
            }
        }
    } catch { }

    await db.collection('redeem_logs').insertOne({ userId, key, redeemedAt: Date.now(), source: 'web' })

    res.json({ ok: true, message: 'Key redeemed', role: roleMsg })
})

async function start() {
    console.log("🔄 Starting bot...");
    console.log(`📍 Target Guild ID: ${ALLOWED_GUILD_ID}`);

    if (!DISCORD_TOKEN) {
        console.error("❌ DISCORD_TOKEN is missing!");
        console.error("Please set DISCORD_TOKEN in environment variables");
        process.exit(1);
    }

    const tokenParts = DISCORD_TOKEN.trim().split('.');
    console.log(`🔑 Discord Token validation:`);
    console.log(`   - Length: ${DISCORD_TOKEN.trim().length} characters`);
    console.log(`   - Parts: ${tokenParts.length} (should be 3)`);
    console.log(`   - First part length: ${tokenParts[0]?.length || 0}`);
    console.log(`   - Has whitespace: ${DISCORD_TOKEN !== DISCORD_TOKEN.trim() ? 'YES ⚠️' : 'NO ✅'}`);

    if (tokenParts.length !== 3) {
        console.error("❌ Invalid token format! Token should have 3 parts separated by dots");
        console.error("Expected format: MTxxxxxxxxx.Gxxxxx.xxxxxxxxxxx");
        process.exit(1);
    }

    await connectMongoDB();

    app.listen(PORT, "0.0.0.0", () =>
        console.log(`✅ API running on port ${PORT}`),
    );

    client.once("ready", async () => {
        isReady = true;
        console.log(`🎉 Bot online: ${client.user.tag}`);
        console.log(`🆔 Bot ID: ${client.user.id}`);
        console.log(`📍 Guild: ${ALLOWED_GUILD_ID}`);
        console.log(`📊 Connected to ${client.guilds.cache.size} guild(s)`);

        try {
            await registerSlashCommands();
        } catch (err) {
            console.error("❌ Failed to register slash commands:", err.message);
        }

        // Initialize boost tracking
        try {
            await boostTracking.initBoostTracking(client, ALLOWED_GUILD_ID, db, {
                getAllKeys,
                setKey,
            }, BOOST_WEBHOOK_URL, generateKey);
            console.log("✅ Boost tracking initialized");
        } catch (err) {
            console.error("❌ Failed to initialize boost tracking:", err.message);
        }

        setInterval(() => {
            fetch(`http://localhost:${PORT}/api/health`).catch(() => { });
        }, 60 * 1000);


        setInterval(() => {
            const now = Date.now();
            for (const [key, reset] of pendingResets.entries()) {
                if (now > reset.expiresAt) {
                    pendingResets.delete(key);
                }
            }
        }, 5 * 60 * 1000);

        console.log("✅ Bot ready! Keep-alive active (1 min intervals)");
    });

    client.on("error", (err) => {
        console.error("❌ Discord client error:", err.message);
        console.error("Error stack:", err.stack);
    });

    client.on("warn", (info) => {
        console.warn("⚠️  Discord warning:", info);
    });

    client.on("debug", (info) => {
        if (info.includes("READY") || info.includes("RESUMED") || info.includes("Preparing")) {
            console.log("🔍 Debug:", info);
        }
    });

    client.on("shardError", (error) => {
        console.error("❌ Websocket error:", error);
    });

    try {
        console.log("🔐 Attempting to login to Discord...");
        console.log("⏰ Timeout set to 60 seconds...");

        const loginTimeout = setTimeout(() => {
            console.error("❌ Login timeout after 60 seconds!");
            console.error("This usually means:");
            console.error("  1. Network/firewall blocking Discord API");
            console.error("  2. Discord API is down or slow");
            console.error("  3. WebSocket connection issues");
            console.error("");
            console.error("API will continue running, but bot features won't work.");
        }, 60000);

        await client.login(DISCORD_TOKEN);
        clearTimeout(loginTimeout);
        console.log("✅ Discord login successful (token accepted)");
    } catch (err) {
        console.error("❌ Discord login FAILED:", err.message);
        console.error("Error code:", err.code);
        console.error("Error name:", err.name);
        console.error("Stack:", err.stack);

        if (err.code === "TokenInvalid") {
            console.error("⚠️  TOKEN IS INVALID!");
        } else if (err.code === "DisallowedIntents") {
            console.error("⚠️  INTENTS ERROR!");
        } else {
            console.error("⚠️  UNKNOWN ERROR - Check Discord API status");
        }
    }
}

start().catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});