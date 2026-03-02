import sys
import json
import os
import urllib.request

CONFIG_PATH = os.path.expanduser("~/.antigravity/telegram_bridge.json")

def send_msg(text):
    if not os.path.exists(CONFIG_PATH):
        print("Config not found.")
        return
    with open(CONFIG_PATH, 'r') as f:
        config = json.load(f)
    
    token = config.get("bot_token")
    chat_id = config.get("chat_id")
    if not token or not chat_id:
        print("Credentials missing in config.")
        return
        
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = json.dumps({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req)
        print("Message sent.")
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: tg_push.py 'message'")
    else:
        send_msg(sys.argv[1])
