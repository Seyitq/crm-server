import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';

export const contractRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  // GET /api/contracts/templates — list templates
  fastify.get('/templates', async () => {
    const templates = await prisma.contractTemplate.findMany({
      where: { isActive: true },
      select: { id: true, name: true, description: true, projectId: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    return { success: true, data: templates };
  });

  // POST /api/contracts/generate — generate contract PDF
  fastify.post('/generate', async (request, reply) => {
    const { saleId, templateId } = z.object({
      saleId: z.string().min(1),
      templateId: z.string().min(1),
    }).parse(request.body);

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        unit: {
          include: {
            block: { include: { project: true } },
            floor: true,
          },
        },
        customer: true,
        consultant: { select: { fullName: true } },
        installments: { orderBy: { order: 'asc' } },
      },
    });

    if (!sale) {
      return reply.status(404).send({ success: false, error: 'Satış bulunamadı' });
    }

    const template = await prisma.contractTemplate.findUnique({ where: { id: templateId } });
    if (!template) {
      return reply.status(404).send({ success: false, error: 'Şablon bulunamadı' });
    }

    // Register Handlebars helpers
    Handlebars.registerHelper('formatDate', (date: string | Date) => {
      const d = new Date(date);
      return `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()}`;
    });

    Handlebars.registerHelper('formatCurrency', (amount: number | string) => {
      const num = typeof amount === 'string' ? parseFloat(amount) : amount;
      return num.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    });

    Handlebars.registerHelper('isCash', function (this: any, options: any) {
      return sale.paymentType === 'CASH' ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper('isBankLoan', function (this: any, options: any) {
      return sale.paymentType === 'BANK_LOAN' ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper('isInstallment', function (this: any, options: any) {
      return sale.paymentType === 'INSTALLMENT' ? options.fn(this) : options.inverse(this);
    });

    // Compile template
    const compiledTemplate = Handlebars.compile(template.content);
    const html = compiledTemplate({
      // Customer data
      customerFullName: `${sale.customer.firstName} ${sale.customer.lastName}`,
      customerFirstName: sale.customer.firstName,
      customerLastName: sale.customer.lastName,
      customerTcNo: sale.customer.tcNo,
      customerPhone: sale.customer.phone,
      customerEmail: sale.customer.email || '',
      customerAddress: sale.customer.address || '',

      // Unit data
      unitCode: sale.unit.code,
      unitType: sale.unit.type || '',
      unitArea: sale.unit.area?.toString() || '',
      blockName: sale.unit.block.name,
      floorNumber: sale.unit.floor.number,
      floorLabel: sale.unit.floor.label || `${sale.unit.floor.number}. Kat`,
      projectName: sale.unit.block.project.name,
      projectAddress: sale.unit.block.project.address || '',

      // Sale data
      totalPrice: sale.totalPrice.toString(),
      saleDate: sale.saleDate,
      paymentType: sale.paymentType,
      paymentTypeName: sale.paymentType === 'CASH' ? 'Peşin' : sale.paymentType === 'BANK_LOAN' ? 'Banka Kredisi' : 'Taksit',
      bankName: sale.bankName || '',
      loanAmount: sale.loanAmount?.toString() || '',
      approvalDate: sale.approvalDate,
      consultantName: sale.consultant.fullName,
      notes: sale.notes || '',

      // Installments
      installments: sale.installments.map(inst => ({
        order: inst.order,
        amount: inst.amount.toString(),
        dueDate: inst.dueDate,
      })),
      installmentCount: sale.installments.length,

      // Meta
      today: new Date(),
      contractDate: new Date(),
    });

    // Generate PDF using Puppeteer with system Edge browser
    let pdfPath: string;
    let fileName: string;
    try {
      const puppeteer = await import('puppeteer');
      
      // Find Edge or Chrome executable
      const browserPaths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ].filter(Boolean);
      
      const executablePath = browserPaths.find(p => p && fs.existsSync(p));
      if (!executablePath) {
        return reply.status(500).send({
          success: false,
          error: 'PDF oluşturmak için Edge veya Chrome bulunamadı. PUPPETEER_EXECUTABLE_PATH env ile tarayıcı yolunu belirtin.',
        });
      }

      const browser = await puppeteer.default.launch({
        headless: true,
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
        ],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        timeout: 30000,
      });

      let page;
      try {
        page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

        fileName = `contract_${sale.id}_${Date.now()}.pdf`;
        const { config } = await import('../config/index.js');
        
        // Ensure contracts directory exists
        if (!fs.existsSync(config.storage.contractsDir)) {
          fs.mkdirSync(config.storage.contractsDir, { recursive: true });
        }
        
        pdfPath = path.join(config.storage.contractsDir, fileName);

        await page.pdf({
          path: pdfPath,
          format: 'A4',
          margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
          printBackground: true,
        });
      } finally {
        try {
          await browser.close();
        } catch {
          // Ignore EBUSY errors during browser cleanup on Windows
        }
      }

      // Save contract record
      const contract = await prisma.contract.create({
        data: {
          saleId: sale.id,
          templateId: template.id,
          pdfPath: fileName,
        },
      });

      return {
        success: true,
        data: {
          contractId: contract.id,
          pdfUrl: `/files/contracts/${fileName}`,
          generatedAt: contract.generatedAt,
        },
      };
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: `PDF oluşturulamadı: ${error.message}`,
      });
    }
  });

  // GET /api/contracts/sale/:saleId — list contracts for a sale
  fastify.get<{ Params: { saleId: string } }>('/sale/:saleId', async (request) => {
    const { saleId } = request.params;

    const contracts = await prisma.contract.findMany({
      where: { saleId },
      include: { template: { select: { name: true } } },
      orderBy: { generatedAt: 'desc' },
    });

    return {
      success: true,
      data: contracts.map(c => ({
        id: c.id,
        templateName: c.template.name,
        pdfUrl: `/files/contracts/${c.pdfPath}`,
        generatedAt: c.generatedAt,
      })),
    };
  });
};
