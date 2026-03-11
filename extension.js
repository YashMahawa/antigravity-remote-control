const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const BRIDGE_CONFIG = path.join(os.homedir(), '.antigravity', 'telegram_bridge.json');

// ---------------------------------------------------------------------------
// Configuration Helpers
// ---------------------------------------------------------------------------
function getConfig() {
    try {
        if (fs.existsSync(BRIDGE_CONFIG)) {
            return JSON.parse(fs.readFileSync(BRIDGE_CONFIG, 'utf-8'));
        }
    } catch (e) { }
    return {};
}

function saveConfig(config) {
    const dir = path.dirname(BRIDGE_CONFIG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BRIDGE_CONFIG, JSON.stringify(config, null, 2), 'utf-8');
}

function execP(cmd) {
    return new Promise(resolve => {
        exec(cmd, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim(),
                error: err
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Service Management (Node.js CDP Bot)
// ---------------------------------------------------------------------------
const SERVICE_NAME = 'antigravity-telegram-cdp';
const PLIST_LABEL = 'com.antigravity.telegram-cdp';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

async function isServiceActive() {
    const plat = os.platform();
    if (plat === 'linux') {
        const res = await execP(`systemctl --user is-active ${SERVICE_NAME}.service`);
        return res.ok && res.stdout === 'active';
    } else if (plat === 'darwin') {
        const res = await execP(`launchctl list 2>/dev/null | grep ${PLIST_LABEL}`);
        return res.ok && res.stdout && !res.stdout.startsWith('-');
    } else {
        const res = await execP('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH');
        return res.ok && res.stdout.toLowerCase().includes('node');
    }
}

async function startService(context, output) {
    const plat = os.platform();
    const botScript = path.join(context.extensionPath, 'standalone_bot.js');
    
    if (plat === 'linux') {
        const unitContent = `[Unit]
Description=Antigravity Telegram CDP Bridge
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} "${botScript}"
Restart=always
Environment=PATH=/usr/bin:/usr/local/bin
WorkingDirectory=${context.extensionPath}

[Install]
WantedBy=default.target`;
        
        const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
        const unitDir = path.dirname(unitPath);
        if (!fs.existsSync(unitDir)) fs.mkdirSync(unitDir, { recursive: true });
        fs.writeFileSync(unitPath, unitContent);
        
        await execP('systemctl --user daemon-reload');
        return await execP(`systemctl --user restart ${SERVICE_NAME}.service`);
    } else if (plat === 'darwin') {
        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${botScript}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>`;
        if (!fs.existsSync(path.dirname(PLIST_PATH))) fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
        fs.writeFileSync(PLIST_PATH, plistContent);
        await execP(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
        return await execP(`launchctl load -w "${PLIST_PATH}"`);
    } else {
        // Windows
        return await execP(`start /B node "${botScript.replace(/\\/g, '\\\\')}"`);
    }
}

async function stopService() {
    const plat = os.platform();
    if (plat === 'linux') {
        return await execP(`systemctl --user stop ${SERVICE_NAME}.service`);
    } else if (plat === 'darwin') {
        return await execP(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    } else {
        return await execP('taskkill /F /IM node.exe /FI "WINDOWTITLE eq Antigravity Remote Control CDP Bot*"');
    }
}

// ---------------------------------------------------------------------------
// Webview Provider
// ---------------------------------------------------------------------------
class TelegramBridgeProvider {
    constructor(context, output) {
        this._context = context;
        this._output = output;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'setToken': vscode.commands.executeCommand('telegram-bridge.setBotToken'); break;
                case 'setChat': vscode.commands.executeCommand('telegram-bridge.setChatId'); break;
                case 'toggle':
                    const active = await isServiceActive();
                    if (active) await stopService();
                    else await startService(this._context, this._output);
                    setTimeout(() => this.updateStatus(), 1000);
                    break;
                case 'refreshStatus': this.updateStatus(); break;
            }
        });

        this.updateStatus();
        setInterval(() => this.updateStatus(), 5000);
    }

    async updateStatus() {
        if (!this._view) return;
        const active = await isServiceActive();
        this._view.webview.postMessage({ type: 'statusUpdate', active });
    }

    getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <style>
        body { font-family: sans-serif; padding: 15px; color: var(--vscode-foreground); }
        .btn { display: block; width: 100%; padding: 10px; margin-bottom: 8px; cursor: pointer; border: none; border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .btn-stop { background: #d73a49; }
        .status { margin-bottom: 15px; font-weight: bold; }
        .active { color: #28a745; }
        .inactive { color: #d73a49; }
    </style>
</head>
<body>
    <div class="status">Service: <span id="statusText" class="inactive">Checking...</span></div>
    <button id="toggleBtn" class="btn" onclick="post('toggle')">Start Bridge</button>
    <hr>
    <button class="btn" onclick="post('setToken')">Set Bot Token</button>
    <button class="btn" onclick="post('setChat')">Set Chat ID</button>
    
    <script>
        const vscode = acquireVsCodeApi();
        function post(type) { vscode.postMessage({ type }); }
        window.addEventListener('message', event => {
            const { type, active } = event.data;
            if (type === 'statusUpdate') {
                const text = document.getElementById('statusText');
                const btn = document.getElementById('toggleBtn');
                text.textContent = active ? 'RUNNING' : 'STOPPED';
                text.className = active ? 'active' : 'inactive';
                btn.textContent = active ? 'Stop Bridge' : 'Start Bridge';
                btn.className = active ? 'btn btn-stop' : 'btn';
            }
        });
    </script>
</body>
</html>`;
    }
}

function activate(context) {
    let output = vscode.window.createOutputChannel("Telegram Bridge CDP");
    output.appendLine("Antigravity Remote Control v0.2.5 (CDP) Activated.");

    const provider = new TelegramBridgeProvider(context, output);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('telegramBridgeStatus', provider));

    context.subscriptions.push(
        vscode.commands.registerCommand('telegram-bridge.setBotToken', async () => {
            const token = await vscode.window.showInputBox({ prompt: 'Telegram Bot Token', password: true });
            if (token) {
                let config = getConfig(); config.bot_token = token; saveConfig(config);
                await vscode.workspace.getConfiguration('antigravityTelegram').update('botToken', token, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('Token updated.');
            }
        }),
        vscode.commands.registerCommand('telegram-bridge.setChatId', async () => {
            const chatId = await vscode.window.showInputBox({ prompt: 'Your Telegram Chat ID' });
            if (chatId) {
                let config = getConfig(); config.chat_id = chatId; saveConfig(config);
                await vscode.workspace.getConfiguration('antigravityTelegram').update('chatId', chatId, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('Chat ID updated.');
            }
        })
    );
}

exports.activate = activate;
exports.deactivate = () => {};

