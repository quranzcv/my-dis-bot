import { EmbedBuilder } from 'discord.js';

export default {
    async logAction(guild, action, target, moderator, reason) {
        const channel = guild.channels.cache.get('LOGS_CHANNEL_ID');
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setColor(this.getActionColor(action))
            .setTitle(`📝 ${this.getActionName(action)}`)
            .addFields(
                { name: '👤 العضو', value: target.tag, inline: true },
                { name: '🛡️ المشرف', value: moderator.tag, inline: true },
                { name: '📄 السبب', value: reason || 'لم يتم تحديد سبب' }
            )
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    },

    getActionColor(action) {
        const colors = {
            'ban': '#FF0000',
            'unban': '#00FF00',
            'kick': '#FFA500',
            'warn': '#FFFF00',
            'timeout': '#FFC0CB',
            'untimeout': '#90EE90'
        };
        return colors[action] || '#FFFFFF';
    },

    getActionName(action) {
        const names = {
            'ban': 'حظر عضو',
            'unban': 'فك حظر',
            'kick': 'طرد عضو',
            'warn': 'تحذير عضو',
            'timeout': 'تقييد عضو',
            'untimeout': 'فك التقييد'
        };
        return names[action] || 'إجراء إداري';
    }
};