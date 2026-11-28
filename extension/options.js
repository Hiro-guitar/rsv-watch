function $(id) { return document.getElementById(id); }
function show(text) { $('msg').textContent = text; }

async function load() {
  var s = await chrome.storage.local.get(['gasUrl', 'secret', 'logs']);
  $('gasUrl').value = s.gasUrl || '';
  $('secret').value = s.secret || '';
  $('logs').textContent = (s.logs || []).slice().reverse().join('\n') || 'まだありません';
}

$('save').onclick = async function () {
  var url = $('gasUrl').value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) return show('URLは …/exec で終わるGASのウェブアプリURLを入れてください');
  await chrome.storage.local.set({ gasUrl: url, secret: $('secret').value.trim() });
  show('保存しました');
};
$('check').onclick = function () {
  show('確認しています…');
  chrome.runtime.sendMessage({ type: 'checkNow' }, function () { show('確認しました'); load(); });
};
$('refresh').onclick = function () {
  show('取り直しを始めました（最大3分）。終わると記録に出ます');
  chrome.runtime.sendMessage({ type: 'refreshNow' }, function () { load(); });
};
chrome.storage.onChanged.addListener(load);
load();
