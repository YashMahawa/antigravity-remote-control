#!/usr/bin/env python3
"""Antigravity Remote Control Daemon - Cross-Platform Telegram Bridge.

Supports Linux (Wayland + X11), macOS, and Windows.
Handles keystroke injection, mouse clicks, and screenshots across all platforms.
"""

import os
import sys
import time
import json
import subprocess
import shutil
import urllib.request
import urllib.parse
import urllib.error
import tempfile
import platform

# ---------------------------------------------------------------------------
# Platform Detection
# ---------------------------------------------------------------------------
SYS_PLATFORM = platform.system().lower()  # "linux", "darwin", "windows"
IS_WAYLAND = os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
CONFIG_PATH = os.path.expanduser("~/.antigravity/telegram_bridge.json")


def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def get_bot_token():
    return load_config().get("bot_token", "")


def get_chat_id():
    return str(load_config().get("chat_id", ""))


def get_base_url():
    token = get_bot_token()
    if not token:
        return ""
    return f"https://api.telegram.org/bot{token}"


# ---------------------------------------------------------------------------
# Telegram API
# ---------------------------------------------------------------------------
def send_message(text):
    base_url = get_base_url()
    chat_id = get_chat_id()
    if not base_url or not chat_id:
        return

    url = f"{base_url}/sendMessage"
    data = urllib.parse.urlencode({'chat_id': chat_id, 'text': text}).encode('utf-8')
    req = urllib.request.Request(url, data=data)
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"Error sending msg: {e}")


def send_photo(photo_path, caption=""):
    """Send a photo via multipart/form-data using only stdlib (no curl dependency)."""
    token = get_bot_token()
    chat_id = get_chat_id()
    if not token or not chat_id:
        return

    boundary = "----AntigravityUploadBoundary"
    url = f"https://api.telegram.org/bot{token}/sendPhoto"

    with open(photo_path, "rb") as f:
        file_data = f.read()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="chat_id"\r\n\r\n'
        f"{chat_id}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="caption"\r\n\r\n'
        f"{caption}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="photo"; filename="screenshot.png"\r\n'
        f"Content-Type: image/png\r\n\r\n"
    ).encode("utf-8") + file_data + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(url, data=body)
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        urllib.request.urlopen(req, timeout=30)
    except Exception as e:
        print(f"Error sending photo: {e}")


def get_updates(offset=None):
    base_url = get_base_url()
    if not base_url:
        return None
    url = f"{base_url}/getUpdates?timeout=30"
    if offset:
        url += f"&offset={offset}"
    try:
        with urllib.request.urlopen(url, timeout=35) as response:
            return json.loads(response.read().decode())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Utility Helpers
# ---------------------------------------------------------------------------
def has_cmd(name):
    return shutil.which(name) is not None


