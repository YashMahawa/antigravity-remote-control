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

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'setToken': vscode.commands.executeCommand('telegram-bridge.setBotToken'); break;
                case 'setChat': vscode.commands.executeCommand('telegram-bridge.setChatId'); break;
                case 'toggle': vscode.commands.executeCommand('telegram-bridge.toggleDaemon'); break;
                case 'status': vscode.commands.executeCommand('telegram-bridge.status'); break;
                case 'installDeps': vscode.commands.executeCommand('telegram-bridge.installDeps'); break;
                case 'checkSystem': vscode.commands.executeCommand('telegram-bridge.checkSystem'); break;
            }
        });
    }

    getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
        h3 { text-align: center; margin-bottom: 12px; }
        .btn {
            display: block; width: 100%; padding: 10px; margin-bottom: 10px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; border-radius: 4px; cursor: pointer; text-align: center;
        }
        .btn:hover { background: var(--vscode-button-hoverBackground); }
        .success { background: var(--vscode-testing-iconPassed); }
        .instructions { font-size: 13px; color: var(--vscode-descriptionForeground); margin-bottom: 20px;}
        .setup-steps { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); padding: 8px; margin-bottom: 20px; border-radius: 4px; font-size: 12px;}
    </style>
</head>
<body>
    <h3>Remote Control Panel</h3>

    <div class="setup-steps">
        <b>Telegram Bot Setup:</b><br/>
        1. Chat with <b>@BotFather</b>: send <i>/newbot</i> to get your <b>API Token</b>.<br/>
        2. Chat with <b>@userinfobot</b>: get your <b>Chat ID</b>.<br/>
        3. Save both keys below!
    </div>

    <button class="btn" onclick="post('setToken')">Keys: Set Bot Token</button>
    <button class="btn" onclick="post('setChat')">Keys: Set Chat ID</button>
    
    <hr style="border:1px solid var(--vscode-widget-border); margin:15px 0;">

    <div class="instructions">
        <b>Agent Rule Setup (Antigravity and VS Code):</b><br/>
        Paste this into an Antigravity Rule or VS Code Memory entry so the agent can proactively send Telegram updates.
    </div>
    <button class="btn" onclick="copyInstruction()">Copy Agent Instruction Text</button>

    <hr style="border:1px solid var(--vscode-widget-border); margin:15px 0;">

    <button class="btn success" onclick="post('toggle')">Start or Stop Service</button>
    <button class="btn" onclick="post('status')">Check Service Status</button>

    <hr style="border:1px solid var(--vscode-widget-border); margin:15px 0;">

    <button class="btn" onclick="post('installDeps')">Install Linux Dependencies</button>
    <button class="btn" onclick="post('checkSystem')">Diagnose Linux Input Stack</button>

    <script>
        const vscode = acquireVsCodeApi();
        function post(msgType) { vscode.postMessage({ type: msgType }); }
        
        function copyInstruction() {
            const text = "If the user is away, proactively send Telegram updates by running: python3 ~/.antigravity/tg_push.py 'your message'. Use this for completion updates and critical questions.";
            navigator.clipboard.writeText(text).then(() => {
                alert('Copied. Paste this into Antigravity Rule or VS Code Memory.');
            });
        }
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
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.status', () => {
        exec('systemctl --user status antigravity-telegram-bridge.service', (err, stdout, stderr) => {
            output.appendLine("\\n------------------- Background Daemon Status -------------------");
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
