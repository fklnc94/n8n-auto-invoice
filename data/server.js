const http = require('http');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ==========================================
// 🦇 CloakBrowser Kuyruğu (Tek Sıralı)
// ==========================================
// Aynı anda birden fazla CloakBrowser çalışmasını engellemek için
// tek sarmallı (single-threaded) bir işlem kuyruğu (queue) mimarisi.
let isCloakRunning = false;
const cloakQueue = [];

function processCloakQueue() {
  if (isCloakRunning || cloakQueue.length === 0) return;

  isCloakRunning = true;
  const { req, res, payload, targetInvoice, childEnv } = cloakQueue.shift();
  const email = payload.email;

  console.log(`\n[${new Date().toISOString()}] 🦇 CloakBrowser sırası geldi! (Hesap: ${email}, Hedef: ${targetInvoice}) [Kuyrukta kalan: ${cloakQueue.length}]`);

  exec('node main-cloak.mjs', { env: childEnv }, (cloakError, cloakStdout, cloakStderr) => {
    if (!cloakError) {
      // ✅ CloakBrowser başarılı!
      console.log(`\n--- CLOAKBROWSER BAŞARILI (${email}) ---`);
      if (cloakStderr) console.error(`⚠️ UYARI:\n${cloakStderr}`);
      console.log(`✅ ÇIKTI:\n${cloakStdout}`);
      console.log(`--------------------------------\n`);

      const invMatch = cloakStdout.match(/✅ Fatura başarıyla indirildi: \/data\/(.*\.pdf)/);
      const recMatch = cloakStdout.match(/✅ Makbuz başarıyla indirildi: \/data\/(.*\.pdf)/);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        engine: 'cloakbrowser',
        message: `CloakBrowser ile fatura başarıyla indirildi. Hedef: ${targetInvoice}`,
        invoiceFileName: invMatch ? invMatch[1] : null,
        receiptFileName: recMatch ? recMatch[1] : null,
        logs: cloakStdout,
        warnings: cloakStderr,
        timestamp: new Date().toISOString(),
        email: payload.email,
        owner: payload.owner,
        targetInvoice: payload.targetInvoice,
        signatureText: payload.signatureText
      }));
    } else {
      // ❌ CloakBrowser başarısız → Fallback: Playwright kuyruğuna aktar
      console.log(`\n   ❌ CloakBrowser başarısız (${email}): ${cloakError.message.substring(0, 100)}`);
      console.log(`   🔄 FALLBACK: Playwright+FlareSolverr kuyruğuna ekleniyor...`);

      playwrightQueue.push({ req, res, payload, targetInvoice, childEnv });
      processPlaywrightQueue();
    }

    // Mevcut CloakBrowser işlemi bitti, sıradakine geç
    isCloakRunning = false;
    processCloakQueue();
  });
}

// ==========================================
// 🎭 Playwright Kuyruğu (Tek Sıralı - Fallback)
// ==========================================
let isPlaywrightRunning = false;
const playwrightQueue = [];

