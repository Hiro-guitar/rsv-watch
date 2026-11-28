// 拡張が開いたタブだけ（URLに rsvwatch=1）で動く。ページ本体より先に実行される。
//  1) スマホのふりをする（PCだと案内ページに飛ばされるため）
//  2) 最初の1回だけ古い証明書を消して、ログインし直させる
(function () {
  var p = new URLSearchParams(location.search);
  if (p.get('rsvwatch') === '1') sessionStorage.setItem('rsvwatch', '1');
  if (sessionStorage.getItem('rsvwatch') !== '1') return;

  var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  try {
    Object.defineProperty(Navigator.prototype, 'userAgent', { get: function () { return UA; }, configurable: true });
  } catch (e) {}

  if (sessionStorage.getItem('rsvwatch_cleared') !== '1') {
    Object.keys(localStorage).forEach(function (k) {
      if (/^LIFF_STORE:.*:(accessToken|IDToken|decodedIDToken)$/.test(k)) localStorage.removeItem(k);
    });
    sessionStorage.setItem('rsvwatch_cleared', '1');
  }
})();
