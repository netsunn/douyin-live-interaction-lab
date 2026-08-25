"""通过本地直播控制台输出抖音聊天消息。

抖音 WebSocket 由 Chrome 页面建立并解码，本程序只订阅本地 SSE，
因此不需要处理动态签名、Cookie 或 Protobuf。
"""
import argparse
import json
import sys
import threading
import time
import urllib.request


def display(event_type, item):
    if item.get("replay"):
        return
    source = str(item.get("source") or "unknown").upper()
    avatar_text = f" 头像：{item['avatarUrl']}" if item.get("avatarUrl") else ""
    if event_type == "comment" and item.get("eventType", "comment") == "comment":
        print(f"[聊天][{source}] {item.get('userName', '未知用户')}：{item.get('content', '')}{avatar_text}", flush=True)
    elif event_type == "comment" and item.get("eventType") == "member":
        count_text = f"（当前在线 {item['memberCount']}）" if item.get("memberCount") else ""
        print(f"[进场][{source}] {item.get('userName', '未知用户')} 来了{count_text}{avatar_text}", flush=True)
    elif event_type == "comment" and item.get("eventType") == "like":
        total_text = f"（直播间累计 {item['total']}）" if item.get("total") else ""
        print(f"[点赞][{source}] {item.get('userName', '未知用户')} 点赞 {item.get('count', 1)} 次{total_text}{avatar_text}", flush=True)
    elif event_type == "comment" and item.get("eventType") == "follow":
        print(f"[关注][{source}] {item.get('userName', '未知用户')} 关注了主播{avatar_text}", flush=True)
    elif event_type == "comment" and item.get("eventType") == "fansclub":
        print(f"[粉丝团][{source}] {item.get('userName', '未知用户')} {item.get('content', '加入了粉丝团')}{avatar_text}", flush=True)
    elif event_type == "gift":
        print(f"[礼物][{source}] {item.get('userName', '未知用户')} 送出 {item.get('giftName', '礼物')} × {item.get('count', 1)}{avatar_text}", flush=True)


def listen(url):
    stream_name = "礼物" if "gift" in url else "消息"
    was_disconnected = False
    while True:
        try:
            request = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
            with urllib.request.urlopen(request, timeout=None) as response:
                if was_disconnected:
                    print(f"[{stream_name}流] 已重新连接", flush=True)
                    was_disconnected = False
                event_type = ""
                data_lines = []
                while True:
                    raw = response.readline()
                    if not raw:
                        raise ConnectionError("连接已关闭")
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if line.startswith("event:"):
                        event_type = line[6:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                    elif not line:
                        if event_type in ("comment", "gift") and data_lines:
                            try:
                                display(event_type, json.loads("\n".join(data_lines)))
                            except json.JSONDecodeError:
                                pass
                        event_type = ""
                        data_lines = []
        except Exception as error:
            if not was_disconnected:
                print(f"[{stream_name}流] 连接中断，正在自动重连：{error}", flush=True)
                was_disconnected = True
            time.sleep(1.5)


def main():
    parser = argparse.ArgumentParser(description="输出抖音直播 WebSocket 消息")
    parser.add_argument("--comment-url", default="http://127.0.0.1:8877/api/comment-events")
    parser.add_argument("--gift-url", default="http://127.0.0.1:8877/api/gift-events")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(f"正在监听：{args.comment_url}", flush=True)
    print(f"正在监听：{args.gift_url}", flush=True)
    print("请保持 Chrome 抖音直播页和消息扩展运行。按 Ctrl+C 停止。\n", flush=True)
    for url in (args.comment_url, args.gift_url):
        threading.Thread(target=listen, args=(url,), daemon=True).start()
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)
    except Exception as error:
        print(f"监听失败：{error}", file=sys.stderr, flush=True)
        raise
