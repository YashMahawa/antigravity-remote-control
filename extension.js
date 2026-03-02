const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.antigravity', 'telegram_bridge.json');

function getConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        }
    } catch (e) { }
    return {};
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function shellEscapeSingleQuote(s) {
    return String(s).replace(/'/g, `'\\''`);
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

async function notifyTelegram(text, output) {
    const pushScript = path.join(os.homedir(), '.antigravity', 'tg_push.py');
    if (!fs.existsSync(pushScript)) {
        output.appendLine('Telegram notification skipped: ~/.antigravity/tg_push.py not found.');
        return;
    }
    const cmd = `python3 ${pushScript} '${shellEscapeSingleQuote(text)}'`;
    const res = await execP(cmd);
    if (!res.ok) {
        output.appendLine(`Telegram notification failed: ${res.stderr || res.stdout || 'unknown error'}`);
    }
}

class TelegramBridgeProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
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
                    await vscode.commands.executeCommand('telegram-bridge.toggleDaemon');
                    this.updateStatus();
                    break;
                case 'status': vscode.commands.executeCommand('telegram-bridge.status'); break;
                case 'installDeps': vscode.commands.executeCommand('telegram-bridge.installDeps'); break;
                case 'checkSystem': vscode.commands.executeCommand('telegram-bridge.checkSystem'); break;
                case 'refreshStatus': this.updateStatus(); break;
            }
        });

        // Initial status check
        this.updateStatus();
        // Poll status every 5 seconds
        setInterval(() => this.updateStatus(), 5000);
    }

    async updateStatus() {
        if (!this._view) return;
        const res = await execP('systemctl --user is-active antigravity-telegram-bridge.service');
        const isActive = res.ok && res.stdout === 'active';
        this._view.webview.postMessage({ type: 'statusUpdate', active: isActive });
    }

    getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --accent-color: #007acc;
            --success-color: #28a745;
            --danger-color: #d73a49;
            --border-radius: 2px;
        }
        body { 
            font-family: var(--vscode-font-family); 
            padding: 16px; 
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            line-height: 1.4;
        }
        h2 { 
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 16px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
            padding-bottom: 4px;
        }
        .section { margin-bottom: 24px; }
        .btn {
            display: block; width: 100%; padding: 8px 12px; margin-bottom: 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-secondaryBackground);
            border-radius: var(--border-radius); 
            cursor: pointer; text-align: center;
            font-size: 12px;
            transition: opacity 0.2s;
        }
        .btn:hover { opacity: 0.8; }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-background);
        }
        .btn-toggle {
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .btn-start {
            background: var(--success-color) !important;
            color: white !important;
            border-color: var(--success-color) !important;
        }
        .btn-stop {
            background: var(--danger-color) !important;
            color: white !important;
            border-color: var(--danger-color) !important;
        }
        .description { 
            font-size: 11px; 
            color: var(--vscode-descriptionForeground); 
            margin-bottom: 12px;
        }
        .card { 
            background: var(--vscode-sideBar-dropBackground); 
            border: 1px solid var(--vscode-panel-border); 
            padding: 12px; 
            margin-bottom: 20px; 
            border-radius: var(--border-radius); 
            font-size: 12px;
        }
        hr { border: 0; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); margin: 20px 0; }
        b { color: var(--vscode-foreground); }
    </style>
</head>
<body>
    <div class="section">
        <h2>Authentication</h2>
        <div class="description">Configuration for Telegram Bot connection.</div>
        <button class="btn btn-primary" onclick="post('setToken')">Set Bot Token</button>
        <button class="btn btn-primary" onclick="post('setChat')">Set Chat ID</button>
    </div>

    <div class="section">
        <h2>Agent Integration</h2>
        <div class="description">Copy this instruction into your Agent Customization settings to enable proactive notifications.</div>
        <button class="btn" onclick="copyInstruction()">Copy Instruction Text</button>
    </div>

    <div class="section">
        <h2>Service Control</h2>
        <button id="toggleBtn" class="btn btn-toggle btn-start" onclick="post('toggle')">Start Service</button>
        <button class="btn" onclick="post('status')">Show Service Logs</button>
    </div>

    <hr>

    <div class="section">
        <h2>System Maintenance</h2>
        <button class="btn" onclick="post('installDeps')">Install Dependencies</button>
        <button class="btn" onclick="post('checkSystem')">Run System Diagnosis</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function post(msgType) { vscode.postMessage({ type: msgType }); }
        
        function copyInstruction() {
            const text = "If the user is away, proactively send Telegram updates by running: python3 ~/.antigravity/tg_push.py 'your message'. Use this for completion updates and critical questions.";
            navigator.clipboard.writeText(text);
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'statusUpdate') {
                const btn = document.getElementById('toggleBtn');
                if (message.active) {
                    btn.textContent = 'Stop Service';
                    btn.className = 'btn btn-toggle btn-stop';
                } else {
                    btn.textContent = 'Start Service';
                    btn.className = 'btn btn-toggle btn-start';
                }
            }
        });

        // Request update on load
        post('refreshStatus');
    </script>
</body>
</html>`;
    }
}

