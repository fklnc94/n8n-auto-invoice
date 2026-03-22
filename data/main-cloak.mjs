const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT) || 30000;
const ELEMENT_TIMEOUT = parseInt(process.env.ELEMENT_TIMEOUT) || 15000;

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from 'cloakbrowser';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMAIL = process.env.OPENAI_EMAIL;
const PASSWORD = process.env.OPENAI_PASSWORD;
const TOTP_SECRET = process.env.OPENAI_TOTP_SECRET;

if (!EMAIL || !PASSWORD || !TOTP_SECRET) {
  console.error('\n❌ CRITICAL: OPENAI_EMAIL, OPENAI_PASSWORD veya OPENAI_TOTP_SECRET çevre değişkenleri eksik!');
  process.exit(1);
}

const sanitizedEmail = EMAIL.replace(/[^a-zA-Z0-9]/g, '_');
const userDir = path.join(__dirname, 'openai_accounts', sanitizedEmail);

if (!fs.existsSync(userDir)) {
  fs.mkdirSync(userDir, { recursive: true });
}

// ==========================================
// Log Dosyasına Yazma Özelliği
// ==========================================
const dateStr = new Date().toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\./g, '.');
const LOG_FILE = path.join(userDir, `worker_log-${dateStr}.txt`);

const originalLog = console.log;
console.log = function(...args) {
    originalLog.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    fs.appendFileSync(LOG_FILE, msg + '\n');
};

const originalError = console.error;
console.error = function(...args) {
    originalError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    fs.appendFileSync(LOG_FILE, `ERROR: ${msg}\n`);
};

const COOKIE_FILE = path.join(userDir, `${sanitizedEmail}-session-cookies.json`);

// ==========================================
// TOTP Generator
// ==========================================
function base32Decode(encoded) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of encoded.toUpperCase()) {
    const val = chars.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret) {
  const key = base32Decode(secret);
  const time = Math.floor(Date.now() / 1000 / 30);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(time, 4);
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(timeBuffer);
  const hash = hmac.digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const code = ((hash[offset] & 0x7f) << 24 |
    (hash[offset + 1] & 0xff) << 16 |
    (hash[offset + 2] & 0xff) << 8 |
    (hash[offset + 3] & 0xff)) % 1000000;
  return code.toString().padStart(6, '0');
}

// ==========================================
// Güvenli SS
// ==========================================
async function safeScreenshot(targetPage, filePath) {
  try {
    await targetPage.screenshot({ path: filePath, fullPage: true, timeout: 10000 });
    console.log(`   📸 SS kaydedildi: ${filePath}`);
  } catch (ssErr) {
    console.log(`   ⚠️ SS alınamadı (${path.basename(filePath)}): ${ssErr.message.substring(0, 80)}`);
  }
}

