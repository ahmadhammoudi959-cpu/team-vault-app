import { h, icon, dial, button, field, setBusy, toast, modal, confirmDialog, num, relTime, fmtDate, countLabel } from './ui.js';
import { api, ApiError, errorText, setSessionLostHandler } from './api.js';
import * as vc from './vcrypto.js';
import * as bl from './billing.js';

const root = document.getElementById('app');

// Everything decrypted lives only in this object, in memory. Locking wipes it.
const S = {
  appName: 'الخزنة',
  user: null,
  keys: null,
  entries: [],
  users: {},
  query: '',
  status: null,
  searchEl: null,
  resultsEl: null,
  bannerEl: null,
  billing: null, // admins' billing document (decrypted) + edit counter
  alerts: [],
  seenMarks: new Set(), // alerts marked as seen in this session (a status fetched earlier may not know yet)
  hub: null, // Hostinger/Render data for the subscriptions screens
  reportMonth: null,
};

// ---------------------------------------------------------------------------
// reference data
// ---------------------------------------------------------------------------
const PLATFORMS = [
  { id: 'instagram', name: 'Instagram', aka: 'انستجرام انستغرام انستا' },
  { id: 'facebook', name: 'Facebook', aka: 'فيسبوك فيس بوك فيس' },
  { id: 'meta_ads', name: 'Meta Business / الإعلانات', aka: 'ميتا بيزنس اعلانات اعلان ads manager business suite' },
  { id: 'tiktok', name: 'TikTok', aka: 'تيك توك تيكتوك' },
  { id: 'tiktok_ads', name: 'TikTok Ads', aka: 'تيك توك اعلانات' },
  { id: 'snapchat', name: 'Snapchat', aka: 'سناب شات سناب' },
  { id: 'x', name: 'X (Twitter)', aka: 'تويتر اكس twitter' },
  { id: 'youtube', name: 'YouTube', aka: 'يوتيوب' },
  { id: 'linkedin', name: 'LinkedIn', aka: 'لينكدان لينكد ان' },
  { id: 'whatsapp', name: 'WhatsApp Business', aka: 'واتساب واتس' },
  { id: 'google', name: 'Google / Gmail', aka: 'جوجل جيميل' },
  { id: 'google_ads', name: 'Google Ads', aka: 'جوجل اعلانات' },
  { id: 'email', name: 'بريد إلكتروني', aka: 'ايميل email mail' },
  { id: 'website', name: 'موقع / لوحة تحكم', aka: 'website wordpress cpanel' },
  { id: 'hosting', name: 'استضافة / دومين', aka: 'hosting domain دومين' },
  { id: 'store', name: 'متجر إلكتروني', aka: 'store shopify salla zid سلة زد شوبيفاي' },
  { id: 'system', name: 'سيستم / برنامج', aka: 'system erp crm' },
  { id: 'other', name: 'أخرى', aka: '' },
];
const platformOf = (id) => PLATFORMS.find((p) => p.id === id) || PLATFORMS[PLATFORMS.length - 1];
const platformName = (m) => (m.platform === 'other' && m.platformName ? m.platformName : platformOf(m.platform).name);
const platformRank = (id) => {
  const i = PLATFORMS.findIndex((p) => p.id === id);
  return i < 0 ? 99 : i;
};

const ACTIONS = {
  setup_complete: 'تجهيز الخزنة لأول مرة',
  login_ok: 'تسجيل دخول',
  login_fail: 'محاولة دخول فاشلة',
  login_while_locked: 'محاولة دخول والحساب مقفول',
  account_locked: 'قفل الحساب بسبب محاولات خاطئة',
  account_unlock: 'فك قفل حساب',
  login_waiting_approval: 'دخول قبل موافقة المدير',
  login_device_blocked: 'محاولة دخول من جهاز محظور',
  device_pending: 'طلب دخول من جهاز جديد',
  device_approve: 'موافقة على جهاز',
  device_block: 'حظر جهاز',
  device_recovery_approved: 'موافقة طارئة على جهاز',
  recovery_login: 'دخول بوضع الاسترجاع',
  totp_enrolled: 'تفعيل تطبيق المصادقة',
  totp_reset: 'إعادة ضبط التحقق بخطوتين',
  unlock_ok: 'فتح الخزنة',
  logout: 'تسجيل خروج',
  member_registered: 'تسجيل عضو جديد',
  member_approve: 'الموافقة على عضو',
  member_reject: 'رفض عضو',
  member_remove: 'إزالة عضو وتغيير مفتاح الخزنة',
  key_rotate: 'تغيير مفتاح الخزنة',
  rotation_prepare: 'تحضير تغيير مفتاح الخزنة',
  role_change: 'تغيير صلاحية',
  invite_create: 'إنشاء دعوة',
  invite_cancel: 'إلغاء دعوة',
  entry_create: 'إضافة حساب',
  entry_update: 'تعديل حساب',
  entry_delete: 'حذف حساب',
  entry_restore: 'استرجاع حساب محذوف',
  entry_purge: 'حذف نهائي لحساب',
  secret_view: 'عرض كلمة سر',
  secret_copy: 'نسخ كلمة سر',
  secret_edit: 'فتح كلمة سر للتعديل',
  reveal_limit_hit: 'تجاوز الحد المسموح لعرض كلمات السر',
  password_change: 'تغيير كلمة السر الرئيسية',
  backup_export: 'تنزيل نسخة احتياطية',
  backup_import: 'استرجاع نسخة احتياطية',
  gate_rotate: 'تغيير رابط الدخول',
  renewals_refresh: 'تحديث بيانات Hostinger و Render',
  billing_update: 'تعديل العملاء والأسعار في الفواتير',
};
const ALARMING = new Set(['login_fail', 'login_while_locked', 'account_locked', 'login_device_blocked', 'reveal_limit_hit', 'device_block', 'member_remove', 'recovery_login', 'device_recovery_approved', 'entry_purge']);

const STRENGTH = ['ضعيفة جدًا', 'ضعيفة', 'مقبولة', 'قوية', 'قوية جدًا'];

document.addEventListener('click', (e) => {
  document.querySelectorAll('details.menu[open]').forEach((m) => {
    if (!m.contains(e.target)) m.open = false;
  });
});

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function show(...nodes) {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  root.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

const toLatinDigits = (s) =>
  String(s).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

// Search normalisation: case, accents, Arabic hamza/taa marbuta/alef-maqsura forms, digits.
function norm(s) {
  return toLatinDigits(String(s || ''))
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ًͯ-ٰٟـ]/g, '')
    .replace(/ٱ/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const DAY_MS = 86_400_000;
// A plain date (YYYY-MM-DD), or a UTC time from the server counted by its UTC calendar day,
// so a domain ending 2026-11-30T23:59:59Z shows 30 November, the same date hPanel shows.
function parseDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z)?$/.exec(String(v || ''));
  const t = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function daysUntil(v) {
  const t = parseDay(v);
  if (t === null) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((t - today.getTime()) / DAY_MS);
}
function fmtDay(v) {
  const t = parseDay(v);
  return t === null ? '—' : new Intl.DateTimeFormat('ar-EG-u-nu-latn', { dateStyle: 'long' }).format(new Date(t));
}
function daysText(d) {
  if (d === null) return '';
  if (d < 0) return `انتهى منذ ${countLabel(-d, 'يوم واحد', 'يومين', 'أيام', 'يومًا')}`;
  if (d === 0) return 'ينتهي اليوم';
  return `بعد ${countLabel(d, 'يوم واحد', 'يومين', 'أيام', 'يومًا')}`;
}
const urgency = (d) => (d === null ? '' : d <= 7 ? 'tag-danger' : d <= 30 ? 'tag-warn' : '');

function safeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function pref(key, fallback) {
  try {
    return localStorage.getItem(`vault.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem(`vault.${key}`, String(value));
  } catch {
    /* storage unavailable */
  }
}

function textInput(value = '', opts = {}) {
  return h('input', { type: 'text', value, autocomplete: 'off', spellcheck: 'false', ...opts });
}
function ltrInput(value = '', opts = {}) {
  return textInput(value, { dir: 'ltr', autocapitalize: 'none', autocorrect: 'off', ...opts });
}
function passwordInput(opts = {}) {
  return h('input', { type: 'password', dir: 'ltr', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', ...opts });
}
const formError = () => h('p', { class: 'form-error', role: 'alert' });

function strengthMeter() {
  const label = h('span', { class: 'meter-label' });
  const el = h('div', { class: 'meter', dataset: { score: '' } }, h('span', { class: 'meter-track' }, h('span', { class: 'meter-bar' })), label);
  el.update = (pw) => {
    if (!pw) {
      el.dataset.score = '';
      label.textContent = '';
      return;
    }
    const { score } = vc.strength(pw);
    el.dataset.score = String(score);
    label.textContent = `قوة كلمة السر: ${STRENGTH[score]}`;
  };
  return el;
}

function masterPasswordRules(pw1, pw2) {
  if (pw1.length < 12) return 'كلمة السر الرئيسية يجب أن تكون 12 حرفًا على الأقل. الأفضل جملة طويلة يسهل تذكرها.';
  if (vc.strength(pw1).score < 2) return 'كلمة السر ضعيفة. أطِلها أو اخلط حروفًا كبيرة وصغيرة وأرقامًا ورموزًا.';
  if (pw1 !== pw2) return 'كلمتا السر غير متطابقتين.';
  return null;
}

let clipTimer = null;
let clipArmed = false;
async function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = h('textarea', { class: 'sr-only', readonly: true });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
async function copySecret(text, what) {
  try {
    await writeClipboard(text);
  } catch {
    toast('تعذّر النسخ. اضغط على الصفحة ثم حاول مرة أخرى.', 'error');
    return;
  }
  toast(`تم نسخ ${what}. ستُمسح من الحافظة بعد 30 ثانية.`);
  clipArmed = true;
  clearTimeout(clipTimer);
  clipTimer = setTimeout(clearClipboard, 30_000);
}
function clearClipboard() {
  if (!clipArmed) return;
  clipArmed = false;
  writeClipboard('').catch(() => {
    // The page had no focus; try again the next time it does.
    clipArmed = true;
    window.addEventListener('focus', clearClipboard, { once: true });
  });
}
async function copyPlain(text, what) {
  try {
    await writeClipboard(text);
    toast(`تم نسخ ${what}.`);
  } catch {
    toast('تعذّر النسخ.', 'error');
  }
}

function handleErr(ex) {
  if (ex instanceof ApiError && ex.code === 'key_changed') {
    toast(errorText(ex), 'error', 7000);
    lock(true);
    return;
  }
  if (ex instanceof ApiError && ex.code === 'no_session') return;
  toast(errorText(ex), 'error', 7000);
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: filename, class: 'sr-only' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// sign-in screens (dark steel, with the dial)
// ---------------------------------------------------------------------------
function authShell({ title, lead = null, body }) {
  const shell = h(
    'main',
    { class: 'auth' },
    h(
      'div',
      { class: 'auth-inner' },
      h('div', { class: 'auth-mark' }, dial(124)),
      h('h1', { class: 'auth-title' }, title),
      lead ? h('p', { class: 'auth-lead' }, lead) : null,
      h('div', { class: 'auth-panel' }, body),
      h('p', { class: 'auth-foot' }, icon('shield', 16), h('span', null, 'التشفير وفكّه يتمّان على جهازك فقط، وكلمة السر الرئيسية لا تُرسل إلى أي سيرفر.')),
    ),
  );
  return shell;
}
const working = (shell, on) => shell.classList.toggle('is-working', on);
function shake(shell) {
  shell.classList.remove('is-denied');
  void shell.offsetWidth;
  shell.classList.add('is-denied');
}

function showMessage({ title, text, fingerprint = null, action = null, secondary = null }) {
  const body = h(
    'div',
    { class: 'stack' },
    (Array.isArray(text) ? text : [text]).map((t) => h('p', null, t)),
    fingerprint ? h('p', { class: 'fingerprint mono', dir: 'ltr' }, fingerprint) : null,
    action ? button(action[0], { kind: 'primary', onClick: action[1] }) : null,
    secondary ? button(secondary[0], { kind: 'link', onClick: secondary[1] }) : null,
  );
  show(authShell({ title, body }));
}

function showLogin(prefill = '') {
  const user = ltrInput(prefill, { autocomplete: 'username', required: true, maxlength: 32 });
  const pw = passwordInput({ autocomplete: 'current-password', required: true });
  const err = formError();
  const submit = button('افتح الخزنة', { kind: 'primary', type: 'submit', iconName: 'lock' });
  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    field('اسم المستخدم', user),
    field('كلمة السر الرئيسية', pw),
    err,
    submit,
  );
  const shell = authShell({ title: S.appName, lead: 'سجّل الدخول لفتح خزنة الفريق.', body: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const username = user.value.trim().toLowerCase();
    if (!username || !pw.value) {
      err.textContent = 'اكتب اسم المستخدم وكلمة السر الرئيسية.';
      return;
    }
    setBusy(submit, true, 'جارٍ فتح الخزنة…');
    working(shell, true);
    try {
      const pre = await api.post('/auth/prelogin', { username });
      const { authKey, kek } = await vc.deriveFromPassword(pw.value, pre.kdfSalt, pre.kdfIter);
      const r = await api.post('/auth/login', { username, authKey });
      working(shell, false);
      await afterLogin(r, kek, username);
    } catch (ex) {
      working(shell, false);
      setBusy(submit, false);
      err.textContent = errorText(ex);
      pw.select();
      shake(shell);
    }
  });
  show(shell);
  (prefill ? pw : user).focus();
}

async function afterLogin(r, kek, username) {
  if (r.status === 'ok') return openVault(r, kek);
  if (r.status === 'device_pending') return showDevicePending(r.device, username);
  if (r.status === 'pending_approval') return showMemberPending(r.fingerprint, username);
  return showLogin(username);
}

function showDevicePending(device, username) {
  showMessage({
    title: 'هذا جهاز جديد',
    text: [
      'لحماية الخزنة، أي جهاز جديد يحتاج موافقة المدير قبل أن يفتحها.',
      `اطلب من المدير الموافقة على «${device}» من صفحة «الإدارة» ثم «الأجهزة»، وبعدها سجّل الدخول مرة أخرى.`,
    ],
    action: ['تسجيل الدخول بعد الموافقة', () => showLogin(username)],
  });
}

function showMemberPending(fp, username) {
  showMessage({
    title: 'حسابك جاهز وبانتظار موافقة المدير',
    text: [
      'أبلغ المدير أنك أنهيت التسجيل. عند موافقته يحصل حسابك على مفتاح الخزنة.',
      'للتأكد من أن أحدًا لم يتلاعب بمفتاحك، اقرأ للمدير هذه البصمة ليطابقها مع ما يظهر عنده:',
    ],
    fingerprint: fp,
    action: ['تسجيل الدخول بعد الموافقة', () => showLogin(username)],
  });
}

function showUnlock(sess) {
  const pw = passwordInput({ autocomplete: 'current-password', required: true });
  const err = formError();
  const submit = button('افتح الخزنة', { kind: 'primary', type: 'submit', iconName: 'lock' });
  const out = button('تسجيل الخروج', { kind: 'link' });
  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    h('p', { class: 'muted' }, `مسجّل باسم ${sess.username}`),
    field('كلمة السر الرئيسية', pw),
    err,
    submit,
    out,
  );
  const shell = authShell({ title: `أهلًا ${sess.displayName}`, lead: 'الخزنة مقفولة. اكتب كلمة السر الرئيسية لفتحها.', body: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!pw.value) return;
    setBusy(submit, true, 'جارٍ فتح الخزنة…');
    working(shell, true);
    try {
      const pre = await api.post('/auth/prelogin', { username: sess.username });
      const { authKey, kek } = await vc.deriveFromPassword(pw.value, pre.kdfSalt, pre.kdfIter);
      const r = await api.post('/auth/unlock', { authKey });
      working(shell, false);
      await openVault(r, kek);
    } catch (ex) {
      working(shell, false);
      setBusy(submit, false);
      if (ex instanceof ApiError && (ex.code === 'no_session' || ex.code === 'locked')) {
        showLogin(sess.username);
        toast(errorText(ex), 'error', 7000);
        return;
      }
      err.textContent = errorText(ex);
      pw.select();
      shake(shell);
    }
  });
  out.addEventListener('click', async () => {
    await api.post('/auth/logout').catch(() => {});
    S.user = null;
    showLogin(sess.username);
  });
  show(shell);
  pw.focus();
}

// Shared form for choosing a master password (first admin and invited members).
function masterPasswordForm({ intro, withName, submitLabel, onSubmit }) {
  const name = textInput('', { maxlength: 60, autocomplete: 'name' });
  const username = ltrInput('', { maxlength: 32, autocomplete: 'username', placeholder: 'ahmed' });
  const pw1 = passwordInput({ autocomplete: 'new-password' });
  const pw2 = passwordInput({ autocomplete: 'new-password' });
  const meter = strengthMeter();
  pw1.addEventListener('input', () => meter.update(pw1.value));
  const ack = h('input', { type: 'checkbox' });
  const err = formError();
  const submit = button(submitLabel, { kind: 'primary', type: 'submit' });
  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    intro,
    withName ? field('اسمك', name) : null,
    withName ? field('اسم المستخدم', username, 'حروف إنجليزية صغيرة وأرقام فقط، 3 أحرف على الأقل. ستستخدمه في كل تسجيل دخول.') : null,
    field('كلمة السر الرئيسية', pw1, 'جملة طويلة تتذكرها أفضل من كلمة قصيرة معقدة. مثال على الشكل: «قهوة الصبح على الكورنيش 2026!»'),
    meter,
    field('أعد كتابة كلمة السر الرئيسية', pw2),
    h('label', { class: 'check' }, ack, h('span', null, 'أفهم أن كلمة السر الرئيسية لا يمكن استرجاعها إذا نسيتها، وسأكتبها على ورقة وأحفظها في مكان آمن.')),
    err,
    submit,
  );
  const shellRef = { current: null };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (withName) {
      if (!name.value.trim()) return void (err.textContent = 'اكتب اسمك.');
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username.value.trim().toLowerCase())) {
        return void (err.textContent = 'اسم المستخدم: حروف إنجليزية صغيرة وأرقام (ويمكن . _ -)، من 3 إلى 32 حرفًا.');
      }
    }
    const rule = masterPasswordRules(pw1.value, pw2.value);
    if (rule) return void (err.textContent = rule);
    if (!ack.checked) return void (err.textContent = 'أكّد أنك حفظت كلمة السر في مكان آمن.');
    setBusy(submit, true, 'جارٍ إنشاء مفاتيح التشفير…');
    working(shellRef.current, true);
    try {
      await onSubmit({ displayName: name.value.trim(), username: username.value.trim().toLowerCase(), password: pw1.value });
    } catch (ex) {
      working(shellRef.current, false);
      setBusy(submit, false);
      err.textContent = errorText(ex);
    }
  });
  return { form, shellRef, focus: () => (withName ? name : pw1).focus() };
}

function showSetup() {
  const f = masterPasswordForm({
    intro: h('p', null, 'ستُنشئ الآن حساب المدير الأول. كلمة السر الرئيسية هي المفتاح الوحيد لفك تشفير الخزنة، ولا يوجد أي طريق لاسترجاعها.'),
    withName: true,
    submitLabel: 'إنشاء الخزنة',
    onSubmit: async ({ displayName, username, password }) => {
      const userId = vc.uuid();
      const salt = vc.newSalt();
      const { authKey, kek } = await vc.deriveFromPassword(password, salt, vc.KDF_ITER);
      const keys = await vc.createUserKeys(kek);
      const raw = vc.newVaultKeyRaw();
      let wrapped;
      try {
        wrapped = await vc.wrapVaultKey(raw, keys.publicKey, userId, 1);
      } finally {
        raw.fill(0);
      }
      const r = await api.post('/setup/start', {
        userId, username, displayName, kdfSalt: salt, kdfIter: vc.KDF_ITER, authKey,
        publicKey: keys.publicKey, encPrivateKey: keys.encPrivateKey, wrappedVaultKey: wrapped,
      });
      await openVault(r, kek);
    },
  });
  const shell = authShell({ title: 'تجهيز الخزنة لأول مرة', body: f.form });
  f.shellRef.current = shell;
  show(shell);
  f.focus();
}

async function showRegister(code) {
  let info;
  try {
    info = await api.post('/register/info', { inviteCode: code });
  } catch (ex) {
    return showMessage({
      title: 'رابط الدعوة غير صالح',
      text: errorText(ex),
      action: ['الذهاب لتسجيل الدخول', () => {
        history.replaceState(null, '', '/');
        showLogin();
      }],
    });
  }
  const f = masterPasswordForm({
    intro: h(
      'div',
      { class: 'stack-sm' },
      h('p', null, `دعاك المدير للانضمام باسم «${info.displayName}».`),
      h('p', null, 'اسم المستخدم الخاص بك: ', h('strong', { class: 'mono', dir: 'ltr' }, info.username)),
      h('p', { class: 'muted' }, 'اختر كلمة سر رئيسية خاصة بك. لا أحد غيرك يعرفها، ولا حتى المدير.'),
    ),
    withName: false,
    submitLabel: 'إنهاء التسجيل',
    onSubmit: async ({ password }) => {
      const userId = vc.uuid();
      const salt = vc.newSalt();
      const { authKey, kek } = await vc.deriveFromPassword(password, salt, vc.KDF_ITER);
      const keys = await vc.createUserKeys(kek);
      await api.post('/register/start', {
        inviteCode: code, userId, kdfSalt: salt, kdfIter: vc.KDF_ITER, authKey, publicKey: keys.publicKey, encPrivateKey: keys.encPrivateKey,
      });
      history.replaceState(null, '', '/');
      // Computed here from the key this browser generated, not taken from the server,
      // so a tampered server can't show a matching fingerprint for a swapped key.
      showMemberPending(await vc.fingerprint(keys.publicKey), info.username);
    },
  });
  const shell = authShell({ title: 'انضم إلى خزنة الفريق', body: f.form });
  f.shellRef.current = shell;
  show(shell);
  f.focus();
}

// ---------------------------------------------------------------------------
// unlocking, locking, guards
// ---------------------------------------------------------------------------
async function openVault(r, kek) {
  const privateKey = await vc.openPrivateKey(kek, r.keys.encPrivateKey);
  const vaultKey = await vc.unwrapVaultKey(r.keys.wrappedVaultKey, privateKey, r.user.id, r.keys.keyVersion);
  S.user = r.user;
  S.keys = {
    privateKey,
    vaultKey,
    keyVersion: r.keys.keyVersion,
    wrapped: r.keys.wrappedVaultKey,
    publicKey: r.keys.publicKey,
    encPrivateKey: r.keys.encPrivateKey,
  };
  if (location.hash) history.replaceState(null, '', '/');
  await loadEntries();
  showVault();
  startGuards();
}

async function loadEntries() {
  const r = await api.get('/entries');
  if (r.keyVersion !== S.keys.keyVersion) throw new ApiError(409, 'key_changed');
  const out = [];
  for (const e of r.entries) {
    try {
      out.push({ ...e, meta: await vc.openMeta(S.keys.vaultKey, e.id, e.keyVersion, e.meta) });
    } catch {
      out.push({ ...e, meta: { client: 'تعذّر فك تشفير هذا الحساب', platform: 'other', label: e.id }, broken: true });
    }
  }
  S.entries = out;
  S.users = r.users || {};
}

function wipe() {
  S.keys = null;
  S.entries = [];
  S.users = {};
  S.query = '';
  S.status = null;
  S.billing = null;
  S.alerts = [];
  S.seenMarks = new Set();
  S.hub = null;
  S.reportMonth = null;
  clearTimeout(clipTimer);
  clearClipboard();
}

function lock(manual) {
  if (!S.user || !S.keys) return;
  const sess = { username: S.user.username, displayName: S.user.displayName };
  wipe();
  showUnlock(sess);
  if (!manual) toast('قُفلت الخزنة تلقائيًا بعد فترة بدون نشاط.');
}

let guardsOn = false;
let lastActivity = Date.now();
let hiddenAt = 0;
const autoLockMs = () => {
  const m = Number(pref('autolock', 10));
  return (Number.isFinite(m) && m >= 1 ? m : 10) * 60_000;
};

function startGuards() {
  lastActivity = Date.now();
  if (guardsOn) return;
  guardsOn = true;
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, () => {
      lastActivity = Date.now();
    }, { passive: true, capture: true });
  }
  setInterval(() => {
    if (S.keys && Date.now() - lastActivity > autoLockMs()) lock(false);
  }, 10_000);
  setInterval(() => {
    if (S.keys && Date.now() - lastActivity < 5 * 60_000) api.post('/auth/ping').catch(() => {});
  }, 4 * 60_000);
  setInterval(() => {
    if (S.keys) refreshStatus();
  }, 2 * 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (S.keys && hiddenAt && Date.now() - hiddenAt > 5 * 60_000) lock(false);
  });
  window.addEventListener('keydown', (e) => {
    if (!S.keys || !S.searchEl || !S.searchEl.isConnected) return;
    const typing = e.target instanceof HTMLElement && e.target.matches('input, textarea, select');
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      S.searchEl.focus();
      S.searchEl.select();
    }
  });
}

let statusRetries = 0;
async function refreshStatus() {
  if (!S.user || S.user.role !== 'admin' || !S.keys) return;
  try {
    S.status = await api.get('/admin/status');
  } catch {
    return;
  }
  // Hostinger/Render data is fetched in the background the first time; look again shortly.
  if (S.status.renewalsPending && statusRetries < 4) {
    statusRetries += 1;
    setTimeout(refreshStatus, 5000);
  } else if (!S.status.renewalsPending) {
    statusRetries = 0;
  }
  renderBanners();
  document.querySelectorAll('[data-badge]').forEach((el) => {
    const n = (S.status.pendingMembers || 0) + (S.status.pendingDevices || 0);
    el.hidden = n === 0;
    el.textContent = n ? num(n) : '';
  });
  try {
    if (!S.billing) await loadBilling();
    await computeAlerts();
  } catch {
    /* alerts come back on the next refresh */
  }
  updateBell();
}

// ---------------------------------------------------------------------------
// vault: search + client wall + client panels
// ---------------------------------------------------------------------------
function topbar({ title, withSearch }) {
  const menu = h(
    'details',
    { class: 'menu' },
    h('summary', { class: 'btn btn-ghost-light btn-icon', 'aria-label': 'القائمة', title: 'القائمة' }, icon('menu'), h('span', { class: 'badge', dataset: { badge: '' }, hidden: true })),
    h(
      'div',
      { class: 'menu-pop' },
      h('p', { class: 'menu-who' }, h('strong', null, S.user.displayName), h('span', { class: 'mono', dir: 'ltr' }, S.user.username)),
      button('حسابي', { kind: 'menu', iconName: 'user', onClick: () => showAccount() }),
      S.user.role === 'admin'
        ? h('button', { type: 'button', class: 'btn btn-menu', onClick: () => showAdmin('team') }, icon('users', 18), h('span', null, 'الإدارة'), h('span', { class: 'badge', dataset: { badge: '' }, hidden: true }))
        : null,
      S.user.role === 'admin' ? button('الاشتراكات والفواتير', { kind: 'menu', iconName: 'calendar', onClick: () => showHub('alerts') }) : null,
      button('تسجيل الخروج', { kind: 'menu', iconName: 'logout', onClick: () => logout() }),
    ),
  );
  menu.addEventListener('click', (e) => {
    if (e.target.closest('.menu-pop button')) menu.open = false;
  });

  let search = null;
  if (withSearch) {
    search = h('input', {
      type: 'search', class: 'search-input', value: S.query, placeholder: 'ابحث باسم العميل… مثلًا Star Style',
      'aria-label': 'ابحث باسم العميل', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search',
    });
    search.addEventListener('input', () => {
      S.query = search.value;
      renderResults();
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && search.value) {
        e.preventDefault();
        setQuery('');
      }
    });
    S.searchEl = search;
  }
  const bar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, dial(34), h('span', null, title)),
    withSearch ? h('div', { class: 'search' }, icon('search'), search) : h('div', { class: 'search-spacer' }),
    h(
      'div',
      { class: 'top-actions' },
      withSearch
        ? button('إضافة حساب', { kind: 'primary', iconName: 'plus', onClick: () => openEntryForm() })
        : button('رجوع للخزنة', { kind: 'primary', iconName: 'back', onClick: () => showVault() }),
      S.user.role === 'admin'
        ? h('button', { type: 'button', class: 'btn btn-ghost-light btn-icon bell', title: 'التنبيهات', 'aria-label': 'التنبيهات', onClick: () => showHub('alerts') }, icon('bell'), h('span', { class: 'badge', dataset: { bell: '' }, hidden: true }))
        : null,
      button('', { kind: 'ghost-light', iconName: 'lock', title: 'قفل الخزنة الآن', onClick: () => lock(true) }),
      menu,
    ),
  );
  return bar;
}

function showVault() {
  const bar = topbar({ title: S.appName, withSearch: true });
  S.resultsEl = h('div', { class: 'results' });
  S.bannerEl = h('div', { class: 'banners' });
  show(bar, h('main', { class: 'vault' }, S.bannerEl, S.resultsEl));
  renderResults();
  renderBanners();
  updateBell();
  refreshStatus();
  if (window.matchMedia('(min-width: 760px)').matches) S.searchEl.focus();
}

function setQuery(q) {
  S.query = q;
  if (S.searchEl) S.searchEl.value = q;
  renderResults();
  window.scrollTo(0, 0);
}

function groupByClient(list) {
  const groups = new Map();
  for (const e of list) {
    const key = norm(e.meta.client) || '-';
    if (!groups.has(key)) groups.set(key, { name: e.meta.client || 'بدون اسم', items: [] });
    groups.get(key).items.push(e);
  }
  return [...groups.values()];
}

const uniqueClients = () => groupByClient(S.entries).map((g) => g.name).sort((a, b) => a.localeCompare(b, 'ar'));

function renderResults() {
  const el = S.resultsEl;
  if (!el) return;
  if (!S.entries.length) {
    el.replaceChildren(emptyVault());
    return;
  }
  const q = norm(S.query);
  if (!q) {
    el.replaceChildren(clientWall());
    return;
  }
  const tokens = q.split(' ');
  const compactQ = q.replace(/ /g, '');
  const matches = S.entries.filter((e) => {
    const hay = norm([e.meta.client, platformName(e.meta), platformOf(e.meta.platform).aka, e.meta.label, e.meta.username, e.meta.url, e.meta.hosting, e.meta.dbProvider].join(' '));
    return tokens.every((t) => hay.includes(t)) || hay.replace(/ /g, '').includes(compactQ);
  });
  if (!matches.length) {
    el.replaceChildren(noResults());
    return;
  }
  const scored = groupByClient(matches).map((g) => {
    const cn = norm(g.name);
    return { ...g, score: cn === q ? 3 : cn.startsWith(q) ? 2 : cn.includes(q) ? 1 : 0 };
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ar'));
  el.replaceChildren(
    h('div', { class: 'results-head' }, button('كل العملاء', { kind: 'link', iconName: 'back', onClick: () => setQuery('') })),
    ...scored.map((g) => clientPanel(g)),
  );
}

function emptyVault() {
  return h(
    'div',
    { class: 'empty' },
    h('h2', null, 'الخزنة فارغة'),
    h('p', null, 'أضف أول حساب: اكتب اسم العميل واختر المنصة، ثم بيانات الدخول. كل شيء يُشفَّر على جهازك قبل أن يُحفظ.'),
    button('إضافة أول حساب', { kind: 'primary', iconName: 'plus', onClick: () => openEntryForm() }),
  );
}

function noResults() {
  const q = S.query.trim();
  return h(
    'div',
    { class: 'empty' },
    h('h2', null, `لا يوجد عميل باسم «${q}»`),
    h('p', null, 'راجع طريقة كتابة الاسم، أو أضف حسابًا جديدًا لهذا العميل.'),
    h(
      'div',
      { class: 'row-gap' },
      button(`إضافة حساب لـ «${q}»`, { kind: 'primary', iconName: 'plus', onClick: () => openEntryForm(null, { client: q }) }),
      button('عرض كل العملاء', { kind: 'secondary', onClick: () => setQuery('') }),
    ),
  );
}

function clientWall() {
  const clients = groupByClient(S.entries).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return h(
    'section',
    { class: 'wall', 'aria-labelledby': 'wall-title' },
    h(
      'div',
      { class: 'wall-head' },
      h('h2', { id: 'wall-title' }, 'العملاء'),
      h('span', { class: 'muted' }, `${countLabel(clients.length, 'عميل واحد', 'عميلان', 'عملاء', 'عميلًا')}، ${countLabel(S.entries.length, 'حساب واحد', 'حسابان', 'حسابات', 'حسابًا')}`),
    ),
    h('div', { class: 'boxes' }, clients.map((c) => clientBox(c))),
  );
}

function clientBox(c) {
  const plats = [...new Set(c.items.map((e) => e.meta.platform))].sort((a, b) => platformRank(a) - platformRank(b));
  return h(
    'button',
    { type: 'button', class: 'box', onClick: () => setQuery(c.name), 'aria-label': `${c.name}: ${countLabel(c.items.length, 'حساب واحد', 'حسابان', 'حسابات', 'حسابًا')}` },
    h('span', { class: 'plate' }, h('bdi', { class: 'plate-text' }, c.name)),
    h(
      'span',
      { class: 'box-meta' },
      h('span', null, countLabel(c.items.length, 'حساب واحد', 'حسابان', 'حسابات', 'حسابًا')),
      h('span', { class: 'dots', 'aria-hidden': 'true' }, plats.slice(0, 7).map((p) => h('i', { class: 'dot', dataset: { p } }))),
    ),
  );
}

function clientPanel(g) {
  const items = [...g.items].sort((a, b) => platformRank(a.meta.platform) - platformRank(b.meta.platform) || String(a.meta.label || '').localeCompare(String(b.meta.label || ''), 'ar'));
  return h(
    'section',
    { class: 'client' },
    h(
      'header',
      { class: 'client-head' },
      h('h2', null, h('bdi', null, g.name)),
      h('span', { class: 'muted' }, countLabel(items.length, 'حساب واحد', 'حسابان', 'حسابات', 'حسابًا')),
      button('إضافة حساب لهذا العميل', { kind: 'secondary', small: true, iconName: 'plus', onClick: () => openEntryForm(null, { client: g.name }) }),
    ),
    h('ul', { class: 'rows' }, items.map((e) => entryRow(e))),
  );
}

async function fetchSecret(e, reason) {
  const r = await api.post(`/entries/${e.id}/secret`, { reason });
  return vc.openSecret(S.keys.vaultKey, e.id, r.keyVersion, r.secret);
}

function notesView(s) {
  const out = [];
  if (s.dbUrl) {
    out.push(h(
      'div',
      { class: 'note-block' },
      h('span', { class: 'cred-k' }, 'رابط قاعدة البيانات'),
      h('div', { class: 'cred' }, h('span', { class: 'cred-v mono', dir: 'ltr' }, s.dbUrl), button('نسخ', { kind: 'ghost', small: true, iconName: 'copy', title: 'نسخ رابط قاعدة البيانات', onClick: () => copySecret(s.dbUrl, 'رابط قاعدة البيانات') })),
    ));
  }
  if (s.notes) out.push(h('div', { class: 'note-block' }, h('span', { class: 'cred-k' }, 'ملاحظات سرية'), h('p', { class: 'note-text' }, s.notes)));
  if (Array.isArray(s.history) && s.history.length) {
    out.push(
      h(
        'div',
        { class: 'note-block' },
        h('span', { class: 'cred-k' }, 'كلمات سر سابقة'),
        h('ul', { class: 'history' }, s.history.map((x) => h('li', null, h('span', { class: 'mono', dir: 'ltr' }, x.password), h('span', { class: 'muted' }, `حتى ${fmtDate(x.changedAt)}`)))),
      ),
    );
  }
  return out;
}

const MASK = '••••••••••••';

function rowTags(m) {
  const tags = [];
  if (m.hosting) tags.push(h('span', { class: 'tag' }, 'الاستضافة: ', h('bdi', null, m.hosting)));
  if (m.dbProvider) tags.push(h('span', { class: 'tag' }, 'قاعدة البيانات: ', h('bdi', null, m.dbProvider)));
  if (m.renewAt) {
    const d = daysUntil(m.renewAt);
    tags.push(h('span', { class: `tag ${urgency(d)}`, title: fmtDay(m.renewAt) }, d !== null && d <= 30 ? `التجديد ${daysText(d)}` : `التجديد: ${fmtDay(m.renewAt)}`));
  }
  return tags.length ? h('div', { class: 'row-tags' }, tags) : null;
}

function entryRow(e) {
  const m = e.meta;
  const secretEl = h('span', { class: 'cred-v mono secret', dir: 'ltr' }, MASK);
  const extra = h('div', { class: 'row-extra', hidden: true });
  let timer = null;
  const showBtn = button('إظهار', { kind: 'ghost', small: true, iconName: 'eye' });
  const conceal = () => {
    clearTimeout(timer);
    secretEl.textContent = MASK;
    delete secretEl.dataset.shown;
    extra.hidden = true;
    extra.replaceChildren();
    showBtn.replaceChildren(icon('eye', 16), h('span', null, 'إظهار'));
  };
  showBtn.addEventListener('click', async () => {
    if (secretEl.dataset.shown) return conceal();
    setBusy(showBtn, true);
    try {
      const s = await fetchSecret(e, 'view');
      setBusy(showBtn, false);
      secretEl.textContent = s.password || '(بدون كلمة سر)';
      secretEl.dataset.shown = '1';
      const notes = notesView(s);
      extra.replaceChildren(...notes);
      extra.hidden = notes.length === 0;
      showBtn.replaceChildren(icon('eyeOff', 16), h('span', null, 'إخفاء'));
      timer = setTimeout(conceal, 30_000);
    } catch (ex) {
      setBusy(showBtn, false);
      handleErr(ex);
    }
  });
  const copyPw = button('نسخ', { kind: 'ghost', small: true, iconName: 'copy', title: 'نسخ كلمة السر' });
  copyPw.addEventListener('click', async () => {
    try {
      const s = await fetchSecret(e, 'copy');
      await copySecret(s.password || '', 'كلمة السر');
    } catch (ex) {
      handleErr(ex);
    }
  });
  const link = safeUrl(m.url);
  const who = S.users[e.updatedBy];
  return h(
    'li',
    { class: `row${e.broken ? ' is-broken' : ''}` },
    h(
      'div',
      { class: 'row-id' },
      h('span', { class: 'plat' }, h('i', { class: 'dot', dataset: { p: m.platform } }), h('span', null, platformName(m))),
      m.label ? h('bdi', { class: 'row-label' }, m.label) : null,
      rowTags(m),
    ),
    h(
      'div',
      { class: 'cred' },
      h('span', { class: 'cred-k' }, 'اسم المستخدم'),
      h('span', { class: 'cred-v mono', dir: 'ltr' }, m.username || '—'),
      m.username ? button('نسخ', { kind: 'ghost', small: true, iconName: 'copy', title: 'نسخ اسم المستخدم', onClick: () => copyPlain(m.username, 'اسم المستخدم') }) : null,
    ),
    h('div', { class: 'cred' }, h('span', { class: 'cred-k' }, 'كلمة السر'), secretEl, showBtn, copyPw),
    h(
      'div',
      { class: 'row-actions' },
      link ? h('a', { class: 'btn btn-ghost btn-sm', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 16), h('span', null, 'فتح الموقع')) : null,
      e.broken ? null : button('تعديل', { kind: 'ghost', small: true, iconName: 'edit', onClick: () => openEntryForm(e) }),
    ),
    extra,
    h('p', { class: 'row-foot' }, `آخر تعديل ${relTime(e.updatedAt)}${who ? ` بواسطة ${who}` : ''}`),
  );
}

// ---------------------------------------------------------------------------
// add / edit
// ---------------------------------------------------------------------------
async function openEntryForm(entry = null, preset = {}) {
  const editing = !!entry;
  let secret = { password: '', notes: '', history: [] };
  if (editing) {
    try {
      secret = await fetchSecret(entry, 'edit');
    } catch (ex) {
      return handleErr(ex);
    }
  }
  const m = editing ? entry.meta : { client: preset.client || '', platform: 'instagram', label: '', username: '', url: '' };

  const client = textInput(m.client, { list: 'client-options', maxlength: 80, dir: 'auto' });
  const options = h('datalist', { id: 'client-options' }, uniqueClients().map((n) => h('option', { value: n })));
  const platform = h('select', null, PLATFORMS.map((p) => h('option', { value: p.id, selected: p.id === m.platform }, p.name)));
  const customName = textInput(m.platformName || '', { maxlength: 40 });
  const customField = field('اسم المنصة', customName);
  customField.hidden = m.platform !== 'other';
  platform.addEventListener('change', () => {
    customField.hidden = platform.value !== 'other';
  });
  const label = textInput(m.label || '', { maxlength: 100, dir: 'auto' });
  const username = ltrInput(m.username || '', { maxlength: 200 });
  // A text field masked with CSS, so browsers never offer to save clients' passwords.
  const pw = ltrInput(secret.password || '', { class: 'mono masked', maxlength: 500, 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
  const meter = strengthMeter();
  meter.update(pw.value);
  pw.addEventListener('input', () => meter.update(pw.value));
  const eye = button('', { kind: 'ghost', iconName: 'eye', title: 'إظهار أو إخفاء كلمة السر' });
  eye.addEventListener('click', () => {
    pw.classList.toggle('masked');
    eye.replaceChildren(icon(pw.classList.contains('masked') ? 'eye' : 'eyeOff', 18));
  });
  const gen = button('توليد كلمة سر قوية', { kind: 'secondary', small: true, iconName: 'spark' });
  gen.addEventListener('click', () => {
    pw.value = vc.generatePassword(20);
    pw.classList.remove('masked');
    eye.replaceChildren(icon('eyeOff', 18));
    meter.update(pw.value);
  });
  const url = ltrInput(m.url || '', { inputmode: 'url', maxlength: 500, placeholder: 'https://' });
  const hosting = textInput(m.hosting || '', { list: 'hosting-options', maxlength: 80, dir: 'auto' });
  const dbProvider = textInput(m.dbProvider || '', { list: 'db-options', maxlength: 80, dir: 'auto' });
  const dbUrl = ltrInput(secret.dbUrl || '', { class: 'mono masked', maxlength: 2000, placeholder: 'postgresql://…', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
  const dbEye = button('', { kind: 'ghost', iconName: 'eye', title: 'إظهار أو إخفاء رابط قاعدة البيانات' });
  dbEye.addEventListener('click', () => {
    dbUrl.classList.toggle('masked');
    dbEye.replaceChildren(icon(dbUrl.classList.contains('masked') ? 'eye' : 'eyeOff', 18));
  });
  const renewAt = h('input', { type: 'date', value: m.renewAt || '', dir: 'ltr' });
  const techOpen = !!(m.hosting || m.dbProvider || secret.dbUrl || m.renewAt) || ['system', 'website', 'hosting', 'store'].includes(m.platform);
  const tech = h(
    'details',
    { class: 'tech', open: techOpen },
    h('summary', null, 'تفاصيل البرنامج والتجديد (اختياري)'),
    h(
      'div',
      { class: 'stack' },
      h('datalist', { id: 'hosting-options' }, ['Render', 'Hostinger', 'Vercel', 'Netlify', 'Cloudflare', 'Firebase', 'VPS'].map((n) => h('option', { value: n }))),
      h('datalist', { id: 'db-options' }, ['Neon', 'Render Postgres', 'Supabase', 'Hostinger MySQL', 'MongoDB Atlas', 'Firebase', 'PlanetScale'].map((n) => h('option', { value: n }))),
      h('div', { class: 'grid-2' }, field('مكان الاستضافة', hosting), field('مكان قاعدة البيانات', dbProvider)),
      field('رابط قاعدة البيانات (سري ومشفر)', h('div', { class: 'pw-wrap' }, dbUrl, dbEye)),
      field('تاريخ التجديد أو الانتهاء', renewAt, 'سننبّه المدير قبلها بشهر: دومين، استضافة، اشتراك برنامج، أو أي شيء له تاريخ.'),
    ),
  );
  const notes = h('textarea', { rows: 4, maxlength: 5000, spellcheck: 'false' });
  notes.value = secret.notes || '';
  const err = formError();
  const formId = `entry-${Math.random().toString(36).slice(2)}`;
  const form = h(
    'form',
    { id: formId, class: 'stack', novalidate: true },
    options,
    field('العميل', client, 'اكتب اسم العميل بنفس الطريقة دائمًا. لتجده بالعربي والإنجليزي اكتب الاثنين، مثل: Star Style - ستار ستايل'),
    h('div', { class: 'grid-2' }, field('المنصة', platform), customField),
    field('وصف الحساب (اختياري)', label, 'مثلًا: اسم الصفحة، أو «حساب الإعلانات الرئيسي».'),
    field('اسم المستخدم أو الإيميل أو رقم الموبايل', username),
    h('div', { class: 'field' }, h('label', { for: pw.id || (pw.id = `${formId}-pw`) }, 'كلمة السر'), h('div', { class: 'pw-wrap' }, pw, eye), h('div', { class: 'pw-tools' }, meter, gen)),
    field('رابط تسجيل الدخول (اختياري)', url),
    field('ملاحظات سرية (اختياري)', notes, 'أكواد الاسترجاع، الرقم المربوط بالحساب، من معه التحقق بخطوتين… تُشفَّر مثل كلمة السر.'),
    tech,
    err,
  );
  const save = button(editing ? 'حفظ التعديلات' : 'حفظ الحساب', { kind: 'primary', type: 'submit', iconName: 'check' });
  save.setAttribute('form', formId);
  const cancel = button('إلغاء', { kind: 'secondary' });
  const del = editing ? button('حذف الحساب', { kind: 'danger-ghost', iconName: 'trash' }) : null;
  const dlg = modal({ title: editing ? 'تعديل الحساب' : 'إضافة حساب', body: form, footer: [save, cancel, del], wide: true });
  cancel.addEventListener('click', dlg.close);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const clientName = client.value.replace(/\s+/g, ' ').trim();
    if (!clientName) return void (err.textContent = 'اكتب اسم العميل.');
    if (platform.value === 'other' && !customName.value.trim()) return void (err.textContent = 'اكتب اسم المنصة.');
    const meta = {
      client: clientName,
      platform: platform.value,
      platformName: platform.value === 'other' ? customName.value.trim() : undefined,
      label: label.value.trim(),
      username: username.value.trim(),
      url: url.value.trim(),
      hosting: hosting.value.trim() || undefined,
      dbProvider: dbProvider.value.trim() || undefined,
      renewAt: /^\d{4}-\d{2}-\d{2}$/.test(renewAt.value) ? renewAt.value : undefined,
    };
    let history = Array.isArray(secret.history) ? secret.history : [];
    if (editing && secret.password && pw.value !== secret.password) {
      history = [{ password: secret.password, changedAt: new Date().toISOString() }, ...history].slice(0, 5);
    }
    const secretOut = { password: pw.value, notes: notes.value, history, dbUrl: dbUrl.value.trim() || undefined };
    setBusy(save, true, 'جارٍ التشفير والحفظ…');
    try {
      const id = editing ? entry.id : vc.uuid();
      const kv = S.keys.keyVersion;
      const sealed = await vc.sealEntry(S.keys.vaultKey, id, kv, meta, secretOut);
      if (editing) await api.put(`/entries/${id}`, { keyVersion: kv, ...sealed });
      else await api.post('/entries', { id, keyVersion: kv, ...sealed });
      const now = new Date().toISOString();
      const record = { id, keyVersion: kv, meta, createdAt: editing ? entry.createdAt : now, createdBy: editing ? entry.createdBy : S.user.id, updatedAt: now, updatedBy: S.user.id };
      S.entries = editing ? S.entries.map((x) => (x.id === id ? record : x)) : [record, ...S.entries];
      S.users[S.user.id] = S.user.displayName;
      dlg.close();
      toast(editing ? 'تم حفظ التعديلات.' : 'تم حفظ الحساب في الخزنة.');
      setQuery(clientName);
      renderBanners();
    } catch (ex) {
      setBusy(save, false);
      if (ex instanceof ApiError && ex.code === 'key_changed') {
        dlg.close();
        return handleErr(ex);
      }
      err.textContent = errorText(ex);
    }
  });

  if (del) {
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'حذف هذا الحساب؟',
        text: `سيُنقل حساب ${platformName(m)} الخاص بـ «${m.client}» إلى المحذوفات، ويستطيع المدير استرجاعه.`,
        confirmLabel: 'حذف الحساب',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/entries/${entry.id}`);
        S.entries = S.entries.filter((x) => x.id !== entry.id);
        dlg.close();
        toast('تم حذف الحساب.');
        renderResults();
        renderBanners();
      } catch (ex) {
        handleErr(ex);
      }
    });
  }
  (preset.client || editing ? username : client).focus();
}

