"""Browser end-to-end test: drives the real UI in headless Chrome against a local server.
Checks the full first-run → add → search → reveal → invite → approve → member-login flow,
and fails on any console error (CSP / Trusted Types violations included).

  python3 test/e2e_browser.py <base_url> <setup_token> <screenshot_dir>
"""
import base64
import hashlib
import hmac
import struct
import sys
import time

from playwright.sync_api import sync_playwright, expect

BASE, SETUP_TOKEN, SHOTS = sys.argv[1], sys.argv[2], sys.argv[3]
ADMIN_PW = 'Correct-Horse-Battery-77!'
MEMBER_PW = 'Member-Strong-Pass-2026'


class Auth:
    def __init__(self, secret):
        s = secret.replace(' ', '')
        self.key = base64.b32decode(s + '=' * ((8 - len(s) % 8) % 8))
        self.last = 0

    def code(self):
        now = int(time.time() // 30)
        step = max(self.last + 1, now - 1)
        while step > now + 1:
            time.sleep(1)
            now = int(time.time() // 30)
        self.last = step
        h = hmac.new(self.key, struct.pack('>Q', step), hashlib.sha1).digest()
        o = h[-1] & 0x0F
        return '%06d' % ((struct.unpack('>I', h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000)


errors = []


def watch(page, who):
    page.on('console', lambda m: errors.append(f'[{who}] console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'[{who}] pageerror: {e}'))


def shot(page, name, full=True):
    page.screenshot(path=f'{SHOTS}/{name}.png', full_page=full)


def add_entry(page, client, platform, label, username, password=None, notes='', tech=None):
    page.get_by_role('button', name='إضافة حساب', exact=True).click()
    dlg = page.locator('dialog[open]')
    dlg.get_by_label('العميل').fill(client)
    dlg.get_by_label('المنصة', exact=True).select_option(platform)
    dlg.get_by_label('وصف الحساب (اختياري)').fill(label)
    dlg.get_by_label('اسم المستخدم أو الإيميل أو رقم الموبايل').fill(username)
    if password:
        dlg.get_by_label('كلمة السر', exact=True).fill(password)
    else:
        dlg.get_by_role('button', name='توليد كلمة سر قوية').click()
    if notes:
        dlg.get_by_label('ملاحظات سرية (اختياري)').fill(notes)
    if tech:
        details = dlg.locator('details.tech')
        if details.get_attribute('open') is None:
            details.locator('summary').click()
        dlg.get_by_label('مكان الاستضافة').fill(tech['hosting'])
        dlg.get_by_label('مكان قاعدة البيانات').fill(tech['db'])
        dlg.get_by_label('رابط قاعدة البيانات (سري ومشفر)').fill(tech['dbUrl'])
        dlg.get_by_label('تاريخ التجديد أو الانتهاء').fill(tech['renewAt'])
    dlg.get_by_role('button', name='حفظ الحساب').click()
    expect(page.locator('dialog[open]')).to_have_count(0, timeout=15000)


with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'])

    # ---------- admin: first-run setup ----------
    ctx = browser.new_context(viewport={'width': 1366, 'height': 900}, locale='ar-EG')
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    probe = ctx.new_page()
    resp = probe.goto(f'{BASE}/')
    assert resp.status == 404, 'stranger must see 404'
    assert probe.locator('body').inner_text().strip() == 'Not Found'
    probe.close()
    page = ctx.new_page()
    watch(page, 'admin')
    page.goto(f'{BASE}/setup/{SETUP_TOKEN}')
    expect(page.get_by_role('heading', name='تجهيز الخزنة لأول مرة')).to_be_visible()
    shot(page, '01-setup')
    page.get_by_label('اسمك').fill('أحمد حمودي')
    page.get_by_label('اسم المستخدم').fill('owner')
    page.get_by_label('كلمة السر الرئيسية', exact=True).fill(ADMIN_PW)
    page.get_by_label('أعد كتابة كلمة السر الرئيسية').fill(ADMIN_PW)
    page.get_by_role('button', name='متابعة').click()
    expect(page.locator('.form-error')).to_contain_text('أكّد')  # checkbox is required
    page.locator('.check input').check()
    page.get_by_role('button', name='متابعة').click()
    expect(page.get_by_role('heading', name='فعّل التحقق بخطوتين')).to_be_visible(timeout=30000)
    page.locator('.manual-key summary').click()
    secret = page.locator('.manual-key code').inner_text()
    admin_auth = Auth(secret)
    shot(page, '02-totp')
    page.get_by_label('الرمز من التطبيق').fill(admin_auth.code())
    page.get_by_role('button', name='تفعيل وفتح الخزنة').click()
    expect(page.get_by_role('heading', name='الخزنة فارغة')).to_be_visible(timeout=30000)
    shot(page, '03-empty-vault')

    # ---------- add credentials ----------
    add_entry(page, 'Star Style - ستار ستايل', 'instagram', '@starstyle.eg', 'starstyle.eg', 'Ig-Pass-123!', 'Backup codes: 1111 2222 3333\nالرقم المربوط: 01000000000')
    add_entry(page, 'Star Style - ستار ستايل', 'facebook', 'صفحة Star Style', 'ads@starstyle.com')
    add_entry(page, 'Star Style - ستار ستايل', 'meta_ads', 'حساب الإعلانات الرئيسي', 'ads@starstyle.com')
    add_entry(page, 'Nile Foods', 'tiktok', '', 'nilefoods.official')
    add_entry(page, 'Nile Foods', 'instagram', '@nilefoods', 'nilefoods')
    add_entry(page, 'مطعم الكورنيش', 'google', 'Gmail', 'corniche.rest@gmail.com')
    renew_at = time.strftime('%Y-%m-%d', time.localtime(time.time() + 12 * 86400))
    add_entry(page, 'Cairo Gym', 'website', 'لوحة تحكم الموقع', 'admin',
              tech={'hosting': 'Hostinger', 'db': 'Neon', 'dbUrl': 'postgresql://gym:S3cret@ep-x.neon.tech/gym', 'renewAt': renew_at})
    gym = page.locator('.row').filter(has_text='لوحة تحكم الموقع')
    expect(gym.locator('.row-tags')).to_contain_text('Hostinger')
    expect(gym.locator('.row-tags')).to_contain_text('Neon')
    expect(gym.locator('.row-tags')).to_contain_text('12')
    gym.get_by_role('button', name='إظهار').click()
    expect(gym.locator('.row-extra')).to_contain_text('postgresql://gym:S3cret@ep-x.neon.tech/gym')
    shot(page, '04b-program-details')
    gym.get_by_role('button', name='إخفاء').click()
    page.get_by_role('button', name='كل العملاء').click()
    expect(page.locator('.box')).to_have_count(4)
    expect(page.locator('.banner').filter(has_text='خلال 30 يومًا')).to_be_visible(timeout=15000)
    shot(page, '04-client-wall')

    # ---------- search by client name (Arabic and English, typos in hamza) ----------
    search = page.get_by_role('searchbox', name='ابحث باسم العميل')
    search.fill('ستار')
    expect(page.locator('.client')).to_have_count(1)
    expect(page.locator('.client .row')).to_have_count(3)
    search.fill('star style')
    expect(page.locator('.client .row')).to_have_count(3)
    search.fill('انستجرام')
    expect(page.locator('.client')).to_have_count(2)
    search.fill('إنستجرام')
    expect(page.locator('.client')).to_have_count(2)
    search.fill('zzz-not-there')
    expect(page.get_by_role('heading', name='لا يوجد عميل باسم «zzz-not-there»')).to_be_visible()
    search.fill('star')
    row = page.locator('.row').filter(has_text='@starstyle.eg')
    row.get_by_role('button', name='إظهار').click()
    expect(row.locator('.secret')).to_have_text('Ig-Pass-123!')
    expect(row.locator('.note-text')).to_contain_text('Backup codes')
    shot(page, '05-search-reveal')
    row.get_by_role('button', name='نسخ كلمة السر').click()
    expect(page.locator('.toast').filter(has_text='تم نسخ كلمة السر')).to_be_visible()
    clip = page.evaluate('navigator.clipboard.readText()')
    assert clip == 'Ig-Pass-123!', clip

    # edit → password history
    row.get_by_role('button', name='تعديل').click()
    dlg = page.locator('dialog[open]')
    pw = dlg.get_by_label('كلمة السر', exact=True)
    expect(pw).to_have_value('Ig-Pass-123!')
    shot(page, '06-edit-dialog', full=False)
    pw.fill('Ig-NEW-456!')
    dlg.get_by_role('button', name='حفظ التعديلات').click()
    expect(page.locator('dialog[open]')).to_have_count(0)
    row = page.locator('.row').filter(has_text='@starstyle.eg')
    row.get_by_role('button', name='إظهار').click()
    expect(row.locator('.secret')).to_have_text('Ig-NEW-456!')
    expect(row.locator('.history')).to_contain_text('Ig-Pass-123!')

    # ---------- invite a member ----------
    page.locator('details.menu > summary').click()
    page.get_by_role('button', name='الإدارة').click()
    expect(page.get_by_role('heading', name='دعوة عضو جديد')).to_be_visible()
    page.get_by_label('الاسم', exact=True).fill('سارة')
    page.get_by_label('اسم المستخدم').fill('sara')
    page.get_by_role('button', name='إنشاء رابط الدعوة').click()
    link = page.locator('.invite-result input').input_value()
    assert '#invite=' in link, link
    shot(page, '07-admin-team')

    # ---------- member registers on her own browser ----------
    mctx = browser.new_context(viewport={'width': 390, 'height': 844}, locale='ar-EG', is_mobile=True, has_touch=True)
    mpage = mctx.new_page()
    watch(mpage, 'member')
    mpage.goto(link)
    expect(mpage.get_by_role('heading', name='انضم إلى خزنة الفريق')).to_be_visible()
    mpage.get_by_label('كلمة السر الرئيسية', exact=True).fill(MEMBER_PW)
    mpage.get_by_label('أعد كتابة كلمة السر الرئيسية').fill(MEMBER_PW)
    mpage.locator('.check input').check()
    shot(mpage, '08-member-register')
    mpage.get_by_role('button', name='متابعة').click()
    expect(mpage.get_by_role('heading', name='فعّل التحقق بخطوتين')).to_be_visible(timeout=30000)
    mpage.locator('.manual-key summary').click()
    member_auth = Auth(mpage.locator('.manual-key code').inner_text())
    mpage.get_by_label('الرمز من التطبيق').fill(member_auth.code())
    mpage.get_by_role('button', name='تفعيل وإنهاء التسجيل').click()
    expect(mpage.get_by_role('heading', name='حسابك جاهز وبانتظار موافقة المدير')).to_be_visible()
    member_fp = mpage.locator('.fingerprint').inner_text()
    shot(mpage, '09-member-pending')

    # ---------- admin approves after comparing fingerprints ----------
    page.get_by_role('tab', name='الفريق').click()
    pending = page.locator('.pending')
    expect(pending).to_have_count(1)
    assert pending.locator('.fingerprint').inner_text() == member_fp, 'fingerprints must match'
    shot(page, '10-admin-pending')
    pending.get_by_role('button', name='موافقة ومنحه مفتاح الخزنة').click()
    expect(page.locator('.pending')).to_have_count(0)

    # ---------- member logs in and finds the client ----------
    mpage.get_by_role('button', name='تسجيل الدخول بعد الموافقة').click()
    mpage.get_by_label('كلمة السر الرئيسية').fill(MEMBER_PW)
    mpage.get_by_label('رمز التحقق').fill(member_auth.code())
    mpage.get_by_role('button', name='افتح الخزنة').click()
    expect(mpage.locator('.box')).to_have_count(4, timeout=30000)
    shot(mpage, '11-member-wall-mobile')
    mpage.get_by_role('searchbox', name='ابحث باسم العميل').fill('nile')
    expect(mpage.locator('.client .row')).to_have_count(2)
    shot(mpage, '12-member-search-mobile')
    expect(mpage.locator('details.menu').get_by_role('button', name='الإدارة')).to_have_count(0)

    # ---------- the member's second device must be approved ----------
    m2 = browser.new_context(viewport={'width': 1280, 'height': 800}, locale='ar-EG')
    m2page = m2.new_page()
    watch(m2page, 'member-laptop')
    gate = link.split('#')[0]
    m2page.goto(gate)
    m2page.get_by_label('اسم المستخدم').fill('sara')
    m2page.get_by_label('كلمة السر الرئيسية').fill(MEMBER_PW)
    m2page.get_by_label('رمز التحقق').fill(member_auth.code())
    m2page.get_by_role('button', name='افتح الخزنة').click()
    expect(m2page.get_by_role('heading', name='هذا جهاز جديد')).to_be_visible(timeout=30000)
    shot(m2page, '13-device-pending')
    page.get_by_role('tab', name='الأجهزة').click()
    expect(page.get_by_role('button', name='موافقة')).to_have_count(1)
    shot(page, '14-admin-devices')
    page.get_by_role('button', name='موافقة').click()
    expect(page.get_by_role('button', name='موافقة')).to_have_count(0)

    # ---------- audit log ----------
    page.get_by_role('tab', name='سجل النشاط').click()
    expect(page.locator('.log-item').first).to_be_visible()
    expect(page.locator('.log')).to_contain_text('نسخ كلمة سر')
    expect(page.locator('.log')).to_contain_text('طلب دخول من جهاز جديد')
    shot(page, '15-admin-audit')

    page.get_by_role('tab', name='التجديدات').click()
    soon = page.locator('.card').filter(has_text='يحتاج تجديد خلال 30 يومًا')
    for name in ['old-client.com', 'star-style-db', 'starstyle.com (.COM Domain)', 'Business Web Hosting', 'Cairo Gym']:
        expect(soon).to_contain_text(name, timeout=15000)
    expect(soon).not_to_contain_text('nilefoods.net')
    shot(page, '15b-admin-renewals')

    page.get_by_role('tab', name='النسخ الاحتياطي').click()
    page.get_by_label('كلمة سر النسخة الاحتياطية', exact=True).first.fill('Backup-Pass-2026-OK!')
    page.get_by_label('أعد كتابتها').fill('Backup-Pass-2026-OK!')
    with page.expect_download() as dl:
        page.get_by_role('button', name='تنزيل نسخة احتياطية مشفرة').click()
    backup_path = dl.value.path()
    backup_text = open(backup_path, encoding='utf-8').read()
    assert '"team-vault-backup"' in backup_text and 'Star' not in backup_text and 'Ig-NEW' not in backup_text
    page.locator('input[type=file]').set_input_files(backup_path)
    page.get_by_label('كلمة سر النسخة الاحتياطية').nth(1).fill('Backup-Pass-2026-OK!')
    page.get_by_role('button', name='استرجاع الحسابات من الملف').click()
    expect(page.locator('.toast').filter(has_text='مكرر')).to_be_visible(timeout=30000)
    shot(page, '16-admin-backup')

    # ---------- removing a member rotates the vault key ----------
    page.get_by_role('tab', name='الفريق').click()
    page.locator('.person').filter(has_text='sara').get_by_role('button', name='إزالة من الفريق').click()
    page.locator('dialog[open]').get_by_role('button', name='إزالة وتغيير المفتاح').click()
    expect(page.locator('.toast').filter(has_text='تمت إزالة')).to_be_visible(timeout=30000)
    expect(page.locator('.person').filter(has_text='sara')).to_have_count(0)
    mpage.reload()
    expect(mpage.get_by_role('button', name='افتح الخزنة')).to_be_visible()
    expect(mpage.get_by_label('رمز التحقق')).to_be_visible()  # back to full login: the account is gone
    page.get_by_role('tab', name='رابط الدخول').click()
    shot(page, '17-admin-gate')

    # ---------- lock and unlock ----------
    page.get_by_role('button', name='رجوع للخزنة').click()
    page.get_by_role('button', name='قفل الخزنة الآن').click()
    expect(page.get_by_role('heading', name='أهلًا أحمد حمودي')).to_be_visible()
    shot(page, '18-unlock')
    page.get_by_label('كلمة السر الرئيسية').fill('wrong-password-123')
    page.get_by_role('button', name='افتح الخزنة').click()
    expect(page.locator('.form-error')).to_contain_text('غير صحيحة', timeout=30000)
    page.get_by_label('كلمة السر الرئيسية').fill(ADMIN_PW)
    page.get_by_role('button', name='افتح الخزنة').click()
    expect(page.locator('.box')).to_have_count(4, timeout=30000)

    # reload: keys are gone from memory, so the vault asks for the master password again
    page.reload()
    expect(page.get_by_role('heading', name='أهلًا أحمد حمودي')).to_be_visible()

    # login screen look
    lctx = browser.new_context(viewport={'width': 1366, 'height': 900}, locale='ar-EG')
    lpage = lctx.new_page()
    watch(lpage, 'login')
    lpage.goto(gate)
    expect(lpage.get_by_role('button', name='افتح الخزنة')).to_be_visible()
    shot(lpage, '19-login')

    browser.close()

# The deliberate wrong-password unlock answers 401, which Chrome logs as a failed resource.
errors = [e for e in errors if 'status of 401' not in e]
if errors:
    print('BROWSER ERRORS:')
    for e in errors:
        print('  ', e)
    sys.exit(1)
print('E2E OK')
