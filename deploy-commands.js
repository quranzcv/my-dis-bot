import { REST, Routes } from 'discord.js';

const commands = [
    {
        name: 'ping',
        description: 'رد بـ Pong!',
    },
    // أضف أوامر أخرى هنا
];

const TOKEN = 'TOKEN_الجديد_هنا'; // استبدله بتوكن البوت
const APPLICATION_ID = 'APPLICATION_ID_الجديد'; // استبدله بمعرف التطبيق

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('جاري نشر الأوامر...');
        
        await rest.put(
            Routes.applicationCommands(APPLICATION_ID),
            { body: commands },
        );

        console.log('✅ تم نشر الأوامر بنجاح!');
    } catch (error) {
        console.error('❌ حدث خطأ:', error);
    }
})();
const token = 'MTI1MDk4NjQwNjkwNjQyOTQ2MQ.GnTu5D.H6gub4DmfHXeErqX5c6U7c7z_q44pkxcBPmkD8'