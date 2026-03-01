const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Config - Reading from Antigravity settings
const settingsPath = path.join(os.homedir(), '.config', 'Antigravity', 'User', 'settings.json');
let botToken = "";
let chatId = "";

try {
    if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        botToken = settings['antigravityTelegram.botToken'] || botToken;
        chatId = settings['antigravityTelegram.chatId'] || chatId;
    }
} catch (e) {
    console.error("Error reading settings:", e);
}

const bot = new TelegramBot(botToken, { polling: true });
const BRIDGE_FILE = path.join(os.homedir(), '.antigravity', 'telegram_bridge.json');

console.log("Standalone Telegram Bot started...");

bot.on('message', async (msg) => {
    const text = msg.text;
    const fromChatId = msg.chat.id;

    if (chatId && fromChatId.toString() !== chatId.toString()) {
        console.log(`Unauthorized access: ${fromChatId}`);
        return;
    }

    if (!text) return;

    if (text === '/screen') {
        takeScreenshot(fromChatId, false);
    } else if (text === '/screenshot') {
        takeScreenshot(fromChatId, true);
    } else if (text === '/status') {
        bot.sendMessage(fromChatId, "✅ Standalone service is active.");
    } else if (!text.startsWith('/')) {
        // Forward prompt to Antigravity via bridge file
        try {
            const payload = {
                prompt: text,
                timestamp: Date.now()
            };
            fs.writeFileSync(BRIDGE_FILE, JSON.stringify(payload));
            bot.sendMessage(fromChatId, "⏳ Prompt forwarded to Antigravity...");
        } catch (err) {
            bot.sendMessage(fromChatId, "❌ Error forwarding prompt: " + err.message);
        }
    }
});

function takeScreenshot(targetId, windowOnly = false) {
    const tmpPath = path.join(os.tmpdir(), `screen_${Date.now()}.png`);
    const cmd = windowOnly ? `gnome-screenshot -w -f "${tmpPath}"` : `gnome-screenshot -f "${tmpPath}"`;

    bot.sendMessage(targetId, windowOnly ? "📸 Capturing active window..." : "🖥️ Capturing full screen...");

    exec(cmd, async (error) => {
        if (error) {
            bot.sendMessage(targetId, "❌ Screenshot failed. Is gnome-screenshot installed?");
            return;
        }

        try {
            await bot.sendPhoto(targetId, tmpPath, { caption: windowOnly ? "🖼️ Active Window" : "💻 Full Desktop" });
            setTimeout(() => { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); }, 2000);
        } catch (err) {
            bot.sendMessage(targetId, `❌ Error sending photo: ${err.message}`);
        }
    });
}