// ==========================================
// Full Login Akışı
// ==========================================
async function performFullLogin(page) {
  console.log('\n[!] Cookie bulunamadı veya geçersiz. Sıfırdan Login yapılıyor...');

  console.log('📄 Adım 1: chatgpt.com/auth/login_with -> auth.openai.com/log-in');
  await page.goto('https://chatgpt.com/auth/login_with', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(3000);
  await safeScreenshot(page, path.join(userDir, 'ss-01-login-page.png'));

  console.log('📧 Adım 2: E-posta giriliyor...');
  const emailInput = page.locator('input[name="email"]').first();
  await emailInput.waitFor({ timeout: ELEMENT_TIMEOUT });
  await emailInput.click();
  await page.waitForTimeout(300);
  await emailInput.type(EMAIL, { delay: 60 });
  await safeScreenshot(page, path.join(userDir, 'ss-02-email-entered.png'));

  console.log('🔘 Adım 3: E-posta onaylanıyor...');
  await Promise.all([
    page.waitForURL('**/log-in/password**', { timeout: ELEMENT_TIMEOUT }).catch(() => {}),
    page.locator('button[name="intent"][value="email"]').click()
  ]);
  await page.waitForTimeout(3000);
  await safeScreenshot(page, path.join(userDir, 'ss-03-email-confirmed.png'));

  console.log('🔑 Adım 4: Şifre giriliyor...');
  const passInput = page.locator('input[autocomplete="current-password"], input[type="password"]').first();
  await passInput.waitFor({ timeout: ELEMENT_TIMEOUT });
  await passInput.click();
  await page.waitForTimeout(300);
  await passInput.type(PASSWORD, { delay: 40 });
  await safeScreenshot(page, path.join(userDir, 'ss-04-password-entered.png'));

  console.log('🔘 Adım 5: Şifre onaylanıyor...');
  await Promise.all([
    page.waitForURL('**/mfa-challenge/**', { timeout: ELEMENT_TIMEOUT }).catch(() => {}),
    page.locator('button[name="intent"][value="validate"]').click()
  ]);
  await page.waitForTimeout(3000);
  await safeScreenshot(page, path.join(userDir, 'ss-05-password-confirmed.png'));

  const otpCode = generateTOTP(TOTP_SECRET);
  console.log(`🔢 Adım 6: OTP Giriliyor (${otpCode})...`);
  const otpInput = page.locator('input[name="code"]').first();
  await otpInput.waitFor({ timeout: ELEMENT_TIMEOUT });
  await otpInput.click();
  await page.waitForTimeout(300);
  await otpInput.type(otpCode, { delay: 80 });
  await safeScreenshot(page, path.join(userDir, 'ss-06-otp-entered.png'));

  console.log('🔘 Adım 7: OTP onaylanıyor...');
  await Promise.all([
    page.waitForURL('**/chatgpt.com/**', { timeout: PAGE_TIMEOUT }).catch(() => {}),
    page.locator('button[name="intent"][value="verify"]').click()
  ]);
  await page.waitForTimeout(5000);
  await safeScreenshot(page, path.join(userDir, 'ss-07-otp-confirmed.png'));

  console.log('🌐 Adım 8: Ana sayfaya yönlendiriliyor...');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(5000);
  await safeScreenshot(page, path.join(userDir, 'ss-08-homepage.png'));

  return page.url();
}

// ==========================================
// Türkçe Ay Çeviri Tablosu
// ==========================================
const trMonths = {
  'ocak':'january', 'oca':'jan',
  'şubat':'february', 'subat':'february', 'şub':'feb', 'sub':'feb',
  'mart':'march', 'mar':'mar',
  'nisan':'april', 'nis':'apr',
  'mayıs':'may', 'mayis':'may',
  'haziran':'june', 'haz':'jun',
  'temmuz':'july', 'tem':'jul',
  'ağustos':'august', 'agustos':'august', 'ağu':'aug', 'agu':'aug',
  'eylül':'september', 'eylul':'september', 'eyl':'sep',
  'ekim':'october', 'eki':'oct',
  'kasım':'november', 'kasim':'november', 'kas':'nov',
  'aralık':'december', 'aralik':'december', 'ara':'dec'
};

// ==========================================
// Ana Yönetici (CloakBrowser İle)
// ==========================================
(async () => {
  let browser;
  try {
    console.log('\n🦇 CloakBrowser ile fatura indirme başlatılıyor...');

    let sessionCookies = [];
    let hasSavedSession = false;

    // 1. Kayıtlı session var mı kontrol et
    if (fs.existsSync(COOKIE_FILE)) {
      try {
        sessionCookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
        hasSavedSession = true;
        console.log(`\n💾 Kayıtlı session bulundu (${sessionCookies.length} cookie).`);
      } catch (e) {
        console.warn('⚠️ Kayıtlı cookie dosyası okunamadı (Bozuk JSON). Yok sayılıyor.');
      }
    } else {
      console.log('\nℹ️ Kayıtlı session bulunamadı.');
    }

    // 2. CloakBrowser Başlat — FlareSolverr'a gerek YOK!
    console.log('\n🚀 CloakBrowser başlatılıyor...');
    browser = await launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'tr-TR',
      timezoneId: 'Europe/Istanbul',
      acceptDownloads: true
    });

    // Kayıtlı cookie'leri yükle
    if (hasSavedSession) {
      const cleanCookies = sessionCookies.map(c => {
        const { url, ...cleanC } = c;
        return cleanC;
      });
      await context.addCookies(cleanCookies);
    }

    const page = await context.newPage();
    let finalUrl = '';
    let success = false;

    // 3. Cookie ile giriş dene
    if (hasSavedSession) {
      console.log('🌐 Cookie ile ChatGPT anasayfasına gidiliyor...');
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await page.waitForTimeout(5000);
      
      finalUrl = page.url();
      success = finalUrl === 'https://chatgpt.com/' || finalUrl.includes('chatgpt.com/c/');
      
      if (success) {
        console.log('\n✅ COOKIE İLE GİRİŞ BAŞARILI!');
      } else {
        console.log('\n❌ Cookie geçersiz. Sıfırdan login denenecek.');
      }
    }

    // 4. Cookie çalışmadıysa sıfırdan login
    if (!success) {
      finalUrl = await performFullLogin(page);
      success = finalUrl === 'https://chatgpt.com/' || finalUrl.includes('chatgpt.com/c/');
      
      if (success) {
        console.log('\n✅ SIFIRDAN GİRİŞ BAŞARILI!');
      } else {
        console.log('\n❌ Sıfırdan giriş de başarısız oldu.');
      }
    }

    // 5. Başarılı olduysa devam
    if (success) {
      const allCookies = await context.cookies();
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(allCookies, null, 2));
      console.log(`   💾 Güncel Cookie'ler kaydedildi: ${COOKIE_FILE}`);
      
      await safeScreenshot(page, path.join(userDir, 'ss-09-login-success.png'));

      // === FATURA İNDİRME ===
      console.log('\n⚙️ Adım 13: Hesap Ayarları sayfasına gidiliyor (/#settings/Account)...');
      await page.goto('https://chatgpt.com/#settings/Account', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await page.waitForTimeout(4000);
      
      console.log('   URL:', page.url());
      await safeScreenshot(page, path.join(userDir, 'ss-10-settings.png'));

      console.log('\n💳 Adım 14: Ödeme (Payment) bölümündeki "Yönet" butonuna tıklanıyor...');
      const manageBtn = page.locator('button[aria-label="Ödemeyi yönet"], button[aria-label="Manage payment"], button[aria-label="Manage billing"]').first();
      
      try {
        await manageBtn.scrollIntoViewIfNeeded();
        await manageBtn.waitFor({ state: 'visible', timeout: ELEMENT_TIMEOUT });
        
        const pagePromise = context.waitForEvent('page', { timeout: ELEMENT_TIMEOUT }).catch(() => null);
        await manageBtn.click();
        
        const newPage = await pagePromise;
        const stripePage = newPage || page;
        
        const targetSelection = process.env.OPENAI_TARGET_INVOICE || 'last';
        console.log(`\n📄 Adım 15: Fatura bulunuyor... (Seçilen Hedef: ${targetSelection})`);
        
        await stripePage.waitForTimeout(4000);
        await safeScreenshot(stripePage, path.join(userDir, 'ss-11-stripe-portal.png'));

        const invoiceLinks = stripePage.locator('a[data-testid="hip-link"], a[href*="invoice.stripe.com"]');
        await invoiceLinks.first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT });
        
        let targetLink;
        if (targetSelection === 'previous') {
          console.log('   Hedef "previous" (sondan bir önceki) fatura seçildi.');
          targetLink = invoiceLinks.nth(1);
        } else {
          console.log('   Hedef "last" (en güncel) fatura seçildi.');
          targetLink = invoiceLinks.first();
        }
        
        // Fatura tarihini oku
        const invoiceDateText = await targetLink.locator('span').first().textContent().catch(() => '');
        console.log(`   📅 Fatura Tarihi Okundu: ${invoiceDateText.trim()}`);

        let cleanDate = invoiceDateText.toLowerCase().replace(/,/g, '');
        for (const [tr, en] of Object.entries(trMonths)) {
          if (cleanDate.includes(tr)) {
            cleanDate = cleanDate.replace(tr, en);
            break;
          }
        }
        
        const parsedNodeDate = new Date(cleanDate);
        let formattedDate = `${String(new Date().getDate()).padStart(2,'0')}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getFullYear())}`;
        
        if (!isNaN(parsedNodeDate.getTime())) {
          const dd = String(parsedNodeDate.getDate()).padStart(2, '0');
          const mm = String(parsedNodeDate.getMonth() + 1).padStart(2, '0');
          const yyyy = String(parsedNodeDate.getFullYear());
          formattedDate = `${dd}-${mm}-${yyyy}`;
        }
        
        console.log(`   🗓️ Dosya adı için çevrilen tarih: ${formattedDate}`);
        
        // CloakBrowser temiz olduğu için ayrı context ihtiyacı YOK
        // Doğrudan fatura linkine git
        console.log('   🔗 Fatura linkine tıklanıyor...');
        const invoiceUrl = await targetLink.getAttribute('href');
        
        let invoicePage;
        if (invoiceUrl) {
          invoicePage = await context.newPage();
          await invoicePage.goto(invoiceUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        } else {
          const [newInvPage] = await Promise.all([
            context.waitForEvent('page', { timeout: ELEMENT_TIMEOUT }),
            targetLink.click()
          ]);
          invoicePage = newInvPage;
          await invoicePage.waitForLoadState('domcontentloaded');
        }
        
        console.log('   ✅ Fatura sayfası açıldı:', invoicePage.url());
        await invoicePage.waitForTimeout(4000);
        await safeScreenshot(invoicePage, path.join(userDir, 'ss-12-download-page.png'));
        
        const safeEmail = EMAIL.replace(/[^a-zA-Z0-9]/g, '_');
        
        // --- FATURA İNDİRME ---
        console.log('\n📥 Adım 16: Fatura (Invoice) PDF olarak indiriliyor...');
        const downloadInvoiceBtn = invoicePage.locator('button:has-text("Faturayı indir"), button:has-text("Download invoice")').first();
        await downloadInvoiceBtn.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT });
        
        const [invoiceDownload] = await Promise.all([
          invoicePage.waitForEvent('download', { timeout: PAGE_TIMEOUT }),
          downloadInvoiceBtn.click()
        ]);
        
        const invoiceFileName = `${safeEmail}_fatura_${formattedDate}.pdf`;
        await invoiceDownload.saveAs(path.join(userDir, invoiceFileName));
        console.log(`   ✅ Fatura başarıyla indirildi: /data/openai_accounts/${sanitizedEmail}/${invoiceFileName}`);
        
        // --- MAKBUZ İNDİRME ---
        console.log('\n📥 Adım 17: Makbuz (Receipt) PDF olarak indiriliyor...');
        const downloadReceiptBtn = invoicePage.locator('[data-testid="download-invoice-receipt-pdf-button"]').first();
        await downloadReceiptBtn.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT });
        
        const [receiptDownload] = await Promise.all([
          invoicePage.waitForEvent('download', { timeout: PAGE_TIMEOUT }),
          downloadReceiptBtn.click()
        ]);
        
        const receiptFileName = `${safeEmail}_makbuz_${formattedDate}.pdf`;
        await receiptDownload.saveAs(path.join(userDir, receiptFileName));
        console.log(`   ✅ Makbuz başarıyla indirildi: /data/openai_accounts/${sanitizedEmail}/${receiptFileName}`);
        
        console.log('\n🎉 TÜM İŞLEMLER BAŞARIYLA TAMAMLANDI!');

      } catch (e) {
        console.log('   ⚠️ Fatura yönetimi / indirme sürecinde hata:', e.message);
        const errPage = context.pages()[context.pages().length - 1];
        if (errPage) await safeScreenshot(errPage, path.join(userDir, `ss-error-billing-${Date.now()}.png`));
        process.exit(1);
      }
      
    } else {
      await safeScreenshot(page, path.join(userDir, 'ss-final-error.png'));
      process.exit(1);
    }
  } catch (err) {
    console.error('\n❌ Genel Hata Yakalandı:', err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
