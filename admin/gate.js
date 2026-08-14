/* The whole of the unauthenticated surface: post the three fields, and on
   success pull in the panel — whose script and stylesheet the server
   refuses to serve without the cookie this call just set.

   Wrapped, because panel.js loads into the same global scope and declares
   its own `$`; two top-level consts of one name is a SyntaxError that
   takes the whole panel down with it. */
(() => {
  const $ = id => document.getElementById(id);

  async function boot() {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/admin/panel.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = '/admin/panel.js';
    document.body.appendChild(js);
    $('gate').remove();
    /* panel.css undoes the rest of this page's body styling itself — see
       the note there about justify-items outliving a display change. */
  }

  $('signin').onsubmit = async e => {
    e.preventDefault();
    const go = $('go');
    go.disabled = true; go.textContent = 'CHECKING…';
    $('err').hidden = true;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: $('username').value, password: $('password').value, code: $('code').value
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        $('err').textContent = data.message || 'That did not work.';
        $('err').hidden = false;
        $('code').value = '';
        $('code').focus();
        return;
      }
      boot();
    } catch (err) {
      $('err').textContent = 'Could not reach the server.';
      $('err').hidden = false;
    } finally {
      go.disabled = false; go.textContent = 'SIGN IN';
    }
  };

  /* already signed in? skip the form */
  fetch('/api/admin/me').then(r => { if (r.ok) boot(); }).catch(() => {});
})();
