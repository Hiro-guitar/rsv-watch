// 拡張が開いたタブだけで動く。
//  ・予約ページ自身の「ブラウザでログインする」ボタンを1回だけ押す
//  ・新しい証明書が保存されたら拡張の本体へ渡す
// LINEのログイン画面（access.line.me）では何も操作しない。
(function () {
  if (sessionStorage.getItem('rsvwatch') !== '1') return;
  var started = Date.now();
  var sent = false;

  function tick() {
    if (sent) return;
    var key = Object.keys(localStorage).find(function (k) { return /^LIFF_STORE:.*:accessToken$/.test(k); });
    var raw = key ? localStorage.getItem(key) : null;
    if (raw && sessionStorage.getItem('rsvwatch_cleared') === '1') {
      var token = raw;
      try { token = JSON.parse(raw); } catch (e) {}
      sent = true;
      chrome.runtime.sendMessage({ type: 'token', token: token });
      return;
    }
    if (sessionStorage.getItem('rsvwatch_clicked') !== '1') {
      var btn = Array.prototype.find.call(document.querySelectorAll('span, a, button'), function (el) {
        return el.textContent.trim() === 'ブラウザでログインする';
      });
      if (btn) {
        sessionStorage.setItem('rsvwatch_clicked', '1');
        btn.click();
        return;
      }
    }
    if (Date.now() - started < 150000) setTimeout(tick, 1000);
  }
  tick();
})();
