import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

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
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers)) {
            return interaction.reply({ content: '⚠️ ليس لديك صلاحية استخدام هذا الأمر!', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'لم يتم تحديد سبب';

        try {
            switch (subcommand) {
                case 'ban':
                    await interaction.guild.members.ban(user, { reason });
                    await interaction.reply(`✅ تم حظر ${user.tag} (السبب: ${reason})`);
                    break;
                case 'unban':
                    await interaction.guild.members.unban(user);
                    await interaction.reply(`✅ تم فك حظر ${user.tag}`);
                    break;
                case 'kick':
                    await interaction.guild.members.kick(user, reason);
                    await interaction.reply(`✅ تم طرد ${user.tag} (السبب: ${reason})`);
                    break;
            }
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '❌ حدث خطأ أثناء تنفيذ الأمر!', ephemeral: true });
        }
    }
};