#!/usr/bin/env python3
"""予約枠ウォッチャー（Liny予約 / rsv.e-ticket.link）

数分おきに空き枠を読み、次のときだけスマホへ通知する（ntfy）。
  - 新しい日付の枠が公開されたとき（翌々月分の一斉公開）
  - 対象メニューに空きが出たとき（キャンセル拾い）
  - ログインが切れたとき／エラーが続いたとき

予約の送信はしない。読むだけ。

環境変数（GitHub の Secrets から渡す）
  LIFF_ACCESS_TOKEN  ブラウザでLINEログインした後のアクセストークン
  GROUP_ID           予約ページURLの group_id
  NTFY_TOPIC         ntfy のトピック名（推測されない長い文字列）
  BOOK_URL           通知をタップしたときに開く予約ページURL（任意）
  TARGET_MENU        監視するメニュー名（既定: 1歳児預り）
  STATE_PATH         前回の状態を置く場所（既定: state/state.json）
  FIXTURE            テスト用: APIの代わりに読むJSONファイル
  DRY_RUN            1 なら通知を送らず標準出力に出す
"""

import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request

API_BASE = "https://reserve-api.liny.jp/exapi/"
NTFY_URL = "https://ntfy.sh/"
JST = dt.timezone(dt.timedelta(hours=9))
WEEKDAYS = "月火水木金土日"
ERROR_ALERT_AFTER = 6  # 連続この回数失敗したら知らせる（5分おきなら約30分）

UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)


class AuthError(Exception):
    pass


# ---------------------------------------------------------------- 設定

def env(name, default=None, required=False):
    v = os.environ.get(name, "").strip()
    if not v:
        if required:
            sys.exit(f"環境変数 {name} が設定されていません")
        return default
    return v


def load_token():
    raw = env("LIFF_ACCESS_TOKEN", required=True)
    # localStorage の値は "..." と引用符つきなので外す
    if raw.startswith('"') and raw.endswith('"'):
        raw = json.loads(raw)
    return raw


# ---------------------------------------------------------------- 通信

def api(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": "https://rsv.e-ticket.link",
        "Referer": "https://rsv.e-ticket.link/",
        "User-Agent": UA,
    }
    h.update(headers or {})
    req = urllib.request.Request(API_BASE + path, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def fetch_slots(group_id):
    fixture = env("FIXTURE")
    if fixture:
        if fixture == "AUTH_FAIL":
            raise AuthError("fixture")
        with open(fixture, encoding="utf-8") as f:
            return json.load(f)

    token = load_token()
    try:
        v = api("POST", "reserve-verify", {"access_token": token})
    except urllib.error.HTTPError as e:
        if e.code in (400, 401, 403, 404):
            raise AuthError(f"reserve-verify HTTP {e.code}") from e
        raise
    reserve_token = v.get("reserve_token")
    if not reserve_token:
        raise AuthError("reserve_token なし")

    path = (
        f"slots?group_id={group_id}"
        "&fields[]=reserved_count&fields[]=menu_reserved_count"
    )
    try:
        return api("GET", path, headers={"X-Linebot-Reserve-Auth-Token": reserve_token})
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise AuthError(f"slots HTTP {e.code}") from e
        raise


def notify(title, message, priority=3, click=None, tags=None):
    if env("DRY_RUN") == "1":
        print(f"--- 通知(優先度{priority}) {title}\n{message}\n")
        return
    payload = {
        "topic": env("NTFY_TOPIC", required=True),
        "title": title,
        "message": message,
        "priority": priority,
    }
    if click:
        payload["click"] = click
    if tags:
        payload["tags"] = tags
    req = urllib.request.Request(
        NTFY_URL,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30):
        pass


# ---------------------------------------------------------------- 判定

def now_jst():
    fake = env("NOW")  # テスト用 "2026-11-27 12:00"
    if fake:
        return dt.datetime.strptime(fake, "%Y-%m-%d %H:%M").replace(tzinfo=JST)
    return dt.datetime.now(JST)


def parse_jst(s):
    return dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=JST)


def label(date_str):
    d = dt.date.fromisoformat(date_str)
    return f"{d.month}/{d.day}({WEEKDAYS[d.weekday()]})"


def summarize(data, menu_name, now):
    """日付ごとの状態を返す {date: {"open": bool, "rest": int, "cap": int}}"""
    out = {}
    for s in data.get("event_slots", []):
        date = s["event_date"]
        menu = next((m for m in s.get("event_menus", []) if m.get("name") == menu_name), None)
        if menu is None:
            continue
        cap = int(menu.get("capacity") or 0)
        rest = max(cap - int(menu.get("reserved_count") or 0), 0)
        deadline_ok = True
        if s.get("deadline"):
            deadline_ok = parse_jst(s["deadline"]) > now
        is_open = bool(menu.get("can_reserve")) and rest > 0 and deadline_ok
        out[date] = {"open": is_open, "rest": rest, "cap": cap}
    return out


