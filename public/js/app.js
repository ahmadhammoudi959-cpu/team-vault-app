import { h, icon, dial, button, field, setBusy, toast, modal, confirmDialog, num, relTime, fmtDate, countLabel } from './ui.js';
import { api, ApiError, errorText, setSessionLostHandler } from './api.js';
import * as vc from './vcrypto.js';

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
function otpInput() {
  const el = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, dir: 'ltr', class: 'otp', placeholder: '••••••', spellcheck: 'false',
  });
  el.addEventListener('input', () => {
    el.value = toLatinDigits(el.value).replace(/\D/g, '').slice(0, 6);
  });
  return el;
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
  const code = otpInput();
  const err = formError();
  const submit = button('افتح الخزنة', { kind: 'primary', type: 'submit', iconName: 'lock' });
  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    field('اسم المستخدم', user),
    field('كلمة السر الرئيسية', pw),
    field('رمز التحقق', code, 'الأرقام الستة الظاهرة الآن في Google Authenticator أو Microsoft Authenticator.'),
    err,
    submit,
  );
  const shell = authShell({ title: S.appName, lead: 'سجّل الدخول لفتح خزنة الفريق.', body: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const username = user.value.trim().toLowerCase();
    if (!username || !pw.value || code.value.length !== 6) {
      err.textContent = 'اكتب اسم المستخدم وكلمة السر الرئيسية ورمز التحقق المكوّن من 6 أرقام.';
      return;
    }
    setBusy(submit, true, 'جارٍ فتح الخزنة…');
    working(shell, true);
    try {
      const pre = await api.post('/auth/prelogin', { username });
      const { authKey, kek } = await vc.deriveFromPassword(pw.value, pre.kdfSalt, pre.kdfIter);
      const r = await api.post('/auth/login', { username, authKey, totp: code.value });
      working(shell, false);
      await afterLogin(r, kek, username);
    } catch (ex) {
      working(shell, false);
      setBusy(submit, false);
      err.textContent = errorText(ex);
      code.value = '';
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
  if (r.status === 'totp_setup') {
    return showTotpEnroll({
      title: 'فعّل تطبيق المصادقة من جديد',
      lead: 'تمت إعادة ضبط التحقق بخطوتين لحسابك. اربط تطبيق المصادقة على هاتفك قبل المتابعة.',
      qr: r.qr,
      secret: r.secret,
      submitLabel: 'تفعيل ومتابعة',
      onCode: (totp) => api.post('/auth/totp-setup', { ticket: r.ticket, totp }),
      after: (r2) => afterLogin(r2, kek, username),
    });
  }
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

function showTotpEnroll({ title, lead, qr, secret, onCode, after, submitLabel = 'تفعيل وفتح الخزنة' }) {
  const code = otpInput();
  const err = formError();
  const submit = button(submitLabel, { kind: 'primary', type: 'submit', iconName: 'check' });
  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    h(
      'ol',
      { class: 'steps' },
      h('li', null, 'ثبّت تطبيق Google Authenticator أو Microsoft Authenticator على هاتفك.'),
      h('li', null, 'اضغط «+» في التطبيق وامسح هذا الرمز.'),
      h('li', null, 'اكتب الأرقام الستة التي تظهر في التطبيق.'),
    ),
    h('figure', { class: 'qr' }, h('img', { src: qr, alt: 'رمز QR لربط تطبيق المصادقة', width: 196, height: 196 })),
    h('details', { class: 'manual-key' }, h('summary', null, 'لا يمكنك المسح؟ أدخل المفتاح يدويًا'), h('code', { class: 'mono', dir: 'ltr' }, secret)),
    field('الرمز من التطبيق', code),
    err,
    submit,
  );
  const shell = authShell({ title, lead, body: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (code.value.length !== 6) {
      err.textContent = 'اكتب الرمز المكوّن من 6 أرقام.';
      return;
    }
    setBusy(submit, true, 'جارٍ التحقق…');
    working(shell, true);
    try {
      const r = await onCode(code.value);
      working(shell, false);
      await after(r);
    } catch (ex) {
      working(shell, false);
      setBusy(submit, false);
      err.textContent = errorText(ex);
      code.value = '';
      shake(shell);
    }
  });
  show(shell);
  code.focus();
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
    submitLabel: 'متابعة',
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
      showTotpEnroll({
        title: 'فعّل التحقق بخطوتين',
        lead: 'كل دخول للخزنة سيطلب رمزًا يتغير كل 30 ثانية من تطبيق على هاتفك.',
        qr: r.qr,
        secret: r.secret,
        onCode: (totp) => api.post('/setup/finish', { username, totp }),
        after: (r2) => openVault(r2, kek),
      });
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
    submitLabel: 'متابعة',
    onSubmit: async ({ password }) => {
      const userId = vc.uuid();
      const salt = vc.newSalt();
      const { authKey, kek } = await vc.deriveFromPassword(password, salt, vc.KDF_ITER);
      const keys = await vc.createUserKeys(kek);
      const r = await api.post('/register/start', {
        inviteCode: code, userId, kdfSalt: salt, kdfIter: vc.KDF_ITER, authKey, publicKey: keys.publicKey, encPrivateKey: keys.encPrivateKey,
      });
      showTotpEnroll({
        title: 'فعّل التحقق بخطوتين',
        lead: 'كل دخول للخزنة سيطلب رمزًا يتغير كل 30 ثانية من تطبيق على هاتفك.',
        qr: r.qr,
        secret: r.secret,
        submitLabel: 'تفعيل وإنهاء التسجيل',
        onCode: (totp) => api.post('/register/finish', { inviteCode: code, totp }),
        after: async () => {
          history.replaceState(null, '', '/');
          // Computed here from the key this browser generated, not taken from the server,
          // so a tampered server can't show a matching fingerprint for a swapped key.
          showMemberPending(await vc.fingerprint(keys.publicKey), info.username);
        },
      });
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

async function refreshStatus() {
  if (!S.user || S.user.role !== 'admin' || !S.keys) return;
  try {
    S.status = await api.get('/admin/status');
  } catch {
    return;
  }
  renderBanners();
  document.querySelectorAll('[data-badge]').forEach((el) => {
    const n = (S.status.pendingMembers || 0) + (S.status.pendingDevices || 0);
    el.hidden = n === 0;
    el.textContent = n ? num(n) : '';
  });
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
    const hay = norm([e.meta.client, platformName(e.meta), platformOf(e.meta.platform).aka, e.meta.label, e.meta.username, e.meta.url].join(' '));
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
    };
    let history = Array.isArray(secret.history) ? secret.history : [];
    if (editing && secret.password && pw.value !== secret.password) {
      history = [{ password: secret.password, changedAt: new Date().toISOString() }, ...history].slice(0, 5);
    }
    const secretOut = { password: pw.value, notes: notes.value, history };
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
  const pend = (st.pendingMembers || 0) + (st.pendingDevices || 0);
  if (pend) {
    items.push(banner('info', `${countLabel(pend, 'طلب واحد', 'طلبان', 'طلبات', 'طلبًا')} بانتظار موافقتك (أعضاء أو أجهزة جديدة).`, ['مراجعة', () => showAdmin(st.pendingMembers ? 'team' : 'devices')]));
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

function banner(kind, text, action = null) {
  return h(
    'div',
    { class: `banner banner-${kind}`, role: kind === 'danger' ? 'alert' : null },
    icon(kind === 'info' ? 'users' : 'alert', 18),
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
  S.searchEl = null;
  const panel = h('div', { class: 'admin-panel', role: 'tabpanel' });
  const nav = h(
    'nav',
    { class: 'tabs', role: 'tablist', 'aria-label': 'أقسام الإدارة' },
    ADMIN_TABS.map(([id, label, ic]) => h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(id === tab), onClick: () => showAdmin(id) }, icon(ic, 18), h('span', null, label))),
  );
  show(topbar({ title: 'الإدارة', withSearch: false }), h('main', { class: 'admin' }, nav, panel));
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
    actions.push(button('إعادة ضبط التحقق بخطوتين', { kind: 'ghost', small: true, onClick: async () => {
      const ok = await confirmDialog({ title: 'إعادة ضبط التحقق بخطوتين؟', text: `استخدمها إذا فقد ${u.displayName} هاتفه. سيُطلب منه ربط تطبيق مصادقة جديد عند الدخول التالي، وسيُسجَّل خروجه الآن.`, confirmLabel: 'إعادة الضبط' });
      if (ok) adminAct(`/admin/users/${u.id}/reset-totp`, {}, 'تمت إعادة الضبط.', panel);
    } }));
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
      !u.totpEnabled ? h('span', { class: 'tag tag-warn' }, 'لم يربط التحقق بخطوتين') : null,
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
    await api.post('/admin/rotate', { fromVersion: d.keyVersion, newVersion, revision: d.revision, removeUserId, entries, wraps });
    S.keys.vaultKey = newKey;
    S.keys.keyVersion = newVersion;
    S.keys.wrapped = wraps.find((w) => w.userId === S.user.id).wrapped;
  } finally {
    raw.fill(0);
  }
  await loadEntries();
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
      const file = await vc.sealBackup(ep1.value, { app: 'team-vault', exportedAt: new Date().toISOString(), count: entries.length, entries });
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
        const meta = { client: String(it.client || '').trim(), platform: PLATFORMS.some((p) => p.id === it.platform) ? it.platform : 'other', platformName: it.platformName, label: it.label || '', username: it.username || '', url: it.url || '' };
        if (!meta.client) continue;
        if (existing.has(key(meta))) {
          skipped += 1;
          continue;
        }
        existing.add(key(meta));
        const id = vc.uuid();
        const sealed = await vc.sealEntry(S.keys.vaultKey, id, S.keys.keyVersion, meta, { password: it.password || '', notes: it.notes || '', history: Array.isArray(it.history) ? it.history : [] });
        toAdd.push({ id, ...sealed });
      }
      let added = 0;
      for (let i = 0; i < toAdd.length; i += 500) {
        const r = await api.post('/admin/import', { keyVersion: S.keys.keyVersion, entries: toAdd.slice(i, i + 500) });
        added += r.added;
      }
      await loadEntries();
      file.value = '';
      ip.value = '';
      const addedText = added ? `تمت إضافة ${countLabel(added, 'حساب واحد', 'حسابين', 'حسابات', 'حسابًا')}` : 'لا توجد حسابات جديدة في الملف';
      toast(`${addedText}${skipped ? `، وتم تخطي ${num(skipped)} مكرر` : ''}.`);
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