// ---------------------------------------------------------------------------
// banners for admins
// ---------------------------------------------------------------------------
function renderBanners() {
  const el = S.bannerEl;
  if (!el || !el.isConnected) return;
  const st = S.status;
  if (!st || !S.user || S.user.role !== 'admin') {
    el.replaceChildren();
    return;
  }
  const items = [];
  if (st.recoveryUser) {
    items.push(banner('danger', `وضع الاسترجاع مفعّل للمستخدم ${st.recoveryUser}. احذف المتغير RECOVERY_USER من إعدادات Render فور الانتهاء.`));
  }
  const soon = [
    ...S.entries.filter((e) => e.meta.renewAt).map((e) => ({ title: `${e.meta.client}: ${platformName(e.meta)}`, days: daysUntil(e.meta.renewAt) })),
    ...(st.renewals || []).map((x) => ({ title: x.title, days: daysUntil(x.at) })),
  ].filter((x) => x.days !== null && x.days <= 30).sort((a, b) => a.days - b.days);
  if (soon.length) {
    items.push(banner(
      soon[0].days <= 7 ? 'danger' : 'warn',
      [`${countLabel(soon.length, 'تجديد واحد', 'تجديدان', 'تجديدات', 'تجديدًا')} خلال 30 يومًا. الأقرب: «`, h('bdi', null, soon[0].title), `» ${daysText(soon[0].days)}.`],
      ['عرض التنبيهات', () => showHub('alerts')],
      'calendar',
    ));
  }
  const pend = (st.pendingMembers || 0) + (st.pendingDevices || 0);
  if (pend) {
    items.push(banner('info', `${countLabel(pend, 'طلب واحد', 'طلبان', 'طلبات', 'طلبًا')} بانتظار موافقتك (أعضاء أو أجهزة جديدة).`, ['مراجعة', () => showAdmin(st.pendingMembers ? 'team' : 'devices')]));
  }
  const backupDays = st.lastBackupAt ? (Date.now() - new Date(st.lastBackupAt).getTime()) / 86400_000 : Infinity;
  if (st.dbPlan !== 'free' && st.entries > 0 && backupDays > 14) {
    items.push(banner('warn', st.lastBackupAt ? `آخر نسخة احتياطية مشفرة كانت ${relTime(st.lastBackupAt)}. نزّل نسخة جديدة واحفظها خارج الإنترنت.` : 'لم تُنزَّل أي نسخة احتياطية مشفرة بعد. نزّل نسخة واحفظها في مكان آمن خارج الإنترنت.', ['النسخ الاحتياطي', () => showAdmin('backup')]));
  }
  if (st.dbPlan === 'free' && st.dbCreatedAt) {
    const left = Math.ceil((new Date(st.dbCreatedAt).getTime() + 30 * 86400_000 - Date.now()) / 86400_000);
    const backupAge = st.lastBackupAt ? (Date.now() - new Date(st.lastBackupAt).getTime()) / 86400_000 : Infinity;
    if (left <= 10 || backupAge > 7) {
      const txt = left > 0
        ? `قاعدة البيانات المجانية على Render تنتهي خلال ${countLabel(left, 'يوم واحد', 'يومين', 'أيام', 'يومًا')}. نزّل نسخة احتياطية مشفرة بانتظام، أو رقِّ قاعدة البيانات لخطة مدفوعة.`
        : 'انتهت مدة قاعدة البيانات المجانية على Render. رقِّها لخطة مدفوعة خلال 14 يومًا أو ستُحذف البيانات.';
      items.push(banner(left <= 10 ? 'danger' : 'warn', txt, ['النسخ الاحتياطي', () => showAdmin('backup')]));
    }
  }
  el.replaceChildren(...items);
}

