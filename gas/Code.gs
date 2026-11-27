/**
 * 予約枠ウォッチャー（Google Apps Script版）
 *
 * 5分おきに予約ページの空き枠を読み、次のときだけLINEに通知する。
 *   - 新しい日付の枠が公開されたとき（一斉公開）
 *   - 対象メニューに空きが出たとき（キャンセル）
 *   - ログインが切れたとき／エラーが30分続いたとき
 * 予約の送信はしない（読むだけ）。
 *
 * スクリプト プロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   LIFF_ACCESS_TOKEN   予約ページにブラウザでLINEログインしたときのアクセストークン
 *   LINE_CHANNEL_TOKEN  通知用LINE公式アカウントのチャネルアクセストークン（長期）
 *   GROUP_ID            予約ページURLの group_id
 *   BOOK_URL            通知に載せる予約ページURL（任意）
 *   LINE_USER_ID        自分のユーザーID（任意。無ければ友だち全員に一斉送信）
 *   TARGET_MENU         監視するメニュー名（任意。既定: 1歳児預り）
 *
 * 使い方: プロパティを入れてから setup を1回実行する。止めるときは stop。
 */

var API_BASE = 'https://reserve-api.liny.jp/exapi/';
var LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
var LINE_BROADCAST_URL = 'https://api.line.me/v2/bot/message/broadcast';
var ERROR_ALERT_AFTER = 6; // 5分おきなら約30分
var WEEK = '日月火水木金土';
var STATE_KEY = 'STATE';

// ------------------------------------------------------------ 公開関数

/** 最初に1回だけ実行：5分おきのトリガーを作って、すぐ1回確認する */
function setup() {
  stop();
  ScriptApp.newTrigger('check').timeBased().everyMinutes(5).create();
  check();
}

/** 監視を止める */
function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'check') ScriptApp.deleteTrigger(t);
  });
}

/** 覚えている状態を消す（次の実行が「初回」扱いになる） */
function resetState() {
  PropertiesService.getScriptProperties().deleteProperty(STATE_KEY);
}

/** LINEに届くかだけ試す */
function testNotify() {
  notify_('予約監視: テスト', 'LINE通知のテストです。', 'info', null);
}

/** トリガーから呼ばれる本体 */
function check() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 前回がまだ動いていたら今回は飛ばす
  try {
    run_();
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------ 設定

function cfg_(name, def, required) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  v = v == null ? '' : String(v).trim();
  if (!v) {
    if (required) throw new Error('スクリプト プロパティ ' + name + ' が未設定です');
    return def;
  }
  return v;
}

function loadToken_() {
  var raw = cfg_('LIFF_ACCESS_TOKEN', null, true);
  if (raw.charAt(0) === '"' && raw.charAt(raw.length - 1) === '"') raw = JSON.parse(raw);
  return raw;
}

// ------------------------------------------------------------ 通信

function AuthError_(msg) {
  this.name = 'AuthError';
  this.message = msg;
}

function api_(method, path, body, headers) {
  var h = {
    Accept: 'application/json',
    Origin: 'https://rsv.e-ticket.link',
    Referer: 'https://rsv.e-ticket.link/'
  };
  for (var k in headers || {}) h[k] = headers[k];
  var opt = { method: method, headers: h, muteHttpExceptions: true };
  if (body != null) {
    opt.contentType = 'application/json';
    opt.payload = JSON.stringify(body);
  }
  var res = UrlFetchApp.fetch(API_BASE + path, opt);
  return { code: res.getResponseCode(), text: res.getContentText() };
}

function fetchSlots_(groupId) {
  var v = api_('post', 'reserve-verify', { access_token: loadToken_() });
  if (v.code === 400 || v.code === 401 || v.code === 403 || v.code === 404) {
    throw new AuthError_('reserve-verify HTTP ' + v.code);
  }
  if (v.code !== 200) throw new Error('reserve-verify HTTP ' + v.code);
  var reserveToken = JSON.parse(v.text).reserve_token;
  if (!reserveToken) throw new AuthError_('reserve_token なし');

  var path = 'slots?group_id=' + encodeURIComponent(groupId) +
    '&fields[]=reserved_count&fields[]=menu_reserved_count';
  var s = api_('get', path, null, { 'X-Linebot-Reserve-Auth-Token': reserveToken });
  if (s.code === 401 || s.code === 403) throw new AuthError_('slots HTTP ' + s.code);
  if (s.code !== 200) throw new Error('slots HTTP ' + s.code);
  return JSON.parse(s.text);
}

