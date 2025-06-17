import { 
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    Partials,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    ActivityType,
    TextInputBuilder,
    TextInputStyle,
    InteractionType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    AttachmentBuilder
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import OpenAI from 'openai';
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import moderation from './commands/moderation.js';
import logs from './utils/logs.js';
import welcomeEvent from './events/welcome.js';



// --- تحميل الإعدادات من ملف config.json ---
// تأكد من وجود ملف config.json في نفس مسار هذا الملف
// وتأكد من أن جميع الـ IDs والبيانات فيه صحيحة ومحدثة.
import config from './config.json' with { type: 'json' };

// --- إعدادات المسارات في ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- إعدادات ثابتة ومتحولات عالمية ---
const EMBED_COLOR = "#2B2D31";
const BOT_MESSAGE_COOLDOWN = 10000; // 10 ثواني لحذف رسائل البوت المؤقتة

// --- سجلات السبام ومكافحة الرايد (متغيرات للحالة) ---
const spamMap = new Map();
const raidJoinThreshold = 5; // عدد الانضمامات لاكتشاف الرايد
const raidTimeframeSeconds = 10; // الإطار الزمني بالثواني لاكتشاف الرايد
const raidJoinTracker = {}; // لتتبع الانضمامات لمكافحة الرايد

// --- تعريف البوت Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,           // مطلوب للأوامر والسيرفرات
        GatewayIntentBits.GuildMembers,     // مطلوب للأوتو رول، التايم آوت، فحص العضو
        GatewayIntentBits.GuildMessages,    // مطلوب لاستقبال رسائل الأوامر النصية
        GatewayIntentBits.MessageContent,   // مطلوب لقراءة محتوى الرسائل (لأوامر البريفيكس والسبام والفلترة)
        GatewayIntentBits.DirectMessages,   // قد تحتاجها للتواصل الخاص
        GatewayIntentBits.GuildVoiceStates, // إذا كنت تخطط لأوامر متعلقة بالفويس
        GatewayIntentBits.GuildMessageReactions // إذا كنت تستخدم تفاعلات الرسائل
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.Reaction] // لضمان معالجة الأحداث بشكل صحيح
});

// --- دالة مساعدة لتسجيل أخطاء البوت في قناة اللوج المخصصة ---
async function sendBotErrorLog(error, context = "General Error") {
    // التأكد من وجود client و log_channel_id قبل المحاولة بالإرسال
    if (!client || !config.bot_log_channel_id) {
        console.error("❌ فشل إرسال سجل خطأ البوت: لم يتم تعريف Client أو bot_log_channel_id في config.json.");
        console.error(error); // عرض الخطأ في الكونسول أيضاً
        return;
    }

    const logChannel = client.channels.cache.get(config.bot_log_channel_id);
    if (!logChannel) {
        console.error(`❌ قناة سجلات البوت غير موجودة (ID: ${config.bot_log_channel_id}). يرجى التحقق من config.json`);
        console.error(error); // عرض الخطأ في الكونسول أيضاً
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0xFF0000) // أحمر للخطأ
        .setTitle('🚨 خطأ في البوت!')
        .setDescription(`**السياق:** ${context}\n**الخطأ:** \`\`\`js\n${error.stack || error.message}\n\`\`\``)
        .setTimestamp()
        .setFooter({ text: `معرف الخطأ: ${Date.now()}` });

    // محاولة إرسال الإيمبيد، مع معالجة أي خطأ قد يحدث أثناء الإرسال نفسه
    await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل خطأ البوت نفسه:', err));
}

// --- دالة مساعدة للتحقق من الصلاحيات لمنفذ الأمر (سلاش أو نصي أو زر/قائمة) ---
async function checkPermissions(interactionOrMessage, requiredLevel) {
    const member = interactionOrMessage.member;
    const guild = interactionOrMessage.guild;
    if (!guild || !member) return false; // يجب أن يكون التفاعل/الرسالة من داخل سيرفر ولديك عضو

    const adminRoleId = config.admin_role_id;
    const supportRoleId = config.support_role_id;
    const ownerRoleId = config.owner_role_id;

    // الحصول على معلومات ما إذا كان العضو يمتلك الرتب
    const isAdmin = member.roles.cache.has(adminRoleId);
    const isSupport = member.roles.cache.has(supportRoleId);
    const isOwner = member.roles.cache.has(ownerRoleId);

    let hasPermission = false;
    let requiredPermName = "";

    // التحقق من صلاحيات المالك أولاً كأعلى مستوى
    if (isOwner) {
        hasPermission = true;
        requiredPermName = "مالك البوت (أعلى صلاحية)";
    } else if (typeof requiredLevel === 'string') {
        // إذا كان المستوى المطلوب هو نص (مثل 'admin', 'support', 'owner')
        switch (requiredLevel) {
            case 'admin':
                hasPermission = isAdmin || isOwner;
                requiredPermName = "رتبة المسؤول";
                break;
            case 'support':
                hasPermission = isAdmin || isSupport || isOwner; // المسؤول والمالك يشملان الدعم
                requiredPermName = "رتبة المسؤول أو الدعم";
                break;
            case 'owner': // تحقق صارم للمالك فقط
                hasPermission = isOwner;
                requiredPermName = "مالك البوت";
                break;
            default:
                hasPermission = false; // أي نص آخر غير صالح
                break;
        }
    client.on('guildMemberAdd', welcomeEvent.execute);
    } else if (typeof requiredLevel === 'bigint') {
        // إذا كان المستوى المطلوب هو PermissionsBitField.Flags (مثل PermissionsBitField.Flags.ManageMessages)
        // المالك لديه كل صلاحيات البوت افتراضياً
        hasPermission = member.permissions.has(requiredLevel) || isOwner;
        // محاولة الحصول على اسم الصلاحية للرسالة
        requiredPermName = Object.keys(PermissionsBitField.Flags).find(key => PermissionsBitField.Flags[key] === requiredLevel) || `ID: ${requiredLevel.toString()}`;
    } else {
        hasPermission = false; // نوع غير معروف للمستوى المطلوب
    }

    // إذا لم يكن لدى العضو الصلاحيات، أرسل رسالة خطأ
    if (!hasPermission) {
        const replyContent = `ليس لديك الصلاحيات المطلوبة (\`${requiredPermName}\`) لاستخدام هذا الأمر.`;

        // التعامل مع أنواع التفاعل/الرسائل المختلفة
        if (interactionOrMessage.isCommand && interactionOrMessage.isCommand()) {
            // أمر Slash Command
            await interactionOrMessage.reply({ content: replyContent, ephemeral: true });
        } else if (interactionOrMessage.isMessage && interactionOrMessage.isMessage()) {
            // أمر Prefix Command (رسالة عادية)
            const replyMsg = await interactionOrMessage.reply({ content: replyContent }).catch(() => {});
            // حذف رسالة البوت بعد فترة قصيرة وحذف رسالة المستخدم
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
            interactionOrMessage.delete().catch(() => {});
        } else if ((interactionOrMessage.isButton && interactionOrMessage.isButton()) || (interactionOrMessage.isStringSelectMenu && interactionOrMessage.isStringSelectMenu())) {
            // تفاعلات الأزرار أو القوائم المنسدلة
            await interactionOrMessage.reply({ content: replyContent, ephemeral: true });
        }
        return false;
    }
    return true; // العضو لديه الصلاحية المطلوبة
}

