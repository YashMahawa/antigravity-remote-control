# Antigravity Telegram Bridge 🚀

Welcome to the **Telegram Bridge**! This extension provides a robust, native, multi-platform bridge to remotely control your IDE's AI assistant securely from the Telegram App on your phone.

Originally built to conquer the intense security restrictions of **GNOME Wayland on Linux**, it now completely bypasses standard sandboxing to cleanly inject keystrokes exactly like a real physical keyboard!


## 🌟 Why this matters (The Wayland Challenge)
Modern display servers like Linux Wayland strictly prohibit applications from simulating keystrokes or moving the mouse via scripts (to prevent malware). Standard tools completely fail or trigger buggy behavior when simulating IDE shortcuts. 

**This extension solves it** by dynamically detecting your OS environment and falling back to true hardware virtualization:
- **Linux (Wayland)**: Seamlessly leverages `/dev/uinput` via `ydotool` to guarantee cross-app native clicks, paired with `xdotool` for typing. 
- **macOS**: Harnesses native Apple `osascript` application system events.
- **Windows**: Injects commands deep via native .NET `System.Windows.Forms.SendKeys` assemblies.

Now your remote background prompts will **never freeze your IDE**.

## 📱 Features:
- **Direct Real-Time Chat**: Use your phone to send prompts directly to your workstation's AI without needing IDE focus!  
  *(Note: You can simply text normal sentences, no need to prefix with `/chat`!)*
- **Force Stop**: Send `/stop` to instantly kill run-away loops and generate cycles.
- **Remote Screenshots**: Ask the bot for `/screenshot` to see what your IDE is currently looking at!
- **Control Panel integrated into the IDE**: View instructions and toggle the daemon effortlessly from your Activity Bar!

## ⚙️ Setup Instructions:
1. Click the Telegram Bridge icon in your VS Code Activity Bar.
2. Click **Set Bot Token** and provide your Bot API key from `@BotFather`.
3. Click **Set Chat ID** and provide your personal Telegram Chat ID.
4. If on Linux/Wayland, hit **Calibrate Click Targets** to set exactly where the background daemon should click.
5. Hit **Start Daemon**! Once running, you can walk away from your desk! No external dependencies needed for the Python listener!

*Dependencies Note*: On Linux, you should have `ydotoold` (for Wayland clicks), `xdotool` (for Wayland text typing), and `gnome-screenshot` (for image capturing) installed on your system.
