'use strict';
// Invite page: the one-time token is in the URL fragment (never sent to the server in the URL).
(function () {
  const $ = (id) => document.getElementById(id);
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname); // keep the token out of history and screenshots
  const err = (m) => { $('invite-error').textContent = m; $('invite-error').hidden = !m; };
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) err('This invite link is incomplete. Ask your teammate for a new one.');
  $('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('pw').value !== $('pw2').value) return err('The two passwords differ.');
    err('');
    const r = await fetch('/api/auth/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: $('pw').value }) }).catch(() => null);
    const data = r ? await r.json().catch(() => ({})) : {};
    $('pw').value = '';
    $('pw2').value = '';
    if (!r || !r.ok) return err(data.error || 'The relay could not be reached. Try again.');
    location.replace('/');
  });
})();