def run_sys(cmd):
    """Run a shell command, setting DISPLAY for Linux X11 compatibility."""
    try:
        print(f"[run_sys] {cmd}", flush=True)
        env = os.environ.copy()
        if SYS_PLATFORM == "linux":
            env.setdefault("DISPLAY", ":0")
        subprocess.run(cmd, shell=True, check=True, text=True, env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as e:
        print(f"[run_sys] FAIL: {cmd} -> {e}")


def run_cmd(argv):
    """Run a command with argument list, return (ok, output_or_error)."""
    try:
        print(f"[run_cmd] {' '.join(argv)}", flush=True)
        result = subprocess.run(argv, check=True, capture_output=True, text=True)
        return True, result.stdout.strip()
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        stdout = (e.stdout or "").strip()
        return False, f"exit={e.returncode} stdout={stdout} stderr={stderr}"
    except Exception as e:
        return False, str(e)


# ---------------------------------------------------------------------------
# Screen Resolution
# ---------------------------------------------------------------------------
def get_screen_size():
    """Detect screen resolution. Falls back to 1920x1080."""
    if SYS_PLATFORM == "linux":
        try:
            output = subprocess.check_output(
                "xrandr --current 2>/dev/null | grep '*' | awk '{print $1}'",
                shell=True, text=True
            ).strip()
            res = output.split('x')
            if len(res) == 2:
                return int(res[0]), int(res[1])
        except Exception:
            pass

    elif SYS_PLATFORM == "darwin":
        try:
            output = subprocess.check_output(
                "system_profiler SPDisplaysDataType 2>/dev/null | grep Resolution",
                shell=True, text=True
            ).strip()
            # Typical: "Resolution: 2560 x 1600 Retina" or "Resolution: 1920 x 1080"
            parts = output.split()
            idx = parts.index("Resolution:") if "Resolution:" in parts else -1
            if idx >= 0:
                return int(parts[idx + 1]), int(parts[idx + 3])
        except Exception:
            pass

    elif SYS_PLATFORM == "windows":
        try:
            from ctypes import windll
            user32 = windll.user32
            return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
        except Exception:
            pass

    return 1920, 1080


def scale_coords(x_1920, y_1080):
    """Scale coordinates from 1920x1080 reference to current resolution."""
    sw, sh = get_screen_size()
    scale_x = sw / 1920.0
    scale_y = sh / 1080.0
    return int(x_1920 * scale_x), int(y_1080 * scale_y)


# ---------------------------------------------------------------------------
# Text Typing (Cross-Platform)
# ---------------------------------------------------------------------------
def type_text(text):
    """Type text into the currently focused input field."""
    if not text:
        return False, "Empty text"

    if SYS_PLATFORM == "darwin":
        # macOS: Use osascript to type via System Events
        # First clear existing field content
        run_sys('osascript -e \'tell application "System Events" to keystroke "a" using command down\'')
        run_sys('osascript -e \'tell application "System Events" to key code 51\'')  # Delete
        time.sleep(0.1)
        # Type the text using clipboard to avoid escaping issues
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        script = f'''
        set the clipboard to "{escaped}"
        tell application "System Events"
            keystroke "v" using command down
        end tell
        '''
        run_cmd(["osascript", "-e", script])
        return True, "macos-clipboard-paste"

    elif SYS_PLATFORM == "windows":
        # Windows: Use PowerShell clip + SendKeys paste
        # Clipboard method avoids all special character escaping issues
        ps_clip = f'Set-Clipboard -Value "{text.replace(chr(34), "`" + chr(34))}"'
        run_cmd(["powershell", "-c", ps_clip])
        time.sleep(0.05)
        ps_paste = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "[System.Windows.Forms.SendKeys]::SendWait('^a'); "
            "Start-Sleep -Milliseconds 50; "
            "[System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}'); "
            "Start-Sleep -Milliseconds 50; "
            "[System.Windows.Forms.SendKeys]::SendWait('^v'); "
        )
        run_cmd(["powershell", "-c", ps_paste])
        return True, "windows-clipboard-paste"

    else:
        # Linux: Clear field first
        if has_cmd("xdotool"):
            run_sys("xdotool key ctrl+a BackSpace")
            time.sleep(0.1)

        # On Wayland, prefer ydotool for typing
        if IS_WAYLAND and has_cmd("ydotool"):
            ok, out = run_cmd(["sudo", "-n", "ydotool", "type", "--key-delay", "6", text])
            if ok:
                return True, "linux-ydotool"

        # Fallback to xdotool (works on X11 and some Wayland with XWayland)
        if has_cmd("xdotool"):
            # Use xdotool type with --clearmodifiers for reliability
            safe_text = text.replace("'", "'\\''")
            run_sys(f"xdotool type --clearmodifiers --delay 10 '{safe_text}'")
            return True, "linux-xdotool"

    return False, "No typing backend found"


# ---------------------------------------------------------------------------
# Mouse Clicking (Cross-Platform)
# ---------------------------------------------------------------------------
def click_coords(x, y):
    """Click at screen coordinates (x, y)."""
    if SYS_PLATFORM == "darwin":
        # macOS: Use AppleScript with System Events "click at" or cliclick
        if has_cmd("cliclick"):
            run_sys(f"cliclick c:{x},{y}")
            return True, "macos-cliclick"
        else:
            # Pure AppleScript fallback using Python CGEvent
            script = f'''
            do shell script "python3 -c \\"
import Quartz
point = Quartz.CGPointMake({x}, {y})
mouseDown = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, point, Quartz.kCGMouseButtonLeft)
mouseUp = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, point, Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, mouseDown)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, mouseUp)
\\""
            '''
            ok, out = run_cmd(["osascript", "-e", script])
            if ok:
                return True, "macos-quartz-cgevent"
            # Final fallback: try with cliclick installation hint
            return False, "macOS mouse click requires 'brew install cliclick' or Accessibility permissions for Quartz"

    elif SYS_PLATFORM == "windows":
        ps = f"""
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int buttons, int extraInfo);' -Name NativeMethods -Namespace Win32
        [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point({x}, {y})
        Start-Sleep -Milliseconds 30
        [Win32.NativeMethods]::mouse_event(2, 0, 0, 0, 0)
        [Win32.NativeMethods]::mouse_event(4, 0, 0, 0, 0)
        """
        ok, out = run_cmd(["powershell", "-c", ps])
        if ok:
            return True, "windows-mouse_event"
        return False, f"Windows click failed: {out}"

    else:
        # Linux
        if IS_WAYLAND and has_cmd("ydotool"):
            prefix = ["sudo", "-n", "ydotool"]
            # Move to absolute 0,0 first, then to target
            run_cmd(prefix + ["mousemove", "--absolute", "--", "-10000", "-10000"])
            time.sleep(0.06)
            run_cmd(prefix + ["mousemove", "--", str(x), str(y)])
            time.sleep(0.04)
            run_cmd(prefix + ["click", "1"])
            return True, "linux-ydotool"

        if has_cmd("xdotool"):
            run_sys(f"xdotool mousemove {x} {y} click 1")
            return True, "linux-xdotool"

    return False, "No clicking backend found"