function processPlaywrightQueue() {
  if (isPlaywrightRunning || playwrightQueue.length === 0) return;

  isPlaywrightRunning = true;
  const { req, res, payload, targetInvoice, childEnv } = playwrightQueue.shift();
  const email = payload.email;

  console.log(`\n[${new Date().toISOString()}] 🚦 Playwright sırası geldi! (Hesap: ${email}, Hedef: ${targetInvoice}) [Kuyrukta kalan: ${playwrightQueue.length}]`);

  exec('node main.js', { env: childEnv }, (error, stdout, stderr) => {
    console.log(`\n--- PLAYWRIGHT İŞLEM SONUCU (${email}) ---`);
    let finalStatus = 'success';

    if (error) {
      console.error(`❌ HATA:\n${error.message}`);
      finalStatus = 'error';
    }
    if (stderr) {
      console.error(`⚠️ UYARI:\n${stderr}`);
    }
    console.log(`✅ ÇIKTI:\n${stdout}`);
    console.log(`--------------------------------\n`);

    const invMatch = stdout.match(/✅ Fatura başarıyla indirildi: \/data\/(.*\.pdf)/);
    const recMatch = stdout.match(/✅ Makbuz başarıyla indirildi: \/data\/(.*\.pdf)/);
    const invoiceFileName = invMatch ? invMatch[1] : null;
    const receiptFileName = recMatch ? recMatch[1] : null;

    res.writeHead(finalStatus === 'success' ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: finalStatus,
      message: finalStatus === 'success' ? `Fatura başarıyla indirildi. Hedef: ${targetInvoice}` : `Fatura indirilirken hata oluştu.`,
      invoiceFileName,
      receiptFileName,
      logs: stdout,
      errorMessage: error ? error.message : null,
      warnings: stderr,
      timestamp: new Date().toISOString(),
      email: payload.email,
      owner: payload.owner,
      targetInvoice: payload.targetInvoice,
      signatureText: payload.signatureText
    }));

    // Mevcut işlem bitince kuyruktaki sıradaki işleme geç
    isPlaywrightRunning = false;
    processPlaywrightQueue();
  });
}

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/trigger-invoice') {
    let rawData = '';
    req.on('data', chunk => rawData += chunk);
    req.on('end', () => {
      let payload = {};
      try {
        if (rawData) payload = JSON.parse(rawData);
      } catch (e) {
        console.error('Invalid JSON received');
      }

      const email = payload.email || '';
      const password = payload.password || '';
      const totpSecret = payload.totpSecret || '';
      const targetInvoice = payload.targetInvoice || 'last';

      if (!email || !password || !totpSecret) {
        console.log(`[${new Date().toISOString()}] ⚠️ Geçersiz/Boş payload geldi. Zorunlu giriş bilgileri eksik olduğu için işlem atlandı.`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          status: 'skipped',
          error: 'Eksik parametreler: email, password veya totpSecret bulunamadı.'
        }));
      }

      console.log(`[${new Date().toISOString()}] n8n'den tetikleme geldi! (Hesap: ${email}, Hedef: ${targetInvoice})`);

      const childEnv = Object.assign({}, process.env, {
        OPENAI_EMAIL: email,
        OPENAI_PASSWORD: password,
        OPENAI_TOTP_SECRET: totpSecret,
        OPENAI_TARGET_INVOICE: targetInvoice
      });

      // ====================================================
      // 🦇 CloakBrowser kuyruğuna ekle (tek sıralı işlem)
      // ====================================================
      console.log(`   🦇 CloakBrowser kuyruğuna eklendi. [Kuyruk: ${cloakQueue.length + 1}]`);
      cloakQueue.push({ req, res, payload, targetInvoice, childEnv });
      processCloakQueue();
    });

  } else if (req.url === '/edit-pdf' && req.method === 'POST') {
    let rawData = '';
    req.on('data', chunk => rawData += chunk);
    req.on('end', async () => {
      let payload = {};
      try {
        if (rawData) payload = JSON.parse(rawData);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Geçersiz JSON formatı' }));
      }

      const { invoiceFileName, receiptFileName, declarationText, signatureText } = payload;
      if (!invoiceFileName && !receiptFileName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Düzenlenecek dosya adı gönderilmedi (invoiceFileName veya receiptFileName).' }));
      }

      const customDeclaration = declarationText || process.env.PDF_DECLARATION_TEXT || "SAT- .................................. numaralı yapay zeka hizmetleri satın alımına ilişkin onaylanmış talep formuna istinaden ödemesi gerçekleştirilmiştir.";
      const customSignature = signatureText || process.env.PDF_SIGNATURE_TEXT || "Fatih KILINÇ";

      const { PDFDocument, rgb } = require('pdf-lib');
      const fontkit = require('@pdf-lib/fontkit');
      const fs = require('fs');
      const path = require('path');

      const results = [];
      const errors = [];

      async function editPdf(filename) {
        try {
          const filePath = path.join(__dirname, filename);
          if (!fs.existsSync(filePath)) throw new Error(`Dosya bulunamadı: ${filename}`);

          const pdfBytes = fs.readFileSync(filePath);
          const pdfDoc = await PDFDocument.load(pdfBytes);
          pdfDoc.registerFontkit(fontkit);

          const fontBytes = fs.readFileSync(path.join(__dirname, 'Roboto-Regular.ttf'));
          const customFont = await pdfDoc.embedFont(fontBytes);
          const fontSize = 10;

          const pages = pdfDoc.getPages();
          if (pages.length === 0) return;

          const page = pages[0];
          const { width, height } = page.getSize();
          const box8TopY = height * 0.30;

          // Genişliğe göre otomatik alt satıra geçmesi için maxWidth kullanıyoruz
          page.drawText(customDeclaration, {
            x: 50,
            y: box8TopY - 15,
            size: fontSize,
            font: customFont,
            color: rgb(0, 0, 0),
            maxWidth: width - 100, // Soldan 50, sağdan 50 boşluk kalacak genişlik
            lineHeight: 15
          });

          const textWidth = customFont.widthOfTextAtSize(customSignature, fontSize);

          // İsim kısmı 9. bölgenin sağ üst köşesi / 8. bölgenin sağ alt köşesi
          const box9TopY = height * 0.20;
          page.drawText(customSignature, {
            x: width - 50 - textWidth,
            y: box9TopY - 5, // 9. kutunun tam tepesi/8'in en altı
            size: fontSize,
            font: customFont,
            color: rgb(0, 0, 0)
          });

          const modifiedBytes = await pdfDoc.save();
          fs.writeFileSync(filePath, modifiedBytes);
          results.push(`${filename} başarıyla düzenlendi.`);
          return { filename: path.basename(filePath), content: Buffer.from(modifiedBytes).toString('base64') };
        } catch (err) {
          errors.push(`${filename} düzenlenirken hata: ${err.message}`);
          return null;
        }
      }

      const base64Files = [];

      if (invoiceFileName) {
        const res = await editPdf(invoiceFileName);
        if (res) base64Files.push(res);
      }
      if (receiptFileName) {
        const res = await editPdf(receiptFileName);
        if (res) base64Files.push(res);
      }

      res.writeHead(errors.length === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: errors.length === 0 ? 'success' : 'partial_or_full_error',
        results,
        base64Files,
        errors,
        timestamp: new Date().toISOString(),
        email: payload.email,
        owner: payload.owner,
        targetInvoice: payload.targetInvoice
      }));
    });

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint bulunamadı. Lütfen /trigger-invoice veya /edit-pdf adresine POST isteği atın.' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 [WORKER] Webhook dinleniyor: http://${HOST}:${PORT}`);
  console.log(`   n8n üzerinden POST/GET isteği atabilirsiniz: http://[local-ip]:${PORT}/trigger-invoice`);
});
