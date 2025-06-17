import { EmbedBuilder } from 'discord.js';
import Canvas from 'canvas';
import { join } from 'path';

export default {
    name: 'guildMemberAdd',
    async execute(member) {
        // 1. إنشاء صورة الترحيب
        const canvas = Canvas.createCanvas(800, 300);
        const ctx = canvas.getContext('2d');
        
        // تحميل خلفية الصورة
        const background = await Canvas.loadImage(join(process.cwd(), 'assets', 'welcome-bg.png'));
        ctx.drawImage(background, 0, 0, canvas.width, canvas.height);
        
        // إضافة نص الترحيب
        ctx.font = '35px "Arial"';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(`أهلاً بك في ${member.guild.name}!`, canvas.width / 2, canvas.height / 1.8);
        
        // إضافة اسم العضو
        ctx.font = '30px "Arial"';
        ctx.fillText(member.user.tag, canvas.width / 2, canvas.height / 1.5);
        
        // إضافة صورة العضو
        ctx.beginPath();
        ctx.arc(125, 150, 100, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        
        const avatar = await Canvas.loadImage(member.user.displayAvatarURL({ extension: 'jpg' }));
        ctx.drawImage(avatar, 25, 50, 200, 200);
        
        // 2. إرسال رسالة الترحيب
        const channel = member.guild.channels.cache.get('YOUR_WELCOME_CHANNEL_ID');
        if (!channel) return;
        
        const attachment = new AttachmentBuilder(await canvas.encode('png'), { name: 'welcome.png' });
        
        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle(`🎉 مرحباً بك ${member.user.username}!`)
            .setDescription(`
                نرحب بك في ${member.guild.name}!
                • أنت العضو رقم ${member.guild.memberCount}
                • اقرأ القوانين في <#ID_CANAL_القوانين>
                • قدم نفسك في <#ID_CANAL_التعارف>
            `)
            .setImage('attachment://welcome.png')
            .setTimestamp();
        
        await channel.send({
            content: `${member}`,
            embeds: [embed],
            files: [attachment]
        });
        
        // 3. منح رتبة تلقائية
        const role = member.guild.roles.cache.get('YOUR_DEFAULT_ROLE_ID');
        if (role) {
            await member.roles.add(role).catch(console.error);
        }
    }
};