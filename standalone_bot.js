require('dotenv').config();
const { Telegraf } = require('telegraf');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

// Config - Reading from Antigravity settings or Bridge config
const settingsPath = path.join(os.homedir(), '.config', 'Antigravity', 'User', 'settings.json');
const bridgeConfigPath = path.join(os.homedir(), '.antigravity', 'telegram_bridge.json');

let botToken = process.env.BOT_TOKEN;
let chatId = process.env.CHAT_ID;

function loadConfig() {
    try {
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            botToken = settings['antigravityTelegram.botToken'] || botToken;
            chatId = settings['antigravityTelegram.chatId'] || chatId;
        }
        if (fs.existsSync(bridgeConfigPath)) {
            const config = JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf8'));
            botToken = config.bot_token || botToken;
            chatId = config.chat_id || chatId;
        }
    } catch (e) {
        console.error("Error reading settings:", e);
    }
}

loadConfig();

if (!botToken) {
    console.error("❌ No Bot Token found! Please set it in Antigravity settings.");
    process.exit(1);
}

const bot = new Telegraf(botToken);
console.log("Antigravity Remote Control CDP Bot started...");

// --- CDP Helpers ---
const CDP_PORT = 7800;
const CDP_CALL_TIMEOUT = 5000;

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function discoverCDP() {
    try {
        const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const workbench = list.find(t => t.url?.includes('workbench.html') || (t.title && t.title.includes('workbench')));
        if (workbench?.webSocketDebuggerUrl) {
            return workbench.webSocketDebuggerUrl;
        }
        throw new Error('Workbench CDP target not found.');
    } catch (e) {
        throw new Error(`CDP discovery failed (Port ${CDP_PORT} open?): ${e.message}`);
    }
}

async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map();
    const contexts = [];

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const { resolve, reject, timeoutId } = pendingCalls.get(data.id);
                clearTimeout(timeoutId);
                pendingCalls.delete(data.id);
                if (data.error) reject(new Error(data.error.message));
                else resolve(data.result);
            }
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            }
        } catch (_) {}
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out`));
            }
        }, CDP_CALL_TIMEOUT);
        pendingCalls.set(id, { resolve, reject, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await call('Runtime.enable', {});
    await new Promise(r => setTimeout(r, 1000));
    return { ws, call, contexts };
}

async function injectMessage(cdp, text) {
    const safeText = JSON.stringify(text);
    const EXPRESSION = `(async () => {
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy" };

        const editors = [...document.querySelectorAll('#conversation [contenteditable="true"], #chat [contenteditable="true"], #cascade [contenteditable="true"]')]
            .filter(el => el.offsetParent !== null);
        const editor = editors.at(-1);
        if (!editor) return { ok:false, error:"editor_not_found" };

        const textToInsert = ${safeText};

        editor.focus();
        document.execCommand?.("selectAll", false, null);
        document.execCommand?.("delete", false, null);

        let inserted = false;
        try { inserted = !!document.execCommand?.("insertText", false, textToInsert); } catch {}
        if (!inserted) {
            editor.textContent = textToInsert;
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: textToInsert }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: textToInsert }));
        }

        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
        if (submit && !submit.disabled) {
            submit.click();
            return { ok:true, method:"click_submit" };
        }

        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
        editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter" }));
        return { ok:true, method:"enter_keypress" };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (result.result && result.result.value && result.result.value.ok !== undefined) {
                return result.result.value;
            }
        } catch (e) { }
    }
    return { ok: false, reason: "no_context" };
}

