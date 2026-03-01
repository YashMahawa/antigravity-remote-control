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
                case 'start': vscode.commands.executeCommand('telegram-bridge.restartDaemon'); break;
                case 'stop': vscode.commands.executeCommand('telegram-bridge.stopDaemon'); break;
                case 'status': vscode.commands.executeCommand('telegram-bridge.status'); break;
                case 'installDeps': vscode.commands.executeCommand('telegram-bridge.installDeps'); break;
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
        h3 { text-align: center; margin-bottom: 20px; }
        .btn {
            display: block; width: 100%; padding: 10px; margin-bottom: 10px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; border-radius: 4px; cursor: pointer; text-align: center;
        }
        .btn:hover { background: var(--vscode-button-hoverBackground); }
        .danger { background: #d32f2f; color: white; }
        .danger:hover { background: #b71c1c; }
        .success { background: var(--vscode-testing-iconPassed); }
        .instructions { font-size: 13px; color: var(--vscode-descriptionForeground); margin-bottom: 20px;}
        .setup-steps { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); padding: 8px; margin-bottom: 20px; border-radius: 4px; font-size: 12px;}
    </style>
</head>
<body>
    <h3>Remote Control Panel</h3>

    <div class="setup-steps">
        <b>📲 Telegram Bot Quick Setup:</b><br/>
        1. Chat with <b>@BotFather</b>: send <i>/newbot</i> to get your <b>API Token</b>.<br/>
        2. Chat with <b>@userinfobot</b>: get your <b>Chat ID</b>.<br/>
        3. Save both keys below!
    </div>

    <button class="btn" onclick="post('setToken')">Keys: Set Bot Token</button>
    <button class="btn" onclick="post('setChat')">Keys: Set Chat ID</button>
    
    <hr style="border:1px solid var(--vscode-widget-border); margin:15px 0;">

    <div class="instructions">
        <b>🤖 Enable Agent "Ask" Feature:</b><br/>
        Paste the following into your "Global Agent Customization" so I can proactively message you!
    </div>
    <button class="btn" style="background:#4a148c;" onclick="copyInstruction()">📋 Copy Agent Instructions</button>

    <hr style="border:1px solid var(--vscode-widget-border); margin:15px 0;">

    <button class="btn success" onclick="post('start')">▶ Start/Restart Service</button>
    <button class="btn danger" onclick="post('stop')">⏹ Stop Service</button>
    <button class="btn" onclick="post('status')">ℹ Check Status Log</button>

    <hr style="border:1px solid var(--vscode-widget-border); margin:15px 0;">

    <button class="btn" onclick="post('installDeps')">🔧 Auto-Install Linux Dependencies</button>

    <script>
        const vscode = acquireVsCodeApi();
        function post(msgType) { vscode.postMessage({ type: msgType }); }
        
        function copyInstruction() {
            const text = "System Instruction: If the user is away, you (the agent) can proactively send messages or ask questions to the user's Telegram by running: python3 /home/yash/.antigravity/tg_push.py 'your message text'. Use this to report completion or ask for input on long tasks.";
            navigator.clipboard.writeText(text).then(() => {
                alert('Copied to clipboard! Paste this into Customizations > Global Rules.');
            });
        }
    </script>
</body>
</html>`;
    }
}

function activate(context) {
    let output = vscode.window.createOutputChannel("Telegram Bridge");
    output.appendLine("🚀 Antigravity Telegram Bridge Extension active.");

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
        exec('systemctl --user restart antigravity-telegram-bridge.service', (err, stdout, stderr) => {
            if (err) vscode.window.showErrorMessage('Failed to start daemon: ' + err.message);
            else {
                vscode.window.showInformationMessage('Background Telegram Bridge Daemon Started 🚀');
                output.appendLine("✅ Daemon Started.");
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.stopDaemon', () => {
        exec('systemctl --user stop antigravity-telegram-bridge.service', (err, stdout, stderr) => {
            if (err) vscode.window.showErrorMessage('Failed to stop daemon: ' + err.message);
            else {
                vscode.window.showInformationMessage('Background Telegram Bridge Daemon Stopped 🛑');
                output.appendLine("🛑 Daemon Stopped.");
            }
        });
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
        vscode.window.showInformationMessage('Installing Linux Dependencies (Requires sudo in terminal)...');
        const terminal = vscode.window.createTerminal("Bridge Installer");
        terminal.show();
        terminal.sendText('sudo apt-get update && sudo apt-get install -y ydotool xdotool gnome-screenshot && (sudo systemctl enable --now ydotoold || (echo "Starting ydotoold manually..." && nohup sudo ydotoold > /dev/null 2>&1 &))');
    }));
}

function deactivate() { }

module.exports = { activate, deactivate }
