import { EmbedBuilder } from 'discord.js';

export default {
    async logAction(guild, action, target, moderator, reason) {
        const channel = guild.channels.cache.get('YOUR_LOG_CHANNEL_ID');
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setTitle(`إجراء إداري: ${action}`)
            .setColor('#ff0000')
            .addFields(
                { name: 'العضو', value: target.toString(), inline: true },
                { name: 'المشرف', value: moderator.toString(), inline: true },
                { name: 'السبب', value: reason || 'لا يوجد سبب' }
            );
        
        await channel.send({ embeds: [embed] });
    }
};