/** kind: 'release' 公開 / 'open' 空き / 'alert' 要対応 / その他は印なし */
function notify_(title, message, kind, click) {
  var mark = { release: '【至急】', open: '【空き】', alert: '【要対応】' }[kind] || '';
  var text = mark + title + '\n\n' + message;
  if (click) text += '\n\n予約ページ:\n' + click;

  var payload = { messages: [{ type: 'text', text: text.slice(0, 4900) }] };
  var userId = cfg_('LINE_USER_ID', null, false);
  var url = LINE_BROADCAST_URL;
  if (userId) {
    payload.to = userId;
    url = LINE_PUSH_URL;
  }
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg_('LINE_CHANNEL_TOKEN', null, true) },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('LINE送信失敗 HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
  }
}

// ------------------------------------------------------------ 判定

function nowJst_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
}

function label_(dateStr) {
  var p = dateStr.split('-').map(Number);
  var wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  return p[1] + '/' + p[2] + '(' + WEEK.charAt(wd) + ')';
}

/** {date: {open, rest, cap}} を返す */
function summarize_(data, menuName, now) {
  var out = {};
  (data.event_slots || []).forEach(function (s) {
    var menu = null;
    (s.event_menus || []).forEach(function (m) {
      if (m.name === menuName) menu = m;
    });
    if (!menu) return;
    var cap = Number(menu.capacity || 0);
    var rest = Math.max(cap - Number(menu.reserved_count || 0), 0);
    var deadlineOk = !s.deadline || s.deadline > now; // 同じ書式の文字列なので比較できる
    out[s.event_date] = {
      open: !!menu.can_reserve && rest > 0 && deadlineOk,
      closed: !deadlineOk,
      rest: rest,
      cap: cap
    };
  });
  return out;
}

