import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// افتح اتصال قاعدة البيانات
const db = await open({
    filename: './database.db',
    driver: sqlite3.Database
});

// إنشاء الجداول إذا لم تكن موجودة
await db.exec(`
    CREATE TABLE IF NOT EXISTS mod_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        moderator_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`);

export default {
    async addModLog(userId, action, reason, moderatorId) {
        await db.run(
            'INSERT INTO mod_logs (user_id, action, reason, moderator_id) VALUES (?, ?, ?, ?)',
            userId, action, reason, moderatorId
        );
    },

    async removeModLog(userId, action) {
        await db.run(
            'DELETE FROM mod_logs WHERE user_id = ? AND action = ?',
            userId, action
        );
    },

    async getWarnCount(userId) {
        const result = await db.get(
            'SELECT COUNT(*) as count FROM mod_logs WHERE user_id = ? AND action = "warn"',
            userId
        );
        return result.count;
    },

    async getModLogs(userId) {
        return await db.all(
            'SELECT * FROM mod_logs WHERE user_id = ? ORDER BY created_at DESC',
            userId
        );
    }
};