function banner(kind, text, action = null, iconName = null) {
  return h(
    'div',
    { class: `banner banner-${kind}`, role: kind === 'danger' ? 'alert' : null },
    icon(iconName || (kind === 'info' ? 'users' : 'alert'), 18),
    h('p', null, text),
    action ? button(action[0], { kind: 'secondary', small: true, onClick: action[1] }) : null,
  );
}

// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------
async function logout() {
  await api.post('/auth/logout').catch(() => {});
  const u = S.user ? S.user.username : '';
  wipe();
  S.user = null;
  showLogin(u);
}

async function showAccount() {
  const fp = await vc.fingerprint(S.keys.publicKey);
  const lockSel = h('select', null, [5, 10, 15, 30].map((n) => h('option', { value: String(n), selected: String(n) === String(pref('autolock', 10)) }, `${num(n)} دقائق`)));
  lockSel.addEventListener('change', () => {
    setPref('autolock', lockSel.value);
    toast('تم حفظ مدة القفل التلقائي على هذا الجهاز.');
  });
  const cur = passwordInput({ autocomplete: 'current-password' });
  const p1 = passwordInput({ autocomplete: 'new-password' });
  const p2 = passwordInput({ autocomplete: 'new-password' });
  const meter = strengthMeter();
  p1.addEventListener('input', () => meter.update(p1.value));
  const err = formError();
  const save = button('تغيير كلمة السر الرئيسية', { kind: 'primary', type: 'submit' });
  const form = h('form', { class: 'stack', novalidate: true }, field('كلمة السر الحالية', cur), field('كلمة السر الجديدة', p1), meter, field('أعد كتابة الجديدة', p2), err, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const rule = masterPasswordRules(p1.value, p2.value);
    if (rule) return void (err.textContent = rule);
    setBusy(save, true, 'جارٍ إعادة تشفير مفتاحك…');
    try {
      const pre = await api.post('/auth/prelogin', { username: S.user.username });
      const now = await vc.deriveFromPassword(cur.value, pre.kdfSalt, pre.kdfIter);
      let enc;
      try {
        const salt = vc.newSalt();
        const next = await vc.deriveFromPassword(p1.value, salt, vc.KDF_ITER);
        enc = { salt, next, encPrivateKey: await vc.rewrapPrivateKey(now.kek, S.keys.encPrivateKey, next.kek) };
      } catch {
        throw new ApiError(401, 'bad_password');
      }
      await api.post('/account/password', { currentAuthKey: now.authKey, kdfSalt: enc.salt, kdfIter: vc.KDF_ITER, authKey: enc.next.authKey, encPrivateKey: enc.encPrivateKey });
      S.keys.encPrivateKey = enc.encPrivateKey;
      m.close();
      toast('تم تغيير كلمة السر الرئيسية، وتم تسجيل خروج أجهزتك الأخرى.');
    } catch (ex) {
      setBusy(save, false);
      err.textContent = errorText(ex);
    }
  });
  const m = modal({
    title: 'حسابي',
    body: h(
      'div',
      { class: 'stack' },
      h('dl', { class: 'facts' },
        h('dt', null, 'الاسم'), h('dd', null, S.user.displayName),
        h('dt', null, 'اسم المستخدم'), h('dd', { class: 'mono', dir: 'ltr' }, S.user.username),
        h('dt', null, 'الصلاحية'), h('dd', null, S.user.role === 'admin' ? 'مدير' : 'عضو'),
        h('dt', null, 'بصمة مفتاحك'), h('dd', { class: 'mono', dir: 'ltr' }, fp)),
      field('القفل التلقائي بعد عدم النشاط', lockSel),
      h('h3', null, 'تغيير كلمة السر الرئيسية'),
      form,
    ),
  });
}

// ---------------------------------------------------------------------------
// administration
// ---------------------------------------------------------------------------
const ADMIN_TABS = [
  ['team', 'الفريق', 'users'],
  ['devices', 'الأجهزة', 'device'],
  ['audit', 'سجل النشاط', 'list'],
  ['backup', 'النسخ الاحتياطي', 'download'],
  ['gate', 'رابط الدخول', 'link'],
  ['trash', 'المحذوفات', 'trash'],
];

function showAdmin(tab = 'team') {
  if (!S.user || S.user.role !== 'admin') return;
  if (tab === 'renewals') return void showHub('alerts');
  S.searchEl = null;
  const panel = h('div', { class: 'admin-panel', role: 'tabpanel' });
  const nav = h(
    'nav',
    { class: 'tabs', role: 'tablist', 'aria-label': 'أقسام الإدارة' },
    ADMIN_TABS.map(([id, label, ic]) => h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(id === tab), onClick: () => showAdmin(id) }, icon(ic, 18), h('span', null, label))),
  );
  show(topbar({ title: 'الإدارة', withSearch: false }), h('main', { class: 'admin' }, nav, panel));
  updateBell();
  refreshStatus();
  const render = { team: renderTeam, devices: renderDevices, audit: renderAudit, backup: renderBackup, gate: renderGate, trash: renderTrash }[tab];
  render(panel).catch((ex) => panel.replaceChildren(h('div', { class: 'empty' }, h('p', null, errorText(ex)))));
}

const section = (title, ...kids) => h('section', { class: 'card' }, h('h2', null, title), ...kids);
const loading = () => h('p', { class: 'muted loading' }, 'جارٍ التحميل…');

async function renderTeam(panel) {
  panel.replaceChildren(loading());
  const d = await api.get('/admin/users');
  const pending = d.users.filter((u) => u.status === 'pending_approval');
  const active = d.users.filter((u) => u.status === 'active');
  panel.replaceChildren(...[
    pending.length ? section('بانتظار موافقتك', h('div', { class: 'stack' }, await Promise.all(pending.map((u) => pendingMember(u, panel))))) : null,
    section('دعوة عضو جديد', inviteForm(panel)),
    section('أعضاء الفريق', h('ul', { class: 'people' }, active.map((u) => memberItem(u, panel)))),
    d.invites.length
      ? section('دعوات لم تُستخدم بعد', h('ul', { class: 'people' }, d.invites.map((i) => h(
        'li',
        { class: 'person' },
        h('div', { class: 'person-id' }, h('strong', null, i.displayName), h('span', { class: 'mono', dir: 'ltr' }, i.username)),
        h('span', { class: 'muted' }, `تنتهي ${relTimeFuture(i.expiresAt)}`),
        button('إلغاء الدعوة', { kind: 'danger-ghost', small: true, onClick: async () => {
          try {
            await api.del(`/admin/invites/${i.id}`);
            toast('تم إلغاء الدعوة.');
            renderTeam(panel);
          } catch (ex) {
            handleErr(ex);
          }
        } }),
      ))))
      : null,
  ].filter(Boolean));
}

function relTimeFuture(value) {
  const hours = Math.max(1, Math.round((new Date(value).getTime() - Date.now()) / 3600_000));
  return `بعد ${countLabel(hours, 'ساعة واحدة', 'ساعتين', 'ساعات', 'ساعة')}`;
}

async function pendingMember(u, panel) {
  const fp = await vc.fingerprint(u.publicKey);
  const approve = button('موافقة ومنحه مفتاح الخزنة', { kind: 'primary', small: true, iconName: 'check' });
  const reject = button('رفض', { kind: 'danger-ghost', small: true });
  approve.addEventListener('click', async () => {
    setBusy(approve, true, 'جارٍ مشاركة المفتاح…');
    let raw = null;
    try {
      raw = await vc.unwrapVaultKeyRaw(S.keys.wrapped, S.keys.privateKey, S.user.id, S.keys.keyVersion);
      const wrapped = await vc.wrapVaultKey(raw, u.publicKey, u.id, S.keys.keyVersion);
      await api.post(`/admin/users/${u.id}/approve`, { keyVersion: S.keys.keyVersion, wrapped });
      toast(`تمت الموافقة على ${u.displayName}.`);
      refreshStatus();
      renderTeam(panel);
    } catch (ex) {
      setBusy(approve, false);
      handleErr(ex);
    } finally {
      if (raw) raw.fill(0);
    }
  });
  reject.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `رفض ${u.displayName}؟`, text: 'سيُحذف هذا الحساب الجديد، ويمكنك دعوته لاحقًا من جديد.', confirmLabel: 'رفض وحذف', danger: true });
    if (!ok) return;
    try {
      await api.del(`/admin/users/${u.id}`);
      toast('تم رفض الحساب.');
      refreshStatus();
      renderTeam(panel);
    } catch (ex) {
      handleErr(ex);
    }
  });
  return h(
    'div',
    { class: 'pending' },
    h('div', { class: 'person-id' }, h('strong', null, u.displayName), h('span', { class: 'mono', dir: 'ltr' }, u.username), h('span', { class: 'tag' }, u.role === 'admin' ? 'مدير' : 'عضو')),
    h('p', null, 'اطلب منه قراءة البصمة الظاهرة على شاشته، ووافق فقط إذا كانت مطابقة لهذه:'),
    h('p', { class: 'fingerprint mono', dir: 'ltr' }, fp),
    h('div', { class: 'row-gap' }, approve, reject),
  );
}

function inviteForm(panel) {
  const name = textInput('', { maxlength: 60 });
  const username = ltrInput('', { maxlength: 32, placeholder: 'sara' });
  const role = h('select', null, h('option', { value: 'member' }, 'عضو: يرى ويضيف ويعدّل الحسابات'), h('option', { value: 'admin' }, 'مدير: كل ما سبق + إدارة الفريق'));
  const err = formError();
  const result = h('div', { class: 'invite-result', hidden: true });
  const submit = button('إنشاء رابط الدعوة', { kind: 'primary', type: 'submit', iconName: 'link' });
  const form = h('form', { class: 'stack', novalidate: true }, h('div', { class: 'grid-2' }, field('الاسم', name), field('اسم المستخدم', username)), field('الصلاحية', role), err, submit, result);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const un = username.value.trim().toLowerCase();
    if (!name.value.trim()) return void (err.textContent = 'اكتب الاسم.');
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(un)) return void (err.textContent = 'اسم المستخدم: حروف إنجليزية صغيرة وأرقام (ويمكن . _ -)، من 3 إلى 32 حرفًا.');
    setBusy(submit, true, 'جارٍ الإنشاء…');
    try {
      const r = await api.post('/admin/invites', { username: un, displayName: name.value.trim(), role: role.value });
      setBusy(submit, false);
      const linkBox = ltrInput(r.link, { readOnly: true, class: 'mono link-box' });
      linkBox.readOnly = true;
      result.replaceChildren(
        h('p', null, h('strong', null, 'ابعت هذا الرابط للشخص بنفسك (واتساب مثلًا).'), ' يعمل مرة واحدة فقط وخلال 72 ساعة. بعد تسجيله ستظهر لك موافقته هنا.'),
        h('div', { class: 'pw-wrap' }, linkBox, button('نسخ الرابط', { kind: 'secondary', iconName: 'copy', onClick: () => copyPlain(r.link, 'رابط الدعوة') })),
      );
      result.hidden = false;
      name.value = '';
      username.value = '';
    } catch (ex) {
      setBusy(submit, false);
      err.textContent = errorText(ex);
    }
  });
  return form;
}

function memberItem(u, panel) {
  const self = u.id === S.user.id;
  const actions = [];
  if (!self) {
    actions.push(button(u.role === 'admin' ? 'جعله عضوًا' : 'جعله مديرًا', { kind: 'ghost', small: true, onClick: () => adminAct(`/admin/users/${u.id}/role`, { role: u.role === 'admin' ? 'member' : 'admin' }, 'تم تغيير الصلاحية.', panel) }));
  }
  if (u.locked) actions.push(button('فك القفل', { kind: 'secondary', small: true, onClick: () => adminAct(`/admin/users/${u.id}/unlock`, {}, 'تم فك القفل.', panel) }));
  if (!self) {
    actions.push(button('إزالة من الفريق', { kind: 'danger-ghost', small: true, iconName: 'trash', onClick: () => removeMember(u, panel) }));
  }
  return h(
    'li',
    { class: 'person' },
    h(
      'div',
      { class: 'person-id' },
      h('strong', null, u.displayName, self ? ' (أنت)' : ''),
      h('span', { class: 'mono', dir: 'ltr' }, u.username),
      h('span', { class: `tag${u.role === 'admin' ? ' tag-admin' : ''}` }, u.role === 'admin' ? 'مدير' : 'عضو'),
      u.locked ? h('span', { class: 'tag tag-danger' }, 'مقفول') : null,
    ),
    h('span', { class: 'muted' }, `آخر دخول: ${relTime(u.lastLoginAt)}`),
    h('div', { class: 'row-gap' }, actions),
  );
}

async function adminAct(url, body, done, panel) {
  try {
    await api.post(url, body);
    toast(done);
    renderTeam(panel);
  } catch (ex) {
    handleErr(ex);
  }
}

async function removeMember(u, panel) {
  const ok = await confirmDialog({
    title: `إزالة ${u.displayName} من الفريق؟`,
    text: [
      'سيُحذف حسابه فورًا ويُسجَّل خروجه من كل أجهزته.',
      'وللأمان سيتم تغيير مفتاح الخزنة وإعادة تشفير كل الحسابات على جهازك الآن، حتى لا ينفعه أي شيء احتفظ به.',
      'مهم: غيّر كلمات سر الحسابات الحساسة التي كان يعرفها.',
    ],
    confirmLabel: 'إزالة وتغيير المفتاح',
    danger: true,
  });
  if (!ok) return;
  const progress = modal({ title: 'جارٍ تغيير مفتاح الخزنة…', body: h('p', null, 'لا تغلق الصفحة. تتم إعادة تشفير كل الحسابات على جهازك.') });
  try {
    await rotateVault(u.id);
    progress.close();
    toast(`تمت إزالة ${u.displayName} وتغيير مفتاح الخزنة.`);
    renderTeam(panel);
  } catch (ex) {
    progress.close();
    handleErr(ex);
  }
}

async function rotateVault(removeUserId) {
  const d = await api.get('/admin/rotation');
  if (d.keyVersion !== S.keys.keyVersion) throw new ApiError(409, 'key_changed');
  const newVersion = d.keyVersion + 1;
  const raw = vc.newVaultKeyRaw();
  try {
    const newKey = await vc.importVaultKey(raw);
    const entries = [];
    for (const e of d.entries) {
      const meta = await vc.openMeta(S.keys.vaultKey, e.id, e.keyVersion, e.meta);
      const secret = await vc.openSecret(S.keys.vaultKey, e.id, e.keyVersion, e.secret);
      entries.push({ id: e.id, ...(await vc.sealEntry(newKey, e.id, newVersion, meta, secret)) });
    }
    const wraps = [];
    for (const u of d.users) {
      if (u.id !== removeUserId) wraps.push({ userId: u.id, wrapped: await vc.wrapVaultKey(raw, u.publicKey, u.id, newVersion) });
    }
    // The admins' billing document moves to the new key too.
    let billing = null;
    if (d.billing) billing = await vc.sealDoc(newKey, 'billing', newVersion, await vc.openDoc(S.keys.vaultKey, 'billing', d.billing.keyVersion, d.billing.blob));
    await api.post('/admin/rotate', { fromVersion: d.keyVersion, newVersion, revision: d.revision, removeUserId, entries, wraps, billing, billingRevision: d.billing ? d.billing.revision : undefined });
    S.billing = null;
    S.keys.vaultKey = newKey;
    S.keys.keyVersion = newVersion;
    S.keys.wrapped = wraps.find((w) => w.userId === S.user.id).wrapped;
  } finally {
    raw.fill(0);
  }
  await loadEntries();
}

