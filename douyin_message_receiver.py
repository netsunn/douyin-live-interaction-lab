import json
import base64
import gzip
import re
import sys
from pathlib import Path
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

from douyin_proto import ChatMessage, FansclubMessage, GiftMessage, LikeMessage, MemberMessage, PushFrame, Response, SocialMessage

HOST = "127.0.0.1"
PORT = 8890
COMMENT_URL = "http://127.0.0.1:8877/api/douyin/comment-event"
GIFT_URL = "http://127.0.0.1:8877/api/douyin/gift-event"
gift_progress = {}
avatar_owners = {}
DEFAULT_AVATAR_MARKERS = (
    "default_avatar", "default-avatar", "avatar_default", "avatar-default",
    "default_user", "default-user", "user_default", "user-default",
    "defavatar", "def_avatar", "def-avatar",
    "mosaic-legacy/3795/3047680722", "mosaic-legacy/3791/5070639578",
)


def user_avatar_url(user):
    for image in (user.avatar_medium, user.avatar_large, user.avatar_thumb):
        for url in image.url_list_list:
            if valid_avatar_url(url):
                fingerprint = (image.uri or url.split("?", 1)[0]).lower()
                if any(marker in fingerprint for marker in DEFAULT_AVATAR_MARKERS):
                    return ""
                owner = str(user.id or user.nick_name or "")
                owners = avatar_owners.setdefault(fingerprint, set())
                if owner:
                    owners.add(owner)
                if len(owners) > 1:
                    return ""
                return re.sub(r"/\d{2,4}x\d{2,4}/", "/200x200/", url, count=1)
    return ""


def decode_websocket_events(frame):
    raw = base64.b64decode(frame.get("base64", ""))
    if not raw or frame.get("truncated"):
        return []
    package = PushFrame().parse(raw)
    if not package.payload:
        return []
    payload = gzip.decompress(package.payload) if package.payload_encoding == "gzip" or package.payload[:2] == b"\x1f\x8b" else package.payload
    response = Response().parse(payload)
    chats = []
    members = []
    gifts = []
    likes = []
    follows = []
    fansclub_events = []
    social_events = []
    methods = []
    for message in response.messages_list:
        methods.append(message.method)
        if message.method != "WebcastChatMessage":
            if message.method == "WebcastMemberMessage":
                member = MemberMessage().parse(message.payload)
                members.append({"userName": member.user.nick_name or "未知用户", "avatarUrl": user_avatar_url(member.user), "memberCount": member.member_count, "source": "websocket"})
            elif message.method == "WebcastGiftMessage":
                gift = GiftMessage().parse(message.payload)
                gifts.append({"userName": gift.user.nick_name or "未知用户", "userId": gift.user.id, "avatarUrl": user_avatar_url(gift.user), "giftName": gift.gift.name or gift.gift.describe or f"礼物{gift.gift_id}", "giftId": gift.gift_id, "groupId": gift.group_id, "messageId": message.msg_id, "count": gift.combo_count or gift.repeat_count or gift.group_count or gift.total_count or 1, "repeatEnd": gift.repeat_end, "diamondCount": gift.gift.diamond_count, "source": "websocket"})
            elif message.method == "WebcastLikeMessage":
                like = LikeMessage().parse(message.payload)
                likes.append({"userName": like.user.nick_name or "未知用户", "avatarUrl": user_avatar_url(like.user), "count": max(1, like.count), "total": like.total, "source": "websocket"})
            elif message.method == "WebcastSocialMessage":
                social = SocialMessage().parse(message.payload)
                social_events.append({
                    "userName": social.user.nick_name or "未知用户",
                    "avatarUrl": user_avatar_url(social.user),
                    "action": social.action,
                    "shareType": social.share_type,
                    "followCount": social.follow_count,
                })
                if social.action == 1 or social.follow_count > 0:
                    follows.append({"userName": social.user.nick_name or "未知用户", "avatarUrl": user_avatar_url(social.user), "followCount": social.follow_count, "action": social.action, "source": "websocket"})
            elif message.method == "WebcastFansclubMessage":
                fansclub = FansclubMessage().parse(message.payload)
                action_text = "加入了粉丝团" if fansclub.type == 2 else "粉丝团升级了" if fansclub.type == 1 else (fansclub.content or "粉丝团互动")
                fansclub_events.append({"userName": fansclub.user.nick_name or "未知用户", "avatarUrl": user_avatar_url(fansclub.user), "fansclubType": fansclub.type, "content": action_text, "source": "websocket"})
            continue
        chat = ChatMessage().parse(message.payload)
        chats.append({"userName": chat.user.nick_name or "未知用户", "avatarUrl": user_avatar_url(chat.user), "content": chat.content, "source": "websocket"})
    return chats, members, gifts, likes, follows, fansclub_events, social_events, methods


def incremental_gift_count(gift):
    key = (gift["userId"], gift["giftId"], gift["groupId"] or gift["messageId"])
    current = max(1, int(gift["count"] or 1))
    previous = gift_progress.get(key, 0)
    gift_progress[key] = max(previous, current)
    if len(gift_progress) > 5000:
        gift_progress.pop(next(iter(gift_progress)))
    return max(0, current - previous)


