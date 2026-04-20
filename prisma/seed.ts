import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function seed() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const adminPasswordHash = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: adminPasswordHash,
      fullName: 'Sistem Yöneticisi',
      role: 'ADMIN',
      phone: '05551234567',
      email: 'admin@crm.local',
    },
  });
  console.log(`  ✅ Admin user: ${admin.username}`);

  // Create sample sales consultants
  const consultantPasswordHash = await bcrypt.hash('danisman123', 12);

  const consultant1 = await prisma.user.upsert({
    where: { username: 'ahmet.yilmaz' },
    update: {},
    create: {
      username: 'ahmet.yilmaz',
      passwordHash: consultantPasswordHash,
      fullName: 'Ahmet Yılmaz',
      role: 'SALES_CONSULTANT',
      phone: '05559876543',
    },
  });

  const consultant2 = await prisma.user.upsert({
    where: { username: 'ayse.demir' },
    update: {},
    create: {
      username: 'ayse.demir',
      passwordHash: consultantPasswordHash,
      fullName: 'Ayşe Demir',
      role: 'SALES_CONSULTANT',
      phone: '05553456789',
    },
  });
  console.log(`  ✅ Consultants: ${consultant1.fullName}, ${consultant2.fullName}`);

  // Create a sample project
  const project = await prisma.project.upsert({
    where: { id: 'sample-project-1' },
    update: {},
    create: {
      id: 'sample-project-1',
      name: 'Yeşil Vadi Konutları',
      description: 'Modern yaşamın adresi, 3 blok, toplam 180 daire',
      address: 'Ataşehir, İstanbul',
    },
  });
  console.log(`  ✅ Project: ${project.name}`);

  // Assign consultants to project
  await prisma.userProject.upsert({
    where: { userId_projectId: { userId: consultant1.id, projectId: project.id } },
    update: {},
    create: { userId: consultant1.id, projectId: project.id },
  });
  await prisma.userProject.upsert({
    where: { userId_projectId: { userId: consultant2.id, projectId: project.id } },
    update: {},
    create: { userId: consultant2.id, projectId: project.id },
  });
  console.log('  ✅ Consultants assigned to project');

  // Create blocks
  const blockA = await prisma.block.upsert({
    where: { id: 'block-a' },
    update: {},
    create: { id: 'block-a', name: 'A Blok', projectId: project.id, order: 1 },
  });
  const blockB = await prisma.block.upsert({
    where: { id: 'block-b' },
    update: {},
    create: { id: 'block-b', name: 'B Blok', projectId: project.id, order: 2 },
  });
  console.log(`  ✅ Blocks: ${blockA.name}, ${blockB.name}`);

  // Create floors for Block A (10 floors)
  for (let i = 1; i <= 10; i++) {
    const floorId = `floor-a-${i}`;
    const floor = await prisma.floor.upsert({
      where: { id: floorId },
      update: {},
      create: {
        id: floorId,
        number: i,
        label: i === 0 ? 'Zemin Kat' : `${i}. Kat`,
        blockId: blockA.id,
      },
    });

    // Create 6 units per floor
    for (let j = 1; j <= 6; j++) {
      const unitCode = `A-${i}0${j}`;
      const types = ['1+1', '2+1', '3+1', '2+1', '3+1', '4+1'];
      const areas = [65, 95, 130, 95, 130, 165];
      const basePrices = [1500000, 2500000, 3500000, 2500000, 3500000, 4500000];

      await prisma.unit.upsert({
        where: { code_blockId: { code: unitCode, blockId: blockA.id } },
        update: {},
        create: {
          code: unitCode,
          floorId: floor.id,
          blockId: blockA.id,
          type: types[j - 1],
          area: areas[j - 1],
          price: basePrices[j - 1] + (i * 50000), // Higher floors = higher price
        },
      });
    }
  }
  console.log('  ✅ Block A: 10 floors, 60 units');

  // Create floors for Block B (10 floors)
  for (let i = 1; i <= 10; i++) {
    const floorId = `floor-b-${i}`;
    const floor = await prisma.floor.upsert({
      where: { id: floorId },
      update: {},
      create: {
        id: floorId,
        number: i,
        label: `${i}. Kat`,
        blockId: blockB.id,
      },
    });

    for (let j = 1; j <= 6; j++) {
      const unitCode = `B-${i}0${j}`;
      const types = ['2+1', '2+1', '3+1', '3+1', '2+1', '3+1'];
      const areas = [90, 95, 125, 130, 90, 125];
      const basePrices = [2200000, 2400000, 3200000, 3400000, 2200000, 3200000];

      await prisma.unit.upsert({
        where: { code_blockId: { code: unitCode, blockId: blockB.id } },
        update: {},
        create: {
          code: unitCode,
          floorId: floor.id,
          blockId: blockB.id,
          type: types[j - 1],
          area: areas[j - 1],
          price: basePrices[j - 1] + (i * 50000),
        },
      });
    }
  }
  console.log('  ✅ Block B: 10 floors, 60 units');

  // Create sample customers
  const customer1 = await prisma.customer.upsert({
    where: { tcNo: '12345678901' },
    update: {},
    create: {
      tcNo: '12345678901',
      firstName: 'Mehmet',
      lastName: 'Kaya',
      phone: '05321234567',
      email: 'mehmet.kaya@email.com',
      address: 'Kadıköy, İstanbul',
    },
  });

  const customer2 = await prisma.customer.upsert({
    where: { tcNo: '98765432109' },
    update: {},
    create: {
      tcNo: '98765432109',
      firstName: 'Fatma',
      lastName: 'Öztürk',
      phone: '05339876543',
      email: 'fatma.ozturk@email.com',
      address: 'Beşiktaş, İstanbul',
    },
  });
  console.log(`  ✅ Customers: ${customer1.firstName} ${customer1.lastName}, ${customer2.firstName} ${customer2.lastName}`);

  // Create a sample contract template
  await prisma.contractTemplate.upsert({
    where: { id: 'template-default' },
    update: {},
    create: {
      id: 'template-default',
      name: 'Standart Satış Sözleşmesi',
      description: 'Tüm projelerde kullanılan standart satış sözleşmesi',
      content: `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <title>Gayrimenkul Satış Sözleşmesi</title>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Cormorant+Garamond:wght@300;400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #1a1a2e;
      --gold: #b8902a;
      --gold-light: #d4af5a;
      --rule: #c8b99a;
      --bg: #faf8f4;
      --paper: #ffffff;
      --muted: #6b6150;
      --accent-bg: #f5f0e8;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 11.5pt;
      line-height: 1.75;
      color: var(--ink);
      background: var(--bg);
      padding: 0;
    }

    .page {
      max-width: 820px;
      margin: 40px auto;
      background: var(--paper);
      box-shadow: 0 4px 40px rgba(0,0,0,0.12);
      border: 1px solid #e8e0d0;
      position: relative;
    }

    /* Decorative corner borders */
    .page::before, .page::after {
      content: '';
      position: absolute;
      width: 60px;
      height: 60px;
      border-color: var(--gold);
      border-style: solid;
      z-index: 2;
      pointer-events: none;
    }
    .page::before { top: 20px; left: 20px; border-width: 2px 0 0 2px; }
    .page::after  { bottom: 20px; right: 20px; border-width: 0 2px 2px 0; }

    .inner-corners::before, .inner-corners::after {
      content: '';
      position: absolute;
      width: 60px;
      height: 60px;
      border-color: var(--gold);
      border-style: solid;
      z-index: 2;
      pointer-events: none;
    }
    .inner-corners::before { top: 20px; right: 20px; border-width: 2px 2px 0 0; }
    .inner-corners::after  { bottom: 20px; left: 20px; border-width: 0 0 2px 2px; }

    .content {
      padding: 64px 72px 72px;
    }

    /* ─── HEADER ─── */
    .header {
      text-align: center;
      padding-bottom: 36px;
      border-bottom: 1px solid var(--rule);
      margin-bottom: 36px;
    }

    .header-ornament {
      font-size: 22pt;
      color: var(--gold);
      letter-spacing: 12px;
      display: block;
      margin-bottom: 12px;
    }

    h1 {
      font-family: Georgia, 'Times New Roman', serif;
      font-weight: 600;
      font-size: 22pt;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: var(--ink);
      margin-bottom: 10px;
    }

    .header-subtitle {
      font-size: 10pt;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--muted);
    }

    .header-date {
      margin-top: 14px;
      font-size: 10.5pt;
      color: var(--muted);
      font-style: italic;
    }

    /* ─── SECTION HEADINGS ─── */
    .section {
      margin-bottom: 32px;
    }

    h2 {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 11pt;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 14px;
      padding-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    h2::after {
      content: '';
      flex: 1;
      height: 1px;
      background: linear-gradient(to right, var(--rule), transparent);
    }

    h2 .section-num {
      font-size: 9pt;
      font-weight: 600;
      color: var(--muted);
      letter-spacing: 1px;
    }

    /* ─── PARTIES ─── */
    .parties-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }

    .party-card {
      background: var(--accent-bg);
      border: 1px solid var(--rule);
      border-top: 3px solid var(--gold);
      padding: 20px 24px;
    }

    .party-label {
      font-size: 8.5pt;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--rule);
    }

    .party-row {
      display: flex;
      gap: 8px;
      margin-bottom: 5px;
      font-size: 10.5pt;
    }

    .party-field {
      font-weight: 600;
      color: var(--muted);
      min-width: 90px;
      font-size: 9.5pt;
      letter-spacing: 0.5px;
    }

    .party-value {
      color: var(--ink);
      font-weight: 500;
    }

    /* ─── PROPERTY INFO ─── */
    .property-box {
      background: var(--accent-bg);
      border: 1px solid var(--rule);
      padding: 20px 24px;
      line-height: 1.9;
    }

    .property-box p { font-size: 11pt; }

    .highlight {
      font-weight: 600;
      color: var(--ink);
      border-bottom: 1px dotted var(--gold);
      padding-bottom: 1px;
    }

    /* ─── PRICE BOX ─── */
    .price-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--ink);
      color: white;
      padding: 20px 28px;
    }

    .price-label {
      font-size: 9pt;
      letter-spacing: 2px;
      text-transform: uppercase;
      opacity: 0.7;
    }

    .price-amount {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 22pt;
      font-weight: 600;
      color: var(--gold-light);
      letter-spacing: 1px;
    }

    .price-sub {
      font-size: 9pt;
      opacity: 0.55;
      margin-top: 2px;
      letter-spacing: 0.5px;
    }

    /* ─── PAYMENT TYPE BADGE ─── */
    .payment-type-row {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
    }

    .badge {
      display: inline-block;
      background: var(--gold);
      color: white;
      font-size: 8.5pt;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      padding: 5px 14px;
    }

    .payment-note {
      font-size: 10.5pt;
      color: var(--muted);
      font-style: italic;
    }

    /* ─── BANK LOAN ─── */
    .loan-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1px;
      background: var(--rule);
      border: 1px solid var(--rule);
      margin-top: 12px;
    }

    .loan-cell {
      background: var(--accent-bg);
      padding: 14px 18px;
    }

    .loan-cell-label {
      font-size: 8.5pt;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
    }

    .loan-cell-value {
      font-size: 13pt;
      font-weight: 600;
      color: var(--ink);
    }

    /* ─── INSTALLMENT TABLE ─── */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
      font-size: 10.5pt;
    }

    thead tr {
      background: var(--ink);
      color: white;
    }

    thead th {
      padding: 10px 14px;
      font-size: 8.5pt;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      text-align: left;
    }

    tbody tr {
      border-bottom: 1px solid #ece7dc;
      transition: background 0.15s;
    }

    tbody tr:nth-child(even) { background: var(--accent-bg); }

    tbody td {
      padding: 9px 14px;
      color: var(--ink);
    }

    .amount { text-align: right; font-weight: 600; }

    tfoot tr {
      background: var(--accent-bg);
      border-top: 2px solid var(--gold);
    }

    tfoot td {
      padding: 10px 14px;
      font-weight: 700;
      font-size: 11pt;
      color: var(--gold);
    }

    /* ─── GENERAL PROVISIONS ─── */
    .provisions p {
      font-size: 10.5pt;
      color: var(--muted);
      margin-bottom: 8px;
      padding-left: 16px;
      border-left: 2px solid var(--rule);
    }

    /* ─── SIGNATURES ─── */
    .signature-section {
      margin-top: 52px;
      padding-top: 32px;
      border-top: 1px solid var(--rule);
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
    }

    .signature-box {
      text-align: center;
    }

    .signature-label {
      font-size: 8.5pt;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--gold);
      font-weight: 700;
      margin-bottom: 6px;
    }

    .signature-name {
      font-size: 11pt;
      color: var(--ink);
      font-weight: 500;
      margin-bottom: 48px;
    }

    .signature-line {
      width: 80%;
      margin: 0 auto;
      border-top: 1px solid var(--ink);
      padding-top: 8px;
      font-size: 9pt;
      color: var(--muted);
      font-style: italic;
      letter-spacing: 0.5px;
    }

    /* ─── FOOTER ─── */
    .doc-footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--rule);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .doc-footer-left {
      font-size: 9pt;
      color: var(--muted);
    }

    .doc-footer-left strong { color: var(--ink); }

    .doc-seal {
      width: 60px;
      height: 60px;
      border: 2px solid var(--rule);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
    }

    .doc-seal-text {
      font-size: 6pt;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted);
      text-align: center;
      line-height: 1.4;
    }

    /* ─── PRINT ─── */
    @media print {
      body { background: white; padding: 0; }
      .page { margin: 0; box-shadow: none; border: none; max-width: 100%; }
      .page::before, .page::after,
      .inner-corners::before, .inner-corners::after { display: none; }
      .content { padding: 30px 40px; }
      .price-box { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="inner-corners"></div>
    <div class="content">

      <!-- HEADER -->
      <div class="header">
        <span class="header-ornament">✦ ✦ ✦</span>
        <h1>Gayrimenkul Satış Sözleşmesi</h1>
        <p class="header-subtitle">Resmi Satış Belgesi &nbsp;·&nbsp; Tapu Devrine Esas</p>
        <p class="header-date">Düzenlenme Tarihi: {{formatDate today}}</p>
      </div>

      <!-- 1. TARAFLAR -->
      <div class="section">
        <h2><span class="section-num">01</span> Taraflar</h2>
        <div class="parties-grid">
          <div class="party-card">
            <div class="party-label">Satıcı</div>
            <div class="party-row">
              <span class="party-field">Unvan</span>
              <span class="party-value">{{projectName}}</span>
            </div>
            <div class="party-row">
              <span class="party-field">Adres</span>
              <span class="party-value">{{projectAddress}}</span>
            </div>
          </div>
          <div class="party-card">
            <div class="party-label">Alıcı</div>
            <div class="party-row">
              <span class="party-field">Ad Soyad</span>
              <span class="party-value">{{customerFullName}}</span>
            </div>
            <div class="party-row">
              <span class="party-field">TC Kimlik</span>
              <span class="party-value">{{customerTcNo}}</span>
            </div>
            <div class="party-row">
              <span class="party-field">Telefon</span>
              <span class="party-value">{{customerPhone}}</span>
            </div>
            <div class="party-row">
              <span class="party-field">Adres</span>
              <span class="party-value">{{customerAddress}}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. SÖZLEŞME KONUSU -->
      <div class="section">
        <h2><span class="section-num">02</span> Sözleşme Konusu</h2>
        <div class="property-box">
          <p>
            <span class="highlight">{{projectName}}</span> projesinde yer alan,
            Blok: <span class="highlight">{{blockName}}</span> &nbsp;/&nbsp;
            Kat: <span class="highlight">{{floorLabel}}</span> &nbsp;/&nbsp;
            Daire No: <span class="highlight">{{unitCode}}</span> numaralı,
            <span class="highlight">{{unitType}}</span> tipinde,
            brüt <span class="highlight">{{unitArea}} m²</span> alanlı
            bağımsız bölümün 2644 sayılı Tapu Kanunu hükümleri çerçevesinde
            aşağıda belirlenen bedel ve koşullar dahilinde satışıdır.
          </p>
        </div>
      </div>

      <!-- 3. SATIŞ BEDELİ -->
      <div class="section">
        <h2><span class="section-num">03</span> Satış Bedeli</h2>
        <div class="price-box">
          <div>
            <div class="price-label">Toplam Satış Bedeli</div>
            <div class="price-sub">Türk Lirası cinsinden &nbsp;·&nbsp; KDV Dahil</div>
          </div>
          <div style="text-align:right;">
            <div class="price-amount">{{formatCurrency totalPrice}} ₺</div>
          </div>
        </div>
      </div>

      <!-- 4. ÖDEME KOŞULLARI -->
      <div class="section">
        <h2><span class="section-num">04</span> Ödeme Koşulları</h2>

        <div class="payment-type-row">
          <span class="badge">{{paymentTypeName}}</span>
        </div>

        {{#isCash}}
        <p class="payment-note">Satış bedeli peşin olarak, sözleşme imza tarihinde tek seferde ödenecektir.</p>
        {{/isCash}}

        {{#isBankLoan}}
        <p class="payment-note">Satış bedeli banka konut kredisi aracılığıyla ödenecektir. Kredi onayı ve ödeme, aşağıda belirtilen banka tarafından gerçekleştirilecektir.</p>
        <div class="loan-grid">
          <div class="loan-cell">
            <div class="loan-cell-label">Banka</div>
            <div class="loan-cell-value">{{bankName}}</div>
          </div>
          <div class="loan-cell">
            <div class="loan-cell-label">Kredi Tutarı</div>
            <div class="loan-cell-value">{{formatCurrency loanAmount}} ₺</div>
          </div>
        </div>
        {{/isBankLoan}}

        {{#isInstallment}}
        <p class="payment-note">Satış bedeli aşağıdaki taksit planına uygun olarak ödenecektir. Herhangi bir taksitin vadesinde ödenmemesi halinde temerrüt hükümleri uygulanır.</p>
        <table>
          <thead>
            <tr>
              <th>Taksit No</th>
              <th>Vade Tarihi</th>
              <th style="text-align:right;">Tutar</th>
            </tr>
          </thead>
          <tbody>
            {{#each installments}}
            <tr>
              <td>{{this.order}}</td>
              <td>{{formatDate this.dueDate}}</td>
              <td class="amount">{{formatCurrency this.amount}} ₺</td>
            </tr>
            {{/each}}
          </tbody>
        </table>
        {{/isInstallment}}
      </div>

      <!-- 5. GENEL HÜKÜMLER -->
      <div class="section">
        <h2><span class="section-num">05</span> Genel Hükümler</h2>
        <div class="provisions">
          <p>İşbu sözleşme, taraflar arasında karşılıklı irade beyanı ile akdedilmiş olup, Türk Borçlar Kanunu ve ilgili mevzuat hükümleri çerçevesinde hüküm doğurur.</p>
          <p>Uyuşmazlıkların çözümünde öncelikle taraflarca dostane çözüm yolu aranacak; uzlaşı sağlanamaması halinde {{projectName}} merkezinin bulunduğu yerdeki mahkemeler ve icra daireleri yetkili kılınmıştır.</p>
          <p>Sözleşme iki (2) asıl nüsha olarak düzenlenmiş olup birer nüshası her bir tarafa teslim edilmiştir. Tüm maddeler taraflarca okunmuş ve kabul edilmiştir.</p>
        </div>
      </div>

      <!-- İMZALAR -->
      <div class="signature-section">
        <div class="signature-box">
          <div class="signature-label">Satıcı</div>
          <div class="signature-name">{{projectName}}</div>
          <div class="signature-line">Ad Soyad / İmza / Kaşe</div>
        </div>
        <div class="signature-box">
          <div class="signature-label">Alıcı</div>
          <div class="signature-name">{{customerFullName}}</div>
          <div class="signature-line">Ad Soyad / İmza</div>
        </div>
      </div>

      <!-- FOOTER -->
      <div class="doc-footer">
        <div class="doc-footer-left">
          <div>Danışman: <strong>{{consultantName}}</strong></div>
          <div>Belge Tarihi: {{formatDate today}}</div>
        </div>
        <div class="doc-seal">
          <div class="doc-seal-text">Resmi<br>Belge</div>
        </div>
      </div>

    </div>
  </div>
</body>
</html>`,
      projectId: project.id,
    },
  });
  console.log('  ✅ Contract template created');

  console.log('\n🎉 Seed completed successfully!');
  console.log('\n📋 Login credentials:');
  console.log('   Admin:      admin / admin123');
  console.log('   Consultant: ahmet.yilmaz / danisman123');
  console.log('   Consultant: ayse.demir / danisman123');
}

seed()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