function activate(context) {
    let output = vscode.window.createOutputChannel("Telegram Bridge");
    output.appendLine("Antigravity Telegram Bridge extension active.");

    const provider = new TelegramBridgeProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('telegramBridgeStatus', provider));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.setBotToken', async () => {
        const token = await vscode.window.showInputBox({ prompt: 'Enter your Telegram Bot Token:', ignoreFocusOut: true });
        if (token) {
            let config = getConfig(); config.bot_token = token; saveConfig(config);
            vscode.window.showInformationMessage('Bot Token saved.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.setChatId', async () => {
        const chatId = await vscode.window.showInputBox({ prompt: 'Enter your Telegram Chat ID:', ignoreFocusOut: true });
        if (chatId) {
            let config = getConfig(); config.chat_id = chatId; saveConfig(config);
            vscode.window.showInformationMessage('Chat ID saved.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.restartDaemon', () => {
        exec('systemctl --user restart antigravity-telegram-bridge.service', async err => {
            if (err) {
                vscode.window.showErrorMessage('Failed to start daemon: ' + err.message);
                return;
            }
            vscode.window.showInformationMessage('Background Telegram Bridge service restarted.');
            output.appendLine("Service restarted.");
            await notifyTelegram('Bridge service restarted.', output);
            provider.updateStatus();
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.stopDaemon', () => {
        exec('systemctl --user stop antigravity-telegram-bridge.service', async err => {
            if (err) {
                vscode.window.showErrorMessage('Failed to stop daemon: ' + err.message);
                return;
            }
            vscode.window.showInformationMessage('Background Telegram Bridge service stopped.');
            output.appendLine("Service stopped.");
            await notifyTelegram('Bridge service stopped.', output);
            provider.updateStatus();
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.toggleDaemon', async () => {
        const active = await execP('systemctl --user is-active antigravity-telegram-bridge.service');
        if (active.ok && active.stdout === 'active') {
            exec('systemctl --user stop antigravity-telegram-bridge.service', async err => {
                if (err) {
                    vscode.window.showErrorMessage('Failed to stop daemon: ' + err.message);
                    return;
                }
                vscode.window.showInformationMessage('Background Telegram Bridge service stopped.');
                output.appendLine("Service stopped via toggle.");
                await notifyTelegram('Bridge service stopped.', output);
                provider.updateStatus();
            });
        } else {
            exec('systemctl --user restart antigravity-telegram-bridge.service', async err => {
                if (err) {
                    vscode.window.showErrorMessage('Failed to start daemon: ' + err.message);
                    return;
                }
                vscode.window.showInformationMessage('Background Telegram Bridge service started.');
                output.appendLine("Service started via toggle.");
                await notifyTelegram('Bridge service started.', output);
                provider.updateStatus();
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.status', () => {
        exec('systemctl --user status antigravity-telegram-bridge.service', (err, stdout, stderr) => {
            output.appendLine("\n------------------- Background Daemon Status -------------------");
            output.appendLine(stdout || stderr || "No output or service not found.");
            output.show(true);
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.installDeps', () => {
        if (os.platform() !== 'linux') {
            vscode.window.showInformationMessage('Auto-install is only intended for Linux systems.');
            return;
        }
        vscode.window.showInformationMessage('Installing and repairing ydotool stack (requires sudo in terminal)...');
        const terminal = vscode.window.createTerminal("Bridge Installer");
        terminal.show();
        terminal.sendText(
            [
                'set -e',
                'sudo apt-get update',
                'sudo apt-get install -y ydotool ydotoold xdotool gnome-screenshot',
                'YDOTOOLD_BIN="$(command -v ydotoold || true)"',
                'if [ -z "$YDOTOOLD_BIN" ]; then echo "ydotoold binary not found after install"; exit 1; fi',
                "printf '%s\\n' '[Unit]' 'Description=ydotool daemon' 'After=multi-user.target' '' '[Service]' 'Type=simple' \"ExecStart=$YDOTOOLD_BIN\" 'Restart=always' 'RestartSec=1' '' '[Install]' 'WantedBy=multi-user.target' | sudo tee /etc/systemd/system/ydotoold.service >/dev/null",
                'sudo systemctl daemon-reload',
                'sudo systemctl enable --now ydotoold',
                'sudo systemctl status ydotoold --no-pager -l'
            ].join(' && ')
        );
    }));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.checkSystem', async () => {
        if (os.platform() !== 'linux') {
            vscode.window.showInformationMessage('Linux diagnostics only.');
            return;
        }

        output.appendLine('');
        output.appendLine('------------------- Linux Input Stack Diagnosis -------------------');

        const cmds = [
            ['ydotool', 'command -v ydotool'],
            ['ydotoold', 'command -v ydotoold'],
            ['xdotool', 'command -v xdotool'],
            ['gnome-screenshot', 'command -v gnome-screenshot'],
            ['ydotoold-service-active', 'systemctl is-active ydotoold'],
            ['ydotoold-service-enabled', 'systemctl is-enabled ydotoold'],
            ['ydotool-smoke', 'sudo -n ydotool key 28:1 28:0']
        ];

        let hasError = false;
        for (const [label, cmd] of cmds) {
            const res = await execP(cmd);
            if (res.ok) {
                output.appendLine(`OK ${label}: ${res.stdout || 'ok'}`);
            } else {
                hasError = true;
                output.appendLine(`FAIL ${label}: ${res.stderr || res.stdout || (res.error && res.error.message) || 'failed'}`);
            }
        }

        output.appendLine('------------------------------------------------------------------');
        output.show(true);

        if (hasError) {
            const choice = await vscode.window.showWarningMessage(
                'Linux input diagnostics found problems (often ydotoold missing/inactive). Run auto-fix installer?',
                'Run Auto-Fix',
                'Later'
            );
            if (choice === 'Run Auto-Fix') {
                vscode.commands.executeCommand('telegram-bridge.installDeps');
            }
        } else {
            vscode.window.showInformationMessage('Linux input stack looks healthy.');
        }
    }));
}

function deactivate() { }

module.exports = { activate, deactivate }