// ---------------------------------------------------------------------------
// subscriptions & invoices: alerts, the Hostinger and Render windows, the monthly report
// ---------------------------------------------------------------------------
const HOSTINGER_DOMAINS_URL = 'https://hpanel.hostinger.com/domains';
const HOSTINGER_BILLING_URL = 'https://hpanel.hostinger.com/billing/subscriptions';
const HOSTINGER_INVOICES_URL = 'https://hpanel.hostinger.com/billing/payment-history/paid';
const HOSTINGER_CARDS_URL = 'https://hpanel.hostinger.com/billing/payment-methods';
const HOSTINGER_EMAILS_URL = 'https://hpanel.hostinger.com/emails';
const HOSTINGER_WEBSITES_URL = 'https://hpanel.hostinger.com/websites';
const RENDER_BILLING_URL = 'https://dashboard.render.com/billing';
const SUB_STATUS = { active: 'فعّال', not_renewing: 'لن يتجدد', non_renewing: 'لن يتجدد', cancelled: 'ملغي', paused: 'متوقف مؤقتًا', in_trial: 'تجريبي', transferred: 'منقول', future: 'لم يبدأ' };
const SUB_KIND = { domain: 'دومين', email: 'إيميل', hosting: 'استضافة', vps: 'VPS', addon: 'خدمة إضافية', other: 'أخرى' };
const DOMAIN_STATUS = { active: 'فعّال', expired: 'منتهي', pending_setup: 'قيد الإعداد', requested: 'مطلوب', pending_verification: 'بانتظار التحقق', deleted: 'محذوف', suspended: 'موقوف', failed: 'فشل' };
const SITE_TYPE = { wordpress: 'WordPress', builder: 'Website Builder', horizons: 'Horizons', nodejs: 'Node.js', other: 'موقع' };
const SERVICE_TYPE = { web_service: 'موقع / API', static_site: 'موقع ثابت', private_service: 'خدمة داخلية', background_worker: 'عامل خلفي', cron_job: 'مهمة مجدولة' };
const ALERT_SOURCE = {
  entry: 'تاريخ مسجّل في الخزنة',
  extra: 'تكلفة مضافة يدويًا',
  hostinger_domain: 'دومين على Hostinger',
  hostinger_subscription: 'اشتراك على Hostinger',
  hostinger_mail: 'إيميل على Hostinger',
  hostinger_card: 'بطاقة الدفع على Hostinger',
  render_database: 'قاعدة بيانات مجانية على Render',
};
const ALERT_GROUPS = [
  ['due', 'منتهي أو مستحق اليوم'],
  ['week', 'خلال أسبوع'],
  ['month', 'خلال شهر'],
  ['two_months', 'خلال شهرين'],
];
const PROVIDER_LABEL = { hostinger: 'Hostinger', render: 'Render', vault: 'الخزنة', other: 'أخرى' };
const STATE_LABEL = { charged: 'تم الخصم', past: 'مضى موعده', auto: 'خصم تلقائي', manual: 'يحتاج تجديد يدوي', monthly: 'فاتورة شهرية', recurring: 'متكرر' };
const CURRENCIES = ['EUR', 'USD', 'EGP', 'SAR', 'AED', 'KWD', 'QAR', 'JOD', 'TRY', 'GBP'];
const PERIODS = [[1, 'شهريًا'], [3, 'كل 3 شهور'], [6, 'كل 6 شهور'], [12, 'سنويًا'], [24, 'كل سنتين'], [0, 'مرة واحدة']];
const INTEGRATION_ERRORS = {
  auth: 'المفتاح (التوكن) غير صحيح أو انتهت صلاحيته. أنشئ مفتاحًا جديدًا وضعه في Render.',
  timeout: 'الخدمة لم ترد في الوقت المناسب. جرّب «تحديث» بعد قليل.',
  network: 'تعذّر الوصول للخدمة. جرّب «تحديث» بعد قليل.',
  rate_limited: 'طلبات كثيرة على الخدمة. جرّب بعد دقائق.',
  http_404: 'غير متاح في هذا الحساب.',
};
const integrationError = (code) => INTEGRATION_ERRORS[code] || `تعذّر جلب البيانات (${code}).`;


// An amount and its currency as one left-to-right unit (U+2066…U+2069), so Arabic text around
// it can't reorder "250 USD + 15 EUR" into something unreadable.
function money(v, cur) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(v));
  return `\u2066${n}${cur ? `\u00a0${cur}` : ''}\u2069`;
}
function periodText(count, unit) {
  const m = bl.periodMonths(count, unit);
  if (!m) return '';
  if (m === 1) return 'شهريًا';
  if (m === 12) return 'سنويًا';
  if (m === 24) return 'كل سنتين';
  if (m % 12 === 0) return `كل ${num(m / 12)} سنوات`;
  return `كل ${num(m)} شهور`;
}
const moneyBag = (bag) => (Object.keys(bag).length ? Object.entries(bag).map(([c, v]) => money(v, c === '—' ? '' : c)).join(' + ') : '—');
const extLink = (url, label, kind = 'secondary') => (url ? h('a', { class: `btn btn-${kind} btn-sm`, href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 16), h('span', null, label)) : null);
const monthName = (key) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(bl.monthRange(key).start));
const dayTag = (v) => {
  const d = bl.daysFrom(v);
  return d === null ? null : h('span', { class: `tag ${urgency(d)}` }, daysText(d));
};

// The vault's own dates and account details, for alerts and for guessing a domain's client.
function vaultDates() {
  return S.entries.map((e) => ({
    id: e.id,
    client: e.meta.client,
    title: `${e.meta.client}: ${platformName(e.meta)}${e.meta.label ? ` (${e.meta.label})` : ''}`,
    renewAt: e.meta.renewAt,
    url: e.meta.url,
    username: e.meta.username,
    label: e.meta.label,
    hosting: e.meta.hosting,
  }));
}

// ---- the billing document (encrypted with the vault key, admins only) ----
async function loadBilling() {
  if (!S.user || S.user.role !== 'admin' || !S.keys) return null;
  const r = await api.get('/admin/billing');
  const doc = r.blob ? await vc.openDoc(S.keys.vaultKey, 'billing', r.keyVersion, r.blob) : bl.emptyDoc(vc.toB64(vc.randomBytes(32)));
  doc.items = doc.items && typeof doc.items === 'object' ? doc.items : {};
  doc.extras = Array.isArray(doc.extras) ? doc.extras : [];
  doc.noticeSalt ||= vc.toB64(vc.randomBytes(32));
  S.billing = { doc, revision: r.revision || 0, hmac: await vc.hmacKey(doc.noticeSalt) };
  if (!r.blob) {
    try {
      await updateBilling(() => {});
    } catch {
      /* another admin created it first; it loads next time */
    }
  }
  return S.billing;
}

// Applies a change to a fresh copy and saves it; if another admin saved first, retries on theirs.
async function updateBilling(mutate) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!S.billing) await loadBilling();
    const doc = structuredClone(S.billing.doc);
    mutate(doc);
    const blob = await vc.sealDoc(S.keys.vaultKey, 'billing', S.keys.keyVersion, doc);
    try {
      const r = await api.put('/admin/billing', { keyVersion: S.keys.keyVersion, blob, revision: S.billing.revision });
      S.billing.doc = doc;
      S.billing.revision = r.revision;
      return;
    } catch (ex) {
      if (!(ex instanceof ApiError && ex.code === 'billing_changed') || attempt) throw ex;
      S.billing = null;
    }
  }
}

const knownClients = () => [...new Set([
  ...S.entries.map((e) => e.meta.client),
  ...Object.values((S.billing && S.billing.doc.items) || {}).map((x) => x.client),
  ...((S.billing && S.billing.doc.extras) || []).map((x) => x.client),
].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));

const noteFor = (key) => (S.billing && S.billing.doc.items[key]) || {};

// ---- alerts (bell) ----
async function computeAlerts() {
  if (!S.status || !S.billing) return [];
  const list = bl.alertItems({ renewals: S.status.renewals || [], entries: vaultDates(), extras: S.billing.doc.extras });
  const seen = new Set([...(S.status.noticeReads || []), ...S.seenMarks]);
  for (const x of list) {
    x.mark = await vc.hmacHex(S.billing.hmac, bl.alertLabel(x));
    x.read = seen.has(x.mark);
    x.client ||= noteFor(x.key).client || '';
  }
  S.alerts = list;
  return list;
}

function updateBell() {
  const n = (S.alerts || []).filter((x) => !x.read).length;
  document.querySelectorAll('[data-bell]').forEach((el) => {
    el.hidden = n === 0;
    el.textContent = n ? num(n) : '';
  });
}

async function markSeen(list) {
  const marks = list.filter((x) => !x.read).map((x) => x.mark);
  for (let i = 0; i < marks.length; i += 500) await api.post('/admin/notices/read', { keys: marks.slice(i, i + 500) });
  for (const m of marks) S.seenMarks.add(m);
  for (const x of list) x.read = true;
  for (const x of S.alerts || []) if (S.seenMarks.has(x.mark)) x.read = true;
  updateBell();
}

// ---- the hub ----
const HUB_TABS = [
  ['alerts', 'التنبيهات', 'bell'],
  ['hostinger', 'Hostinger', 'globe'],
  ['render', 'Render', 'server'],
  ['report', 'التقرير الشهري', 'chart'],
];

function showHub(tab = 'alerts') {
  if (!S.user || S.user.role !== 'admin') return;
  S.searchEl = null;
  const panel = h('div', { class: 'admin-panel', role: 'tabpanel' });
  const nav = h(
    'nav',
    { class: 'tabs no-print', role: 'tablist', 'aria-label': 'أقسام الاشتراكات والفواتير' },
    HUB_TABS.map(([id, label, ic]) => h(
      'button',
      { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(id === tab), onClick: () => showHub(id) },
      icon(ic, 18),
      h('span', null, label),
      id === 'alerts' ? h('span', { class: 'badge', dataset: { bell: '' }, hidden: true }) : null,
    )),
  );
  show(topbar({ title: 'الاشتراكات والفواتير', withSearch: false }), h('main', { class: 'admin hub' }, nav, panel));
  updateBell();
  const draw = { alerts: renderAlerts, hostinger: renderHostingerTab, render: renderRenderTab, report: renderReport }[tab];
  draw(panel).catch((ex) => panel.replaceChildren(h('div', { class: 'empty' }, h('p', null, errorText(ex)))));
}

// Provider data, cached for a minute in memory (the server caches it for 30 minutes).
async function hubData(force = false) {
  if (!force && S.hub && Date.now() - S.hub.at < 60_000) return S.hub.data;
  const data = await api.get(force ? '/admin/renewals?refresh=1' : '/admin/renewals');
  S.hub = { data, at: Date.now() };
  return data;
}

function refreshButton(redraw) {
  const b = button('تحديث الآن من Hostinger و Render', { kind: 'secondary', small: true, iconName: 'restore' });
  b.addEventListener('click', async () => {
    setBusy(b, true, 'جارٍ التحديث…');
    try {
      await hubData(true);
      await refreshStatus();
      toast('تم تحديث البيانات من Hostinger و Render.');
      redraw();
    } catch (ex) {
      setBusy(b, false);
      handleErr(ex);
    }
  });
  return b;
}

// While the server is still fetching provider data, look again shortly.
function pollWhileLoading(d, panel, redraw) {
  if (!((d.hostinger && d.hostinger.loading) || (d.render && d.render.loading))) return;
  setTimeout(async () => {
    if (!panel.isConnected) return;
    try {
      S.hub = null;
      await hubData();
      redraw();
    } catch {
      /* keep the current view */
    }
  }, 4000);
}

async function ensureHubBasics() {
  if (!S.status) await refreshStatus();
  if (!S.billing) await loadBilling();
}

// ---- tab: alerts ----
function alertLink(x) {
  switch (x.source) {
    case 'hostinger_domain':
      return extLink(HOSTINGER_DOMAINS_URL, 'تجديد من Hostinger');
    case 'hostinger_subscription':
      return extLink(HOSTINGER_BILLING_URL, 'الاشتراك على Hostinger');
    case 'hostinger_mail':
      return extLink(HOSTINGER_EMAILS_URL, 'الإيميلات على Hostinger');
    case 'hostinger_card':
      return extLink(HOSTINGER_CARDS_URL, 'تحديث البطاقة');
    case 'render_database':
      return extLink(x.link || 'https://dashboard.render.com/', 'فتح في Render');
    default:
      return null;
  }
}

function alertRow(x, redraw) {
  const extra = [];
  if (x.problem === 'expired') extra.push('البطاقة منتهية، حدّثها حتى لا يفشل أي تجديد');
  else if (x.problem === 'suspended') extra.push('البطاقة موقوفة، حدّثها حتى لا يفشل أي تجديد');
  else if (x.source === 'hostinger_card') extra.push(`تنتهي صلاحية البطاقة${x.isDefault ? ' الأساسية' : ''}، أضف بطاقة جديدة قبلها`);
  if (x.source === 'hostinger_subscription') extra.push(x.autoRenew ? 'سيُخصم تلقائيًا' : 'التجديد التلقائي متوقف، يحتاج تجديد يدوي');
  if (x.price) extra.push(money(x.price, x.currency));
  if (x.client) extra.push(`العميل: ${x.client}`);
  const seen = button(x.read ? 'تمت القراءة' : 'تعليم كمقروء', { kind: 'ghost', small: true, iconName: 'check' });
  seen.disabled = x.read;
  seen.addEventListener('click', async () => {
    setBusy(seen, true);
    try {
      await markSeen([x]);
      redraw();
    } catch (ex) {
      setBusy(seen, false);
      handleErr(ex);
    }
  });
  return h(
    'li',
    { class: `person alert-item${x.read ? ' is-read' : ''}` },
    h('div', { class: 'person-id' }, x.read ? null : h('span', { class: 'dot', title: 'جديد' }), h('span', { class: `tag ${urgency(x.days)}` }, daysText(x.days)), h('strong', null, h('bdi', null, x.title))),
    h('span', { class: 'muted stack-xs' }, h('span', null, `${ALERT_SOURCE[x.source] || ''}: ${fmtDay(x.day)}`), extra.length ? h('span', null, extra.join('، ')) : null),
    h(
      'div',
      { class: 'row-gap' },
      alertLink(x),
      x.entryId ? button('فتح في الخزنة', { kind: 'ghost', small: true, onClick: () => {
        showVault();
        setQuery(x.client || '');
      } }) : null,
      seen,
    ),
  );
}

async function renderAlerts(panel) {
  panel.replaceChildren(loading());
  await ensureHubBasics();
  await computeAlerts();
  const draw = () => {
    updateBell();
    const list = S.alerts || [];
    const unread = list.filter((x) => !x.read);
    const all = button('تعليم الكل كمقروء', { kind: 'secondary', small: true, iconName: 'check' });
    all.disabled = !unread.length;
    all.addEventListener('click', async () => {
      setBusy(all, true);
      try {
        await markSeen(list);
        draw();
      } catch (ex) {
        setBusy(all, false);
        handleErr(ex);
      }
    });
    const pending = S.status && S.status.renewalsPending;
    panel.replaceChildren(...[
      section(
        'التنبيهات',
        h('p', { class: 'muted' }, 'لكل دومين وإيميل واستضافة واشتراك وبطاقة دفع: تنبيه قبل الموعد بشهرين، ثم قبله بشهر، ثم في الأسبوع الأخير، ثم يوم الاستحقاق. كل مرحلة جديدة تظهر كتنبيه جديد حتى لو قرأت السابق.'),
        pending ? h('p', { class: 'muted loading' }, 'جارٍ جلب بيانات Hostinger و Render…') : null,
        h('div', { class: 'row-gap' }, all, refreshButton(() => renderAlerts(panel))),
      ),
      ...ALERT_GROUPS.map(([stage, title]) => {
        const items = list.filter((x) => x.stage === stage);
        return items.length ? section(`${title} (${num(items.length)})`, h('ul', { class: 'people' }, items.map((x) => alertRow(x, draw)))) : null;
      }),
      list.length ? null : section('لا توجد تنبيهات', h('p', { class: 'muted' }, 'لا شيء ينتهي أو يُخصم خلال الشهرين القادمين.')),
    ].filter(Boolean));
    if (pending) {
      setTimeout(async () => {
        if (!panel.isConnected) return;
        await refreshStatus();
        await computeAlerts();
        draw();
      }, 5000);
    }
  };
  draw();
}

// ---- assigning a charge to a client, with what we charge them ----
function currencySelect(value) {
  const list = [...new Set([value, ...CURRENCIES].filter(Boolean))];
  return h('select', null, list.map((c) => h('option', { value: c, selected: c === value }, c)));
}

function clientInput(value) {
  const id = `clients-${Math.random().toString(36).slice(2, 8)}`;
  const input = textInput(value || '', { list: id, autocomplete: 'off', maxlength: 80, placeholder: 'اسم العميل كما في الخزنة' });
  return h('div', null, input, h('datalist', { id }, knownClients().map((c) => h('option', { value: c }))));
}

const readNumber = (input) => {
  const t = input.value.trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n < 1e8 ? Math.round(n * 100) / 100 : NaN;
};

