const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.antigravity', 'telegram_bridge.json');
const DAEMON_SCRIPT = path.join(os.homedir(), '.antigravity', 'tg_system_daemon.py');

// ---------------------------------------------------------------------------
// Configuration Helpers
// ---------------------------------------------------------------------------
function getConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        }
    } catch (e) { }
    return {};
}

function saveConfig(config) {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function shellEscapeSingleQuote(s) {
    return String(s).replace(/'/g, `'\\\\''`);
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
// Platform-Aware Service Management
// ---------------------------------------------------------------------------

/**
 * Returns the platform's service management approach.
 * - linux:   systemctl --user (systemd)
 * - darwin:  launchctl (user agent plist)
 * - windows: direct python process management
 */
const SERVICE_NAME = 'antigravity-telegram-bridge';
const PLIST_LABEL = 'com.antigravity.telegram-bridge';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

function getPythonCmd() {
    // Prefer python3, fall back to python
    if (os.platform() === 'win32') return 'python';
    return 'python3';
}

async function isServiceActive() {
    const plat = os.platform();
    if (plat === 'linux') {
        const res = await execP(`systemctl --user is-active ${SERVICE_NAME}.service`);
        return res.ok && res.stdout === 'active';
    } else if (plat === 'darwin') {
        const res = await execP(`launchctl list 2>/dev/null | grep ${PLIST_LABEL}`);
        return res.ok && res.stdout.length > 0;
    } else {
        // Windows: check for running python process with daemon script
        const res = await execP('tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH');
        return res.ok && res.stdout.toLowerCase().includes('python');
    }
}

async function startService(output) {
    const plat = os.platform();
    if (plat === 'linux') {
        return await execP(`systemctl --user restart ${SERVICE_NAME}.service`);
    } else if (plat === 'darwin') {
        // Create LaunchAgent plist if it doesn't exist
        ensureMacOSPlist();
        // Unload first (ignore errors if not loaded)
        await execP(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
        return await execP(`launchctl load -w "${PLIST_PATH}"`);
    } else {
        // Windows: start pythonw in background
        const scriptPath = DAEMON_SCRIPT.replace(/\\/g, '\\\\');
        return await execP(`start /B pythonw "${scriptPath}"`);
    }
}

async function stopService(output) {
    const plat = os.platform();
    if (plat === 'linux') {
        return await execP(`systemctl --user stop ${SERVICE_NAME}.service`);
    } else if (plat === 'darwin') {
        return await execP(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    } else {
        return await execP('taskkill /F /FI "WINDOWTITLE eq Remote Control Daemon*" /IM python.exe');
    }
}

async function getServiceStatus(output) {
    const plat = os.platform();
    if (plat === 'linux') {
        return await execP(`systemctl --user status ${SERVICE_NAME}.service`);
    } else if (plat === 'darwin') {
        return await execP(`launchctl list ${PLIST_LABEL} 2>&1`);
    } else {
        return await execP('tasklist /FI "IMAGENAME eq python.exe" /FO TABLE /NH');
    }
}

function ensureMacOSPlist() {
    if (os.platform() !== 'darwin') return;
    const pythonPath = getPythonCmd();
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${pythonPath}</string>
        <string>${DAEMON_SCRIPT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(os.homedir(), '.antigravity', 'daemon.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(os.homedir(), '.antigravity', 'daemon.err')}</string>
</dict>
</plist>`;

    const dir = path.dirname(PLIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PLIST_PATH, plistContent, 'utf-8');
}

// ---------------------------------------------------------------------------
// Telegram Push Notification (from extension to user)
// ---------------------------------------------------------------------------
async function notifyTelegram(text, output) {
    const pushScript = path.join(os.homedir(), '.antigravity', 'tg_push.py');
    if (!fs.existsSync(pushScript)) {
        output.appendLine('Telegram notification skipped: tg_push.py not found.');
        return;
    }
    const cmd = `${getPythonCmd()} "${pushScript}" '${shellEscapeSingleQuote(text)}'`;
    const res = await execP(cmd);
    if (!res.ok) {
        output.appendLine(`Telegram notification failed: ${res.stderr || res.stdout || 'unknown error'}`);
    }
}

// ---------------------------------------------------------------------------
// Webview Provider (Sidebar UI)
// ---------------------------------------------------------------------------
class TelegramBridgeProvider {
    constructor(extensionUri, output) {
        this._extensionUri = extensionUri;
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
                    await vscode.commands.executeCommand('telegram-bridge.toggleDaemon');
                    setTimeout(() => this.updateStatus(), 1500);
                    break;
                case 'status': vscode.commands.executeCommand('telegram-bridge.status'); break;
                case 'installDeps': vscode.commands.executeCommand('telegram-bridge.installDeps'); break;
                case 'checkSystem': vscode.commands.executeCommand('telegram-bridge.checkSystem'); break;
                case 'refreshStatus': this.updateStatus(); break;
            }
        });

        // Initial status check + periodic polling
        this.updateStatus();
        setInterval(() => this.updateStatus(), 5000);
    }

    async updateStatus() {
        if (!this._view) return;
        const active = await isServiceActive();
        this._view.webview.postMessage({ type: 'statusUpdate', active });
    }

    getHtml() {
        const plat = os.platform();
        const platformLabel = plat === 'darwin' ? 'macOS' : plat === 'win32' ? 'Windows' : 'Linux';
        const showLinuxTools = plat === 'linux';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
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
            margin-bottom: 12px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
            padding-bottom: 4px;
        }
        .section { margin-bottom: 20px; }
        .btn {
            display: block; width: 100%; padding: 8px 12px; margin-bottom: 6px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-secondaryBackground);
            border-radius: var(--border-radius); 
            cursor: pointer; text-align: center;
            font-size: 12px;
            transition: opacity 0.15s;
        }
        .btn:hover { opacity: 0.85; }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-background);
        }
        .btn-toggle {
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            padding: 10px 12px;
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
            margin-bottom: 8px;
        }
        .badge {
            display: inline-block;
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            margin-bottom: 12px;
        }
        hr { border: 0; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); margin: 16px 0; }
    </style>