async function startNewChat(cdp) {
    const EXP = `(async () => {
        try {
            const exactBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
            if (exactBtn) {
                exactBtn.click();
                return { success: true };
            }
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            const newChatBtn = allButtons.find(btn => {
                const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
                const title = btn.getAttribute('title')?.toLowerCase() || '';
                return (ariaLabel.includes('new') || title.includes('new')) && btn.offsetParent !== null;
            });
            if (newChatBtn) {
                newChatBtn.click();
                return { success: true };
            }
            return { error: 'New chat button not found' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (result.result && result.result.value && result.result.value.success) {
                return result.result.value;
            }
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

async function stopGeneration(cdp) {
    const EXP = `(async () => {
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true };
        }
        const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
        if (stopBtn && stopBtn.offsetParent !== null) {
            stopBtn.click();
            return { success: true };
        }
        return { error: 'No active generation found to stop' };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (result.result && result.result.value && result.result.value.success) {
                return result.result.value;
            }
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

async function injectFile(cdp, filePath) {
    await cdp.call("DOM.enable", {});
    const EXP = `(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const input = inputs.find(i => i.offsetParent !== null) || inputs[0];
        if (input) {
            input.dataset.tgBotTempId = 'bot-upload-' + Date.now();
            return input.dataset.tgBotTempId;
        }
        return null;
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            const uid = res.result?.value;
            if (uid) {
                const nodeRes = await cdp.call("Runtime.evaluate", { expression: `document.querySelector('[data-tg-bot-temp-id="${uid}"]')`, contextId: ctx.id });
                if (nodeRes.result?.objectId) {
                    await cdp.call("DOM.setFileInputFiles", { files: [filePath], objectId: nodeRes.result.objectId });
                    await cdp.call("Runtime.callFunctionOn", {
                        objectId: nodeRes.result.objectId,
                        functionDeclaration: `function() {
                            this.dispatchEvent(new Event('input', { bubbles: true }));
                            this.dispatchEvent(new Event('change', { bubbles: true }));
                        }`
                    });
                    return { success: true };
                }
            }
        } catch(e) {}
    }
    return { success: false, error: 'File input element not found' };
}

async function pollForAIResponse(cdp, ctx) {
    const EXP = `(async () => {
        const cancelBtn = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        const isGenerating = cancelBtn && cancelBtn.offsetParent !== null;
        
        const articles = Array.from(document.querySelectorAll('#cascade article, #cascade [data-message-id], #conversation article, #conversation [data-message-id], #chat article, #chat [data-message-id]'));
        const lastArticle = articles.at(-1);
        const text = lastArticle ? (lastArticle.innerText || lastArticle.textContent || '') : '';
        
        return { isGenerating, count: articles.length, text };
    })()`;

    let checkCount = 0;
    let initialCount = -1;
    let baselineText = "";

    const check = async () => {
        for (const c of cdp.contexts) {
            try {
                const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: c.id, awaitPromise: true });
                if (res.result?.value) return res.result.value;
            } catch(e){}
        }
        return { isGenerating: false, count: 0, text: "" };
    };

    // Wait a sec to let UI start generating state
    await new Promise(r => setTimeout(r, 1000));
    const startState = await check();
    initialCount = startState.count;
    baselineText = startState.text;

    const interval = setInterval(async () => {
        checkCount++;
        if (checkCount > 150) { // 5 mins timeout
            clearInterval(interval);
            ctx.reply("⚠️ AI response timed out (5 mins).");
            try { cdp.ws.close(); } catch(e){}
            return;
        }

        const state = await check();
        if (!state.isGenerating) {
            clearInterval(interval);
            // Wait 500ms for final render
            await new Promise(r => setTimeout(r, 500));
            const finalState = await check();
            
            if (finalState.count > initialCount || finalState.text !== baselineText) {
                const fullText = finalState.text.trim() || 'Empty response.';
                for (let i = 0; i < fullText.length; i += 4000) {
                    await ctx.reply("🤖 " + fullText.slice(i, i + 4000));
                }
            }
            try { cdp.ws.close(); } catch(e){}
        }
    }, 2000);
}

// --- Middleware to check auth ---
bot.use((ctx, next) => {
    const fromChatId = ctx.chat?.id?.toString();
    if (chatId && fromChatId !== chatId) {
        console.log(`Unauthorized access from: ${fromChatId}`);
        return;
    }
    return next();
});

// --- Commands ---
bot.command('status', (ctx) => {
    ctx.reply("✅ Antigravity Remote Control active. CDP Engine ready.");
});

bot.command('screen', (ctx) => {
    takeScreenshot(ctx, false);
});

bot.command('screenshot', (ctx) => {
    takeScreenshot(ctx, true);
});

bot.command('new', async (ctx) => {
    try {
        const url = await discoverCDP();
        const cdp = await connectCDP(url);
        const res = await startNewChat(cdp);
        
        if (res.success) {
            ctx.reply("✅ Started new chat session.");
        } else {
            ctx.reply(`❌ Failed: ${res.error || 'Unknown error'}`);
        }
        cdp.ws.close();
    } catch (err) {
        ctx.reply(`❌ Error: ${err.message}`);
    }
});

bot.command('stop', async (ctx) => {
    try {
        const url = await discoverCDP();
        const cdp = await connectCDP(url);
        const res = await stopGeneration(cdp);
        
        if (res.success) {
            ctx.reply("⏹️ Stopped AI generation.");
        } else {
            ctx.reply(`❌ Failed: ${res.error || 'No active generation'}`);
        }
        cdp.ws.close();
    } catch (err) {
        ctx.reply(`❌ Error: ${err.message}`);
    }
});

// --- Text & File Handlers ---
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    try {
        const url = await discoverCDP();
        const cdp = await connectCDP(url);
        
        const res = await injectMessage(cdp, text);
        
        if (res.ok) {
            ctx.reply("🚀 Prompt submitted. Waiting for response...");
            pollForAIResponse(cdp, ctx);
        } else if (res.reason === "busy") {
            ctx.reply("⏳ AI is busy. Use /stop to interrupt.");
            cdp.ws.close();
        } else {
            ctx.reply(`❌ Failed: Editor not found.`);
            cdp.ws.close();
        }
    } catch (err) {
        ctx.reply(`❌ IDE Connection Error: ${err.message}`);
    }
});

bot.on(['photo', 'document'], async (ctx) => {
    try {
        let fileId;
        if (ctx.message.photo) fileId = ctx.message.photo.pop().file_id;
        else if (ctx.message.document) fileId = ctx.message.document.file_id;
        
        if (!fileId) return;

        ctx.reply("📥 Downloading...");
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const ext = path.extname(fileLink.href) || (ctx.message.photo ? '.jpg' : '');
        const tmpPath = path.join(os.tmpdir(), `tg_upload_${Date.now()}${ext}`);
        
        await downloadFile(fileLink.href, tmpPath);
        
        ctx.reply("💉 Injecting...");
        const url = await discoverCDP();
        const cdp = await connectCDP(url);
        const res = await injectFile(cdp, tmpPath);
        
        if (res.success) {
            ctx.reply("✅ File uploaded! You can send your prompt now.");
        } else {
            ctx.reply(`❌ Upload failed: ${res.error}`);
        }
        cdp.ws.close();
    } catch (err) {
        ctx.reply(`❌ Error: ${err.message}`);
    }
});

// --- Helper Functions ---
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, response => {
            if (response.statusCode !== 200) return reject(new Error('Failed download'));
            response.pipe(file);
            file.on('finish', () => file.close(() => resolve(dest)));
        }).on('error', err => fs.unlink(dest, () => reject(err)));
    });
}

function takeScreenshot(ctx, windowOnly = false) {
    const tmpPath = path.join(os.tmpdir(), `screen_${Date.now()}.png`);
    let cmd = '';

    if (os.platform() === 'win32') {
        const psCmd = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = New-Object System.Drawing.Bitmap [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0, 0, 0, 0, $b.Size); $b.Save('${tmpPath}', [System.Drawing.Imaging.ImageFormat]::Png)`;
        cmd = `powershell.exe -c "${psCmd}"`;
    } else if (os.platform() === 'darwin') {
        cmd = windowOnly ? `screencapture -x -w "${tmpPath}"` : `screencapture -x "${tmpPath}"`;
    } else {
        cmd = windowOnly ? `gnome-screenshot -w -f "${tmpPath}"` : `gnome-screenshot -f "${tmpPath}"`;
    }
    
    ctx.reply(windowOnly ? "📸 Capturing window..." : "🖥️ Capturing screen...");

    exec(cmd, async (error) => {
        if (error) {
            ctx.reply(`❌ Failed. Make sure screenshot tools are installed.`);
            return;
        }
        try {
            await ctx.replyWithPhoto({ source: tmpPath });
            setTimeout(() => { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); }, 2000);
        } catch (err) {
            ctx.reply(`❌ Error: ${err.message}`);
        }
    });
}

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