# ---------------------------------------------------------------------------
# Stop / Escape (Cross-Platform)
# ---------------------------------------------------------------------------
def click_stop():
    """Send Escape + Ctrl+C to interrupt the current operation."""
    if SYS_PLATFORM == "darwin":
        run_sys('osascript -e \'tell application "System Events" to key code 53\'')  # Escape
        time.sleep(0.05)
        run_sys('osascript -e \'tell application "System Events" to keystroke "c" using control down\'')
    elif SYS_PLATFORM == "windows":
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "[System.Windows.Forms.SendKeys]::SendWait('{ESC}'); "
            "Start-Sleep -Milliseconds 50; "
            "[System.Windows.Forms.SendKeys]::SendWait('^c')"
        )
        run_cmd(["powershell", "-c", ps])
    else:
        if has_cmd("xdotool"):
            run_sys("xdotool key Escape")
            time.sleep(0.06)
            run_sys("xdotool key ctrl+c")

    return True, "stop-keys"


# ---------------------------------------------------------------------------
# Screenshot (Cross-Platform)
# ---------------------------------------------------------------------------
def capture_screenshot():
    """Capture a screenshot and send it via Telegram."""
    tmp_path = os.path.join(tempfile.gettempdir(), f"screen_{int(time.time())}.png")
    success = False

    if SYS_PLATFORM == "darwin":
        # macOS: native screencapture command (always available)
        result = subprocess.run(
            ["screencapture", "-x", tmp_path],
            capture_output=True, text=True
        )
        success = result.returncode == 0

    elif SYS_PLATFORM == "windows":
        ps = (
            f"Add-Type -AssemblyName System.Windows.Forms; "
            f"Add-Type -AssemblyName System.Drawing; "
            f"$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "
            f"$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); "
            f"$gfx = [System.Drawing.Graphics]::FromImage($bmp); "
            f"$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); "
            f"$bmp.Save('{tmp_path}', [System.Drawing.Imaging.ImageFormat]::Png); "
            f"$gfx.Dispose(); $bmp.Dispose()"
        )
        result = subprocess.run(["powershell", "-c", ps], capture_output=True, text=True)
        success = result.returncode == 0

    else:
        # Linux: Try gnome-screenshot first, then grim (Wayland), then scrot
        if has_cmd("gnome-screenshot"):
            result = subprocess.run(
                ["gnome-screenshot", "-f", tmp_path],
                capture_output=True, text=True,
                env={**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":0")}
            )
            success = result.returncode == 0
        elif IS_WAYLAND and has_cmd("grim"):
            result = subprocess.run(["grim", tmp_path], capture_output=True, text=True)
            success = result.returncode == 0
        elif has_cmd("scrot"):
            result = subprocess.run(["scrot", tmp_path], capture_output=True, text=True)
            success = result.returncode == 0

    if success and os.path.exists(tmp_path):
        send_photo(tmp_path, f"Screenshot ({SYS_PLATFORM})")
    else:
        send_message(f"Screenshot failed on {SYS_PLATFORM}. Ensure screenshot tools are available.")

    try:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Submit Enter Key (Cross-Platform)
# ---------------------------------------------------------------------------
def submit_fallback_keys():
    """Press Enter to submit the typed text."""
    if SYS_PLATFORM == "darwin":
        run_sys('osascript -e \'tell application "System Events" to key code 36\'')  # Return
        return True, "macos-enter"
    elif SYS_PLATFORM == "windows":
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"
        )
        run_cmd(["powershell", "-c", ps])
        return True, "windows-enter"
    else:
        if has_cmd("xdotool"):
            run_sys("xdotool key Return")
            return True, "linux-xdotool-enter"
        if IS_WAYLAND and has_cmd("ydotool"):
            run_cmd(["sudo", "-n", "ydotool", "key", "28:1", "28:0"])
            return True, "linux-ydotool-enter"
    return False, "No enter key backend"


