// LINEのログイン確認画面（「次のアカウントでログイン」）で「ログイン」を1回だけ押す。
// ・拡張が開いたウィンドウのときだけ動く（本体に確認してから）
// ・パスワード入力が出ている場合や「別のアカウントでログイン」は押さない
(function () {
  if (sessionStorage.getItem('rsvwatch_line_clicked') === '1') return;
  chrome.runtime.sendMessage({ type: 'isOurs' }, function (res) {
    if (!res || !res.ours) return;
    var started = Date.now();
    (function tick() {
      if (document.querySelector('input[type="password"]')) return;
      var text = document.body ? document.body.innerText : '';
      var btn = Array.prototype.find.call(document.querySelectorAll('button, a'), function (el) {
        return el.textContent.trim() === 'ログイン';
      });
      if (btn && text.indexOf('次のアカウントでログイン') !== -1) {
        sessionStorage.setItem('rsvwatch_line_clicked', '1');
        btn.click();
        return;
      }
      if (Date.now() - started < 30000) setTimeout(tick, 500);
    })();
  });
})();
