(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CURRENCY = 'EGP';
  const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + CURRENCY;
  const whole = (n) => Number(n).toLocaleString('en-US');

  const st = {
    screen: 'welcome', buf: '', card: '', token: null, holder: '',
    mode: 'withdraw', error: '', busy: false, data: null, timer: null, idle: null,
  };

  // ---------- small helpers ----------
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const p = (text, cls) => el('p', cls || 'line', text);
  const o = (label, fn) => ({ label, fn });
  const firstName = () => st.holder.split(' ')[0] || 'there';
  const groupCard = (digits) => (digits + '_'.repeat(16 - digits.length)).replace(/(.{4})/g, '$1 ').trim();

  // ---------- API (tier 1 -> tier 2) ----------
  async function api(path, options) {
    const headers = { 'Content-Type': 'application/json' };
    if (st.token) headers.Authorization = 'Bearer ' + st.token;
    let res;
    try {
      res = await fetch('/api' + path, Object.assign({}, options, { headers }));
    } catch (e) {
      throw { status: 0, message: 'Cannot reach the bank. Try again in a moment.' };
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) throw { status: res.status, message: data.error || 'Something went wrong. Try again.' };
    return data;
  }

  async function run(task) {
    if (st.busy) return;
    st.busy = true;
    try { await task(); } catch (e) { handleErr(e); } finally { st.busy = false; }
  }

  function handleErr(e) {
    const known = e && e.status !== undefined;
    const message = known ? e.message : 'Something went wrong. Try again.';
    if (known && e.status === 401 && st.token) {
      st.token = null;
      return go('welcome', { error: 'Your session has ended. Insert your card to sign in again.' });
    }
    if (st.screen === 'pin' && known && (e.status === 403 || e.status === 404)) {
      return go('welcome', { error: message });
    }
    if (st.screen === 'pin') st.buf = '';
    st.error = message;
    render();
  }

  // ---------- screens ----------
  const screens = {
    welcome: () => ({
      title: 'Welcome to Delta Bank',
      body: [p('Insert your card to begin.'), p('Demo card 1111 2222 3333 4444, PIN 1234', 'hint')],
      right: [null, null, null, o('Insert card', () => go('card'))],
    }),

    card: () => ({
      title: 'Card number',
      body: [p('Enter the 16 digits on your card, then press Enter.'), p(groupCard(st.buf), 'entry')],
      right: [null, null, null, o('Cancel', cancel)],
    }),

    pin: () => ({
      title: 'Enter your PIN',
      body: [
        p('Type your 4-digit PIN, then press Enter.'),
        p(Array.from({ length: 4 }, (_, i) => (i < st.buf.length ? '\u25CF' : '\u25CB')).join(' '), 'entry'),
      ],
      right: [null, null, null, o('Cancel', cancel)],
    }),

    menu: () => ({
      title: 'Hello, ' + firstName(),
      body: [p('What would you like to do?')],
      left: [o('Check balance', showBalance), o('Withdraw cash', () => go('withdraw')), null, null],
      right: [o('Deposit cash', () => go('amount', { mode: 'deposit' })), o('Mini statement', showHistory), null, o('Exit', exit)],
    }),

    withdraw: () => ({
      title: 'Withdraw cash',
      body: [p('Choose an amount.')],
      left: [
        o('100 ' + CURRENCY, () => doMove('withdraw', 100)),
        o('200 ' + CURRENCY, () => doMove('withdraw', 200)),
        o('500 ' + CURRENCY, () => doMove('withdraw', 500)),
        o('Back', () => go('menu')),
      ],
      right: [
        o('1,000 ' + CURRENCY, () => doMove('withdraw', 1000)),
        o('2,000 ' + CURRENCY, () => doMove('withdraw', 2000)),
        o('Other amount', () => go('amount', { mode: 'withdraw' })),
        o('Exit', exit),
      ],
    }),

    amount: () => ({
      title: st.mode === 'withdraw' ? 'Withdraw cash' : 'Deposit cash',
      body: [
        p('Enter the amount, then press Enter.'),
        p(whole(st.buf || 0) + ' ' + CURRENCY, 'entry'),
        p(st.mode === 'withdraw' ? 'Multiples of 10, up to 5,000 EGP.' : 'Whole amounts, up to 5,000 EGP.', 'hint'),
      ],
      left: [null, null, null, o('Back', () => go(st.mode === 'withdraw' ? 'withdraw' : 'menu'))],
      right: [null, null, null, o('Exit', exit)],
    }),

    balance: () => ({
      title: 'Your balance',
      wide: true,
      body: [p('Available in your account'), p(money(st.data.balance), 'big')],
      left: [null, null, null, o('Menu', () => go('menu'))],
      right: [null, null, null, o('Exit', exit)],
    }),

    done: () => {
      const d = st.data;
      return {
        title: d.kind === 'withdraw' ? 'Please take your cash' : 'Deposit received',
        wide: true,
        body: [
          p((d.kind === 'withdraw' ? 'Withdrawn: ' : 'Deposited: ') + money(d.amount)),
          p('New balance', 'hint'),
          p(money(d.balance), 'big'),
        ],
        left: [null, null, null, o('Menu', () => go('menu'))],
        right: [null, null, null, o('Exit', exit)],
      };
    },

    history: () => {
      let content;
      if (!st.data.length) {
        content = p('No transactions yet.');
      } else {
        content = el('table', 'tx');
        const head = el('tr');
        ['Date', 'Type', 'Amount', 'Balance'].forEach((h) => head.append(el('th', h === 'Type' ? 'tx-type' : null, h)));
        content.append(head);
        st.data.forEach((t) => {
          const row = el('tr');
          const when = new Date(t.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
          const sign = t.kind === 'withdraw' ? '-' : '+';
          row.append(
            el('td', null, when),
            el('td', 'tx-type', t.kind === 'withdraw' ? 'Withdrawal' : 'Deposit'),
            el('td', null, sign + whole(t.amount)),
            el('td', null, whole(t.balance_after)),
          );
          content.append(row);
        });
      }
      return {
        title: 'Mini statement',
        wide: true,
        body: [content],
        left: [null, null, null, o('Menu', () => go('menu'))],
        right: [null, null, null, o('Exit', exit)],
      };
    },

    goodbye: () => ({
      title: 'Thank you for banking with Delta Bank',
      body: [p('Please take your card.')],
    }),
  };

  // ---------- navigation ----------
  function go(screen, extra) {
    clearTimeout(st.timer);
    st.screen = screen;
    st.buf = '';
    st.error = '';
    Object.assign(st, extra || {});
    if (screen === 'welcome') $('tray').classList.remove('dispensing');
    render();
  }

  function cancel() {
    if (st.busy) return;
    if (st.token) return exit();
    if (st.screen !== 'welcome' && st.screen !== 'goodbye') go('welcome');
  }

  function exit() {
    if (st.screen === 'goodbye') return;
    const token = st.token;
    if (token) {
      fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
    }
    st.token = null; st.holder = ''; st.card = '';
    go('goodbye');
    st.timer = setTimeout(() => go('welcome'), 2800);
  }

  // ---------- actions ----------
  const showBalance = () => run(async () => {
    const d = await api('/balance');
    go('balance', { data: d });
  });

  const showHistory = () => run(async () => {
    const d = await api('/transactions');
    go('history', { data: d.transactions });
  });

  const submitLogin = () => run(async () => {
    const d = await api('/login', { method: 'POST', body: JSON.stringify({ card: st.card, pin: st.buf }) });
    st.token = d.token;
    st.holder = d.holder;
    go('menu');
  });

  function doMove(kind, amount) {
    if (!Number.isInteger(amount) || amount <= 0) {
      st.error = 'Enter an amount first.';
      return render();
    }
    return run(async () => {
      const d = await api('/' + kind, { method: 'POST', body: JSON.stringify({ amount }) });
      go('done', { data: { kind, amount, balance: d.balance } });
      if (kind === 'withdraw') dispense();
    });
  }

  function dispense() {
    const tray = $('tray');
    tray.classList.remove('dispensing');
    void tray.offsetWidth; // restart the animation
    tray.classList.add('dispensing');
  }

  // ---------- input ----------
  const LIMITS = { card: 16, pin: 4, amount: 4 };

  function enter() {
    if (st.busy) return;
    if (st.screen === 'welcome') return go('card');
    if (st.screen === 'card') {
      if (st.buf.length !== 16) { st.error = 'A card number has 16 digits.'; return render(); }
      st.card = st.buf;
      return go('pin');
    }
    if (st.screen === 'pin') {
      if (st.buf.length !== 4) { st.error = 'A PIN has 4 digits.'; return render(); }
      return submitLogin();
    }
    if (st.screen === 'amount') return doMove(st.mode, parseInt(st.buf, 10));
  }

  function key(k) {
    if (st.busy) return;
    const limit = LIMITS[st.screen];
    if (/^\d$/.test(k)) {
      if (!limit || st.buf.length >= limit) return;
      if (st.screen === 'amount' && st.buf === '' && k === '0') return;
      st.buf += k; st.error = '';
      return render();
    }
    if (k === 'clear' || k === 'back') {
      if (!limit) return;
      st.buf = k === 'clear' ? '' : st.buf.slice(0, -1);
      st.error = '';
      return render();
    }
    if (k === 'enter') return enter();
    if (k === 'cancel') return cancel();
  }

  // ---------- rendering ----------
  function renderSide(side, items) {
    const keys = $(side === 'left' ? 'keysLeft' : 'keysRight').children;
    for (let i = 0; i < 4; i++) {
      const item = items && items[i];
      const k = keys[i];
      k.disabled = !item;
      k.setAttribute('aria-label', item ? item.label : 'Not in use');
      k.onclick = item ? item.fn : null;
      if (item) {
        const b = el('button', 'opt opt-' + side, item.label);
        b.type = 'button';
        b.tabIndex = -1;
        b.style.gridRow = String(i + 1);
        b.onclick = item.fn;
        $('grid').append(b);
      }
    }
  }

  function armIdle() {
    clearTimeout(st.idle);
    if (st.token) st.idle = setTimeout(() => { if (st.token) exit(); }, 60000);
  }

  function render() {
    const s = screens[st.screen]();
    $('title').textContent = s.title;

    const nodes = s.body.slice();
    if (st.error) {
      const e = el('p', 'error', st.error);
      e.setAttribute('role', 'alert');
      nodes.push(e);
    }
    const body = $('body');
    body.replaceChildren(...nodes);
    body.classList.toggle('wide', !!s.wide);

    $('grid').querySelectorAll('.opt').forEach((n) => n.remove());
    renderSide('left', s.left);
    renderSide('right', s.right);

    $('slot').classList.toggle('ready', st.screen === 'welcome');
    $('atm').classList.toggle('eject', st.screen === 'goodbye');
    armIdle();
  }

  // ---------- colour theme ----------
  const THEMES = ['violet', 'ocean', 'rose', 'mint'];
  function setTheme(name) {
    if (!THEMES.includes(name)) name = 'violet';
    document.documentElement.dataset.theme = name;
    document.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === name)));
    try { localStorage.setItem('atm-theme', name); } catch (e) { /* storage unavailable */ }
  }
  $('themes').addEventListener('click', (e) => {
    const b = e.target.closest('.swatch');
    if (b) setTheme(b.dataset.theme);
  });
  let savedTheme = 'violet';
  try { savedTheme = localStorage.getItem('atm-theme') || 'violet'; } catch (e) { /* ignore */ }
  setTheme(savedTheme);

  // ---------- start ----------
  ['keysLeft', 'keysRight'].forEach((id) => {
    for (let i = 0; i < 4; i++) {
      const b = el('button', 'key');
      b.type = 'button';
      $(id).append(b);
    }
  });

  $('pad').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]');
    if (b) key(b.dataset.key);
  });
  $('slot').addEventListener('click', () => { if (st.screen === 'welcome') go('card'); });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^\d$/.test(e.key)) return key(e.key);
    if (e.key === 'Backspace') { e.preventDefault(); return key('back'); }
    if (e.key === 'Escape') return key('cancel');
    if (e.key === 'Enter') {
      // Keypad and side keys keep their own Enter behaviour; everywhere else Enter means "Enter".
      const own = e.target instanceof Element && e.target.closest('#pad, .keys, .themes');
      if (!own) { e.preventDefault(); key('enter'); }
    }
  });

  render();
})();