</head>
<body>
    <div class="badge">${platformLabel}</div>

    <div class="section">
        <h2>Service Control</h2>
        <button id="toggleBtn" class="btn btn-toggle btn-start" onclick="post('toggle')">Start Service</button>
        <button class="btn" onclick="post('status')">Show Service Logs</button>
    </div>

    <div class="section">
        <h2>Authentication</h2>
        <div class="description">Telegram Bot API credentials.</div>
        <button class="btn btn-primary" onclick="post('setToken')">Set Bot Token</button>
        <button class="btn btn-primary" onclick="post('setChat')">Set Chat ID</button>
    </div>

    <div class="section">
        <h2>Agent Integration</h2>
        <div class="description">Copy this instruction into Agent Customization to enable proactive notifications.</div>
        <button class="btn" onclick="copyInstruction()">Copy Instruction Text</button>
    </div>

    ${showLinuxTools ? `
    <hr>
    <div class="section">
        <h2>Linux Tools</h2>
        <button class="btn" onclick="post('installDeps')">Install Dependencies</button>
        <button class="btn" onclick="post('checkSystem')">Run System Diagnosis</button>
    </div>
    ` : ''}

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

        post('refreshStatus');
    </script>
</body>
</html>`;
    }
}

// ---------------------------------------------------------------------------
// Extension Activation
// ---------------------------------------------------------------------------
function activate(context) {
    let output = vscode.window.createOutputChannel("Telegram Bridge");
    output.appendLine("Antigravity Remote Control extension active.");

    try {
        const agDir = path.join(os.homedir(), '.antigravity');
        if (!fs.existsSync(agDir)) fs.mkdirSync(agDir, { recursive: true });

        const bundledDaemon = path.join(context.extensionPath, 'daemon', 'tg_system_daemon.py');
        const destructDaemon = path.join(agDir, 'tg_system_daemon.py');
        if (fs.existsSync(bundledDaemon)) fs.copyFileSync(bundledDaemon, destructDaemon);

        const bundledPush = path.join(context.extensionPath, 'daemon', 'tg_push.py');
        const destructPush = path.join(agDir, 'tg_push.py');
        if (fs.existsSync(bundledPush)) fs.copyFileSync(bundledPush, destructPush);

        output.appendLine("Bundled Python daemon scripts synced.");
    } catch (err) {
        output.appendLine("Failed to sync bundled python scripts: " + err.message);
    }

    const provider = new TelegramBridgeProvider(context.extensionUri, output);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('telegramBridgeStatus', provider));

    // --- Set Bot Token ---
    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.setBotToken', async () => {
        const token = await vscode.window.showInputBox({ prompt: 'Enter your Telegram Bot Token:', ignoreFocusOut: true });
        if (token) {
            let config = getConfig(); config.bot_token = token; saveConfig(config);
            vscode.window.showInformationMessage('Bot Token saved.');
        }
    }));

    // --- Set Chat ID ---
    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.setChatId', async () => {
        const chatId = await vscode.window.showInputBox({ prompt: 'Enter your Telegram Chat ID:', ignoreFocusOut: true });
        if (chatId) {
            let config = getConfig(); config.chat_id = chatId; saveConfig(config);
            vscode.window.showInformationMessage('Chat ID saved.');
        }
    }));

    // --- Restart Daemon ---
    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.restartDaemon', async () => {
        const res = await startService(output);
        if (res.ok) {
            vscode.window.showInformationMessage('Background service started.');
            output.appendLine("Service started.");
            await notifyTelegram('Bridge service started.', output);
        } else {
            vscode.window.showErrorMessage('Failed to start daemon: ' + (res.stderr || res.error?.message || 'unknown'));
            output.appendLine("Start failed: " + (res.stderr || ''));
        }
        provider.updateStatus();
    }));

    // --- Stop Daemon ---
    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.stopDaemon', async () => {
        const res = await stopService(output);
        if (res.ok) {
            vscode.window.showInformationMessage('Background service stopped.');
            output.appendLine("Service stopped.");
            await notifyTelegram('Bridge service stopped.', output);
        } else {
            vscode.window.showErrorMessage('Failed to stop daemon: ' + (res.stderr || res.error?.message || 'unknown'));
        }
        provider.updateStatus();
    }));

    // --- Toggle Daemon ---
    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.toggleDaemon', async () => {
        const active = await isServiceActive();
        if (active) {
            await vscode.commands.executeCommand('telegram-bridge.stopDaemon');
        } else {
            await vscode.commands.executeCommand('telegram-bridge.restartDaemon');
        }
    }));

    // --- Show Status ---
    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.status', async () => {
        const res = await getServiceStatus(output);
        output.appendLine("\n------------------- Service Status -------------------");
        output.appendLine(res.stdout || res.stderr || "No output or service not found.");
        output.show(true);
    }));

    // --- Install Linux Dependencies ---
    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.installDeps', () => {
        if (os.platform() !== 'linux') {
            vscode.window.showInformationMessage('Dependency installer is for Linux only. macOS and Windows use native tools.');
            return;
        }
        vscode.window.showInformationMessage('Installing Linux dependencies (requires sudo)...');
        const terminal = vscode.window.createTerminal("Bridge Installer");
        terminal.show();
        terminal.sendText(
            [
                'set -e',
                'sudo apt-get update',
                'sudo apt-get install -y ydotool xdotool gnome-screenshot',
                // Try to install ydotoold separately (some distros package it separately)
                'sudo apt-get install -y ydotoold 2>/dev/null || true',
                'YDOTOOLD_BIN="$(command -v ydotoold || true)"',
                'if [ -n "$YDOTOOLD_BIN" ]; then',
                "  printf '%s\\n' '[Unit]' 'Description=ydotool daemon' 'After=multi-user.target' '' '[Service]' 'Type=simple' \"ExecStart=$YDOTOOLD_BIN\" 'Restart=always' 'RestartSec=1' '' '[Install]' 'WantedBy=multi-user.target' | sudo tee /etc/systemd/system/ydotoold.service >/dev/null",
                '  sudo systemctl daemon-reload',
                '  sudo systemctl enable --now ydotoold',
                '  sudo systemctl status ydotoold --no-pager -l',
                'else',
                '  echo "WARNING: ydotoold binary not found. ydotool may be version 1.x which bundles the daemon."',
                'fi',
                'echo ""',
                'echo "Done. All dependencies installed."'
            ].join(' && ')
        );
    }));

    // --- Diagnose Linux Input Stack ---
    context.subscriptions.push(vscode.commands.registerCommand('telegram-bridge.checkSystem', async () => {
        if (os.platform() !== 'linux') {
            vscode.window.showInformationMessage('System diagnostics is for Linux only.');
            return;
        }

        output.appendLine('');
        output.appendLine('------------------- Linux Input Stack Diagnosis -------------------');

        const cmds = [
            ['ydotool', 'command -v ydotool'],
            ['ydotoold', 'command -v ydotoold'],
            ['xdotool', 'command -v xdotool'],
            ['gnome-screenshot', 'command -v gnome-screenshot'],
            ['grim (wayland)', 'command -v grim'],
            ['ydotoold-service-active', 'systemctl is-active ydotoold'],
            ['ydotoold-service-enabled', 'systemctl is-enabled ydotoold'],
        ];

        let hasError = false;
        for (const [label, cmd] of cmds) {
            const res = await execP(cmd);
            if (res.ok) {
                output.appendLine(`  OK   ${label}: ${res.stdout || 'ok'}`);
            } else {
                hasError = true;
                output.appendLine(`  FAIL ${label}: ${res.stderr || res.stdout || (res.error && res.error.message) || 'not found'}`);
            }
        }

        output.appendLine('------------------------------------------------------------------');
        output.show(true);

        if (hasError) {
            const choice = await vscode.window.showWarningMessage(
                'Some Linux input tools are missing or inactive. Run auto-fix installer?',
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