def fmt_line(date, info):
    if info["open"]:
        return f"{label(date)} 残り{info['rest']}（定員{info['cap']}）"
    if info["cap"] == 0:
        return f"{label(date)} 受付なし"
    return f"{label(date)} 満員（定員{info['cap']}）"


# ---------------------------------------------------------------- 状態

def load_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_state(path, state):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


# ---------------------------------------------------------------- 本体

def main():
    group_id = env("GROUP_ID", required=True)
    menu = env("TARGET_MENU", "1歳児預り")
    state_path = env("STATE_PATH", "state/state.json")
    book_url = env("BOOK_URL")
    now = now_jst()

    prev = load_state(state_path)
    state = prev or {"known_dates": [], "open_dates": [], "auth_alerted": False, "errors": 0}

    try:
        data = fetch_slots(group_id)
    except AuthError as e:
        print(f"認証エラー: {e}")
        if not state.get("auth_alerted"):
            notify(
                "予約監視: ログインが切れました",
                "PCのChromeで予約ページを開き直してLINEログインし、"
                "新しいアクセストークンをGitHubのSecrets（LIFF_ACCESS_TOKEN）に入れ直してください。"
                "直すまで空き枠の通知は止まります。",
                priority=4,
                tags=["warning"],
            )
            state["auth_alerted"] = True
        save_state(state_path, state)
        return
    except Exception as e:  # 通信エラーなど
        state["errors"] = state.get("errors", 0) + 1
        print(f"取得エラー（連続{state['errors']}回）: {type(e).__name__}")
        if state["errors"] == ERROR_ALERT_AFTER:
            notify(
                "予約監視: 取得エラーが続いています",
                f"{ERROR_ALERT_AFTER}回続けて空き枠を読めませんでした（{type(e).__name__}）。"
                "サイト側の変更や障害の可能性があります。",
                priority=3,
                tags=["warning"],
            )
        save_state(state_path, state)
        return

    if state.get("auth_alerted"):
        notify("予約監視: 再開しました", "ログインが戻り、監視を再開しました。", priority=2)
    if state.get("errors", 0) >= ERROR_ALERT_AFTER:
        notify("予約監視: 復旧しました", "空き枠をまた読めるようになりました。", priority=2)
    state["auth_alerted"] = False
    state["errors"] = 0

    days = summarize(data, menu, now)
    known = set(state.get("known_dates", []))
    prev_open = set(state.get("open_dates", []))
    open_now = {d for d, i in days.items() if i["open"]}

    if prev is None:
        # 初回：今の状態を覚えるだけ。動作確認として1通だけ送る
        lines = [fmt_line(d, days[d]) for d in sorted(open_now)] or ["今は空きなし"]
        notify(
            "予約監視を始めました",
            f"対象: {menu}\n今日以降の枠: {sum(1 for d in days if d >= now.date().isoformat())}日\n"
            + "\n".join(lines),
            priority=2,
            click=book_url,
        )
    else:
        new_dates = sorted(set(days) - known)
        if new_dates:
            months = sorted({d[:7] for d in new_dates})
            mlabel = "・".join(f"{int(m[5:])}月" for m in months)
            n_open = sum(1 for d in new_dates if days[d]["open"])
            lines = [fmt_line(d, days[d]) for d in new_dates]
            notify(
                f"{mlabel}分の枠が公開されました（空き{n_open}日）",
                "\n".join(lines),
                priority=5,
                click=book_url,
                tags=["rotating_light"],
            )

        newly_open = sorted((open_now - prev_open) - set(new_dates))
        if newly_open:
            lines = [fmt_line(d, days[d]) for d in newly_open]
            notify(
                f"空きが出ました（{len(newly_open)}日）",
                "\n".join(lines),
                priority=4,
                click=book_url,
                tags=["bell"],
            )

    # APIから消えた古い日付だけ捨てる（APIに残っている過去日は覚えたまま）
    cutoff = (now.date() - dt.timedelta(days=14)).isoformat()
    state["known_dates"] = sorted(set(days) | {d for d in known if d >= cutoff})
    state["open_dates"] = sorted(open_now)
    state["last_ok"] = now.isoformat(timespec="minutes")
    save_state(state_path, state)
    print(f"OK: 日数{len(days)} 空き{len(open_now)}")


if __name__ == "__main__":
    main()