def valid_avatar_url(url):
    if not url.startswith(("http://", "https://")):
        return False
    lowered = url.lower()
    if any(word in lowered for word in ("frame", "border", "badge", "medal", "grade", "level", "decoration", "emoji", *DEFAULT_AVATAR_MARKERS)):
        return False
    return True


def forward_to_console(payload, url):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    try:
        with urlopen(request, timeout=3) as response:
            return 200 <= response.status < 300, ""
    except Exception as error:
        return False, str(error)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        return

    def headers_common(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.headers_common()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.reply(204, {})

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True, "service": "douyin-message-receiver"})
        else:
            self.reply(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if self.path == "/api/douyin/debug":
            try:
                length = min(int(self.headers.get("Content-Length", "0")), 500000)
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if payload.get("kind") == "websocket":
                    frame = payload.get("frame") or {}
                    message = f"[WS探针] stage={payload.get('stage')} id={payload.get('id', '')} url={payload.get('url', '')} kind={frame.get('kind', '')} size={frame.get('size', '')} hex={frame.get('hex', '')[:128]}"
                    print(message, flush=True)
                    with Path(__file__).with_name("ws-debug.log").open("a", encoding="utf-8") as log:
                        log.write(message + "\n")
                    if payload.get("stage") == "receive":
                        try:
                            chats, members, gifts, likes, follows, fansclub_events, social_events, methods = decode_websocket_events(frame)
                            with Path(__file__).with_name("ws-decode.log").open("a", encoding="utf-8") as log:
                                social_detail = ";".join(
                                    f"{item['userName']}|action={item['action']}|share={item['shareType']}|followCount={item['followCount']}"
                                    for item in social_events
                                )
                                log.write(f"methods={','.join(methods)} chats={len(chats)} members={len(members)} gifts={len(gifts)} likes={len(likes)} follows={len(follows)} fansclub={len(fansclub_events)} social=[{social_detail}] size={frame.get('size')} captured={frame.get('captured')} truncated={frame.get('truncated')}\n")
                            for chat in chats:
                                event = {"eventType": "comment", "userName": chat["userName"], "avatarUrl": chat["avatarUrl"], "content": chat["content"], "receivedAt": datetime.now().isoformat(), "source": "websocket", "countSource": ""}
                                forwarded, error = forward_to_console(event, COMMENT_URL)
                                print(f"[{datetime.now().strftime('%H:%M:%S')}] 🔌 {chat['userName']}：{chat['content']}", flush=True)
                                if not forwarded:
                                    print(f"         控制台转发失败：{error}", flush=True)
                            for member in members:
                                event = {"eventType": "member", "userName": member["userName"], "avatarUrl": member["avatarUrl"], "content": "进入了直播间", "memberCount": member["memberCount"], "receivedAt": datetime.now().isoformat(), "source": "websocket", "countSource": ""}
                                forwarded, error = forward_to_console(event, COMMENT_URL)
                                print(f"[{datetime.now().strftime('%H:%M:%S')}] 👋 [进场][WEBSOCKET] {member['userName']} 来了（当前在线 {member['memberCount']}）", flush=True)
                                if not forwarded:
                                    print(f"         控制台转发失败：{error}", flush=True)
                            for gift in gifts:
                                count = incremental_gift_count(gift)
                                if count <= 0:
                                    continue
                                avatar_url = gift["avatarUrl"]
                                event = {"eventType": "gift", "userName": gift["userName"], "avatarUrl": avatar_url, "content": f"送出 {gift['giftName']} × {count}", "giftName": gift["giftName"], "count": count, "value": gift["diamondCount"], "receivedAt": datetime.now().isoformat(), "source": "websocket", "avatarDebug": "WebSocket礼物消息自带头像" if avatar_url else "WebSocket礼物消息未带头像"}
                                forwarded, error = forward_to_console(event, GIFT_URL)
                                print(f"[{datetime.now().strftime('%H:%M:%S')}] 🎁 [礼物][WEBSOCKET] {gift['userName']} 送出 {gift['giftName']} × {count} 头像：{avatar_url or '无'}", flush=True)
                                if not forwarded:
                                    print(f"         控制台转发失败：{error}", flush=True)
                            for like in likes:
                                event = {"eventType": "like", "userName": like["userName"], "avatarUrl": like["avatarUrl"], "content": f"点赞了 {like['count']} 次", "count": like["count"], "total": like["total"], "receivedAt": datetime.now().isoformat(), "source": "websocket", "countSource": "message"}
                                forwarded, error = forward_to_console(event, COMMENT_URL)
                                total_text = f"（直播间累计 {like['total']}）" if like["total"] else ""
                                print(f"[{datetime.now().strftime('%H:%M:%S')}] 👍 [点赞][WEBSOCKET] {like['userName']} 点赞 {like['count']} 次{total_text}", flush=True)
                                if not forwarded:
                                    print(f"         控制台转发失败：{error}", flush=True)
                            for follow in follows:
                                event = {"eventType": "follow", "userName": follow["userName"], "avatarUrl": follow["avatarUrl"], "content": "关注了主播", "followCount": follow["followCount"], "receivedAt": datetime.now().isoformat(), "source": "websocket", "countSource": "message"}
                                forwarded, error = forward_to_console(event, COMMENT_URL)
                                print(f"[{datetime.now().strftime('%H:%M:%S')}] ➕ [关注][WEBSOCKET] {follow['userName']} 关注了主播", flush=True)
                                if not forwarded:
                                    print(f"         控制台转发失败：{error}", flush=True)
                            for fansclub in fansclub_events:
                                event = {"eventType": "fansclub", "userName": fansclub["userName"], "avatarUrl": fansclub["avatarUrl"], "content": fansclub["content"], "fansclubType": fansclub["fansclubType"], "receivedAt": datetime.now().isoformat(), "source": "websocket", "countSource": "message"}
                                forwarded, error = forward_to_console(event, COMMENT_URL)
                                print(f"[{datetime.now().strftime('%H:%M:%S')}] ⭐ [粉丝团][WEBSOCKET] {fansclub['userName']} {fansclub['content']}", flush=True)
                                if not forwarded:
                                    print(f"         控制台转发失败：{error}", flush=True)
                        except Exception as error:
                            print(f"[WS解码失败] {error}", flush=True)
                            with Path(__file__).with_name("ws-decode.log").open("a", encoding="utf-8") as log:
                                log.write(f"ERROR {type(error).__name__}: {error} size={frame.get('size')} captured={frame.get('captured')} truncated={frame.get('truncated')}\n")
                    return self.reply(200, {"ok": True})
                print(f"[SDK诊断] connected={payload.get('connected')} mode={payload.get('mode')} candidates={payload.get('candidateCount')} new={payload.get('newCount')} modules={payload.get('moduleCount')} visited={payload.get('visited')} tries={payload.get('tries')} reason={payload.get('reason', '')}", flush=True)
                return self.reply(200, {"ok": True})
            except Exception as error:
                return self.reply(400, {"ok": False, "error": str(error)})
        if self.path != "/api/douyin/comment":
            return self.reply(404, {"ok": False, "error": "Not found"})
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 20000)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            user_name = str(payload.get("userName", "")).strip()[:80]
            content = str(payload.get("content", "")).strip()[:500]
            if not user_name or not content:
                raise ValueError("消息缺少用户昵称或正文")
            raw_type = payload.get("eventType")
            event_type = raw_type if raw_type in ("member", "gift", "follow", "like") else "comment"
            avatar_url = str(payload.get("avatarUrl", "")).strip()[:1000]
            if avatar_url and not valid_avatar_url(avatar_url):
                avatar_url = ""
            event = {"eventType": event_type, "userName": user_name, "avatarUrl": avatar_url, "content": content, "receivedAt": payload.get("receivedAt") or datetime.now().isoformat(), "source": str(payload.get("source", "dom"))[:20], "countSource": str(payload.get("countSource", ""))[:30]}
            if event_type == "like":
                event.update({"count": max(1, min(99999, int(payload.get("count", 1) or 1))), "total": max(0, int(payload.get("total", 0) or 0))})
            if event_type == "gift":
                gift_name = str(payload.get("giftName", "")).strip()[:80]
                count = max(1, min(9999, int(payload.get("count", 1) or 1)))
                if not gift_name:
                    raise ValueError("礼物事件缺少礼物名称")
                event.update({"giftName": gift_name, "count": count, "value": 0, "avatarDebug": str(payload.get("avatarDebug", ""))[:200]})
                forwarded, error = forward_to_console(event, GIFT_URL)
            else:
                forwarded, error = forward_to_console(event, COMMENT_URL)
            stamp = datetime.now().strftime("%H:%M:%S")
            if event_type == "gift":
                print(f"[{stamp}] 🎁 {user_name} 送出 {event['giftName']} × {event['count']}", flush=True)
            elif event_type == "member":
                print(f"[{stamp}] 👋 {user_name} 进入了直播间", flush=True)
            elif event_type == "follow":
                print(f"[{stamp}] ➕ {user_name} 关注了主播", flush=True)
            elif event_type == "like":
                total_text = f"，直播间累计 {event['total']}" if event["total"] else ""
                print(f"[{stamp}] 👍 {user_name} 点赞 {event['count']} 次{total_text} [来源:{event['source']}/{event['countSource'] or 'unknown'}]", flush=True)
            else:
                print(f"[{stamp}] 💬 {user_name}：{content}", flush=True)
            if avatar_url:
                print(f"         头像：{avatar_url}", flush=True)
            if not forwarded:
                print(f"         控制台转发失败：{error}", flush=True)
            self.reply(200, {"ok": True, "forwarded": forwarded, "event": event})
        except Exception as error:
            self.reply(400, {"ok": False, "error": str(error)})


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass
    print("抖音直播消息接收器已启动")
    print(f"监听地址：http://{HOST}:{PORT}")
    print(f"评论转发：{COMMENT_URL}")
    print(f"礼物转发：{GIFT_URL}")
    print("按 Ctrl+C 停止\n")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
