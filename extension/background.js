// 1時間おきに GAS へ「証明書はあと何時間もつか」を聞き、
// 残りが少なければ最小化したウィンドウで予約ページを開いて取り直す。
var REFRESH_BELOW_SEC = 8 * 3600; // 残りがこれ未満なら取り直す
var TIMEOUT_MIN = 3;

function ensureAlarm() {
  chrome.alarms.get('tick', function (a) {
    if (!a) chrome.alarms.create('tick', { delayInMinutes: 1, periodInMinutes: 60 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === 'tick') tick(false);
  if (a.name === 'timeout') onTimeout();
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === 'token') onToken(msg.token);
  if (msg.type === 'refreshNow') tick(true).then(function () { sendResponse({ ok: true }); });
  if (msg.type === 'checkNow') tick(false).then(function () { sendResponse({ ok: true }); });
  return msg.type === 'refreshNow' || msg.type === 'checkNow';
});

async function log(text) {
  var line = new Date().toLocaleString('ja-JP') + '  ' + text;
  var s = await chrome.storage.local.get('logs');
  var logs = (s.logs || []).concat([line]).slice(-30);
  await chrome.storage.local.set({ logs: logs });
}

async function cfg() {
  return chrome.storage.local.get(['gasUrl', 'secret', 'running', 'winId', 'runningSince']);
}

async function tick(force) {
  var c = await cfg();
  if (!c.gasUrl || !c.secret) return log('設定（GASのURLと合言葉）が未入力です');
  if (c.running && Date.now() - (c.runningSince || 0) < TIMEOUT_MIN * 60000 + 60000) return;

  var j;
  try {
    var r = await fetch(c.gasUrl + '?secret=' + encodeURIComponent(c.secret));
    j = await r.json();
  } catch (e) {
    return log('GASに確認できませんでした: ' + e.message);
  }
  if (!j.ok) return log('GASに断られました: ' + (j.error || '不明'));
  if (!force && j.valid && j.expires_in > REFRESH_BELOW_SEC) {
    return log('まだ有効（残り ' + (j.expires_in / 3600).toFixed(1) + ' 時間）');
  }
  log(force ? '手動で取り直します' : j.valid ? '残りが少ないので取り直します' : '切れているので取り直します');

  // 予約ページのIDは拡張に持たせず、GASから受け取る
  var w = await chrome.windows.create({ url: j.entry + '&rsvwatch=1', focused: false, state: 'minimized' });
  await chrome.storage.local.set({ running: true, winId: w.id, runningSince: Date.now() });
  chrome.alarms.create('timeout', { delayInMinutes: TIMEOUT_MIN });
}

async function finish() {
  var c = await cfg();
  chrome.alarms.clear('timeout');
  if (c.winId != null) {
    try { await chrome.windows.remove(c.winId); } catch (e) {}
  }
  await chrome.storage.local.set({ running: false, winId: null });
}

async function onToken(token) {
  var c = await cfg();
  if (!c.running) return;
  try {
    var r = await fetch(c.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: c.secret, token: token })
    });
    var j = await r.json();
    if (j.ok) await log('取り直してGASに送りました（残り ' + (j.expires_in / 3600).toFixed(1) + ' 時間）');
    else await log('GASが受け取りを断りました: ' + (j.error || '不明'));
  } catch (e) {
    await log('GASへの送信に失敗: ' + e.message);
  }
  await finish();
}

async function onTimeout() {
  var c = await cfg();
  if (!c.running) return;
  await log('時間内にログインし直せませんでした');
  try {
    await fetch(c.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: c.secret, action: 'fail', reason: '3分以内にログインが終わらなかった' })
    });
  } catch (e) {}
  await finish();
}