// --- عند تشغيل البوت بنجاح ---
client.on('ready', async () => {
    console.log(`✅ ${client.user.tag} جاهز للعمل!`);

    // --- حالة البوت المتحركة ---
    let activityIndex = 0;
    setInterval(() => {
        if (config.bot_status_activities && config.bot_status_activities.length > 0) {
            const activity = config.bot_status_activities[activityIndex];
            client.user.setActivity(activity.name, { type: activity.type });
            activityIndex = (activityIndex + 1) % config.bot_status_activities.length;
        }
    }, 15 * 1000); // تغيير الحالة كل 15 ثانية

    // --- التحقق من صلاحيات البوت الأولية في السيرفر ---
    const guild = client.guilds.cache.get(config.guild_id);
    if (!guild) {
        console.error(`❌ لم يتم العثور على السيرفر (Guild ID غير صحيح: ${config.guild_id}). يرجى التحقق من config.json`);
        return;
    }

    const botMember = await guild.members.fetch(client.user.id).catch(() => null);
    if (!botMember) {
        console.error('❌ لم يتم العثور على البوت كعضو في السيرفر. ربما لم يتم دعوته أو الـ Guild ID خطأ.');
        return;
    }

    const requiredBotPermissions = [
        PermissionsBitField.Flags.ManageRoles,      // لإدارة الرتب (أوتو رول، ألوان الرتب)
        PermissionsBitField.Flags.ManageChannels,   // لإدارة القنوات (التذاكر، قفل/فتح الشات، مسح)
        PermissionsBitField.Flags.ModerateMembers,  // للتايم آوت
        PermissionsBitField.Flags.KickMembers,      // إذا كان لديك أوامر طرد
        PermissionsBitField.Flags.BanMembers,       // إذا كان لديك أوامر حظر
        PermissionsBitField.Flags.SendMessages,     // لإرسال الرسائل
        PermissionsBitField.Flags.EmbedLinks,       // لإرسال الإيمبيد
        PermissionsBitField.Flags.AttachFiles,      // لإرسال ملفات (مثل سجلات التذاكر)
        PermissionsBitField.Flags.UseExternalEmojis,// لاستخدام الإيموجي الخارجية
        PermissionsBitField.Flags.ReadMessageHistory,// لقراءة سجلات الرسائل (للمسح، سجلات التذاكر)
        PermissionsBitField.Flags.ManageMessages    // لمسح الرسائل (فلتر السبام، أمر المسح)
    ];

    const missingPermissions = requiredBotPermissions.filter(perm => !botMember.permissions.has(perm));

    if (missingPermissions.length > 0) {
        console.warn(`⚠️ البوت يفتقد الصلاحيات التالية في السيرفر: ${missingPermissions.map(p => PermissionsBitField.Flags[p]).join(', ')}`);
        console.warn('يرجى التأكد من إعطاء رتبة البوت صلاحيات كافية (خاصة صلاحية المسؤول أو الصلاحيات المذكورة).');
        // إرسال تنبيه في قناة اللوج
        const logChannel = guild.channels.cache.get(config.bot_log_channel_id);
        if (logChannel) {
            const embed = new EmbedBuilder()
                .setColor(0xFFA500) // برتقالي للتحذير
                .setTitle('⚠️ تحذير: صلاحيات البوت غير كافية!')
                .setDescription(`البوت يفتقد الصلاحيات التالية في السيرفر:\n\`\`\`${missingPermissions.map(p => PermissionsBitField.Flags[p]).join(', ')}\`\`\`\nيرجى التأكد من إعطاء رتبة البوت صلاحيات كافية ليعمل بشكل صحيح.`)
                .setTimestamp();
            await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال تحذير الصلاحيات:', err));
        }
    } else {
        console.log('✅ صلاحيات البوت تبدو كافية.');
    }

    /*
    // --- هذا الجزء مخصص لتسجيل أوامر Slash Commands. ---
    // !!! هام جداً: قم بإزالة علامات التعليق (/* و *\/) لتشغيله لمرة واحدة فقط عند أول إطلاق للبوت.
    // !!! بعد أن يتم تسجيل الأوامر بنجاح وتظهر في ديسكورد (قد يستغرق بضع دقائق)،
    // !!! قم بإعادة وضع علامات التعليق على هذا الجزء لمنع تكرار التسجيل في كل مرة يتم فيها تشغيل البوت.
    // !!! إذا كان هناك تكرار في الأوامر بعد إعادة التشغيل، تأكد أن هذا الجزء معلّق.
    // !!! لحذف الأوامر المكررة يدويًا، يمكنك استخدام guild.commands.set([]) لمرة واحدة ثم إعادة تسجيل الأوامر الصحيحة.
    const commands = [
        {
            name: 'setup_color_roles',
            description: 'ينشئ رسالة لاختيار ألوان الرتب بواسطة قائمة منسدلة.',
            default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), // يمكن فقط للمسؤولين استخدام هذا الأمر
        },
        {
            name: 'setup_tickets',
            description: 'ينشئ رسالة إعداد نظام التذاكر في قناة محددة (مع قائمة منسدلة).',
            default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), // يمكن فقط للمسؤولين استخدام هذا الأمر
        },
        {
            name: 'مسح',
            description: 'يمسح عدداً محدداً من الرسائل.',
            options: [
                {
                    name: 'عدد',
                    description: 'عدد الرسائل المراد مسحها (بين 1 و 100).',
                    type: 4, // Integer
                    required: true,
                    min_value: 1,
                    max_value: 100,
                },
            ],
            default_member_permissions: PermissionsBitField.Flags.ManageMessages.toString(), // يتطلب صلاحية إدارة الرسائل
        },
        {
            name: 'send_message',
            description: 'يرسل رسالة في قناة محددة عن طريق البوت، مع إمكانية الرد على رسالة.',
            options: [
                {
                    name: 'channel',
                    description: 'القناة التي سترسل الرسالة إليها.',
                    type: 7, // CHANNEL type
                    required: true,
                    channel_types: [ChannelType.GuildText], // يجب أن تكون قناة نصية
                },
                {
                    name: 'message',
                    description: 'محتوى الرسالة التي سترسلها.',
                    type: 3, // STRING type
                    required: true,
                },
                {
                    name: 'reply_link',
                    description: 'رابط الرسالة للرد عليها (اختياري). مثال: https://discord.com/channels/ID_SERVER/ID_CHANNEL/ID_MESSAGE',
                    type: 3, // STRING type
                    required: false,
                },
            ],
            default_member_permissions: PermissionsBitField.Flags.ManageChannels.toString(), // يتطلب صلاحية إدارة القنوات
        },
        {
            name: 'help',
            description: 'يعرض قائمة بأوامر Slash Command المتاحة.',
            // لا نضع default_member_permissions هنا لأننا نتحقق من admin/support/owner في دالة checkPermissions
        },
        {
            name: 'lock',
            description: 'يغلق قناة الشات الحالية (يمنع الأعضاء العاديين من الكتابة).',
            default_member_permissions: PermissionsBitField.Flags.ManageChannels.toString(),
        },
        {
            name: 'unlock',
            description: 'يفتح قناة الشات المغلقة.',
            default_member_permissions: PermissionsBitField.Flags.ManageChannels.toString(),
        

              client.on('guildMemberAdd', welcomeEvent.execute);
        {
            name: 'timeout',
            description: 'يضع عضواً في التايم آوت.',
            options: [
                {
                    name: 'عضو',
                    description: 'العضو الذي سيتم وضع تايم آوت له.',
                    type: 6, // USER type
                    required: true,
                },
                {
                    name: 'مدة',
                    description: 'مدة التايم آوت (مثال: 10m, 1h, 7d). أقصى 28 يوم.',
                    type: 3, // STRING type
                    required: true,
                },
                {
                    name: 'سبب',
                    description: 'سبب وضع التايم آوت.',
                    type: 3, // STRING type
                    required: false,
                },
            ],
            default_member_permissions: PermissionsBitField.Flags.ModerateMembers.toString(),
        },
        {
            name: 'admin_timeout',
            description: 'يضع عضواً في التايم آوت (للمالكين فقط).',
            options: [
                {
                    name: 'عضو',
                    description: 'العضو الذي سيتم وضع تايم آوت له.',
                    type: 6, // USER type
                    required: true,
                },
                {
                    name: 'مدة',
                    description: 'مدة التايم آوت (مثال: 10m, 1h, 7d). أقصى 28 يوم.',
                    type: 3, // STRING type
                    required: true,
                },
                {
                    name: 'سبب',
                    description: 'سبب وضع التايم آوت.',
                    type: 3, // STRING type
                    required: false,
                },
            ],
            // لا نضع default_member_permissions هنا لأننا نتحقق من صلاحية المالك في checkPermissions
        },
        {
            name: 'list_timeouts',
            description: 'يعرض قائمة بجميع الأعضاء الموجودين في التايم آوت حالياً.',
            default_member_permissions: PermissionsBitField.Flags.Administrator.toString(), // يتطلب صلاحية مسؤول
        },
    ];

    try {
        await guild.commands.set(commands); // تسجيل الأوامر للسيرفر الخاص بك
        console.log('✅ تم تسجيل أوامر Slash Commands بنجاح.');
    } catch (error) {
        console.error('❌ فشل تسجيل أوامر Slash Commands:', error);
        await sendBotErrorLog(error, "Slash Command Registration");
    }
    */
});
export default {
    data: new SlashCommandBuilder()
        .setName('mod')
        .setDescription('أوامر الإدارة')
        .addSubcommand(sub => sub
            .setName('ban')
            .setDescription('حظر عضو')
            .addUserOption(opt => opt.setName('user').setDescription('العضو').setRequired(true))
            .addStringOption(opt => opt.setName('reason').setDescription('السبب')))
        .addSubcommand(sub => sub
            .setName('unban')
            .setDescription('فك حظر عضو')
            .addUserOption(opt => opt.setName('user').setDescription('العضو').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('kick')
            .setDescription('طرد عضو')
            .addUserOption(opt => opt.setName('user').setDescription('العضو').setRequired(true))
            .addStringOption(opt => opt.setName('reason').setDescription('السبب')))
        .addSubcommand(sub => sub
            .setName('warn')
            .setDescription('تحذير عضو')
            .addUserOption(opt => opt.setName('user').setDescription('العضو').setRequired(true))
            .addStringOption(opt => opt.setName('reason').setDescription('السبب').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('timeout')
            .setDescription('تقييد عضو')
            .addUserOption(opt => opt.setName('user').setDescription('العضو').setRequired(true))
            .addStringOption(opt => opt.setName('duration').setDescription('المدة (1h, 30m, 1d)').setRequired(true))
            .addStringOption(opt => opt.setName('reason').setDescription('السبب')))
        .addSubcommand(sub => sub
            .setName('untimeout')
            .setDescription('فك تقييد عضو')
            .addUserOption(opt => opt.setName('user').setDescription('العضو').setRequired(true)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'لم يتم تحديد سبب';
        
        try {
            switch (subcommand) {
                case 'ban':
                    await this.handleBan(interaction, user, reason);
                    break;
                case 'unban':
                    await this.handleUnban(interaction, user);
                    break;
                case 'kick':
                    await this.handleKick(interaction, user, reason);
                    break;
                case 'warn':
                    await this.handleWarn(interaction, user, reason);
                    break;
                case 'timeout':
                    await this.handleTimeout(interaction, user, reason);
                    break;
                case 'untimeout':
                    await this.handleUntimeout(interaction, user);
                    break;
            }
        } catch (error) {
            await interaction.reply({ content: 'حدث خطأ أثناء تنفيذ الأمر!', ephemeral: true });
            console.error(error);
        }
    },

    async handleBan(interaction, user, reason) {
        await interaction.guild.members.ban(user, { reason });
        await db.addModLog(user.id, 'ban', reason, interaction.user.id);
        await interaction.reply(`✅ تم حظر ${user.tag} (السبب: ${reason})`);
    },

    async handleUnban(interaction, user) {
        await interaction.guild.members.unban(user);
        await db.removeModLog(user.id, 'ban');
        await interaction.reply(`✅ تم فك حظر ${user.tag}`);
    },

    async handleKick(interaction, user, reason) {
        await interaction.guild.members.kick(user, reason);
        await db.addModLog(user.id, 'kick', reason, interaction.user.id);
        await interaction.reply(`✅ تم طرد ${user.tag} (السبب: ${reason})`);
    },

    async handleWarn(interaction, user, reason) {
        await db.addModLog(user.id, 'warn', reason, interaction.user.id);
        const warnCount = await db.getWarnCount(user.id);
        
        if (warnCount >= 3) {
            await interaction.guild.members.ban(user, { reason: 'تجاوز عدد التحذيرات المسموح بها' });
            await interaction.reply(`⚠️ تم حظر ${user.tag} بسبب تجاوز الحد الأقصى للتحذيرات (3 تحذيرات)`);
        } else {
            await interaction.reply(`⚠️ تم تحذير ${user.tag} (التحذير رقم ${warnCount}) (السبب: ${reason})`);
        }
    },

    async handleTimeout(interaction, user, reason) {
        const duration = interaction.options.getString('duration');
        const ms = this.parseDuration(duration);
        
        await interaction.guild.members.resolve(user).timeout(ms, reason);
        await db.addModLog(user.id, 'timeout', reason, interaction.user.id);
        await interaction.reply(`⏳ تم تقييد ${user.tag} لمدة ${duration} (السبب: ${reason})`);
    },

    async handleUntimeout(interaction, user) {
        await interaction.guild.members.resolve(user).timeout(null);
        await db.removeModLog(user.id, 'timeout');
        await interaction.reply(`✅ تم فك تقييد ${user.tag}`);
    },

    parseDuration(duration) {
        const units = {
            's': 1000,
            'm': 1000 * 60,
            'h': 1000 * 60 * 60,
            'd': 1000 * 60 * 60 * 24
        };
        
        const match = duration.match(/^(\d+)([smhd])$/);
        if (!match) throw new Error('صيغة المدة غير صالحة (استخدم مثل: 30m, 1h, 7d)');
        
        const [, amount, unit] = match;
        return amount * units[unit];
    }
};
// --- نظام Auto Role عند انضمام عضو جديد ---
client.on('guildMemberAdd', async member => {
    if (member.guild.id !== config.guild_id) return; // التأكد من أنه السيرفر الصحيح

    // --- نظام مكافحة الرايد (اختياري) ---
    // إذا كانت خاصية auto_quarantine_enabled مفعلة في config.json
    if (config.auto_quarantine_enabled) {
        const now = Date.now();
        // تتبع عدد الأعضاء الذين انضموا في إطار زمني محدد
        if (!raidJoinTracker[now]) {
            raidJoinTracker[now] = 0;
        }
        raidJoinTracker[now]++;

        // تنظيف المتتبع من الإدخالات القديمة التي تجاوزت الإطار الزمني
        for (const time in raidJoinTracker) {
            if (now - parseInt(time) > raidTimeframeSeconds * 1000) {
                delete raidJoinTracker[time];
            }
        }

        // حساب إجمالي الانضمامات الأخيرة
        const recentJoins = Object.values(raidJoinTracker).reduce((sum, count) => sum + count, 0);

        // إذا تجاوز عدد الانضمامات العتبة المحددة
        if (recentJoins >= raidJoinThreshold) {
            const quarantineRole = member.guild.roles.cache.get(config.quarantine_role_id);
            if (quarantineRole) {
                try {
                    // تحقق من أن البوت لديه صلاحية Manage Roles وأن رتبته أعلى من رتبة الحجر الصحي
                    if (member.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles) && member.guild.members.me.roles.highest.position > quarantineRole.position) {
                        await member.roles.add(quarantineRole, 'اكتشاف رايد - وضع في الحجر الصحي تلقائياً');
                        const antiRaidLogChannel = member.guild.channels.cache.get(config.anti_raid_log_channel_id);
                        if (antiRaidLogChannel) {
                            const embed = new EmbedBuilder()
                                .setColor(0xFF0000)
                                .setTitle('🚨 تحذير: اكتشاف رايد محتمل!')
                                .setDescription(`عضو جديد \`${member.user.tag}\` (${member.id}) تم وضعه في الحجر الصحي تلقائيًا.\nعدد الانضمامات الأخيرة: ${recentJoins} خلال ${raidTimeframeSeconds} ثواني.`)
                                .setTimestamp();
                            await antiRaidLogChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال رسالة سجل مكافحة الرايد:', err));
                        }
                    } else {
                        console.warn(`[ANTI-RAID] لا أمتلك صلاحية كافية أو رتبتي أقل لوضع ${member.user.tag} في الحجر الصحي. يرجى التأكد من صلاحيات Manage Roles ورتبة البوت.`);
                    }
                } catch (error) {
                    console.error(`فشل وضع العضو ${member.user.tag} في الحجر الصحي:`, error);
                    await sendBotErrorLog(error, `Anti-Raid Quarantine for ${member.user.tag}`);
                }
            } else {
                console.warn('⚠️ دور الحجر الصحي (quarantine_role_id) غير موجود أو غير صحيح في config.json.');
            }
            return; // توقف هنا لمنع إعطاء الأوتو رول للعضو الذي تم وضعه في الحجر الصحي
        }
    }

    // --- نظام Auto Role (إعطاء رتبة تلقائياً للعضو الجديد) ---
    const autoRoleId = config.auto_role_id;
    if (autoRoleId) {
        const role = member.guild.roles.cache.get(autoRoleId);
        if (role) {
            try {
                // تحقق من أن البوت لديه صلاحية Manage Roles و أن رتبته أعلى من رتبة الأوتو رول
                if (member.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles) && member.guild.members.me.roles.highest.position > role.position) {
                    await member.roles.add(role);
                    console.log(`✅ تم إعطاء الرتبة التلقائية ${role.name} للعضو ${member.user.tag}`);
                } else {
                    console.warn(`[AUTO-ROLE] لا أمتلك صلاحية كافية أو رتبتي أقل لإعطاء الرتبة التلقائية للعضو ${member.user.tag}. يرجى التأكد من صلاحيات Manage Roles ورتبة البوت.`);
                }
            } catch (error) {
                console.error(`❌ فشل إعطاء الرتبة التلقائية للعضو ${member.user.tag}:`, error);
                await sendBotErrorLog(error, `Auto Role for ${member.user.tag}`);
            }
        } else {
            console.warn(`⚠️ لم يتم العثور على رتبة الأوتو رول (ID: ${autoRoleId}). يرجى التحقق من config.json`);
        }
    }
});

// --- معالجة الأوامر النصية (Prefix Commands) ---
client.on('messageCreate', async (message) => {
    // تجاهل رسائل البوتات
    if (message.author.bot) return;
    // تجاهل الرسائل في الرسائل الخاصة (DM) إذا كان البوت مخصصًا للسيرفرات فقط
    if (!message.guild) return;

    const guild = message.guild;

    // --- نظام مكافحة السبام ---
    const userId = message.author.id;
    const now = Date.now();

    // تهيئة سجل رسائل المستخدم إذا لم يكن موجوداً
    if (!spamMap.has(userId)) {
        spamMap.set(userId, []);
    }
    const userMessages = spamMap.get(userId);
    userMessages.push(now); // إضافة ختم الوقت للرسالة الحالية

    // تصفية الرسائل التي لا تزال ضمن الإطار الزمني للسبام
    const filteredMessages = userMessages.filter(timestamp => now - timestamp < config.spam_timeframe_seconds * 1000);
    spamMap.set(userId, filteredMessages);

    // التحقق من صلاحيات المشرفين/الداعمين قبل تطبيق فلتر السبام عليهم
    const isAdmin = message.member.roles.cache.has(config.admin_role_id);
    const isSupport = message.member.roles.cache.has(config.support_role_id);
    const isOwner = message.member.roles.cache.has(config.owner_role_id);
    const hasAdminOrSupportOrOwnerRole = isAdmin || isSupport || isOwner;

    // إذا تجاوز المستخدم عتبة السبام ولم يكن من ذوي الصلاحيات
    if (filteredMessages.length >= config.spam_threshold && !hasAdminOrSupportOrOwnerRole) {
        try {
            const member = message.member;
            // التحقق من صلاحيات البوت لوضع تايم آوت والعضو قابل للتعديل
            if (member && member.moderatable && guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                await member.timeout(config.spam_mute_duration_seconds * 1000, 'Spamming');
                const replyMsg = await message.channel.send(`${member}, تم وضعك في التايم آوت لمدة ${config.spam_mute_duration_seconds / 60} دقيقة بسبب السبام.`);
                setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN); // حذف رسالة البوت بعد فترة

                console.log(`[ANTI-SPAM] ${member.user.tag} تم وضع تايم آوت له لمدة ${config.spam_mute_duration_seconds / 60} دقيقة بسبب السبام.`);
                const logChannel = message.guild.channels.cache.get(config.log_channel_id);
                if (logChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle('🚫 اكتشاف سبام!')
                        .setDescription(`**المستخدم:** ${member.user.tag} (${member.id})\n**الإجراء:** تم وضع تايم آوت لمدة ${config.spam_mute_duration_seconds / 60} دقيقة.\n**القناة:** ${message.channel}`)
                        .setTimestamp();
                    await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال رسالة سجل السبام:', err));
                }
            } else {
                console.warn(`[ANTI-SPAM] لم يتمكن البوت من وضع ${member?.user?.tag || 'عضو غير موجود'} في تايم آوت: صلاحيات غير كافية أو غير قابل للتعديل.`);
            }
        } catch (error) {
            console.error(`[ANTI-SPAM] حدث خطأ أثناء وضع تايم آوت لـ ${message.author.tag}:`, error);
            await sendBotErrorLog(error, `Anti-Spam Timeout for ${message.author.tag}`);
        }
        try {
            // محاولة حذف رسائل السبام
            if (message.channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageMessages)) {
                 await message.channel.messages.fetch({ limit: Math.min(filteredMessages.length + 1, 100) }).then(messages => {
                    const spamMessages = messages.filter(msg => msg.author.id === userId && (now - msg.createdTimestamp) < config.spam_timeframe_seconds * 1000);
                    message.channel.bulkDelete(spamMessages, true).catch(err => console.error('فشل مسح رسائل السبام:', err));
                });
            } else {
                console.warn(`[ANTI-SPAM] لا أمتلك صلاحية Manage Messages لحذف رسائل السبام في قناة ${message.channel.name}.`);
            }
        } catch (error) {
            console.error('فشل مسح رسائل السبام:', error);
            await sendBotErrorLog(error, `Anti-Spam Message Deletion in ${message.channel.name}`);
        }
        return; // توقف عن معالجة الرسالة بعد التعامل مع السبام
    }

    // --- نظام فلترة الكلمات المسيئة ---
    const hasSwearWord = config.swear_words.some(word => message.content.toLowerCase().includes(word.toLowerCase()));
    if (hasSwearWord && !hasAdminOrSupportOrOwnerRole) { // لا تطبق على المسؤولين/الداعمين/المالكين
        try {
            if (message.channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageMessages)) {
                await message.delete();
                const warningMsg = await message.channel.send(`${message.author}, يمنع استخدام الألفاظ النابية!`);
                setTimeout(() => warningMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);

                const logChannel = message.guild.channels.cache.get(config.log_channel_id);
                if (logChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle('⚠️ كلمة مسيئة محظورة!')
                        .setDescription(`**المستخدم:** ${message.author.tag} (${message.author.id})\n**القناة:** ${message.channel}\n**الرسالة:** \`\`\`${message.content}\`\`\``)
                        .setTimestamp();
                    await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال رسالة سجل الكلمات المسيئة:', err));
                }
            } else {
                console.warn(`[Swear Filter] لا أمتلك صلاحية Manage Messages لحذف رسالة ${message.author.tag} المسيئة في قناة ${message.channel.name}.`);
            }
        } catch (error) {
            console.error(`فشل حذف رسالة بكلمة مسيئة أو إرسال تحذير:`, error);
            await sendBotErrorLog(error, `Swear Word Deletion for ${message.author.tag}`);
        }
        return; // توقف عن معالجة الرسالة بعد التعامل مع الكلمة المسيئة
    }

    // --- معالجة الأوامر النصية العادية ---
    if (!message.content.startsWith(config.prefix)) return;

    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // --- أمر مسح الرسائل: !مسح <عدد> ---
    if (command === 'مسح') {
        // التحقق من الصلاحيات المطلوبة (إدارة الرسائل)
        if (!(await checkPermissions(message, PermissionsBitField.Flags.ManageMessages))) return;

        const amount = parseInt(args[0]);

        // التحقق من صحة العدد المدخل
        if (isNaN(amount) || amount < 1 || amount > 100) {
            const replyMsg = await message.reply({ content: 'الرجاء تحديد عدد الرسائل المراد مسحها (بين 1 و 100).', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
            message.delete().catch(() => {});
            return;
        }

        // التحقق من صلاحيات البوت لحذف الرسائل
        if (!message.channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageMessages)) {
            const replyMsg = await message.reply({ content: 'لا أمتلك صلاحية "إدارة الرسائل" في هذه القناة لحذف الرسائل.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
            message.delete().catch(() => {});
            return;
        }

        try {
            // جلب الرسائل وحذفها
            const fetched = await message.channel.messages.fetch({ limit: amount });
            await message.channel.bulkDelete(fetched, true); // `true` لتجاهل الرسائل القديمة (أكثر من 14 يوم)
            await message.delete().catch(() => {}); // حذف رسالة الأمر نفسها

            const replyMsg = await message.channel.send({ content: `تم مسح **${fetched.size}** رسالة بنجاح.`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);

            const logChannel = message.guild.channels.cache.get(config.log_channel_id);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle('🗑️ رسائل محذوفة (أمر نصي)')
                    .addFields(
                        { name: 'القناة', value: `#${message.channel.name} (${message.channel.id})`, inline: true },
                        { name: 'العدد', value: `${fetched.size}`, inline: true },
                        { name: 'بواسطة', value: `${message.author.tag} (${message.author.id})` }
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل حذف الرسائل:', err));
            }
        } catch (error) {
            console.error(`فشل مسح الرسائل في قناة ${message.channel.name}:`, error);
            await sendBotErrorLog(error, `Clear Command in ${message.channel.name}`);
            const replyMsg = await message.channel.send({ content: `حدث خطأ أثناء مسح الرسائل: ${error.message}`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
        }
    }

    // --- أمر إغلاق الشات: !ق (alias for !lock) ---
    else if (command === 'ق' || command === 'lock') {
        // التحقق من صلاحيات إدارة القنوات
        if (!(await checkPermissions(message, PermissionsBitField.Flags.ManageChannels))) return;

        const channel = message.channel;
        const everyoneRole = message.guild.roles.everyone;

        try {
            // التحقق من صلاحيات البوت لإدارة القناة
            if (!channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageChannels)) {
                const replyMsg = await message.reply({ content: 'لا أمتلك صلاحية "إدارة القنوات" لإغلاق هذا الشات.', ephemeral: true }).catch(() => {});
                if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
                message.delete().catch(() => {});
                return;
            }

            // تعديل صلاحيات رول @everyone لمنع إرسال الرسائل
            await channel.permissionOverwrites.edit(everyoneRole, { SendMessages: false });
            await message.delete().catch(() => {});
            const replyMsg = await channel.send('🔒 | تم إغلاق الشات بنجاح!');
            setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);

            const logChannel = message.guild.channels.cache.get(config.log_channel_id);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle('🔒 الشات مغلق')
                    .setDescription(`**القناة:** ${channel}\n**بواسطة:** ${message.author.tag} (${message.author.id})`)
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال رسالة سجل إغلاق الشات:', err));
            }
        } catch (error) {
            console.error(`فشل إغلاق الشات ${channel.name}:`, error);
            await sendBotErrorLog(error, `Lock Channel Command for ${channel.name}`);
            const replyMsg = await message.channel.send({ content: `حدث خطأ أثناء إغلاق الشات: ${error.message}`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
        }
    }

    // --- أمر فتح الشات: !ف (alias for !unlock) ---
    else if (command === 'ف' || command === 'unlock') {
        // التحقق من صلاحيات إدارة القنوات
        if (!(await checkPermissions(message, PermissionsBitField.Flags.ManageChannels))) return;

        const channel = message.channel;
        const everyoneRole = message.guild.roles.everyone;

        try {
            // التحقق من صلاحيات البوت لإدارة القناة
            if (!channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageChannels)) {
                const replyMsg = await message.reply({ content: 'لا أمتلك صلاحية "إدارة القنوات" لفتح هذا الشات.', ephemeral: true }).catch(() => {});
                if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
                message.delete().catch(() => {});
                return;
            }

            // تعديل صلاحيات رول @everyone للسماح بإرسال الرسائل (إزالة الإعداد)
            await channel.permissionOverwrites.edit(everyoneRole, { SendMessages: null }); // null لإزالة الإعداد والعودة للوراثة
            await message.delete().catch(() => {});
            const replyMsg = await channel.send('🔓 | تم فتح الشات بنجاح!');
            setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);

            const logChannel = message.guild.channels.cache.get(config.log_channel_id);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle('🔓 الشات مفتوح')
                    .setDescription(`**القناة:** ${channel}\n**بواسطة:** ${message.author.tag} (${message.author.id})`)
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال رسالة سجل فتح الشات:', err));
            }
        } catch (error) {
            console.error(`فشل فتح الشات ${channel.name}:`, error);
            await sendBotErrorLog(error, `Unlock Channel Command for ${channel.name}`);
            const replyMsg = await message.channel.send({ content: `حدث خطأ أثناء فتح الشات: ${error.message}`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
        }
    }

    // --- نظام التايم آوت: !تايم <@يوزر> <وقت> <السبب> (للمشرفين أو أعلى) ---
    else if (command === 'تايم' || command === 'timeout') {
        // التحقق من صلاحية تعديل الأعضاء
        if (!(await checkPermissions(message, PermissionsBitField.Flags.ModerateMembers))) return;

        const targetMember = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
        if (!targetMember) {
            const replyMsg = await message.reply({ content: 'الرجاء منشن العضو أو توفير آيدي العضو لوضع تايم آوت.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
            message.delete().catch(() => {});
            return;
        }

        const timeString = args[1];
        if (!timeString) {
            const replyMsg = await message.reply({ content: 'الرجاء تحديد مدة التايم آوت (مثال: 10s, 30m, 1h, 7d).', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
            message.delete().catch(() => {});
            return;
        }

        let timeInMs;
        const value = parseInt(timeString);
        const unit = timeString.slice(-1).toLowerCase(); // الحصول على الحرف الأخير كوحدة

        if (isNaN(value)) {
            const replyMsg = await message.reply({ content: 'مدة التايم آوت غير صالحة. استخدم s (ثواني), m (دقائق), h (ساعات), d (أيام).', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
            message.delete().catch(() => {});
            return;
        }

        switch (unit) {
            case 's': timeInMs = value * 1000; break;
            case 'm': timeInMs = value * 60 * 1000; break;
            case 'h': timeInMs = value * 60 * 60 * 1000; break;
            case 'd': timeInMs = value * 24 * 60 * 60 * 1000; break;
            default:
                const replyMsg = await message.reply({ content: 'وحدة المدة غير صالحة. استخدم s (ثواني), m (دقائق), h (ساعات), d (أيام).', ephemeral: true }).catch(() => {});
                if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
                message.delete().catch(() => {});
                return;
        }

        const maxTimeout = 28 * 24 * 60 * 60 * 1000; // أقصى مدة تايم آوت هي 28 يومًا
        if (timeInMs > maxTimeout) {
            const replyMsg = await message.reply({ content: 'أقصى مدة للتايم آوت هي 28 يومًا.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
            message.delete().catch(() => {});
            return;
        }

        const reason = args.slice(2).join(' ') || 'لم يتم تحديد سبب';

        // التحقق من صلاحيات البوت والمستخدم المستهدف
        if (!targetMember.moderatable) {
            const replyMsg = await message.reply({ content: 'لا أستطيع إعطاء تايم آوت لهذا العضو. تأكد من أن رتبتي أعلى من رتبته.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
            message.delete().catch(() => {});
            return;
        }
        // منع التايم آوت للمشرفين أو مالك السيرفر
        if (targetMember.permissions.has(PermissionsBitField.Flags.Administrator) || targetMember.id === message.guild.ownerId) {
            const replyMsg = await message.reply({ content: 'لا يمكن إعطاء تايم آوت لعضو لديه صلاحية المسؤول (Administrator) أو هو مالك السيرفر.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COOLDOWN);
            message.delete().catch(() => {});
            return;
        }

        try {
            await targetMember.timeout(timeInMs, reason);
            await message.delete().catch(() => {});
            const replyMsg = await message.channel.send({ content: `تم وضع **${targetMember.user.tag}** في التايم آوت لمدة **${timeString}** بسبب: **${reason}**`, ephemeral: false });
            // لا نحذف رسالة الرد هذه لتبقى مرجعاً في القناة

            const timeoutLogChannel = message.guild.channels.cache.get(config.timeout_log_channel_id);
            const logChannel = message.guild.channels.cache.get(config.log_channel_id);

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle('⏳ تايم آوت')
                .addFields(
                    { name: 'المستخدم', value: `${targetMember.user.tag} (${targetMember.id})`, inline: true },
                    { name: 'بواسطة', value: `${message.author.tag} (${message.author.id})`, inline: true },
                    { name: 'المدة', value: timeString, inline: true },
                    { name: 'السبب', value: reason }
                )
                .setTimestamp();

            // إرسال السجل إلى قناة سجلات التايم آوت وإلى قناة السجلات العامة (إذا كانت مختلفة)
            if (timeoutLogChannel) await timeoutLogChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل التايم آوت:', err));
            if (logChannel && timeoutLogChannel?.id !== logChannel?.id) await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل التايم آوت (لوج عام):', err));

        } catch (error) {
            console.error(`فشل إعطاء تايم آوت لـ ${targetMember.user.tag}:`, error);
            await sendBotErrorLog(error, `Timeout Command for ${targetMember.user.tag}`);
            const replyMsg = await message.channel.send({ content: `حدث خطأ أثناء إعطاء التايم آوت: ${error.message}`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
        }
    }

    // --- أمر تايم آوت إداري: !تايم_الاداري <@يوزر> <وقت> <السبب> (للمالكين فقط) ---
    else if (command === 'تايم_الاداري' || command === 'admin_timeout') {
        // التحقق الصارم للمالك فقط
        if (!(await checkPermissions(message, 'owner'))) return;

        const targetMember = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
        if (!targetMember) {
            const replyMsg = await message.reply({ content: 'الرجاء منشن العضو أو توفير آيدي العضو.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        const timeString = args[1];
        if (!timeString) {
            const replyMsg = await message.reply({ content: 'الرجاء تحديد مدة التايم آوت (مثال: 10s, 30m, 1h, 7d).', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        let timeInMs;
        const value = parseInt(timeString);
        const unit = timeString.slice(-1).toLowerCase();

        if (isNaN(value)) {
            const replyMsg = await message.reply({ content: 'مدة التايم آوت غير صالحة. استخدم s (ثواني), m (دقائق), h (ساعات), d (أيام).', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        switch (unit) {
            case 's': timeInMs = value * 1000; break;
            case 'm': timeInMs = value * 60 * 1000; break;
            case 'h': timeInMs = value * 60 * 60 * 1000; break;
            case 'd': timeInMs = value * 24 * 60 * 60 * 1000; break;
            default:
                const replyMsg = await message.reply({ content: 'وحدة المدة غير صالحة. استخدم s (ثواني), m (دقائق), h (ساعات), d (أيام).', ephemeral: true }).catch(() => {});
                if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
                message.delete().catch(() => {});
                return;
        }

        const maxTimeout = 28 * 24 * 60 * 60 * 1000;
        if (timeInMs > maxTimeout) {
            const replyMsg = await message.reply({ content: 'أقصى مدة للتايم آوت هي 28 يومًا.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        const reason = args.slice(2).join(' ') || 'لم يتم تحديد سبب';

        // التحقق من صلاحيات البوت والعضو المستهدف
        if (!targetMember.moderatable) {
            const replyMsg = await message.reply({ content: 'لا أستطيع إعطاء تايم آوت لهذا العضو. تأكد من أن رتبتي أعلى من رتبته.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }
        // منع التايم آوت للمشرفين أو مالك السيرفر الفعلي (حتى من المالك)
        if (targetMember.permissions.has(PermissionsBitField.Flags.Administrator) || targetMember.id === message.guild.ownerId) {
            const replyMsg = await message.reply({ content: 'لا يمكن إعطاء تايم آوت لعضو لديه صلاحية المسؤول (Administrator) أو هو مالك السيرفر.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        try {
            await targetMember.timeout(timeInMs, reason);
            await message.delete().catch(() => {});
            const replyMsg = await message.channel.send({ content: `[تايم إداري] تم وضع **${targetMember.user.tag}** في التايم آوت لمدة **${timeString}** بسبب: **${reason}**`, ephemeral: false });

            const timeoutLogChannel = message.guild.channels.cache.get(config.timeout_log_channel_id);
            const logChannel = message.guild.channels.cache.get(config.log_channel_id);

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle('🚨 تايم آوت إداري')
                .addFields(
                    { name: 'المستخدم', value: `${targetMember.user.tag} (${targetMember.id})`, inline: true },
                    { name: 'بواسطة', value: `${message.author.tag} (${message.author.id})`, inline: true },
                    { name: 'المدة', value: timeString, inline: true },
                    { name: 'السبب', value: reason }
                )
                .setTimestamp();

            if (timeoutLogChannel) await timeoutLogChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل التايم آوت الإداري:', err));
            if (logChannel && timeoutLogChannel?.id !== logChannel?.id) await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل التايم آوت الإداري (لوج عام):', err));

        } catch (error) {
            console.error(`فشل إعطاء تايم آوت إداري لـ ${targetMember.user.tag}:`, error);
            await sendBotErrorLog(error, `Admin Timeout Command for ${targetMember.user.tag}`);
            const replyMsg = await message.channel.send({ content: `حدث خطأ أثناء إعطاء التايم آوت: ${error.message}`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
        }
    }

    // --- أمر عرض التايمات النشطة: !التايمات ---
    else if (command === 'التايمات' || command === 'list_timeouts') {
        // يتطلب صلاحية مسؤول
        if (!(await checkPermissions(message, 'admin'))) return;

        try {
            await message.delete().catch(() => {});
            await message.channel.sendTyping(); // لإظهار أن البوت يكتب

            const guildMembers = await message.guild.members.fetch(); // جلب جميع أعضاء السيرفر
            // تصفية الأعضاء الذين لديهم تايم آوت نشط (communicationDisabledUntilTimestamp موجود وفي المستقبل)
            const timedOutMembers = guildMembers.filter(member => member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now());

            if (timedOutMembers.size === 0) {
                const replyMsg = await message.channel.send('لا يوجد أعضاء في التايم آوت حالياً.');
                setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
                return;
            }

            const embeds = [];
            let currentDescription = '';
            let count = 0;

            // بناء الإيمبيدات لتجنب تجاوز الحد الأقصى لعدد الأحرف
            for (const [id, member] of timedOutMembers) {
                const timeLeft = member.communicationDisabledUntilTimestamp - Date.now();
                const totalSeconds = Math.floor(timeLeft / 1000);
                const days = Math.floor(totalSeconds / (24 * 3600));
                const hours = Math.floor((totalSeconds % (24 * 3600)) / 3600);
                const minutes = Math.floor((totalSeconds % 3600) / 60);
                const seconds = totalSeconds % 60;

                let timeLeftString = '';
                if (days > 0) timeLeftString += `${days}ي `;
                if (hours > 0) timeLeftString += `${hours}س `;
                if (minutes > 0) timeLeftString += `${minutes}د `;
                // إذا لم يكن هناك وقت متبقي أو كان أقل من ثانية، اعرض 0 ثانية
                if (seconds > 0 || timeLeftString === '') timeLeftString += `${seconds}ث`;
                timeLeftString = timeLeftString.trim();

                const entry = `• ${member.user.tag} (${member.id}) - تبقى: ${timeLeftString}\n`;
                // إذا كان إضافة السطر الجديد ستتجاوز حد 4000 حرف أو 25 حقل (أو عدد محدود من الأعضاء لكل إيمبيد)
                if ((currentDescription + entry).length > 4000 || count === 25) {
                    embeds.push(new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle('⏳ الأعضاء في التايم آوت')
                        .setDescription(currentDescription)
                        .setTimestamp());
                    currentDescription = entry;
                    count = 1;
                } else {
                    currentDescription += entry;
                    count++;
                }
            }
            // إضافة الإيمبيد الأخير إذا كان هناك محتوى متبقي
            if (currentDescription.length > 0) {
                embeds.push(new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle('⏳ الأعضاء في التايم آوت')
                    .setDescription(currentDescription)
                    .setTimestamp());
            }

            // إرسال جميع الإيمبيدات
            for (const embed of embeds) {
                await message.channel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال إيمبيد قائمة التايم آوت:', err));
            }

        } catch (error) {
            console.error('فشل جلب قائمة التايمات:', error);
            await sendBotErrorLog(error, "List Timed Out Members Command");
            const replyMsg = await message.channel.send({ content: 'حدث خطأ أثناء جلب قائمة التايمات.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
        }
    }

    // --- أمر قائمة الألوان: !قائمة الوان (setup_color_roles) ---
    else if ((command === 'قائمة' && args[0] === 'الوان') || command === 'setup_color_roles_prefix') {
        // يتطلب صلاحية دعم أو أعلى
        if (!(await checkPermissions(message, 'support'))) return;

        if (!config.color_selection_channel_id) {
            const replyMsg = await message.reply({ content: 'لم يتم تحديد `color_selection_channel_id` في ملف الإعدادات (config.json).', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        const roleSelectionChannel = message.guild.channels.cache.get(config.color_selection_channel_id);
        if (!roleSelectionChannel) {
            const replyMsg = await message.reply({ content: `القناة المحددة للألوان (ID: ${config.color_selection_channel_id}) غير موجودة في هذا السيرفر.`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        // التحقق من صلاحيات البوت في قناة تحديد الألوان
        if (!roleSelectionChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.SendMessages) ||
            !roleSelectionChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.EmbedLinks) ||
            !roleSelectionChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.UseExternalEmojis)) {
            const replyMsg = await message.reply({ content: `لا أمتلك صلاحية إرسال الرسائل/الإيمبيدات/المكونات في قناة الألوان ${roleSelectionChannel}. يرجى التحقق من صلاحيات البوت.`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        const selectMenuOptions = config.color_roles.map(role => ({
            label: role.label,
            value: role.id,
            // يمكن إضافة emoji هنا إذا كانت متوفرة في config.json
            // مثال: emoji: { name: '🔵' }
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('color_role_selector') // يجب أن يتطابق مع customId في interactionCreate
            .setPlaceholder('اختر لون رتبتك المفضلة...')
            .addOptions(selectMenuOptions);

        const actionRow = new ActionRowBuilder()
            .addComponents(selectMenu);

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle(' اختر لون رتبتك!')
            .setDescription('اختر اللون الذي يعجبك من القائمة أدناه للحصول على رتبة اللون الخاصة بك.');

        try {
            await roleSelectionChannel.send({ embeds: [embed], components: [actionRow] });
            await message.delete().catch(() => {});
            const replyMsg = await message.channel.send({ content: `تم إعداد رسالة ألوان الرتب في قناة ${roleSelectionChannel}.`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
        } catch (error) {
            console.error(`فشل إعداد رسالة الألوان:`, error);
            await sendBotErrorLog(error, "Color Roles Setup Command (Prefix)");
            const replyMsg = await message.channel.send({ content: `حدث خطأ أثناء إعداد رسالة الألوان: ${error.message}`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
        }
    }

    // --- أمر إرسال رسالة: !send_message <#قناة> <الرسالة> [رابط_الرد] ---
    else if (command === 'send_message') {
        // يتطلب صلاحية إدارة القنوات
        if (!(await checkPermissions(message, PermissionsBitField.Flags.ManageChannels))) return;

        const targetChannel = message.mentions.channels.first();
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
            const replyMsg = await message.reply({ content: 'الرجاء منشن القناة النصية التي تريد إرسال الرسالة إليها (مثال: `!send_message #general مرحبا بكم`).', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        // محتوى الرسالة هو كل شيء بعد القناة
        let messageContent = args.slice(1).join(' ');
        if (!messageContent) {
            const replyMsg = await message.reply({ content: 'الرجاء تحديد محتوى الرسالة التي تريد إرسالها.', ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
            message.delete().catch(() => {});
            return;
        }

        // إذا كان هناك رابط رد (اختياري)
        let replyMessageId = null;
        let replyLink = null;
        const lastArg = args[args.length - 1]; // تحقق من آخر وسيط إذا كان رابطاً
        if (lastArg && lastArg.startsWith('https://discord.com/channels/')) {
            try {
                const url = new URL(lastArg);
                const pathParts = url.pathname.split('/').filter(p => p);
                // تنسيق الرابط المتوقع: /channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
                if (pathParts.length >= 4 && pathParts[0] === 'channels') {
                    const guildIdFromLink = pathParts[1];
                    const channelIdFromLink = pathParts[2];
                    const messageIdFromLink = pathParts[3];

                    // التأكد من أن الرابط يخص نفس السيرفر والقناة المستهدفة
                    if (guildIdFromLink === guild.id && channelIdFromLink === targetChannel.id && messageIdFromLink) {
                        replyMessageId = messageIdFromLink;
                        replyLink = lastArg; // حفظ الرابط الأصلي
                        // إزالة رابط الرد من محتوى الرسالة
                        const messageContentParts = args.slice(1);
                        messageContentParts.pop(); // حذف آخر عنصر (الرابط)
                        messageContent = messageContentParts.join(' ');
                    } else {
                         // إذا كان الرابط غير صالح ولكن المستخدم حاول إدخاله، نعطي تحذيراً
                        const replyMsg = await message.reply({ content: 'رابط الرد غير صحيح أو لا يخص القناة المستهدفة. يجب أن يكون الرابط لرسالة في نفس القناة التي ستُرسل إليها الرسالة.', ephemeral: true }).catch(() => {});
                        if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
                        message.delete().catch(() => {});
                        return;
                    }
                } else {
                    const replyMsg = await message.reply({ content: 'تنسيق رابط الرد غير صحيح. يرجى استخدام رابط كامل للرسالة.', ephemeral: true }).catch(() => {});
                    if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
                    message.delete().catch(() => {});
                    return;
                }
            } catch (e) {
                const replyMsg = await message.reply({ content: 'رابط الرد غير صالح. يرجى التأكد من صحة الرابط.', ephemeral: true }).catch(() => {});
                if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
                message.delete().catch(() => {});
                return;
            }
        }

        try {
            await message.delete().catch(() => {}); // حذف رسالة الأمر الأصلية
            if (!targetChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.SendMessages)) {
                const replyMsg = await message.reply({ content: `لا أمتلك صلاحية إرسال الرسائل في القناة ${targetChannel}.`, ephemeral: true }).catch(() => {});
                if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
                return;
            }

            const messageOptions = { content: messageContent };
            if (replyMessageId) {
                messageOptions.reply = {
                    messageReference: replyMessageId,
                    failIfNotExists: false, // لا تفشل إذا تم حذف الرسالة الأصلية
                };
            }

            await targetChannel.send(messageOptions);
            const replyMsg = await message.channel.send({ content: `تم إرسال رسالتك بنجاح في قناة ${targetChannel}.`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);

            const logChannel = message.guild.channels.cache.get(config.log_channel_id);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle('✉️ رسالة مرسلة بواسطة البوت (أمر نصي)')
                    .addFields(
                        { name: 'من قبل', value: `${message.author.tag} (${message.author.id})`, inline: true },
                        { name: 'القناة المستهدفة', value: `#${targetChannel.name} (${targetChannel.id})`, inline: true },
                        { name: 'محتوى الرسالة', value: `\`\`\`${messageContent.substring(0, 1000)}\`\`\`` } // اقتطاع الرسالة الطويلة
                    )
                    .setTimestamp();
                if (replyMessageId) {
                    embed.addFields({ name: 'تم الرد على الرسالة (ID)', value: `${replyMessageId}`, inline: true });
                    // يمكن إضافة رابط للرسالة التي تم الرد عليها
                    embed.setDescription(embed.data.description ? `${embed.data.description}\n[انتقل إلى الرسالة الأصلية](${replyLink})` : `[انتقل إلى الرسالة الأصلية](${replyLink})`);
                }
                await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل رسالة البوت:', err));
            }

        } catch (error) {
            console.error(`فشل إرسال الرسالة في قناة ${targetChannel.name}: ${error.message}`);
            await sendBotErrorLog(error, `Send Message Command (Prefix) - Channel: ${targetChannel.name}`);
            const replyMsg = await message.channel.send({ content: `حدث خطأ أثناء محاولة إرسال الرسالة: ${error.message}`, ephemeral: true }).catch(() => {});
            if (replyMsg) setTimeout(() => replyMsg.delete().catch(() => {}), BOT_MESSAGE_COLDOWN);
        }
    }

    // --- أمر المساعدة النصي: !help ---
    else if (command === 'help') {
        // يتطلب صلاحية دعم أو أعلى
        if (!(await checkPermissions(message, 'support'))) return;

        await message.delete().catch(() => {}); // حذف رسالة الأمر
        const helpEmbed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle('📚 قائمة الأوامر النصية (!)')
            .setDescription('هذه هي الأوامر النصية المتاحة لك:')
            .addFields(
                { name: `\`${config.prefix}مسح <عدد>\``, value: 'يمسح عدداً محدداً من الرسائل في القناة (1-100). (صلاحية: إدارة الرسائل)' },
                { name: `\`${config.prefix}ق\` أو \`${config.prefix}lock\``, value: 'يغلق قناة الشات الحالية (يمنع الأعضاء العاديين من الكتابة). (صلاحية: إدارة القنوات)' },
                { name: `\`${config.prefix}ف\` أو \`${config.prefix}unlock\``, value: 'يفتح قناة الشات المغلقة. (صلاحية: إدارة القنوات)' },
                { name: `\`${config.prefix}تايم <@يوزر> <مدة> <سبب>\``, value: 'يضع عضواً في التايم آوت (مثال: `!تايم @user 30m سبام`). (صلاحية: تعديل الأعضاء)' },
                { name: `\`${config.prefix}تايم_الاداري <@يوزر> <مدة> <سبب>\``, value: 'يضع عضواً في التايم آوت (مخصص للمالكين فقط).' },
                { name: `\`${config.prefix}التايمات\` أو \`${config.prefix}list_timeouts\``, value: 'يعرض قائمة بجميع الأعضاء الموجودين في التايم آوت حالياً. (صلاحية: مسؤول)' },
                { name: `\`${config.prefix}قائمة الوان\` أو \`${config.prefix}setup_color_roles_prefix\``, value: 'ينشئ رسالة لاختيار رتب الألوان في قناة الألوان المحددة. (صلاحية: دعم أو أعلى)' },
                { name: `\`${config.prefix}send_message #قناة <رسالة> [رابط_رد]\``, value: 'يرسل رسالة في قناة محددة عن طريق البوت، مع إمكانية الرد على رسالة أخرى. (صلاحية: إدارة القنوات)' },
                { name: `\`${config.prefix}help\``, value: 'يعرض هذه القائمة.' }
            )
            .setFooter({ text: `البادئة: ${config.prefix} | للاستخدام من قبل الإدارة.` })
            .setTimestamp();

        await message.channel.send({ embeds: [helpEmbed] }).catch(err => console.error('فشل إرسال رسالة المساعدة:', err));
    }
});

// --- معالجة تفاعلات Slash Commands والتفاعلات الأخرى (Buttons, Select Menus) ---
client.on('interactionCreate', async (interaction) => {
    // --- معالجة أوامر Slash Commands ---
    if (interaction.isCommand()) {
        const { commandName, options, member, guild } = interaction;

        try {
            if (commandName === 'send_message') {
                if (!(await checkPermissions(interaction, PermissionsBitField.Flags.ManageChannels))) return;

                const targetChannel = options.getChannel('channel');
                const messageContent = options.getString('message');
                const replyLink = options.getString('reply_link');

                if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
                    return await interaction.reply({ content: 'الرجاء تحديد قناة نصية صحيحة.', ephemeral: true });
                }
                if (!messageContent) {
                    return await interaction.reply({ content: 'الرجاء تحديد محتوى الرسالة التي تريد إرسالها.', ephemeral: true });
                }

                if (!targetChannel.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)) {
                    return await interaction.reply({ content: `لا أمتلك صلاحية إرسال الرسائل في القناة ${targetChannel}.`, ephemeral: true });
                }

                let replyMessageId = null;
                if (replyLink) {
                    try {
                        const url = new URL(replyLink);
                        const pathParts = url.pathname.split('/').filter(p => p);
                        // مسار الرابط المتوقع: /channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
                        if (pathParts.length >= 4 && pathParts[0] === 'channels') {
                            const guildIdFromLink = pathParts[1];
                            const channelIdFromLink = pathParts[2];
                            const messageIdFromLink = pathParts[3];

                            if (guildIdFromLink === guild.id && channelIdFromLink === targetChannel.id && messageIdFromLink) {
                                replyMessageId = messageIdFromLink;
                            } else {
                                return await interaction.reply({ content: 'رابط الرد غير صحيح أو لا يخص القناة المستهدفة. يجب أن يكون الرابط لرسالة في نفس القناة التي ستُرسل إليها الرسالة.', ephemeral: true });
                            }
                        } else {
                            return await interaction.reply({ content: 'تنسيق رابط الرد غير صحيح. يرجى استخدام رابط كامل للرسالة.', ephemeral: true });
                        }
                    } catch (e) {
                        return await interaction.reply({ content: 'رابط الرد غير صالح. يرجى التأكد من صحة الرابط.', ephemeral: true });
                    }
                }

                const messageOptions = { content: messageContent };
                if (replyMessageId) {
                    messageOptions.reply = {
                        messageReference: replyMessageId,
                        failIfNotExists: false,
                    };
                }

                await targetChannel.send(messageOptions);
                await interaction.reply({ content: `تم إرسال رسالتك بنجاح في قناة ${targetChannel}.`, ephemeral: true });

                const logChannel = guild.channels.cache.get(config.log_channel_id);
                if (logChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle('✉️ رسالة مرسلة بواسطة البوت (Slash Command)')
                        .addFields(
                            { name: 'من قبل', value: `${member.user.tag} (${member.id})`, inline: true },
                            { name: 'القناة المستهدفة', value: `#${targetChannel.name} (${targetChannel.id})`, inline: true },
                            { name: 'محتوى الرسالة', value: `\`\`\`${messageContent.substring(0, 1000)}\`\`\`` }
                        )
                        .setTimestamp();
                    if (replyMessageId) {
                        embed.addFields({ name: 'تم الرد على الرسالة (ID)', value: `${replyMessageId}`, inline: true });
                        embed.setDescription(embed.data.description ? `${embed.data.description}\n[انتقل إلى الرسالة الأصلية](${replyLink})` : `[انتقل إلى الرسالة الأصلية](${replyLink})`);
                    }
                    await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل رسالة البوت (Slash):', err));
                }

            } else if (commandName === 'setup_color_roles') {
                if (!(await checkPermissions(interaction, 'admin'))) return;

                await interaction.reply({ content: 'جاري إعداد رسالة ألوان الرتب...', ephemeral: true });
                const roleSelectionChannel = client.channels.cache.get(config.color_selection_channel_id);

                if (!roleSelectionChannel) {
                    return await interaction.editReply({ content: 'خطأ: لم يتم العثور على قناة تحديد الألوان. يرجى التأكد من تعيين `color_selection_channel_id` بشكل صحيح في `config.json`.', ephemeral: true });
                }
                if (!roleSelectionChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.SendMessages) ||
                    !roleSelectionChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.EmbedLinks) ||
                    !roleSelectionChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.UseExternalEmojis)) {
                    return await interaction.editReply({ content: `لا أمتلك صلاحية إرسال الرسائل/المكونات في القناة ${roleSelectionChannel}. يرجى التحقق من صلاحيات البوت.`, ephemeral: true });
                }

                const selectMenuOptions = config.color_roles.map(role => ({
                    label: role.label,
                    value: role.id,
                }));

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('color_role_selector')
                    .setPlaceholder('اختر لون رتبتك المفضلة...')
                    .addOptions(selectMenuOptions);

                const actionRow = new ActionRowBuilder()
                    .addComponents(selectMenu);

                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle(' اختر لون رتبتك!')
                    .setDescription('اختر اللون الذي يعجبك من القائمة أدناه للحصول على رتبة اللون الخاصة بك.');

                await roleSelectionChannel.send({ embeds: [embed], components: [actionRow] });
                await interaction.editReply({ content: `تم إعداد رسالة ألوان الرتب في قناة ${roleSelectionChannel}.`, ephemeral: true });

            } else if (commandName === 'setup_tickets') {
                if (!(await checkPermissions(interaction, 'admin'))) return;

                await interaction.reply({ content: 'جاري إعداد نظام التذاكر...', ephemeral: true });
                const ticketSetupChannel = client.channels.cache.get(config.ticket_setup_channel_id);

                if (!ticketSetupChannel) {
                    return await interaction.editReply({ content: 'خطأ: لم يتم العثور على قناة إعداد التذاكر. يرجى التأكد من تعيين `ticket_setup_channel_id` بشكل صحيح في `config.json`.', ephemeral: true });
                }
                if (!ticketSetupChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.SendMessages) ||
                    !ticketSetupChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.EmbedLinks) ||
                    !ticketSetupChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.UseExternalEmojis)) {
                    return await interaction.editReply({ content: `لا أمتلك صلاحية إرسال الرسائل/المكونات في القناة ${ticketSetupChannel}. يرجى التحقق من صلاحيات البوت.`, ephemeral: true });
                }

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('ticket_type_selector')
                            .setPlaceholder('اختر نوع التذكرة...')
                            .addOptions([
                                { label: 'دعم فني', value: 'دعم ', emoji: '🛠️' },
                                { label: 'استفسار عام', value: 'استفسار ', emoji: '❓' },
                                { label: 'الابلاغ عن مشكله او شخص', value: '  الابلاغ  ', emoji: '⚠️' },
                                { label: 'توثيق بنات', value: 'توثيق البنات', emoji: '📝' },
                            ]),
                    );

                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle('🎫 نظام التذاكر')
                    .setDescription('الرجاء الالتزام بقوانين السيرفر وقوانين التكت وعدم الاساءة لاي من الادارة او الاعضاء');

                await ticketSetupChannel.send({ embeds: [embed], components: [row] });
                await interaction.editReply({ content: `تم إعداد رسالة نظام التذاكر في قناة ${ticketSetupChannel}.`, ephemeral: true });

            } else if (commandName === 'مسح') {
                if (!(await checkPermissions(interaction, PermissionsBitField.Flags.ManageMessages))) return;

                const amount = options.getInteger('عدد');

                if (amount < 1 || amount > 100) {
                    return await interaction.reply({ content: 'الرجاء إدخال عدد بين 1 و 100.', ephemeral: true });
                }
                if (!interaction.channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageMessages)) {
                    return await interaction.reply({ content: 'لا أمتلك صلاحية "إدارة الرسائل" في هذه القناة لحذف الرسائل.', ephemeral: true });
                }

                try {
                    await interaction.deferReply({ ephemeral: true });
                    const fetched = await interaction.channel.messages.fetch({ limit: amount });
                    await interaction.channel.bulkDelete(fetched, true);

                    await interaction.editReply({ content: `تم مسح **${fetched.size}** رسالة بنجاح.` });

                    const logChannel = guild.channels.cache.get(config.log_channel_id);
                    if (logChannel) {
                        const embed = new EmbedBuilder()
                            .setColor(EMBED_COLOR)
                            .setTitle('🗑️ رسائل محذوفة (Slash Command)')
                            .addFields(
                                { name: 'القناة', value: `#${interaction.channel.name} (${interaction.channel.id})`, inline: true },
                                { name: 'العدد', value: `${fetched.size}`, inline: true },
                                { name: 'بواسطة', value: `${member.user.tag} (${member.id})` }
                            )
                            .setTimestamp();
                        await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل حذف الرسائل (Slash):', err));
                    }
                } catch (error) {
                    console.error(`فشل مسح الرسائل: ${error.message}`);
                    await sendBotErrorLog(error, `Clear Command (Slash) in ${interaction.channel.name}`);
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: `حدث خطأ أثناء مسح الرسائل: ${error.message}`, ephemeral: true });
                    } else if (interaction.deferred) {
                        await interaction.editReply({ content: `حدث خطأ أثناء مسح الرسائل: ${error.message}` });
                    }
                }
            } else if (commandName === 'lock') {
                if (!(await checkPermissions(interaction, PermissionsBitField.Flags.ManageChannels))) return;

                const channel = interaction.channel;
                const everyoneRole = interaction.guild.roles.everyone;

                try {
                    if (!channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageChannels)) {
                        return await interaction.reply({ content: 'لا أمتلك صلاحية "إدارة القنوات" لإغلاق هذا الشات.', ephemeral: true });
                    }

                    await channel.permissionOverwrites.edit(everyoneRole, { SendMessages: false });
                    await interaction.reply('🔒 | تم إغلاق الشات بنجاح!');

                    const logChannel = interaction.guild.channels.cache.get(config.log_channel_id);
                    if (logChannel) {
                        const embed = new EmbedBuilder()
                            .setColor(EMBED_COLOR)
                            .setTitle('🔒 الشات مغلق (Slash Command)')
                            .setDescription(`**القناة:** ${channel}\n**بواسطة:** ${interaction.user.tag} (${interaction.user.id})`)
                            .setTimestamp();
                        await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل إغلاق الشات (Slash):', err));
                    }
                } catch (error) {
                    console.error(`فشل إغلاق الشات ${channel.name}:`, error);
                    await sendBotErrorLog(error, `Lock Command (Slash) for ${channel.name}`);
                    await interaction.reply({ content: `حدث خطأ أثناء إغلاق الشات: ${error.message}`, ephemeral: true });
                }
            } else if (commandName === 'unlock') {
                if (!(await checkPermissions(interaction, PermissionsBitField.Flags.ManageChannels))) return;

                const channel = interaction.channel;
                const everyoneRole = interaction.guild.roles.everyone;

                try {
                    if (!channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageChannels)) {
                        return await interaction.reply({ content: 'لا أمتلك صلاحية "إدارة القنوات" لفتح هذا الشات.', ephemeral: true });
                    }

                    await channel.permissionOverwrites.edit(everyoneRole, { SendMessages: null });
                    await interaction.reply('🔓 | تم فتح الشات بنجاح!');

                    const logChannel = interaction.guild.channels.cache.get(config.log_channel_id);
                    if (logChannel) {
                        const embed = new EmbedBuilder()
                            .setColor(EMBED_COLOR)
                            .setTitle('🔓 الشات مفتوح (Slash Command)')
                            .setDescription(`**القناة:** ${channel}\n**بواسطة:** ${interaction.user.tag} (${interaction.user.id})`)
                            .setTimestamp();
                        await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل فتح الشات (Slash):', err));
                    }
                } catch (error) {
                    console.error(`فشل فتح الشات ${channel.name}:`, error);
                    await sendBotErrorLog(error, `Unlock Command (Slash) for ${channel.name}`);
                    await interaction.reply({ content: `حدث خطأ أثناء فتح الشات: ${error.message}`, ephemeral: true });
                }
            } else if (commandName === 'timeout') {
                if (!(await checkPermissions(interaction, PermissionsBitField.Flags.ModerateMembers))) return;

                const targetMember = options.getMember('عضو');
                const timeString = options.getString('مدة');
                const reason = options.getString('سبب') || 'لم يتم تحديد سبب';

                if (!targetMember) {
                    return await interaction.reply({ content: 'الرجاء تحديد العضو.', ephemeral: true });
                }

                let timeInMs;
                const value = parseInt(timeString);
                const unit = timeString.slice(-1).toLowerCase();

                if (isNaN(value)) {
                    return await interaction.reply({ content: 'مدة التايم آوت غير صالحة. استخدم s, m, h, d.', ephemeral: true });
                }

                switch (unit) {
                    case 's': timeInMs = value * 1000; break;
                    case 'm': timeInMs = value * 60 * 1000; break;
                    case 'h': timeInMs = value * 60 * 60 * 1000; break;
                    case 'd': timeInMs = value * 24 * 60 * 60 * 1000; break;
                    default:
                        return await interaction.reply({ content: 'وحدة المدة غير صالحة. استخدم s, m, h, d.', ephemeral: true });
                }

                const maxTimeout = 28 * 24 * 60 * 60 * 1000;
                if (timeInMs > maxTimeout) {
                    return await interaction.reply({ content: 'أقصى مدة للتايم آوت هي 28 يومًا.', ephemeral: true });
                }

                if (!targetMember.moderatable) {
                    return await interaction.reply({ content: 'لا أستطيع إعطاء تايم آوت لهذا العضو. تأكد من أن رتبتي أعلى من رتبته.', ephemeral: true });
                }
                if (targetMember.permissions.has(PermissionsBitField.Flags.Administrator) || targetMember.id === guild.ownerId) {
                    return await interaction.reply({ content: 'لا يمكن إعطاء تايم آوت لعضو لديه صلاحية المسؤول (Administrator) أو هو مالك السيرفر.', ephemeral: true });
                }

                try {
                    await targetMember.timeout(timeInMs, reason);
                    await interaction.reply({ content: `تم وضع **${targetMember.user.tag}** في التايم آوت لمدة **${timeString}** بسبب: **${reason}**`, ephemeral: false });

                    const timeoutLogChannel = guild.channels.cache.get(config.timeout_log_channel_id);
                    const logChannel = guild.channels.cache.get(config.log_channel_id);

                    const embed = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle('⏳ تايم آوت (Slash Command)')
                        .addFields(
                            { name: 'المستخدم', value: `${targetMember.user.tag} (${targetMember.id})`, inline: true },
                            { name: 'بواسطة', value: `${member.user.tag} (${member.id})`, inline: true },
                            { name: 'المدة', value: timeString, inline: true },
                            { name: 'السبب', value: reason }
                        )
                        .setTimestamp();

                    if (timeoutLogChannel) await timeoutLogChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل التايم آوت (Slash):', err));
                    if (logChannel && timeoutLogChannel?.id !== logChannel?.id) await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل التايم آوت (لوج عام - Slash):', err));

                } catch (error) {
                    console.error(`فشل إعطاء تايم آوت لـ ${targetMember.user.tag}:`, error);
                    await sendBotErrorLog(error, `Timeout Command (Slash) for ${targetMember.user.tag}`);
                    await interaction.reply({ content: `حدث خطأ أثناء إعطاء التايم آوت: ${error.message}`, ephemeral: true });
                }
            } else if (commandName === 'admin_timeout') {
                if (!(await checkPermissions(interaction, 'owner'))) return;

                const targetMember = options.getMember('عضو');
                const timeString = options.getString('مدة');
                const reason = options.getString('سبب') || 'لم يتم تحديد سبب';

                if (!targetMember) {
                    return await interaction.reply({ content: 'الرجاء تحديد العضو.', ephemeral: true });
                }

                let timeInMs;
                const value = parseInt(timeString);
                const unit = timeString.slice(-1).toLowerCase();

                if (isNaN(value)) {
                    return await interaction.reply({ content: 'مدة التايم آوت غير صالحة. استخدم s, m, h, d.', ephemeral: true });
                }

                switch (unit) {
                    case 's': timeInMs = value * 1000; break;
                    case 'm': timeInMs = value * 60 * 1000; break;
                    case 'h': timeInMs = value * 60 * 60 * 1000; break;
                    case 'd': timeInMs = value * 24 * 60 * 60 * 1000; break;
                    default:
                        return await interaction.reply({ content: 'وحدة المدة غير صالحة. استخدم s, m, h, d.', ephemeral: true });
                }

                const maxTimeout = 28 * 24 * 60 * 60 * 1000;
                if (timeInMs > maxTimeout) {
                    return await interaction.reply({ content: 'أقصى مدة للتايم آوت هي 28 يومًا.', ephemeral: true });
                }

                if (!targetMember.moderatable) {
                    return await interaction.reply({ content: 'لا أستطيع إعطاء تايم آوت لهذا العضو. تأكد من أن رتبتي أعلى من رتبته.', ephemeral: true });
                }
                if (targetMember.permissions.has(PermissionsBitField.Flags.Administrator) || targetMember.id === guild.ownerId) {
                    return await interaction.reply({ content: 'لا يمكن إعطاء تايم آوت لعضو لديه صلاحية المسؤول (Administrator) أو هو مالك السيرفر.', ephemeral: true });
                }

                try {
                    await targetMember.timeout(timeInMs, reason);
                    await interaction.reply({ content: `[تايم إداري] تم وضع **${targetMember.user.tag}** في التايم آوت لمدة **${timeString}** بسبب: **${reason}**`, ephemeral: false });

                    const timeoutLogChannel = guild.channels.cache.get(config.timeout_log_channel_id);
                    const logChannel = guild.channels.cache.get(config.log_channel_id);

                    const embed = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle('🚨 تايم آوت إداري (Slash Command)')
                        .addFields(
                            { name: 'المستخدم', value: `${targetMember.user.tag} (${targetMember.id})`, inline: true },
                            { name: 'بواسطة', value: `${member.user.tag} (${member.id})`, inline: true },
                            { name: 'المدة', value: timeString, inline: true },
                            { name: 'السبب', value: reason }
                        )
                        .setTimestamp();

                    if (timeoutLogChannel) await timeoutLogChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل التايم آوت الإداري (Slash):', err));
                    if (logChannel && timeoutLogChannel?.id !== logChannel?.id) await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل التايم آوت الإداري (لوج عام - Slash):', err));

                } catch (error) {
                    console.error(`فشل إعطاء تايم آوت إداري لـ ${targetMember.user.tag}:`, error);
                    await sendBotErrorLog(error, `Admin Timeout Command (Slash) for ${targetMember.user.tag}`);
                    await interaction.reply({ content: `حدث خطأ أثناء إعطاء التايم آوت: ${error.message}`, ephemeral: true });
                }
            } else if (commandName === 'list_timeouts') {
                if (!(await checkPermissions(interaction, 'admin'))) return;

                try {
                    await interaction.deferReply({ ephemeral: true });
                    const guildMembers = await guild.members.fetch();
                    const timedOutMembers = guildMembers.filter(m => m.communicationDisabledUntilTimestamp && m.communicationDisabledUntilTimestamp > Date.now());

                    if (timedOutMembers.size === 0) {
                        return await interaction.editReply('لا يوجد أعضاء في التايم آوت حالياً.');
                    }

                    const embeds = [];
                    let currentDescription = '';
                    let count = 0;

                    for (const [id, m] of timedOutMembers) {
                        const timeLeft = m.communicationDisabledUntilTimestamp - Date.now();
                        const totalSeconds = Math.floor(timeLeft / 1000);
                        const days = Math.floor(totalSeconds / (24 * 3600));
                        const hours = Math.floor((totalSeconds % (24 * 3600)) / 3600);
                        const minutes = Math.floor((totalSeconds % 3600) / 60);
                        const seconds = totalSeconds % 60;

                        let timeLeftString = '';
                        if (days > 0) timeLeftString += `${days}ي `;
                        if (hours > 0) timeLeftString += `${hours}س `;
                        if (minutes > 0) timeLeftString += `${minutes}د `;
                        if (seconds > 0 || timeLeftString === '') timeLeftString += `${seconds}ث`;
                        timeLeftString = timeLeftString.trim();

                        const entry = `• ${m.user.tag} (${m.id}) - تبقى: ${timeLeftString}\n`;
                        if ((currentDescription + entry).length > 4000 || count === 25) {
                            embeds.push(new EmbedBuilder()
                                .setColor(EMBED_COLOR)
                                .setTitle('⏳ الأعضاء في التايم آوت')
                                .setDescription(currentDescription)
                                .setTimestamp());
                            currentDescription = entry;
                            count = 1;
                        } else {
                            currentDescription += entry;
                            count++;
                        }
                    }
                    if (currentDescription.length > 0) {
                        embeds.push(new EmbedBuilder()
                            .setColor(EMBED_COLOR)
                            .setTitle('⏳ الأعضاء في التايم آوت')
                            .setDescription(currentDescription)
                            .setTimestamp());
                    }

                    for (const embed of embeds) {
                        await interaction.channel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال إيمبيد قائمة التايم آوت (Slash):', err));
                    }
                    await interaction.editReply('تم عرض قائمة التايم آوت بنجاح.');

                } catch (error) {
                    console.error('فشل جلب قائمة التايمات (Slash):', error);
                    await sendBotErrorLog(error, "List Timed Out Members Command (Slash)");
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: 'حدث خطأ أثناء جلب قائمة التايمات.', ephemeral: true });
                    } else if (interaction.deferred) {
                        await interaction.editReply({ content: 'حدث خطأ أثناء جلب قائمة التايمات.' });
                    }
                }
            } else if (commandName === 'help') {
                if (!(await checkPermissions(interaction, 'support'))) return;

                const helpEmbed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle('📚 قائمة أوامر Slash (/)')
                    .setDescription('هذه هي أوامر Slash Command المتاحة لك:')
                    .addFields(
                        { name: `\`/setup_color_roles\``, value: 'ينشئ رسالة لاختيار ألوان الرتب (للمسؤولين).' },
                        { name: `\`/setup_tickets\``, value: 'ينشئ رسالة إعداد نظام التذاكر (للمسؤولين).' },
                        { name: `\`/مسح <عدد>\``, value: 'يمسح عدداً محدداً من الرسائل (صلاحية: إدارة الرسائل).' },
                        { name: `\`/send_message <#قناة> <رسالة> [رابط_الرد]\``, value: 'يرسل رسالة في قناة محددة عن طريق البوت، مع إمكانية الرد على رسالة أخرى (صلاحية: إدارة القنوات).' },
                        { name: `\`/lock\``, value: 'يغلق قناة الشات الحالية. (صلاحية: إدارة القنوات)' },
                        { name: `\`/unlock\``, value: 'يفتح قناة الشات المغلقة. (صلاحية: إدارة القنوات)' },
                        { name: `\`/timeout <عضو> <مدة> [سبب]\``, value: 'يضع عضواً في التايم آوت. (صلاحية: تعديل الأعضاء)' },
                        { name: `\`/admin_timeout <عضو> <مدة> [سبب]\``, value: 'يضع عضواً في التايم آوت (للمالكين فقط).' },
                        { name: `\`/list_timeouts\``, value: 'يعرض قائمة بجميع الأعضاء الموجودين في التايم آوت حالياً. (صلاحية: مسؤول)' },
                        { name: `\`/help\``, value: 'يعرض هذه القائمة.' }
                    )
                    .setFooter({ text: 'هذه القائمة مخصصة للإدارة.' })
                    .setTimestamp();

                await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
            }

        } catch (error) {
            console.error('خطأ في معالجة أمر Slash Command:', error);
            await sendBotErrorLog(error, `Slash Command Handler - Command: ${commandName}`);
            // محاولة الرد على التفاعل في حالة الخطأ، مع التحقق من أن التفاعل لم يتم الرد عليه بالفعل
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'حدث خطأ غير متوقع أثناء تنفيذ الأمر.', ephemeral: true });
            } else if (interaction.deferred) {
                await interaction.editReply({ content: 'حدث خطأ غير متوقع أثناء تنفيذ الأمر.' });
            }
        }
    }

    // --- معالجة تفاعلات القوائم المنسدلة (Select Menus) ---
    else if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'color_role_selector') {
            const selectedRoleId = interaction.values[0];
            const member = interaction.member;
            const guild = interaction.guild;

            try {
                // التأكد أن البوت يمتلك صلاحية إدارة الرتب وأن رتبته أعلى من رتب الألوان
                if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
                    return await interaction.reply({ content: 'البوت لا يمتلك صلاحية "إدارة الرتب" لتغيير رتب الألوان. يرجى مراجعة صلاحيات البوت.', ephemeral: true });
                }

                const newRole = guild.roles.cache.get(selectedRoleId);
                if (!newRole) {
                    return await interaction.reply({ content: 'الرتبة المحددة غير موجودة.', ephemeral: true });
                }

                // مهم: يجب أن تكون رتبة البوت أعلى من رتبة اللون التي يحاول إدارتها
                if (guild.members.me.roles.highest.position <= newRole.position) {
                    return await interaction.reply({ content: `رتبة البوت يجب أن تكون أعلى من رتبة **${newRole.name}** لإدارتها. يرجى تعديل ترتيب الرتب في إعدادات السيرفر.`, ephemeral: true });
                }

                // إزالة جميع رتب الألوان الأخرى قبل إضافة الجديدة لضمان رتبة لون واحدة فقط
                const currentMemberColorRoles = member.roles.cache.filter(role =>
                    config.color_roles.some(cr => cr.id === role.id)
                );

                for (const role of currentMemberColorRoles.values()) {
                    if (role.id !== selectedRoleId) {
                        await member.roles.remove(role, 'تغيير رتبة اللون').catch(err => console.error(`فشل إزالة رتبة اللون ${role.name} من ${member.user.tag}:`, err));
                    }
                }

                if (!member.roles.cache.has(selectedRoleId)) {
                    await member.roles.add(newRole, 'اختيار رتبة اللون');
                    await interaction.reply({ content: `تم إعطاؤك رتبة اللون: **${newRole.name}**.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `أنت تمتلك هذه الرتبة بالفعل: **${newRole.name}**.`, ephemeral: true });
                }

            } catch (error) {
                console.error(`فشل إعطاء/إزالة رتبة اللون للعضو ${member.user.tag}:`, error);
                await sendBotErrorLog(error, `Color Role Selection for ${member.user.tag}`);
                await interaction.reply({ content: `حدث خطأ أثناء تغيير رتبة اللون: ${error.message}`, ephemeral: true });
            }
        } else if (interaction.customId === 'ticket_type_selector') {
            const ticketType = interaction.values[0];
            const guild = interaction.guild;
            const member = interaction.member;

            const categoryId = config.category_id_for_tickets;
            const category = guild.channels.cache.get(categoryId);

            if (!category || category.type !== ChannelType.GuildCategory) {
                return await interaction.reply({ content: 'فئة التذاكر غير موجودة أو غير صحيحة. يرجى التحقق من `category_id_for_tickets` في `config.json`.', ephemeral: true });
            }
            if (!category.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageChannels)) {
                return await interaction.reply({ content: 'لا أمتلك صلاحية "إدارة القنوات" لإنشاء تذاكر في الفئة المحددة. يرجى التحقق من صلاحيات البوت.', ephemeral: true });
            }

            // منع العضو من فتح أكثر من تذكرة نشطة
            const existingTicket = guild.channels.cache.find(channel =>
                channel.name.startsWith(`ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '')}`) && // تطابق بداية الاسم
                channel.parentId === categoryId && // داخل نفس الفئة
                channel.topic === member.id // وتطابق صاحب التذكرة (ID المخزن في الموضوع)
            );

            if (existingTicket) {
                return await interaction.reply({ content: `لديك بالفعل تذكرة مفتوحة: ${existingTicket}. يرجى إغلاقها قبل فتح تذكرة جديدة.`, ephemeral: true });
            }

            try {
                await interaction.deferReply({ ephemeral: true }); // deferReply لضمان الرد على التفاعل

                const ticketChannel = await guild.channels.create({
                    name: `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90)}`, // اسم القناة (90 حرفًا كحد أقصى للسلامة)
                    type: ChannelType.GuildText,
                    parent: categoryId,
                    topic: member.id, // تخزين ID صاحب التذكرة في موضوع القناة لسهولة التحديد
                    permissionOverwrites: [
                        {
                            id: guild.id, // @everyone (منعهم من رؤية القناة)
                            deny: [PermissionsBitField.Flags.ViewChannel],
                        },
                        {
                            id: member.id, // العضو الذي فتح التذكرة (السماح له بالرؤية والإرسال)
                            allow: [
                                PermissionsBitField.Flags.ViewChannel,
                                PermissionsBitField.Flags.SendMessages,
                                PermissionsBitField.Flags.ReadMessageHistory,
                                PermissionsBitField.Flags.AttachFiles
                            ],
                        },
                        {
                            id: config.support_role_id, // رتبة الدعم (السماح لهم بالرؤية والإرسال)
                            allow: [
                                PermissionsBitField.Flags.ViewChannel,
                                PermissionsBitField.Flags.SendMessages,
                                PermissionsBitField.Flags.ReadMessageHistory,
                                PermissionsBitField.Flags.AttachFiles
                            ],
                        },
                        {
                            id: client.user.id, // البوت نفسه (صلاحيات كاملة للعمل)
                            allow: [
                                PermissionsBitField.Flags.ViewChannel,
                                PermissionsBitField.Flags.SendMessages,
                                PermissionsBitField.Flags.ReadMessageHistory,
                                PermissionsBitField.Flags.ManageChannels, // للسماح للبوت بحذف القناة
                                PermissionsBitField.Flags.ManageMessages, // لمسح الرسائل إذا لزم الأمر
                                PermissionsBitField.Flags.AttachFiles
                            ],
                        },
                    ],
                });

                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle(`🎫 تذكرة جديدة: ${ticketType.replace(/_/g, ' ').toUpperCase()}`) // تنسيق نوع التذكرة
                    .setDescription(` ${member},\n\ الرجاء وصف مشكلتك\n\ فريق دعم سياتيك باسرع مايمكن `)
                    .addFields({ name: 'سبب فتح التكت', value: ticketType.replace(/_/g, ' ') });

                const closeButton = new ButtonBuilder()
                    .setCustomId('close_ticket')
                    .setLabel('إغلاق التذكرة')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔒');

                const claimButton = new ButtonBuilder()
                    .setCustomId('claim_ticket')
                    .setLabel('تولي التذكرة')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('✋');

                const row = new ActionRowBuilder().addComponents(closeButton, claimButton);

                await ticketChannel.send({ content: `<@&${config.support_role_id}> ${member}`, embeds: [embed], components: [row] });
                await interaction.editReply({ content: `تم فتح تذكرتك: ${ticketChannel}`, ephemeral: true });

                const logChannel = guild.channels.cache.get(config.log_channel_id);
                if (logChannel) {
                    const embedLog = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle('🎫 تذكرة تم فتحها')
                        .setDescription(`**المستخدم:** ${member.user.tag} (${member.id})\n**القناة:** ${ticketChannel}\n**النوع:** ${ticketType.replace(/_/g, ' ')}`)
                        .setTimestamp();
                    await logChannel.send({ embeds: [embedLog] }).catch(err => console.error('فشل إرسال سجل فتح التذكرة:', err));
                }

            } catch (error) {
                console.error(`فشل إنشاء تذكرة للعضو ${member.user.tag}:`, error);
                await sendBotErrorLog(error, `Ticket Creation for ${member.user.tag}`);
                // التأكد من الرد على التفاعل حتى لو حدث خطأ
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: `حدث خطأ أثناء إنشاء التذكرة: ${error.message}`, ephemeral: true });
                } else if (interaction.deferred) {
                    await interaction.editReply({ content: `حدث خطأ أثناء إنشاء التذكرة: ${error.message}` });
                }
            }
        }
    }

    // --- معالجة تفاعلات الأزرار (Buttons) ---
    else if (interaction.isButton()) {
        if (interaction.customId === 'close_ticket') {
            const member = interaction.member;
            const channel = interaction.channel;
            const guild = interaction.guild;

            // التحقق من صلاحية الإغلاق: إما أن يكون العضو من فريق الدعم/المسؤولين/المالك أو صاحب التذكرة
            const isSupportOrAdminOrOwner = member.roles.cache.has(config.support_role_id) || member.roles.cache.has(config.admin_role_id) || member.roles.cache.has(config.owner_role_id);
            const isTicketOwner = channel.topic === member.id; // صاحب التذكرة هو من يمتلك ID المخزن في موضوع القناة

            if (!isSupportOrAdminOrOwner && !isTicketOwner) {
                return await interaction.reply({ content: 'ليس لديك صلاحية إغلاق هذه التذكرة.', ephemeral: true });
            }

            try {
                await interaction.deferReply({ ephemeral: true }); // deferReply لضمان الرد على التفاعل

                // التحقق من صلاحيات البوت لحذف القناة
                if (!channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageChannels)) {
                    return await interaction.editReply({ content: 'لا أمتلك صلاحية "إدارة القنوات" لحذف هذه التذكرة. يرجى التحقق من صلاحيات البوت.', ephemeral: true });
                }

                const transcriptChannel = guild.channels.cache.get(config.log_channel_id); // يمكن استخدام قناة سجلات خاصة بالتذاكر إذا أردت
                if (transcriptChannel) {
                    const messages = await channel.messages.fetch({ limit: 100 }); // جلب آخر 100 رسالة
                    let transcriptContent = `سجل تذكرة #${channel.name} (أغلقت بواسطة: ${member.user.tag} - ${member.id})\n تاريخ الإغلاق: ${new Date().toLocaleString()}\n\n`;
                    // عكس ترتيب الرسائل لتكون من الأقدم إلى الأحدث
                    messages.reverse().forEach(msg => {
                        transcriptContent += `${msg.author.tag} [${new Date(msg.createdTimestamp).toLocaleString()}]: ${msg.content}\n`;
                    });

                    // إنشاء مرفق نصي (ملف .txt)
                    const attachment = new AttachmentBuilder(Buffer.from(transcriptContent), { name: `ticket-${channel.name}-transcript.txt` });

                    await transcriptChannel.send({
                        content: `**سجل تذكرة #${channel.name}**\nأغلقت بواسطة ${member}`,
                        files: [attachment],
                        embeds: [new EmbedBuilder()
                            .setColor(EMBED_COLOR)
                            .setTitle(`🔒 تذكرة مغلقة: #${channel.name}`)
                            .addFields(
                                { name: 'المستخدم الذي أغلقها', value: `${member.user.tag} (${member.id})`, inline: true },
                                { name: 'القناة', value: `#${channel.name} (${channel.id})`, inline: true },
                                { name: 'صاحب التذكرة', value: channel.topic ? `<@${channel.topic}>` : 'غير معروف', inline: true }
                            )
                            .setTimestamp()]
                    }).catch(err => console.error('فشل إرسال سجل التذكرة (Attachment):', err));
                }

                await channel.delete('تم إغلاق التذكرة');
                await interaction.editReply({ content: 'تم إغلاق التذكرة وحذف القناة بنجاح.' });

            } catch (error) {
                console.error(`فشل إغلاق التذكرة ${channel.name}:`, error);
                await sendBotErrorLog(error, `Close Ticket Button for ${channel.name}`);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: `حدث خطأ أثناء إغلاق التذكرة: ${error.message}`, ephemeral: true });
                } else if (interaction.deferred) {
                    await interaction.editReply({ content: `حدث خطأ أثناء إغلاق التذكرة: ${error.message}` });
                }
            }
        } else if (interaction.customId === 'claim_ticket') {
            const member = interaction.member;
            const channel = interaction.channel;
            const guild = interaction.guild;

            // يتطلب صلاحية دعم أو أعلى لتولي التذكرة
            if (!member.roles.cache.has(config.support_role_id) && !member.roles.cache.has(config.admin_role_id) && !member.roles.cache.has(config.owner_role_id)) {
                return await interaction.reply({ content: 'ليس لديك صلاحية لتولي هذه التذكرة.', ephemeral: true });
            }

            try {
                // يمكنك إضافة تحقق هنا إذا كانت التذكرة قد تم توليها بالفعل (مثال: من خلال اسم القناة أو إضافة رول مؤقت)
                if (channel.name.includes('-claimed')) { // افتراض أن اسم القناة سيتغير عند التولي
                    return await interaction.reply({ content: 'هذه التذكرة متولاة بالفعل.', ephemeral: true });
                }

                // تغيير اسم القناة للإشارة إلى أنها متولاة ولمن
                const oldName = channel.name;
                // التأكد من أن الاسم الجديد لا يتجاوز 100 حرف
                const newName = `${oldName.slice(0, 90)}-claimed-by-${member.user.username.toLowerCase().slice(0, 8)}`;
                await channel.setName(newName.slice(0, 99), `تم تولي التذكرة بواسطة ${member.user.tag}`);

                // يمكن إرسال رسالة في القناة لإعلام صاحب التذكرة بأن عضواً تولاها
                await channel.send({ content: `${member} لقد تم تولي التذكره من قبل ` });
                await interaction.reply({ content: `لقد توليت هذه التذكرة.`, ephemeral: true });

                const logChannel = guild.channels.cache.get(config.log_channel_id);
                if (logChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle('🤝 تذكرة متولاة')
                        .setDescription(`**التذكرة:** ${channel} (من \`#${oldName}\` إلى \`#${newName.slice(0, 99)}\`)\n**بواسطة:** ${member.user.tag} (${member.id})`)
                        .setTimestamp();
                    await logChannel.send({ embeds: [embed] }).catch(err => console.error('فشل إرسال سجل تولي التذكرة:', err));
                }

            } catch (error) {
                console.error(`فشل تولي التذكرة ${channel.name}:`, error);
                await sendBotErrorLog(error, `Claim Ticket Button for ${channel.name}`);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: `حدث خطأ أثناء تولي التذكرة: ${error.message}`, ephemeral: true });
                } else if (interaction.deferred) {
                    await interaction.editReply({ content: `حدث خطأ أثناء تولي التذكرة: ${error.message}` });
                }
            }
        }
    }
});
const OWNER_ID = '1205922803111698442';
const OWNER_MENTION = `<@${OWNER_ID}>`;
const INSTAGRAM = '@quranz_cv';

// الأذكار والحالات الدينية
const islamicActivities = [
    { name: 'لا إله إلا الله', type: ActivityType.Playing },
    { name: 'أستغفر الله العظيم', type: ActivityType.Listening },
    { name: 'اللهم صل على محمد', type: ActivityType.Watching },
    { name: 'قراءة القرآن الكريم', type: ActivityType.Playing },
    { name: ' انستقرام مصمم البوت' + INSTAGRAM, type: ActivityType.Watching },
    { name: 'سبحان الله وبحمده', type: ActivityType.Listening },
    { name: 'اذكروا الله تعالى', type: ActivityType.Watching }
];

// أوامر نصية بدون بادئة
const textCommands = {
    'السلام عليكم': 'وعليكم السلام ورحمة الله وبركاته منور حب ❤️',
    'سلام عليكم': 'وعليكم السلام ورحمة الله وبركاته منور حب ❤️',
    'بوت': `أنا بوت صمم خصيصاً لخدمتكم، صاحب البوت: ${OWNER_MENTION}`,
    'المطور': `مطوري العزيز هو: ${OWNER_MENTION}`,
    'الانستا': `انستجرام المطور: ${INSTAGRAM}`,
    'اذكار': 'أذكار الصباح والمساء:\nسبحان الله وبحمده سبحان الله العظيم (100 مرة)\nأستغفر الله (100 مرة)\nلا إله إلا الله وحده لا شريك له (100 مرة)'
};

client.on('ready', () => {
    console.log(`✅ ${client.user.tag} يعمل بنجاح!`);

    // تحديث حالة البوت كل 30 ثانية
    let activityIndex = 0;
    setInterval(() => {
        const activity = islamicActivities[activityIndex];
        client.user.setActivity(activity.name, { type: activity.type });
        activityIndex = (activityIndex + 1) % islamicActivities.length;
    }, 5000);

    // تعيين وصف البوت
    client.user.setPresence({
        status: 'online',
        activities: [{
            name: `صلوا على خير البرية`,
            type: ActivityType.Custom
        }]
    });
});

client.on('messageCreate', async (message) => {
    // تجاهل رسائل البوتات والرسائل الخاصة
    if (message.author.bot || !message.guild) return;

    const content = message.content.toLowerCase();

    // الرد على التحية الإسلامية
    if (content === 'السلام عليكم' || content === 'سلام عليكم') {
        await message.reply('وعليكم السلام ورحمة الله وبركاته منور حب ❤️');
        return;
    }

    // معالجة الأوامر النصية بدون بادئة
    for (const [cmd, response] of Object.entries(textCommands)) {
        if (content === cmd.toLowerCase()) {
            await message.reply(response);
            return;
        }
    }

    // أوامر إضافية
    if (content.includes('بوت')) {
        await message.reply(`أنا هنا لخدمتك! صاحب البوت: ${OWNER_MENTION}`);
    }
});



// إنشاء العميل مع الصلاحيات المطلوبة

    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]


// بيانات الرتب (يمكن استيرادها من ملف JSON إذا أردت)
const rolesData = {
    "ادم": "Administrator",
    "مش": "Moderator",
    "عض": "Member",
    "فاي": "VIP",
    "بوت": "BOT"
};

// قائمة بالبوتات الضارة (يمكن استيرادها من ملف JSON)
const dangerousBots = [
    "123456789012345678", // مثال لمعرف بوت ضار
    "987654321098765432"  // مثال آخر
];

// دالة مساعدة للعثور على الرتبة
function findRole(partial) {
    const lowerPartial = partial.toLowerCase();
    for (const [key, value] of Object.entries(rolesData)) {
        if (key.startsWith(lowerPartial)) {
            return value;
        }
    }
    return null;
}

// دالة مساعدة للحصول على رتبة العضو
function getRoleFromPartial(roles) {
    for (const role of roles.values()) {
        for (const [key, value] of Object.entries(rolesData)) {
            if (role.name === value) {
                return value;
            }
        }
    }
    return null;
}

client.on('ready', () => {
    console.log(`Bot logged in as ${client.user.tag}`);
});

    
client.on('guildMemberAdd', async (member) => {
    if (member.user.bot) {
        // نظام حماية السيرفر من البوتات الضارة
        if (dangerousBots.includes(member.id)) {
            // إذا كان البوت ضارًا
            try {
                await member.ban({ reason: 'بوت ضار' });
                const logChannel = member.guild.channels.cache.get('ID_قناة_اللوغات');
                if (logChannel) {
                    await logChannel.send(
                        `🚨 تم حظر البوت الضار ${member.user.tag} (${member.id})`
                    );
                }
            } catch (error) {
                console.error('Error banning bot:', error);
            }
        } else {
            // إذا كان البوت آمنًا
            const adminRole = member.guild.roles.cache.find(r => r.name === 'Administrator');
            if (adminRole) {
                try {
                    await member.roles.add(adminRole);
                    const logChannel = member.guild.channels.cache.get('ID_قناة_اللوغات');
                    if (logChannel) {
                        await logChannel.send(
                            `✅ تم منح البوت الآمن ${member.user.tag} (${member.id}) صلاحية Administrator`
                        );
                    }
                } catch (error) {
                    console.error('Error assigning admin role:', error);
                }
            }
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    
    if (interaction.commandName === 'mod') {
        await moderation.execute(interaction);
        
        // تسجيل الإجراء في سجلات السيرفر
        const subcommand = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'لم يتم تحديد سبب';
        
        await logs.logAction(
            interaction.guild,
            subcommand,
            user,
            interaction.user,
            reason
        );
    });