/** 今月・来月・再来月の状況を1行ずつまとめる */
function monthSummary_(days, today) {
  var y = Number(today.slice(0, 4));
  var m = Number(today.slice(5, 7));
  var lines = [];
  for (var i = 0; i < 3; i++) {
    var yy = y + Math.floor((m - 1 + i) / 12);
    var mm = ((m - 1 + i) % 12) + 1;
    var prefix = yy + '-' + (mm < 10 ? '0' : '') + mm;
    var ds = Object.keys(days).sort().filter(function (d) {
      return d.slice(0, 7) === prefix && d >= today;
    });
    var head = '■' + mm + '月: ';
    if (!ds.length) {
      lines.push(head + (i === 0 ? '今月の残りの予約日はありません' : 'まだ公開されていません'));
      continue;
    }
    var range = ds.length === 1 ? label_(ds[0]) : label_(ds[0]) + '〜' + label_(ds[ds.length - 1]);
    var open = ds.filter(function (d) { return days[d].open; });
    var closed = ds.filter(function (d) { return days[d].closed; });
    var line = head + range + '（' + ds.length + '日）';
    if (open.length) {
      line += ' 空きあり ' + open.length + '日\n' +
        open.map(function (d) { return '　' + label_(d) + ' 残り' + days[d].rest; }).join('\n');
    } else if (closed.length === ds.length) {
      line += ' 受付終了（締切済み）';
    } else {
      line += ' 空きなし（満員）';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** いつでも手動で実行して、今の状況をLINEに送る */
function status() {
  var now = nowJst_();
  var menu = cfg_('TARGET_MENU', '1歳児預り', false);
  var days = summarize_(fetchSlots_(cfg_('GROUP_ID', null, true)), menu, now);
  notify_('予約の状況', '監視対象: ' + menu + '\n\n' + monthSummary_(days, now.slice(0, 10)), 'info',
    cfg_('BOOK_URL', null, false));
}

// ------------------------------------------------------------ 状態

function loadState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(state));
}

// ------------------------------------------------------------ 本体

function run_() {
  var groupId = cfg_('GROUP_ID', null, true);
  var menu = cfg_('TARGET_MENU', '1歳児預り', false);
  var bookUrl = cfg_('BOOK_URL', null, false);
  var now = nowJst_();
  var today = now.slice(0, 10);

  var prev = loadState_();
  var state = prev || { known_dates: [], open_dates: [], auth_alerted: false, errors: 0 };

  var data;
  try {
    data = fetchSlots_(groupId);
  } catch (e) {
    if (e instanceof AuthError_) {
      console.log('認証エラー: ' + e.message);
      if (!state.auth_alerted) {
        notify_('予約監視: ログインが切れました',
          'PCのChromeで予約ページを開き直してLINEログインし、新しいアクセストークンを' +
          'スクリプト プロパティ（LIFF_ACCESS_TOKEN）に入れ直してください。' +
          '直すまで空き枠の通知は止まります。', 'alert', null);
        state.auth_alerted = true;
      }
    } else {
      state.errors = (state.errors || 0) + 1;
      console.log('取得エラー（連続' + state.errors + '回）: ' + e.message);
      if (state.errors === ERROR_ALERT_AFTER) {
        notify_('予約監視: 取得エラーが続いています',
          ERROR_ALERT_AFTER + '回続けて空き枠を読めませんでした（' + e.message + '）。' +
          'サイト側の変更や障害の可能性があります。', 'alert', null);
      }
    }
    saveState_(state);
    return;
  }

  if (state.auth_alerted) notify_('予約監視: 再開しました', 'ログインが戻り、監視を再開しました。', 'info', null);
  if ((state.errors || 0) >= ERROR_ALERT_AFTER) {
    notify_('予約監視: 復旧しました', '空き枠をまた読めるようになりました。', 'info', null);
  }
  state.auth_alerted = false;
  state.errors = 0;

  var days = summarize_(data, menu, now);
  var dates = Object.keys(days).sort();
  var known = {};
  (state.known_dates || []).forEach(function (d) { known[d] = true; });
  var prevOpen = {};
  (state.open_dates || []).forEach(function (d) { prevOpen[d] = true; });
  var openNow = dates.filter(function (d) { return days[d].open; });

  if (!prev) {
    notify_('予約監視を始めました',
      '監視対象: ' + menu + '\n\n' + monthSummary_(days, today), 'info', bookUrl);
  } else {
    var newDates = dates.filter(function (d) { return !known[d]; });
    if (newDates.length) {
      var months = {};
      newDates.forEach(function (d) { months[Number(d.slice(5, 7)) + '月'] = true; });
      var nOpen = newDates.filter(function (d) { return days[d].open; }).length;
      var openNew = newDates.filter(function (d) { return days[d].open; });
      var body = '予約できる日（' + nOpen + '日）:\n' +
        (openNew.length
          ? openNew.map(function (d) { return '　' + label_(d) + ' 残り' + days[d].rest; }).join('\n')
          : '　なし') +
        '\n\n満員・受付なしの日: ' + (newDates.length - nOpen) + '日';
      notify_(Object.keys(months).join('・') + '分の枠が公開されました', body, 'release', bookUrl);
    }
    var isNew = {};
    newDates.forEach(function (d) { isNew[d] = true; });
    var newlyOpen = openNow.filter(function (d) { return !prevOpen[d] && !isNew[d]; });
    if (newlyOpen.length) {
      notify_('キャンセルで空きが出ました',
        newlyOpen.map(function (d) { return '　' + label_(d) + ' 残り' + days[d].rest; }).join('\n'),
        'open', bookUrl);
    }
  }

  // APIから消えた古い日付だけ捨てる
  var cutoff = Utilities.formatDate(new Date(Date.now() - 14 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  var keep = {};
  dates.forEach(function (d) { keep[d] = true; });
  (state.known_dates || []).forEach(function (d) { if (d >= cutoff) keep[d] = true; });
  state.known_dates = Object.keys(keep).sort();
  state.open_dates = openNow;
  state.last_ok = now;
  saveState_(state);
  console.log('OK: 日数' + dates.length + ' 空き' + openNow.length);
}