function editCharge({ key, title, cost = null, currency = '', guessed = '' }, after) {
  const cur = noteFor(key);
  const clientBox = clientInput(cur.client || guessed || '');
  const client = clientBox.querySelector('input');
  const sell = ltrInput(cur.sell ?? '', { inputmode: 'decimal', placeholder: '0' });
  const sellCur = currencySelect(cur.sellCurrency || currency || 'EUR');
  const costIn = ltrInput(cur.cost ?? '', { inputmode: 'decimal', placeholder: cost === null ? '' : String(cost) });
  const costCur = currencySelect(cur.costCurrency || currency || 'USD');
  const note = textInput(cur.note || '', { maxlength: 200 });
  const err = formError();
  const save = button('حفظ', { kind: 'primary', type: 'submit' });
  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    h('p', { class: 'muted' }, h('bdi', null, title)),
    field('العميل', clientBox, guessed && !cur.client ? 'اقتراح من حسابات العميل في الخزنة، عدّله إن لزم.' : 'اختر عميلًا من الخزنة أو اكتب اسمًا جديدًا.'),
    h('div', { class: 'grid-2' }, field('المطلوب من العميل', sell, 'المبلغ الذي ستطلبه من العميل مقابل هذا البند.'), field('العملة', sellCur)),
    h('div', { class: 'grid-2' }, field('التكلفة علينا (اختياري)', costIn, cost === null ? 'السعر غير معروف من المزوّد، اكتبه هنا.' : `اتركه فارغًا لاستخدام سعر المزوّد (${money(cost, currency)}).`), field('عملة التكلفة', costCur)),
    field('ملاحظة (اختياري)', note),
    err,
  );
  const m = modal({ title: 'العميل والسعر', body: form, footer: [save, button('إلغاء', { kind: 'secondary', onClick: () => m.close() })] });
  save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const s1 = readNumber(sell);
    const c1 = readNumber(costIn);
    if (Number.isNaN(s1) || Number.isNaN(c1)) return void (err.textContent = 'اكتب المبالغ أرقامًا فقط، مثلًا 25 أو 12.5');
    const item = {};
    if (client.value.trim()) item.client = client.value.trim().slice(0, 80);
    if (s1 !== null) {
      item.sell = s1;
      item.sellCurrency = sellCur.value;
    }
    if (c1 !== null) {
      item.cost = c1;
      item.costCurrency = costCur.value;
    }
    if (note.value.trim()) item.note = note.value.trim().slice(0, 200);
    setBusy(save, true, 'جارٍ الحفظ…');
    try {
      await updateBilling((doc) => {
        if (Object.keys(item).length) doc.items[key] = item;
        else delete doc.items[key];
      });
      m.close();
      toast('تم حفظ العميل والسعر.');
      after();
    } catch (ex) {
      setBusy(save, false);
      handleErr(ex);
    }
  });
  client.focus();
}

function clientLine(key, guessed) {
  const n = noteFor(key);
  const parts = [];
  if (n.client) parts.push(`العميل: ${n.client}`);
  else if (guessed) parts.push(`العميل (اقتراح): ${guessed}`);
  if (n.sell !== undefined) parts.push(`نطلب منه ${money(n.sell, n.sellCurrency)}`);
  return parts.length ? h('span', null, parts.join('، ')) : null;
}

function assignButton(spec, after) {
  return button(noteFor(spec.key).client ? 'تعديل العميل والسعر' : 'ربط بعميل', { kind: 'ghost', small: true, iconName: 'user', onClick: () => editCharge(spec, after) });
}

function listBlock(title, rows, open = false) {
  return h('details', { class: 'tech', open }, h('summary', null, title), rows.length ? h('ul', { class: 'people' }, rows) : h('p', { class: 'muted' }, 'لا يوجد شيء.'));
}

function stat(label, value, tone = '') {
  return h('div', { class: `stat${tone ? ` stat-${tone}` : ''}` }, h('b', null, value), h('span', null, label));
}

function partErrors(errors, names) {
  const bad = (errors || []).map((e) => e.split(':')).filter(([k]) => names[k]);
  return bad.length ? h('p', { class: 'muted' }, `تعذّر جلب: ${bad.map(([k, c]) => `${names[k]} (${integrationError(c)})`).join('، ')}`) : null;
}

// ---- tab: Hostinger ----
async function renderHostingerTab(panel) {
  panel.replaceChildren(loading());
  await ensureHubBasics();
  const d = await hubData();
  const redraw = () => renderHostingerTab(panel);
  const x = d.hostinger;
  if (!x || x.notConfigured) return void panel.replaceChildren(section('Hostinger', connectGuide('hostinger')));
  if (x.loading) {
    panel.replaceChildren(section('Hostinger', h('p', { class: 'muted loading' }, 'جارٍ جلب البيانات من Hostinger…')));
    return void pollWhileLoading(d, panel, redraw);
  }
  if (x.error) return void panel.replaceChildren(section('Hostinger', h('p', { class: 'form-error' }, integrationError(x.error)), h('div', { class: 'row-gap' }, refreshButton(redraw))));

  const entries = vaultDates();
  const subs = x.subscriptions || [];
  const subById = new Map(subs.map((s) => [s.id, s]));
  const subLine = (sub) => {
    if (!sub) return null;
    const when = bl.subDate(sub);
    const bits = [`${sub.autoRenew ? 'يُخصم تلقائيًا' : 'تجديد يدوي'} ${when ? fmtDay(when) : ''}`.trim()];
    if (sub.renewalPrice !== null) bits.push(money(sub.renewalPrice, sub.currency));
    return h('span', null, bits.join(' — '));
  };
  const spec = (s) => ({ key: `hs:${s.id}`, title: s.title || s.name, cost: s.renewalPrice, currency: s.currency, guessed: bl.guessClient(bl.domainOf(s), entries) || '' });

  // Websites (real domains first; Hostinger's temporary addresses last)
  const sites = (x.websites || []).slice().sort((a, b) => Number(a.temporary) - Number(b.temporary) || String(a.domain).localeCompare(String(b.domain)));
  const siteRows = sites.map((w) => {
    const sub = w.subscriptionId && subById.get(w.subscriptionId);
    return h(
      'li',
      { class: 'person' },
      h('div', { class: 'person-id' }, h('strong', null, h('bdi', null, w.domain || '(بدون دومين)')), h('span', { class: 'tag' }, SITE_TYPE[w.type] || w.type || 'موقع'), w.temporary ? h('span', { class: 'tag' }, 'رابط مؤقت') : null, w.enabled ? null : h('span', { class: 'tag tag-danger' }, 'موقوف')),
      h('span', { class: 'muted stack-xs' }, h('span', null, `الخطة: ${w.plan || '—'}`), subLine(sub), sub ? clientLine(`hs:${sub.id}`, bl.guessClient(w.domain, entries)) : null),
      h('div', { class: 'row-gap' }, sub ? dayTag(bl.subDate(sub)) : null, sub ? assignButton(spec(sub), redraw) : null),
    );
  });

  // Domains (one row per name; the copy with an end date wins)
  const byName = new Map();
  for (const dm of x.domains || []) {
    const prev = byName.get(dm.name);
    if (!prev || (!prev.expiresAt && dm.expiresAt)) byName.set(dm.name, dm);
  }
  const domains = [...byName.values()].sort((a, b) => (Date.parse(a.expiresAt) || Infinity) - (Date.parse(b.expiresAt) || Infinity));
  const domainRows = domains.map((dm) => {
    const sub = dm.subscriptionId && subById.get(dm.subscriptionId);
    return h(
      'li',
      { class: 'person' },
      h('div', { class: 'person-id' }, h('strong', null, h('bdi', null, dm.name || '—')), h('span', { class: `tag${dm.status === 'expired' ? ' tag-danger' : ''}` }, DOMAIN_STATUS[dm.status] || dm.status)),
      h('span', { class: 'muted stack-xs' }, h('span', null, dm.expiresAt ? `ينتهي ${fmtDay(dm.expiresAt)}` : 'بدون تاريخ انتهاء'), subLine(sub), sub ? clientLine(`hs:${sub.id}`, bl.guessClient(dm.name, entries)) : null),
      h('div', { class: 'row-gap' }, dm.expiresAt ? dayTag(dm.expiresAt) : null, sub ? assignButton(spec(sub), redraw) : null),
    );
  });

  // E-mail
  const mailRows = (x.mailOrders || []).map((mo) => {
    const sub = mo.subscriptionId && subById.get(mo.subscriptionId);
    return h(
      'li',
      { class: 'person' },
      h('div', { class: 'person-id' }, h('strong', null, h('bdi', null, mo.domain || '—')), h('span', { class: 'tag' }, mo.plan || 'E-mail'), mo.trial ? h('span', { class: 'tag tag-warn' }, 'تجريبي') : null, mo.status === 'suspended' ? h('span', { class: 'tag tag-danger' }, 'موقوف') : null),
      h('span', { class: 'muted stack-xs' }, h('span', null, `${countLabel(mo.seats || 0, 'صندوق بريد واحد', 'صندوقان', 'صناديق بريد', 'صندوق بريد')}${mo.expiresAt ? ` — ينتهي ${fmtDay(mo.expiresAt)}` : ''}`), subLine(sub), sub ? clientLine(`hs:${sub.id}`, bl.guessClient(mo.domain, entries)) : null),
      h('div', { class: 'row-gap' }, mo.expiresAt ? dayTag(mo.expiresAt) : null, sub ? assignButton(spec(sub), redraw) : null),
    );
  });

  // Subscriptions (everything Hostinger charges for)
  const subRows = subs
    .slice()
    .sort((a, b) => (Date.parse(bl.subDate(a)) || Infinity) - (Date.parse(bl.subDate(b)) || Infinity))
    .map((s) => {
      const when = bl.subDate(s);
      const live = bl.LIVE.has(s.status);
      return h(
        'li',
        { class: 'person' },
        h(
          'div',
          { class: 'person-id' },
          h('strong', null, h('bdi', null, s.title || s.name)),
          h('span', { class: 'tag' }, SUB_KIND[s.kind] || s.kind),
          h('span', { class: `tag${['non_renewing', 'not_renewing', 'cancelled'].includes(s.status) ? ' tag-warn' : ''}` }, SUB_STATUS[s.status] || s.status),
          s.autoRenew && live ? h('span', { class: 'tag tag-admin' }, 'تجديد تلقائي') : null,
        ),
        h(
          'span',
          { class: 'muted stack-xs' },
          h('span', null, `${when ? `${s.autoRenew && live ? 'الخصم القادم' : 'ينتهي'} ${fmtDay(when)}` : '—'}${s.renewalPrice !== null ? ` — ${money(s.renewalPrice, s.currency)}` : ''}${periodText(s.periodCount, s.periodUnit) ? ` ${periodText(s.periodCount, s.periodUnit)}` : ''}`),
          s.websites && s.websites.length > 1 ? h('span', null, `خطة ${s.plan || ''} تستضيف ${countLabel(s.websites.length, 'موقعًا واحدًا', 'موقعين', 'مواقع', 'موقعًا')}`.replace('  ', ' ')) : null,
          clientLine(`hs:${s.id}`, bl.guessClient(bl.domainOf(s), entries)),
        ),
        h('div', { class: 'row-gap' }, live && when ? dayTag(when) : null, assignButton(spec(s), redraw)),
      );
    });

  // Payment cards
  const cardRows = (x.paymentMethods || []).map((c) => h(
    'li',
    { class: 'person' },
    h('div', { class: 'person-id' }, h('strong', null, h('bdi', null, [c.name, c.identifier].filter(Boolean).join(' '))), c.isDefault ? h('span', { class: 'tag tag-admin' }, 'الأساسية') : null, c.expired ? h('span', { class: 'tag tag-danger' }, 'منتهية') : null, c.suspended ? h('span', { class: 'tag tag-danger' }, 'موقوفة') : null),
    h('span', { class: 'muted' }, c.expiresAt ? `تنتهي ${fmtDay(c.expiresAt)}` : '—'),
    c.expiresAt && !c.expired ? dayTag(c.expiresAt) : h('span'),
  ));

  const in30 = subs.filter((s) => s.autoRenew && bl.LIVE.has(s.status) && s.nextBillingAt && (bl.daysFrom(s.nextBillingAt) ?? 99) <= 30 && bl.daysFrom(s.nextBillingAt) >= 0);
  const due30 = {};
  for (const s of in30) if (s.renewalPrice) due30[s.currency || '—'] = Math.round(((due30[s.currency || '—'] || 0) + s.renewalPrice) * 100) / 100;
  const manualSoon = subs.filter((s) => !s.autoRenew && bl.LIVE.has(s.status) && s.expiresAt && (bl.daysFrom(s.expiresAt) ?? 99) <= 60).length;
  const cardIssue = (x.paymentMethods || []).some((c) => c.expired || c.suspended || ((bl.daysFrom(c.expiresAt) ?? 999) <= 60));

  panel.replaceChildren(
    section(
      'Hostinger',
      h('p', { class: 'muted' }, `آخر تحديث ${relTime(x.fetchedAt)}${x.lastError ? ` (آخر محاولة فشلت: ${integrationError(x.lastError)})` : ''}`),
      h(
        'div',
        { class: 'stats' },
        stat('المواقع', num(siteRows.length)),
        stat('الدومينات', num(domainRows.length)),
        stat('الإيميلات', num(mailRows.length)),
        stat('الاشتراكات', num(subRows.length)),
        stat('يُخصم تلقائيًا خلال 30 يومًا', moneyBag(due30)),
        stat('تحتاج تجديد يدوي خلال شهرين', num(manualSoon), manualSoon ? 'warn' : ''),
      ),
      cardIssue ? h('p', { class: 'banner banner-warn' }, icon('card', 18), h('span', null, 'بطاقة الدفع على Hostinger منتهية أو تنتهي قريبًا. أضف بطاقة جديدة حتى لا يفشل أي تجديد تلقائي.')) : null,
      partErrors(x.errors, { websites: 'المواقع', hosting_orders: 'خطط الاستضافة', mail: 'الإيميلات', payment_methods: 'بطاقات الدفع', domains: 'الدومينات', subscriptions: 'الاشتراكات' }),
      h(
        'div',
        { class: 'row-gap' },
        refreshButton(redraw),
        extLink(HOSTINGER_INVOICES_URL, 'الفواتير (PDF) في hPanel'),
        extLink(HOSTINGER_BILLING_URL, 'الاشتراكات في hPanel'),
      ),
    ),
    section('المواقع', h('p', { class: 'muted' }, 'كل المواقع على الاستضافة، مع خطة كل موقع وموعد تجديدها.'), listBlock(`المواقع (${num(siteRows.length)})`, siteRows, siteRows.length <= 12)),
    section('الدومينات', listBlock(`الدومينات (${num(domainRows.length)})`, domainRows, true)),
    section('الإيميلات', listBlock(`الإيميلات (${num(mailRows.length)})`, mailRows, true)),
    section('الاشتراكات والمدفوعات', h('p', { class: 'muted' }, 'كل ما يُدفع لـ Hostinger. اربط كل اشتراك بعميله والمبلغ الذي تطلبه منه، ليظهر في التقرير الشهري.'), listBlock(`الاشتراكات (${num(subRows.length)})`, subRows, true)),
    section('بطاقات الدفع', listBlock(`البطاقات (${num(cardRows.length)})`, cardRows, true), h('div', { class: 'row-gap' }, extLink(HOSTINGER_CARDS_URL, 'إدارة البطاقات في hPanel'))),
  );
}

