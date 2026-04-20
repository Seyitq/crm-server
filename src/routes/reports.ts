import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

export const reportRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  // GET /api/reports/project-sales — Project Sales Summary
  fastify.get('/project-sales', async (request) => {
    const projects = await prisma.project.findMany({
      where: { isActive: true },
      include: {
        blocks: {
          include: {
            units: {
              select: { status: true, price: true },
            },
          },
        },
      },
    });

    const data = projects.map(project => {
      const allUnits = project.blocks.flatMap(b => b.units);
      const soldUnits = allUnits.filter(u => u.status === 'SOLD');
      return {
        projectId: project.id,
        projectName: project.name,
        totalUnits: allUnits.length,
        soldUnits: soldUnits.length,
        reservedUnits: allUnits.filter(u => u.status === 'RESERVED').length,
        availableUnits: allUnits.filter(u => u.status === 'AVAILABLE').length,
        totalRevenue: soldUnits.reduce((sum, u) => sum + Number(u.price), 0),
      };
    });

    return { success: true, data };
  });

  // GET /api/reports/consultant-performance
  fastify.get('/consultant-performance', { preHandler: [requireAdmin] }, async () => {
    const consultants = await prisma.user.findMany({
      where: { role: 'SALES_CONSULTANT', isActive: true },
      select: {
        id: true,
        fullName: true,
        sales: {
          select: { totalPrice: true },
        },
        deposits: {
          where: { status: 'ACTIVE' },
          select: { id: true },
        },
      },
    });

    const data = consultants.map(c => ({
      consultantId: c.id,
      consultantName: c.fullName,
      totalSales: c.sales.length,
      totalRevenue: c.sales.reduce((sum, s) => sum + Number(s.totalPrice), 0),
      activeDeposits: c.deposits.length,
    }));

    return { success: true, data };
  });

  // GET /api/reports/collections?period=daily|monthly&date=YYYY-MM-DD
  fastify.get('/collections', { preHandler: [requireAdmin] }, async (request) => {
    const { period = 'daily', startDate, endDate } = request.query as any;

    const start = startDate ? new Date(startDate) : new Date(new Date().setDate(1)); // First of month
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    const sales = await prisma.sale.findMany({
      where: {
        saleDate: { gte: start, lte: end },
      },
      select: {
        saleDate: true,
        totalPrice: true,
        paymentType: true,
      },
      orderBy: { saleDate: 'asc' },
    });

    const installmentPayments = await prisma.installment.findMany({
      where: {
        paidDate: { gte: start, lte: end },
        status: 'PAID',
      },
      select: {
        paidDate: true,
        paidAmount: true,
      },
    });

    return {
      success: true,
      data: {
        sales,
        installmentPayments,
        summary: {
          totalCash: sales.filter(s => s.paymentType === 'CASH').reduce((sum, s) => sum + Number(s.totalPrice), 0),
          totalBankLoan: sales.filter(s => s.paymentType === 'BANK_LOAN').reduce((sum, s) => sum + Number(s.totalPrice), 0),
          totalInstallment: sales.filter(s => s.paymentType === 'INSTALLMENT').reduce((sum, s) => sum + Number(s.totalPrice), 0),
          totalInstallmentCollected: installmentPayments.reduce((sum, p) => sum + Number(p.paidAmount || 0), 0),
        },
      },
    };
  });

  // GET /api/reports/overdue-installments
  fastify.get('/overdue-installments', async (request) => {
    const where: any = {
      status: 'PENDING',
      dueDate: { lt: new Date() },
    };

    if (request.user.role === 'SALES_CONSULTANT') {
      where.sale = { consultantId: request.user.userId };
    }

    const overdue = await prisma.installment.findMany({
      where,
      include: {
        sale: {
          include: {
            unit: { select: { code: true } },
            customer: { select: { firstName: true, lastName: true, phone: true } },
            consultant: { select: { fullName: true } },
          },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    const data = overdue.map(inst => ({
      installmentId: inst.id,
      saleId: inst.saleId,
      unitCode: inst.sale.unit.code,
      customerName: `${inst.sale.customer.firstName} ${inst.sale.customer.lastName}`,
      customerPhone: inst.sale.customer.phone,
      consultantName: inst.sale.consultant.fullName,
      amount: Number(inst.amount),
      dueDate: inst.dueDate.toISOString(),
      daysOverdue: Math.floor((Date.now() - inst.dueDate.getTime()) / (1000 * 60 * 60 * 24)),
    }));

    return { success: true, data };
  });

  // GET /api/reports/monthly-stats?year=YYYY — aylık satış istatistikleri
  fastify.get('/monthly-stats', { preHandler: [requireAdmin] }, async (request) => {
    const { year } = request.query as { year?: string };
    const targetYear = year ? parseInt(year) : new Date().getFullYear();

    if (isNaN(targetYear) || targetYear < 2000 || targetYear > 2100) {
      return { success: false, error: 'Geçersiz yıl' };
    }

    const start = new Date(targetYear, 0, 1);
    const end   = new Date(targetYear + 1, 0, 1);

    const sales = await prisma.sale.findMany({
      where: { saleDate: { gte: start, lt: end } },
      select: { saleDate: true, totalPrice: true },
    });

    // Build 12-month array
    const months: { month: number; label: string; salesCount: number; revenue: number }[] = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      label: new Date(targetYear, i, 1).toLocaleDateString('tr-TR', { month: 'short' }),
      salesCount: 0,
      revenue: 0,
    }));

    for (const sale of sales) {
      const m = new Date(sale.saleDate).getMonth(); // 0-based
      months[m].salesCount += 1;
      months[m].revenue += Number(sale.totalPrice);
    }

    return {
      success: true,
      data: { year: targetYear, months },
    };
  });

  // GET /api/reports/dashboard — main dashboard stats
  fastify.get('/dashboard', async (request) => {
    const { userId, role } = request.user;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const consultantFilter = role === 'SALES_CONSULTANT' ? { consultantId: userId } : {};

    const [
      totalProjects,
      unitStats,
      todaySales,
      overdueCount,
      expiringDeposits,
      totalCustomers,
      totalSalesCount,
      allSales,
      paidInstallments,
      overdueInstallments,
      todayTasksDue,
    ] = await Promise.all([
      prisma.project.count({ where: { isActive: true } }),
      prisma.unit.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      prisma.sale.count({
        where: { saleDate: { gte: today }, ...consultantFilter },
      }),
      prisma.installment.count({
        where: {
          status: 'PENDING',
          dueDate: { lt: new Date() },
          ...(role === 'SALES_CONSULTANT' ? { sale: { consultantId: userId } } : {}),
        },
      }),
      prisma.deposit.count({
        where: {
          status: 'ACTIVE',
          expiresAt: { lt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) }, // 3 days
          ...consultantFilter,
        },
      }),
      prisma.customer.count(),
      prisma.sale.count({ where: consultantFilter }),
      prisma.sale.findMany({
        where: consultantFilter,
        select: { totalPrice: true },
      }),
      prisma.installment.findMany({
        where: { status: 'PAID', ...(role === 'SALES_CONSULTANT' ? { sale: { consultantId: userId } } : {}) },
        select: { paidAmount: true },
      }),
      prisma.installment.findMany({
        where: { status: 'PENDING', dueDate: { lt: new Date() }, ...(role === 'SALES_CONSULTANT' ? { sale: { consultantId: userId } } : {}) },
        select: { amount: true },
      }),
      // Tasks due today
      prisma.task.count({
        where: {
          status: { in: ['PENDING', 'IN_PROGRESS'] },
          dueDate: { gte: today, lt: new Date(today.getTime() + 24 * 60 * 60 * 1000) },
          ...(role === 'SALES_CONSULTANT' ? { assignedTo: userId } : {}),
        },
      }),
    ]);

    const statusMap = Object.fromEntries(unitStats.map(s => [s.status, s._count.id]));
    const totalRevenue = allSales.reduce((sum, s) => sum + Number(s.totalPrice), 0);
    const collectedRevenue = paidInstallments.reduce((sum, p) => sum + Number(p.paidAmount || 0), 0);
    const overdueAmount = overdueInstallments.reduce((sum, i) => sum + Number(i.amount), 0);

    return {
      success: true,
      data: {
        totalProjects,
        totalUnits: Object.values(statusMap).reduce((a: number, b: any) => a + b, 0),
        availableUnits: statusMap.AVAILABLE || 0,
        reservedUnits: statusMap.RESERVED || 0,
        soldUnits: statusMap.SOLD || 0,
        totalCustomers,
        totalSales: totalSalesCount,
        todaySales,
        totalRevenue: totalRevenue.toString(),
        collectedRevenue: collectedRevenue.toString(),
        overdueInstallments: overdueCount,
        overdueAmount: overdueAmount.toString(),
        expiringDeposits,
        todayTasksDue,
      },
    };
  });
};
