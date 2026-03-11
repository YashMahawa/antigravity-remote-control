# Antigravity Remote Control (v0.2.5)

**Telegram-to-IDE Bridge with Native CDP Integration**

Antigravity Remote Control allows you to control your IDE's AI assistant directly from your smartphone via Telegram. Unlike older versions that relied on brittle UI automation and coordinate-based clicking, **v0.2.5** uses the **Chrome DevTools Protocol (CDP)** to interact natively with the IDE's internal state.

---

## 🚀 Key Features

### 1. Native Chat Interaction
Messages sent from your phone are injected directly into the Antigravity chat engine. This works regardless of whether the window is focused or what OS you are running.

### 2. Full Two-Way Sync
The bot doesn't just send prompts anymore—it **listens** for the AI's response. Once the AI finishes generating, the complete response is forwarded back to your Telegram chat (with automatic chunking for long messages).

### 3. Image & File Upload
Send a photo or document from your phone to the bot, and it will be automatically uploaded into the IDE's context. Perfect for taking a photo of a whiteboard or a physical screen and asking the AI to "analyze this code."

### 4. System Commands
- `/status`: Check if the bridge and CDP connection are healthy.
- `/new`: Reset and start a fresh chat session.
- `/stop`: Instantly interrupt a running generation.
- `/screen`: Get a real-time screenshot of your workstation.

---

## 🛠️ Requirements & Setup

1. **Antigravity IDE**: Must be running.
2. **Remote Debugging**: Launch Antigravity with the `--remote-debugging-port=7800` flag.
3. **Configuration**:
   - Open the **Remote Control** panel in the Activity Bar.
   - Set your **Bot Token** (from [@BotFather](https://t.me/botfather)).
   - Set your **Chat ID** (ensure only you can control your IDE).
4. **Start Service**: Click **Start Bridge** in the sidebar.

---

## 💻 Tech Stack (v0.2.5)
- **Backend**: Node.js Standalone Service.
- **Library**: `telegraf` (Modern, secure Telegram framework).
- **Communication**: Chrome DevTools Protocol (CDP) via WebSockets.
- **Vulnerabilities**: 0 (Audited and replaced deprecated dependencies).

## 🌍 Platform Support
- **Linux**: Fully compatible with Wayland and X11 (native injection).
- **macOS**: Native support.
- **Windows**: Native support.

---
*Developed by Yash Mahawar*