// ---- tab: Render ----
async function renderRenderTab(panel) {
  panel.replaceChildren(loading());
  await ensureHubBasics();
  const d = await hubData();
  const redraw = () => renderRenderTab(panel);
  const x = d.render;
  if (!x || x.notConfigured) return void panel.replaceChildren(section('Render', connectGuide('render')));
  if (x.loading) {
    panel.replaceChildren(section('Render', h('p', { class: 'muted loading' }, 'جارٍ جلب البيانات من Render…')));
    return void pollWhileLoading(d, panel, redraw);
  }
  if (x.error) return void panel.replaceChildren(section('Render', h('p', { class: 'form-error' }, integrationError(x.error)), h('div', { class: 'row-gap' }, refreshButton(redraw))));

  const entries = vaultDates();
  const owners = new Map((x.owners || []).map((o) => [o.id, o.name]));
  const priceTag = (p, plan) => h('span', { class: `tag${plan === 'free' ? ' tag-warn' : ''}` }, `${plan || '—'}${p === null ? '' : p === 0 ? ' — مجاني' : ` — ${money(p, 'USD')} شهريًا`}`);
  let total = 0;
  let unknown = 0;
  const count = (p, suspended) => {
    if (suspended) return;
    if (p === null) unknown += 1;
    else total += p;
  };

  const svcRows = (x.services || []).map((s) => {
    const p = s.type === 'static_site' ? 0 : s.type === 'cron_job' ? null : bl.renderPrice('service', s.plan);
    count(p, s.suspended);
    const domains = (s.customDomains || []).map((c) => `${c.name}${c.verified ? '' : ' (غير مؤكد)'}`);
    const key = `rs:${s.id}`;
    const guess = bl.guessClient(s.customDomains && s.customDomains[0] && s.customDomains[0].name, entries);
    return h(
      'li',
      { class: 'person' },
      h('div', { class: 'person-id' }, h('strong', null, h('bdi', null, s.name)), h('span', { class: 'tag' }, SERVICE_TYPE[s.type] || s.type), priceTag(p, s.type === 'static_site' ? 'static' : s.plan), s.suspended ? h('span', { class: 'tag tag-danger' }, 'موقوفة') : null),
      h(
        'span',
        { class: 'muted stack-xs' },
        h('bdi', { class: 'mono ip', dir: 'ltr' }, s.url || ''),
        domains.length ? h('span', null, 'الدومينات: ', h('bdi', { dir: 'ltr' }, domains.join(', '))) : null,
        h('span', null, [s.region, s.runtime, owners.get(s.ownerId)].filter(Boolean).join(' — ')),
        clientLine(key, guess),
      ),
      h('div', { class: 'row-gap' }, extLink(s.dashboardUrl, 'فتح', 'ghost'), assignButton({ key, title: s.name, cost: p, currency: 'USD', guessed: guess || '' }, redraw)),
    );
  });
  const dbRows = (x.databases || []).map((db) => {
    const p = bl.renderPrice('postgres', db.plan, db.diskSizeGB);
    count(p, db.suspended);
    const key = `rp:${db.id}`;
    return h(
      'li',
      { class: 'person' },
      h('div', { class: 'person-id' }, h('strong', null, h('bdi', null, db.name)), priceTag(p, db.plan), db.suspended ? h('span', { class: 'tag tag-danger' }, 'موقوفة') : null),
      h(
        'span',
        { class: 'muted stack-xs' },
        h('span', null, db.expiresAt ? `المجانية تنتهي ${fmtDay(db.expiresAt)}، ثم تُحذف بعد 14 يومًا إن لم تُرقَّ` : 'لا تنتهي'),
        h('span', null, [db.region, db.version ? `Postgres ${db.version}` : '', db.diskSizeGB ? `${num(db.diskSizeGB)} GB` : '', owners.get(db.ownerId)].filter(Boolean).join(' — ')),
        clientLine(key, ''),
      ),
      h('div', { class: 'row-gap' }, db.expiresAt ? dayTag(db.expiresAt) : null, extLink(db.dashboardUrl, 'فتح', 'ghost'), assignButton({ key, title: db.name, cost: p, currency: 'USD' }, redraw)),
    );
  });
  const kvRows = (x.keyValues || []).map((k) => {
    const p = bl.renderPrice('keyValue', k.plan);
    count(p, false);
    const key = `rk:${k.id}`;
    return h(
      'li',
      { class: 'person' },
      h('div', { class: 'person-id' }, h('strong', null, h('bdi', null, k.name)), priceTag(p, k.plan)),
      h('span', { class: 'muted stack-xs' }, h('span', null, [k.region, k.status, owners.get(k.ownerId)].filter(Boolean).join(' — ')), clientLine(key, '')),
      h('div', { class: 'row-gap' }, extLink(k.dashboardUrl, 'فتح', 'ghost'), assignButton({ key, title: k.name, cost: p, currency: 'USD' }, redraw)),
    );
  });
  const freeEnding = (x.databases || []).filter((db) => db.expiresAt).length;
  const suspended = (x.services || []).filter((s) => s.suspended).length;

  panel.replaceChildren(
    section(
      'Render',
      h('p', { class: 'muted' }, `آخر تحديث ${relTime(x.fetchedAt)}${owners.size ? ` — مساحات العمل: ${[...owners.values()].join('، ')}` : ''}`),
      h(
        'div',
        { class: 'stats' },
        stat('الخدمات', num(svcRows.length)),
        stat('قواعد البيانات', num(dbRows.length)),
        stat('Key Value', num(kvRows.length)),
        stat('التكلفة الشهرية التقديرية', `${money(Math.round(total * 100) / 100, 'USD')}${unknown ? ` + ${num(unknown)} غير معروف` : ''}`),
        stat('قواعد بيانات مجانية ستنتهي', num(freeEnding), freeEnding ? 'warn' : ''),
        stat('خدمات موقوفة', num(suspended), suspended ? 'warn' : ''),
      ),
      h('p', { class: 'muted' }, 'التكلفة التقديرية من أسعار Render المنشورة لكل خطة، ولا تشمل خطة مساحة العمل والاستهلاك الإضافي. Render لا يتيح الفواتير عبر الـ API، والفاتورة الرسمية (PDF) تجدها في صفحة الفواتير.'),
      partErrors(x.errors, { key_value: 'Key Value', owners: 'مساحات العمل', custom_domains: 'الدومينات المربوطة', postgres: 'قواعد البيانات', services: 'الخدمات' }),
      h('div', { class: 'row-gap' }, refreshButton(redraw), extLink(RENDER_BILLING_URL, 'الفواتير (PDF) في Render')),
    ),
    section('الخدمات', listBlock(`الخدمات (${num(svcRows.length)})`, svcRows, true)),
    section('قواعد البيانات', listBlock(`Postgres (${num(dbRows.length)})`, dbRows, true), kvRows.length ? listBlock(`Key Value (${num(kvRows.length)})`, kvRows, true) : null),
  );
}

// ---- tab: monthly report ----
function editExtra(existing, after) {
  const x = existing || { id: vc.uuid(), periodMonths: 1, currency: 'USD', sellCurrency: 'EUR', start: new Date().toISOString().slice(0, 10) };
  const title = textInput(x.title || '', { maxlength: 100, placeholder: 'مثلًا: Google Workspace، باقة إعلانات، استضافة عند شركة أخرى' });
  const provider = textInput(x.provider || '', { maxlength: 60, placeholder: 'اسم الشركة' });
  const clientBox = clientInput(x.client || '');
  const cost = ltrInput(x.cost ?? '', { inputmode: 'decimal', placeholder: '0' });
  const costCur = currencySelect(x.currency || 'USD');
  const sell = ltrInput(x.sell ?? '', { inputmode: 'decimal', placeholder: '0' });
  const sellCur = currencySelect(x.sellCurrency || x.currency || 'EUR');
  const period = h('select', null, PERIODS.map(([v, l]) => h('option', { value: String(v), selected: Number(x.periodMonths || 0) === v }, l)));
  const start = h('input', { type: 'date', value: x.start || '' });
  const note = textInput(x.note || '', { maxlength: 200 });
  const err = formError();
  const save = button('حفظ', { kind: 'primary', type: 'submit' });
  const del = existing ? button('حذف البند', { kind: 'danger-ghost' }) : null;
  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    h('p', { class: 'muted' }, 'لأي تكلفة ليست على Hostinger أو Render. تظهر في التقرير الشهري وفي التنبيهات قبل موعدها.'),
    field('البند', title),
    h('div', { class: 'grid-2' }, field('الشركة', provider), field('العميل', clientBox)),
    h('div', { class: 'grid-2' }, field('التكلفة علينا', cost), field('العملة', costCur)),
    h('div', { class: 'grid-2' }, field('المطلوب من العميل', sell), field('العملة', sellCur)),
    h('div', { class: 'grid-2' }, field('يتكرر', period), field('أول موعد', start)),
    field('ملاحظة (اختياري)', note),
    err,
  );
  const m = modal({ title: existing ? 'تعديل بند' : 'إضافة بند', body: form, footer: [save, del, button('إلغاء', { kind: 'secondary', onClick: () => m.close() })] });
  save.addEventListener('click', () => form.requestSubmit());
  if (del) {
    del.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'حذف البند', text: `سيُحذف «${x.title}» من التقارير والتنبيهات.`, confirmLabel: 'حذف', danger: true }))) return;
      try {
        await updateBilling((doc) => {
          doc.extras = doc.extras.filter((e) => e.id !== x.id);
        });
        m.close();
        toast('تم حذف البند.');
        after();
      } catch (ex) {
        handleErr(ex);
      }
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const c1 = readNumber(cost);
    const s1 = readNumber(sell);
    if (!title.value.trim()) return void (err.textContent = 'اكتب اسم البند.');
    if (Number.isNaN(c1) || Number.isNaN(s1)) return void (err.textContent = 'اكتب المبالغ أرقامًا فقط، مثلًا 25 أو 12.5');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start.value)) return void (err.textContent = 'اختر أول موعد.');
    const item = {
      id: x.id,
      title: title.value.trim().slice(0, 100),
      provider: provider.value.trim().slice(0, 60),
      client: clientBox.querySelector('input').value.trim().slice(0, 80),
      cost: c1,
      currency: costCur.value,
      sell: s1,
      sellCurrency: sellCur.value,
      periodMonths: Number(period.value) || 0,
      start: start.value,
      note: note.value.trim().slice(0, 200),
    };
    setBusy(save, true, 'جارٍ الحفظ…');
    try {
      await updateBilling((doc) => {
        const i = doc.extras.findIndex((e) => e.id === item.id);
        if (i >= 0) doc.extras[i] = item;
        else doc.extras.push(item);
      });
      m.close();
      toast('تم حفظ البند.');
      after();
    } catch (ex) {
      setBusy(save, false);
      handleErr(ex);
    }
  });
  title.focus();
}

async function renderReport(panel) {
  panel.replaceChildren(loading());
  await ensureHubBasics();
  const d = await hubData();
  const redraw = () => renderReport(panel);
  const month = S.reportMonth || bl.monthKey();
  const rows = bl.monthCharges({ hostinger: d.hostinger, render: d.render, doc: S.billing.doc, entries: vaultDates(), month });
  const sum = bl.summarize(rows);
  const go = (n) => {
    S.reportMonth = bl.shiftMonth(month, n);
    redraw();
  };
  const csv = button('تنزيل Excel (CSV)', { kind: 'secondary', small: true, iconName: 'download', onClick: () => download(bl.toCsv(rows, { provider: PROVIDER_LABEL, state: STATE_LABEL }), `report-${month}.csv`) });
  const print = button('طباعة / حفظ PDF', { kind: 'secondary', small: true, iconName: 'printer', onClick: () => window.print() });
  const nav = h(
    'div',
    { class: 'month-nav no-print' },
    button('', { kind: 'secondary', small: true, iconName: 'back', title: 'الشهر السابق', onClick: () => go(-1) }),
    h('strong', null, monthName(month)),
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm btn-icon flip', title: 'الشهر التالي', 'aria-label': 'الشهر التالي', onClick: () => go(1) }, icon('back', 18)),
    month !== bl.monthKey() ? button('هذا الشهر', { kind: 'ghost', small: true, onClick: () => {
      S.reportMonth = bl.monthKey();
      redraw();
    } }) : null,
  );

  const clientRows = sum.clients.map((c) => h(
    'tr',
    null,
    h('td', { 'data-label': 'العميل' }, c.client ? h('bdi', null, c.client) : h('span', { class: 'muted' }, 'بدون عميل')),
    h('td', { class: 'num', 'data-label': 'البنود' }, num(c.count)),
    h('td', { class: 'num', 'data-label': 'التكلفة علينا' }, moneyBag(c.cost)),
    h('td', { class: 'num', 'data-label': 'المطلوب منه' }, moneyBag(c.sell)),
  ));
  const chargeRows = rows.map((r) => h(
    'tr',
    { class: r.state === 'manual' ? 'is-manual' : '' },
    h('td', { class: 'nowrap', 'data-label': 'التاريخ' }, fmtDay(bl.dayOf(r.date))),
    h('td', { 'data-label': 'البند' }, h('span', null, h('bdi', null, r.title), r.note ? h('span', { class: 'muted small block' }, r.note) : null)),
    h('td', { 'data-label': 'المزوّد' }, r.providerName || PROVIDER_LABEL[r.provider] || r.provider),
    h('td', { 'data-label': 'العميل' }, h('span', null, r.client ? h('bdi', null, r.client) : h('span', { class: 'muted' }, '—'), r.clientGuessed ? h('span', { class: 'muted small' }, ' (اقتراح)') : null)),
    h('td', { class: 'num', 'data-label': 'التكلفة' }, r.cost === null ? (r.provider === 'vault' ? '—' : h('span', { class: 'tag tag-warn' }, 'غير معروف')) : `${money(r.cost, r.currency)}${r.estimated && !r.costEdited ? ' *' : ''}`),
    h('td', { class: 'num', 'data-label': 'المطلوب' }, r.sell === null ? '—' : money(r.sell, r.sellCurrency)),
    h('td', { 'data-label': 'الحالة' }, h('span', { class: `tag${r.state === 'manual' ? ' tag-warn' : r.state === 'charged' ? '' : ' tag-admin'}` }, STATE_LABEL[r.state] || r.state)),
    h(
      'td',
      { class: 'no-print no-label' },
      r.provider === 'vault' ? null : r.kind === 'extra'
        ? button('تعديل', { kind: 'ghost', small: true, onClick: () => editExtra(S.billing.doc.extras.find((e) => `x:${e.id}` === r.key), redraw) })
        : button(r.client && !r.clientGuessed ? 'تعديل' : 'ربط بعميل', { kind: 'ghost', small: true, onClick: () => editCharge({ key: r.key, title: r.title, cost: r.costEdited ? null : r.cost, currency: r.currency, guessed: r.clientGuessed ? r.client : '' }, redraw) }),
    ),
  ));
  const extras = S.billing.doc.extras || [];

  panel.replaceChildren(...[
    section(
      `التقرير الشهري — ${monthName(month)}`,
      nav,
      h(
        'div',
        { class: 'stats' },
        stat('التكلفة على الشركة', moneyBag(sum.cost)),
        stat('المطلوب من العملاء', moneyBag(sum.sell), 'good'),
        stat('يحتاج تجديد يدوي', num(sum.manual), sum.manual ? 'warn' : ''),
        stat('بنود بدون عميل', num(sum.unassigned), sum.unassigned ? 'warn' : ''),
      ),
      h('p', { class: 'muted' }, 'كل ما يُدفع هذا الشهر لـ Hostinger و Render وأي تكلفة أضفتها، مع العميل والمبلغ المطلوب منه. اربط البنود بعملائها مرة واحدة، وكل شهر يُحسب وحده. (*) تكلفة Render تقديرية حسب الخطة.'),
      h('div', { class: 'row-gap no-print' }, csv, print, button('إضافة تكلفة أخرى', { kind: 'secondary', small: true, iconName: 'plus', onClick: () => editExtra(null, redraw) })),
    ),
    section(
      'حسب العميل',
      sum.clients.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-cards' }, h('thead', null, h('tr', null, h('th', null, 'العميل'), h('th', null, 'البنود'), h('th', null, 'التكلفة علينا'), h('th', null, 'المطلوب منه'))), h('tbody', null, clientRows)))
        : h('p', { class: 'muted' }, 'لا توجد مدفوعات في هذا الشهر.'),
    ),
    section(
      'كل البنود',
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-cards' }, h('thead', null, h('tr', null, h('th', null, 'التاريخ'), h('th', null, 'البند'), h('th', null, 'المزوّد'), h('th', null, 'العميل'), h('th', null, 'التكلفة'), h('th', null, 'المطلوب'), h('th', null, 'الحالة'), h('th', { class: 'no-print' }, ''))), h('tbody', null, chargeRows)))
        : h('p', { class: 'muted' }, 'لا توجد بنود في هذا الشهر.'),
    ),
    section(
      'الفواتير الرسمية',
      h('p', { class: 'muted' }, 'Hostinger و Render لا يتيحان تنزيل الفواتير عبر الـ API، لذلك لا يقدر البرنامج يجلب ملفات PDF بنفسه. كل فاتورة موجودة في صفحة الفواتير عند المزوّد:'),
      h('div', { class: 'row-gap no-print' }, extLink(HOSTINGER_INVOICES_URL, 'فواتير Hostinger'), extLink(RENDER_BILLING_URL, 'فواتير Render')),
    ),
    extras.length
      ? section('تكاليف أضفتها يدويًا', h('ul', { class: 'people' }, extras.map((x) => h(
        'li',
        { class: 'person' },
        h('div', { class: 'person-id' }, h('strong', null, h('bdi', null, x.title)), x.provider ? h('span', { class: 'tag' }, x.provider) : null),
        h('span', { class: 'muted stack-xs' }, h('span', null, `${money(x.cost, x.currency)} — ${(PERIODS.find(([v]) => v === Number(x.periodMonths || 0)) || [0, ''])[1]} من ${fmtDay(x.start)}`), x.client ? h('span', null, `العميل: ${x.client}${x.sell !== null && x.sell !== undefined ? `، نطلب منه ${money(x.sell, x.sellCurrency)}` : ''}`) : null),
        button('تعديل', { kind: 'ghost', small: true, onClick: () => editExtra(x, redraw) }),
      ))))
      : null,
  ].filter(Boolean));
}

function connectGuide(kind) {
  const steps = kind === 'hostinger'
    ? [
      'افتح hPanel على Hostinger بالحساب الذي عليه الدومينات والاستضافة، ثم من القائمة الجانبية اختر «API» ثم تبويب «API tokens» (أو افتح hpanel.hostinger.com/api).',
      'اضغط «New token»، اكتب اسمًا واختر مدة الصلاحية، ثم انسخ المفتاح (يظهر مرة واحدة فقط).',
      'في Render افتح الخدمة team-vault ثم Environment، وأضف متغيرًا باسم HOSTINGER_API_TOKEN والصق المفتاح، ثم Save, rebuild, and deploy.',
    ]
    : [
      'في Render افتح صورة حسابك ثم Account Settings ثم API Keys، واضغط Create API Key وانسخ المفتاح.',
      'في نفس الخدمة team-vault افتح Environment، وأضف متغيرًا باسم RENDER_API_KEY والصق المفتاح، ثم Save, rebuild, and deploy.',
    ];
  return h(
    'div',
    { class: 'stack-sm' },
    h('p', null, kind === 'hostinger' ? 'غير مربوط بعد. اربطه لتظهر هنا كل المواقع والدومينات والإيميلات والاشتراكات وبطاقات الدفع ومواعيدها:' : 'غير مربوط بعد. اربطه لتظهر هنا كل الخدمات وقواعد البيانات وخططها وتكلفتها وتواريخ انتهاء المجاني منها:'),
    h('ol', { class: 'steps' }, steps.map((t) => h('li', null, t))),
    h('p', { class: 'muted' }, 'المفتاح يُحفظ فقط في إعدادات Render، لا في الكود ولا في قاعدة البيانات، والبرنامج يستخدمه للقراءة فقط ولا يغيّر أي شيء في حسابك.'),
  );
}