# ---------------------------------------------------------------------------
# Send Button Click Logic
# ---------------------------------------------------------------------------
def click_send(is_started=True):
    """Click the chat send button (ongoing session mode)."""
    # DEFAULT MODE: Ongoing Session (Chat input at bottom)
    # Reference: 940x488 focus, 940x510 send on 1920x1080
    fx, fy = scale_coords(940, 488)
    cx, cy = scale_coords(940, 510)

    # LEGACY: New Chat Mode (middle input)
    # if not is_started:
    #     fx, fy = scale_coords(940, 245)
    #     cx, cy = scale_coords(940, 257)

    # Perform Focus Click
    click_coords(fx, fy)
    time.sleep(0.12)
    return cx, cy


# ---------------------------------------------------------------------------
# Reserved command words (case-insensitive, must match exactly)
# ---------------------------------------------------------------------------
COMMANDS = frozenset([
    '/stop', 'stop',
    '/screen', '/screenshot', 'screen', 'screenshot',
    '/new', '/newchat', 'new', 'newchat',
    '/status', 'status',
    '/help', 'help',
])


# ---------------------------------------------------------------------------
# Main Loop
# ---------------------------------------------------------------------------
def main():
    print("Remote Control Daemon Active.", flush=True)

    # Wait for credentials
    while not get_bot_token() or not get_chat_id():
        time.sleep(5)

    # Always assume ongoing session for reliability
    is_session_started = True
    res = get_screen_size()
    send_message(
        f"Remote Control Active\n"
        f"Platform: {SYS_PLATFORM}\n"
        f"Resolution: {res[0]}x{res[1]}\n"
        f"Please ensure a Chat Session is already started and focused in the IDE."
    )

    # Drain old updates so we don't replay history
    updates = get_updates()
    offset = None
    if updates and updates.get('ok') and updates['result']:
        offset = updates['result'][-1]['update_id'] + 1

    while True:
        updates = get_updates(offset)
        if updates and updates.get('ok') and updates['result']:
            for item in updates['result']:
                offset = item['update_id'] + 1
                msg = item.get('message', {})
                text_raw = msg.get('text', '')
                text = text_raw.lower().strip()
                chat_id_str = str(msg.get('chat', {}).get('id'))

                if chat_id_str != get_chat_id() or not text:
                    continue

                # --- Commands ---
                if text in ('/stop', 'stop'):
                    click_stop()
                    send_message("[STOP] Operation interrupted.")

                elif text in ('/screen', '/screenshot', 'screen', 'screenshot'):
                    capture_screenshot()

                elif text in ('/new', '/newchat', 'new', 'newchat'):
                    is_session_started = False
                    send_message("[MODE] Reset to New Chat.")

                elif text in ('/status', 'status'):
                    send_message(
                        f"[STATUS] Running\n"
                        f"Platform: {SYS_PLATFORM}\n"
                        f"Session: {'Ongoing' if is_session_started else 'New'}\n"
                        f"Resolution: {get_screen_size()}"
                    )

                elif text in ('/help', 'help'):
                    send_message(
                        "Commands:\n"
                        "stop - Interrupt current operation\n"
                        "screen - Take a screenshot\n"
                        "status - Show daemon status\n"
                        "new - Reset to new chat mode\n"
                        "help - Show this message\n"
                        "Anything else is sent as a prompt."
                    )

                else:
                    # --- Direct Chat Prompt ---
                    # Strip /chat prefix if used
                    prompt = text_raw[6:].strip() if text.startswith('/chat ') else text_raw.strip()

                    if not prompt:
                        send_message("[SKIP] Empty prompt ignored.")
                        continue

                    # 1. Focus & get send button coordinates
                    target_cx, target_cy = click_send(is_session_started)
                    time.sleep(0.1)

                    # 2. Type text
                    ok, backend = type_text(prompt)
                    if not ok:
                        send_message(f"[ERROR] Keyboard failure: {backend}")
                        continue

                    time.sleep(0.15)

                    # 3. Click Send button
                    click_ok, click_be = click_coords(target_cx, target_cy)
                    if click_ok:
                        st = "Ongoing" if is_session_started else "New"
                        send_message(f"[SENT] ({st}) via {click_be}")
                    else:
                        # Fallback: press Enter key
                        submit_fallback_keys()
                        send_message("[SENT] via Enter key fallback")

                    is_session_started = True
        time.sleep(1)


if __name__ == "__main__":
    main()