async function renderDevices(panel) {
  panel.replaceChildren(loading());
  const d = await api.get('/admin/devices');
  const pending = d.devices.filter((x) => x.status === 'pending');
  const approved = d.devices.filter((x) => x.status === 'approved');
  const item = (x) => {
    const current = x.deviceId === d.currentDeviceId;
    const acts = [];
    if (x.status === 'pending') {
      acts.push(button('موافقة', { kind: 'primary', small: true, iconName: 'check', onClick: async () => {
        try {
          await api.post('/admin/devices/approve', { userId: x.userId, deviceId: x.deviceId });
          toast('تمت الموافقة على الجهاز. يستطيع صاحبه الدخول الآن.');
          refreshStatus();
          renderDevices(panel);
        } catch (ex) {
          handleErr(ex);
        }
      } }));
    }
    if (!current) {
      acts.push(button(x.status === 'pending' ? 'رفض وحظر' : 'حظر الجهاز', { kind: 'danger-ghost', small: true, onClick: async () => {
        const ok = await confirmDialog({
          title: 'حظر هذا الجهاز؟',
          text: `سيُغلق «${x.label}» فورًا، ولن يرى الموقع مرة أخرى. استخدمه لأي جهاز ضاع أو لا تعرفه.`,
          confirmLabel: 'حظر الجهاز',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.post('/admin/devices/block', { deviceId: x.deviceId });
          toast('تم حظر الجهاز.');
          refreshStatus();
          renderDevices(panel);
        } catch (ex) {
          handleErr(ex);
        }
      } }));
    }
    return h(
      'li',
      { class: 'person' },
      h('div', { class: 'person-id' }, icon('device', 18), h('strong', null, x.label), current ? h('span', { class: 'tag tag-admin' }, 'هذا الجهاز') : null),
      h('span', { class: 'muted' }, h('bdi', null, x.displayName), ' ', h('bdi', { class: 'mono' }, x.username)),
      h('span', { class: 'muted stack-xs' }, h('span', null, x.status === 'pending' ? `طلب ${relTime(x.requestedAt)}` : `آخر استخدام ${relTime(x.lastUsedAt)}`), x.lastIp ? h('bdi', { class: 'mono ip' }, x.lastIp) : null),
      h('div', { class: 'row-gap' }, acts),
    );
  };
  panel.replaceChildren(
    section('طلبات أجهزة جديدة', pending.length ? h('ul', { class: 'people' }, pending.map(item)) : h('p', { class: 'muted' }, 'لا توجد طلبات الآن. عندما يحاول أحد الدخول من جهاز جديد سيظهر طلبه هنا.')),
    section('الأجهزة الموثوقة', h('ul', { class: 'people' }, approved.map(item))),
  );
}

async function renderAudit(panel) {
  panel.replaceChildren(loading());
  const names = new Map(S.entries.map((e) => [e.id, `${e.meta.client}: ${platformName(e.meta)}${e.meta.label ? ` (${e.meta.label})` : ''}`]));
  const list = h('ol', { class: 'log' });
  const more = button('تحميل المزيد', { kind: 'secondary' });
  let before = null;
  const load = async () => {
    setBusy(more, true, 'جارٍ التحميل…');
    try {
      const d = await api.get(`/admin/audit${before ? `?before=${before}` : ''}`);
      for (const a of d.items) {
        const detail = [];
        if (a.entryId) detail.push(names.get(a.entryId) || 'حساب محذوف');
        if (a.details && a.details.username) detail.push(a.details.username);
        if (a.details && a.details.device) detail.push(a.details.device);
        if (a.details && a.details.count !== undefined) detail.push(`${num(a.details.count)} حساب`);
        if (a.details && a.details.minutes) detail.push(`${num(a.details.minutes)} دقيقة`);
        list.append(h(
          'li',
          { class: `log-item${ALARMING.has(a.action) ? ' is-alarm' : ''}` },
          h('time', { datetime: a.at }, fmtDate(a.at)),
          h('bdi', { class: 'log-who' }, a.username || '—'),
          h('span', { class: 'log-what' }, ACTIONS[a.action] || a.action, detail.length ? h('span', { class: 'muted' }, ': ', detail.map((d, i) => [i ? '، ' : '', h('bdi', null, d)])) : null),
          h('span', { class: 'log-where muted' }, a.device ? h('span', null, a.device) : null, a.ip ? h('bdi', { class: 'mono ip' }, a.ip) : null),
        ));
        before = a.id;
      }
      setBusy(more, false);
      more.hidden = !d.hasMore;
    } catch (ex) {
      setBusy(more, false);
      handleErr(ex);
    }
  };
  more.addEventListener('click', load);
  panel.replaceChildren(section('سجل النشاط', h('p', { class: 'muted' }, 'كل دخول وكل عرض أو نسخ لكلمة سر يُسجَّل هنا، ولا يمكن تعديل السجل أو حذفه.'), list, more));
  await load();
}

async function renderBackup(panel) {
  const st = S.status || (await api.get('/admin/status'));
  const info = [];
  info.push(h('p', null, `آخر نسخة احتياطية: ${st.lastBackupAt ? relTime(st.lastBackupAt) : 'لم تُنزَّل أي نسخة بعد'}.`));
  if (st.dbPlan === 'free' && st.dbCreatedAt) {
    const end = new Date(new Date(st.dbCreatedAt).getTime() + 30 * 86400_000);
    info.push(h('p', { class: 'banner banner-warn' }, icon('alert', 18), h('span', null, `قاعدة البيانات على الخطة المجانية في Render، وتنتهي يوم ${fmtDate(end)} تقريبًا (بعد 30 يومًا من إنشائها). قبلها: رقِّها لخطة مدفوعة من لوحة Render، أو نزّل نسخة احتياطية الآن واسترجعها في قاعدة جديدة.`)));
  }

  const ep1 = passwordInput({ autocomplete: 'new-password' });
  const ep2 = passwordInput({ autocomplete: 'new-password' });
  const eerr = formError();
  const ebtn = button('تنزيل نسخة احتياطية مشفرة', { kind: 'primary', type: 'submit', iconName: 'download' });
  const exportForm = h(
    'form',
    { class: 'stack', novalidate: true },
    h('p', { class: 'muted' }, 'الملف مشفر بكلمة سر تختارها الآن (منفصلة عن كلمة سر الدخول). بدونها لا يمكن فتحه، فاحفظها على ورقة مع الملف.'),
    h('div', { class: 'grid-2' }, field('كلمة سر النسخة الاحتياطية', ep1), field('أعد كتابتها', ep2)),
    eerr,
    ebtn,
  );
  exportForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    eerr.textContent = '';
    const rule = masterPasswordRules(ep1.value, ep2.value);
    if (rule) return void (eerr.textContent = rule);
    setBusy(ebtn, true, 'جارٍ فك التشفير وإعادة التشفير…');
    try {
      const d = await api.get('/admin/export');
      const entries = [];
      for (const x of d.entries) {
        const meta = await vc.openMeta(S.keys.vaultKey, x.id, x.keyVersion, x.meta);
        const sec = await vc.openSecret(S.keys.vaultKey, x.id, x.keyVersion, x.secret);
        entries.push({ ...meta, ...sec, createdAt: x.createdAt, updatedAt: x.updatedAt });
      }
      const billing = (S.billing || (await loadBilling())) ? S.billing.doc : null;
      const file = await vc.sealBackup(ep1.value, { app: 'team-vault', exportedAt: new Date().toISOString(), count: entries.length, entries, billing: billing ? { items: billing.items, extras: billing.extras } : undefined });
      download(file, `vault-backup-${new Date().toISOString().slice(0, 10)}.tvault`);
      ep1.value = '';
      ep2.value = '';
      toast(`تم تنزيل نسخة مشفرة فيها ${countLabel(entries.length, 'حساب واحد', 'حسابان', 'حسابات', 'حسابًا')}.`);
      S.status = null;
      refreshStatus();
    } catch (ex) {
      handleErr(ex);
    } finally {
      setBusy(ebtn, false);
    }
  });

  const file = h('input', { type: 'file', accept: '.tvault,application/json,application/octet-stream' });
  const ip = passwordInput({ autocomplete: 'off' });
  const ierr = formError();
  const ibtn = button('استرجاع الحسابات من الملف', { kind: 'secondary', type: 'submit', iconName: 'upload' });
  const importForm = h(
    'form',
    { class: 'stack', novalidate: true },
    h('p', { class: 'muted' }, 'يضيف الحسابات الموجودة في الملف إلى الخزنة الحالية، ويتخطى الحسابات المكررة.'),
    field('ملف النسخة الاحتياطية', file, 'الملف الذي نزّلته من هذه الصفحة سابقًا (امتداده tvault).'),
    field('كلمة سر النسخة الاحتياطية', ip),
    ierr,
    ibtn,
  );
  importForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    ierr.textContent = '';
    if (!file.files || !file.files[0]) return void (ierr.textContent = 'اختر ملف النسخة الاحتياطية.');
    if (!ip.value) return void (ierr.textContent = 'اكتب كلمة سر النسخة الاحتياطية.');
    setBusy(ibtn, true, 'جارٍ فك تشفير الملف…');
    try {
      const data = await vc.openBackup(ip.value, await file.files[0].text());
      const key = (m) => [norm(m.client), m.platform, norm(m.username), norm(m.label)].join('|');
      const existing = new Set(S.entries.map((x) => key(x.meta)));
      const toAdd = [];
      let skipped = 0;
      for (const it of Array.isArray(data.entries) ? data.entries : []) {
        const meta = {
          client: String(it.client || '').trim(),
          platform: PLATFORMS.some((p) => p.id === it.platform) ? it.platform : 'other',
          platformName: it.platformName,
          label: it.label || '',
          username: it.username || '',
          url: it.url || '',
          hosting: it.hosting || undefined,
          dbProvider: it.dbProvider || undefined,
          renewAt: /^\d{4}-\d{2}-\d{2}$/.test(it.renewAt || '') ? it.renewAt : undefined,
        };
        if (!meta.client) continue;
        if (existing.has(key(meta))) {
          skipped += 1;
          continue;
        }
        existing.add(key(meta));
        const id = vc.uuid();
        const sealed = await vc.sealEntry(S.keys.vaultKey, id, S.keys.keyVersion, meta, { password: it.password || '', notes: it.notes || '', history: Array.isArray(it.history) ? it.history : [], dbUrl: it.dbUrl || undefined });
        toAdd.push({ id, ...sealed });
      }
      let added = 0;
      for (let i = 0; i < toAdd.length; i += 500) {
        const r = await api.post('/admin/import', { keyVersion: S.keys.keyVersion, entries: toAdd.slice(i, i + 500) });
        added += r.added;
      }
      let notes = 0;
      if (data.billing && typeof data.billing === 'object') {
        const items = data.billing.items && typeof data.billing.items === 'object' ? data.billing.items : {};
        const extras = Array.isArray(data.billing.extras) ? data.billing.extras : [];
        await updateBilling((doc) => {
          for (const [k, v] of Object.entries(items)) {
            if (!doc.items[k] && v && typeof v === 'object') {
              doc.items[k] = v;
              notes += 1;
            }
          }
          for (const x of extras) {
            if (x && x.id && !doc.extras.some((e) => e.id === x.id)) {
              doc.extras.push(x);
              notes += 1;
            }
          }
        });
      }
      await loadEntries();
      file.value = '';
      ip.value = '';
      const addedText = added ? `تمت إضافة ${countLabel(added, 'حساب واحد', 'حسابين', 'حسابات', 'حسابًا')}` : 'لا توجد حسابات جديدة في الملف';
      toast(`${addedText}${skipped ? `، وتم تخطي ${num(skipped)} مكرر` : ''}${notes ? `، واسترجاع ${num(notes)} من بيانات الفواتير` : ''}.`);
    } catch (ex) {
      handleErr(ex);
    } finally {
      setBusy(ibtn, false);
    }
  });

  panel.replaceChildren(
    section('حالة النسخ الاحتياطي', ...info),
    section('تنزيل نسخة احتياطية', exportForm),
    section('استرجاع من نسخة احتياطية', importForm),
  );
}

async function renderGate(panel) {
  panel.replaceChildren(loading());
  const d = await api.get('/admin/gate');
  const box = ltrInput(d.link, { class: 'mono link-box' });
  box.readOnly = true;
  const rotate = button('تغيير الرابط', { kind: 'danger-ghost', iconName: 'restore' });
  rotate.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'تغيير رابط الدخول؟',
      text: 'سيتوقف الرابط الحالي عن العمل لأي جهاز جديد. الأجهزة المسجلة حاليًا تستمر في العمل كما هي. استخدمه إذا وصل الرابط لشخص غير موثوق.',
      confirmLabel: 'تغيير الرابط',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.post('/admin/gate/rotate');
      box.value = r.link;
      toast('تم تغيير رابط الدخول.');
    } catch (ex) {
      handleErr(ex);
    }
  });
  panel.replaceChildren(
    section(
      'رابط الدخول السري',
      h('p', null, 'الموقع يظهر كأنه غير موجود (Not Found) لأي شخص لم يفتح هذا الرابط على جهازه. أرسله فقط لأعضاء فريقك، ويكفي فتحه مرة واحدة على كل جهاز.'),
      h('div', { class: 'pw-wrap' }, box, button('نسخ الرابط', { kind: 'secondary', iconName: 'copy', onClick: () => copyPlain(box.value, 'رابط الدخول') })),
      h('p', { class: 'muted' }, 'روابط الدعوة تحتوي هذا الرابط تلقائيًا، فلا داعي لإرساله مع الدعوة.'),
      h('div', { class: 'row-gap' }, rotate),
    ),
  );
}

async function renderTrash(panel) {
  panel.replaceChildren(loading());
  const d = await api.get('/admin/trash');
  const items = [];
  for (const e of d.entries) {
    let meta;
    try {
      meta = await vc.openMeta(S.keys.vaultKey, e.id, e.keyVersion, e.meta);
    } catch {
      meta = { client: 'تعذّر فك التشفير', platform: 'other' };
    }
    items.push(h(
      'li',
      { class: 'person' },
      h('div', { class: 'person-id' }, h('i', { class: 'dot', dataset: { p: meta.platform } }), h('strong', null, meta.client), h('span', null, platformName(meta)), meta.label ? h('span', { class: 'muted' }, meta.label) : null),
      h('span', { class: 'muted' }, `حُذف ${relTime(e.deletedAt)}${S.users[e.deletedBy] ? ` بواسطة ${S.users[e.deletedBy]}` : ''}`),
      h(
        'div',
        { class: 'row-gap' },
        button('استرجاع', { kind: 'secondary', small: true, iconName: 'restore', onClick: async () => {
          try {
            await api.post(`/admin/trash/${e.id}/restore`);
            await loadEntries();
            toast('تم استرجاع الحساب.');
            renderTrash(panel);
          } catch (ex) {
            handleErr(ex);
          }
        } }),
        button('حذف نهائي', { kind: 'danger-ghost', small: true, iconName: 'trash', onClick: async () => {
          const ok = await confirmDialog({ title: 'حذف نهائي؟', text: 'لا يمكن التراجع عن الحذف النهائي.', confirmLabel: 'حذف نهائي', danger: true });
          if (!ok) return;
          try {
            await api.del(`/admin/trash/${e.id}`);
            toast('تم الحذف النهائي.');
            renderTrash(panel);
          } catch (ex) {
            handleErr(ex);
          }
        } }),
      ),
    ));
  }
  panel.replaceChildren(section('المحذوفات', items.length ? h('ul', { class: 'people' }, items) : h('p', { class: 'muted' }, 'لا توجد حسابات محذوفة.')));
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot() {
  setSessionLostHandler(() => {
    if (!S.keys) return;
    const u = S.user ? S.user.username : '';
    wipe();
    S.user = null;
    showLogin(u);
    toast('انتهت الجلسة. سجّل الدخول مرة أخرى.', 'error', 6000);
  });
  let st;
  try {
    st = await api.get('/state');
  } catch (ex) {
    showMessage({ title: 'تعذّر فتح الخزنة', text: errorText(ex), action: ['إعادة المحاولة', () => location.reload()] });
    return;
  }
  S.appName = st.appName || S.appName;
  document.title = S.appName;
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (st.setupNeeded) {
    if (st.setupAllowed) showSetup();
    else showMessage({ title: 'الخزنة لم تُجهَّز بعد', text: 'افتح رابط الإعداد الأول (الموجود في سجلات Render) على هذا الجهاز.' });
    return;
  }
  if (invite) return showRegister(invite);
  if (st.session) return showUnlock(st.session);
  showLogin();
}

boot();
