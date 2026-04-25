import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { v4 as uuidv4 } from 'uuid';

import { AppModule } from '../src/app.module';
import { MockHcmServer } from './mock-hcm-server';
import { LeaveType, RequestStatus } from '../src/common/enums/enums';

const HCM_PORT = 4099; // isolated port for tests

describe('TOMS E2E Tests (with Mock HCM)', () => {
  let app: INestApplication;
  let hcm: MockHcmServer;
  let httpServer: any;

  beforeAll(async () => {
    // Start the mock HCM server
    hcm = new MockHcmServer(HCM_PORT);
    await hcm.start();

    // Override env so TOMS points at our mock
    process.env.HCM_BASE_URL = `http://localhost:${HCM_PORT}`;
    process.env.HCM_BATCH_URL = `http://localhost:${HCM_PORT}/hcm/batch`;
    process.env.DATABASE_PATH = './data/test-toms.db';
    process.env.HCM_RETRY_ATTEMPTS = '1'; // fail fast in tests
    process.env.BALANCE_STALENESS_MINUTES = '60';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    await hcm.stop();
    // Clean up test DB
    try {
      const fs = require('fs');
      if (fs.existsSync('./data/test-toms.db')) fs.unlinkSync('./data/test-toms.db');
    } catch {}
  });

  beforeEach(() => {
    hcm.clearAll();
  });

  // ─── Health ──────────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 ok', async () => {
      const res = await request(httpServer).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('TOMS');
    });
  });

  // ─── Balance endpoints ───────────────────────────────────────────────────────

  describe('GET /balances/:employeeId/:locationId', () => {
    it('returns 404 when no balances exist', async () => {
      await request(httpServer).get('/balances/EMP-UNKNOWN/LOC-NYC').expect(404);
    });

    it('returns balances after batch sync', async () => {
      hcm.seedBalance('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 20, 0);
      await request(httpServer).post('/balances/sync').expect(200);

      const res = await request(httpServer).get('/balances/EMP-001/LOC-NYC').expect(200);
      expect(res.body.balances).toHaveLength(1);
      expect(res.body.balances[0].total).toBe(20);
      expect(res.body.balances[0].available).toBe(20);
    });

    it('returns X-Balance-Stale header when sync is old', async () => {
      // Seed a balance and manually set stale time — we use 0 minutes staleness
      hcm.seedBalance('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 20, 0);
      await request(httpServer).post('/balances/sync').expect(200);

      // Temporarily set staleness to 0 — any synced balance is immediately stale
      process.env.BALANCE_STALENESS_MINUTES = '0';
      const res = await request(httpServer).get('/balances/EMP-001/LOC-NYC').expect(200);
      expect(res.headers['x-balance-stale']).toBe('true');
      process.env.BALANCE_STALENESS_MINUTES = '60'; // restore
    });
  });

  // ─── Time-Off Request: Submit ────────────────────────────────────────────────

  describe('POST /time-off-requests', () => {
    const futureDate = (offsetDays: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offsetDays);
      return d.toISOString().split('T')[0];
    };

    it('creates a request and moves to PENDING_APPROVAL', async () => {
      hcm.seedBalance('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 20, 0);
      await request(httpServer).post('/balances/sync').expect(200);

      const res = await request(httpServer)
        .post('/time-off-requests')
        .send({
          employeeId: 'EMP-001',
          locationId: 'LOC-NYC',
          leaveType: LeaveType.ANNUAL,
          startDate: futureDate(7),
          endDate: futureDate(11),
          idempotencyKey: uuidv4(),
        })
        .expect(201);

      expect(res.body.status).toBe(RequestStatus.PENDING_APPROVAL);
      expect(res.body.daysRequested).toBeGreaterThan(0);
    });

    it('rejects when HCM returns insufficient balance', async () => {
      hcm.seedBalance('EMP-002', 'LOC-NYC', LeaveType.ANNUAL, 2, 0);
      await request(httpServer).post('/balances/sync').expect(200);

      const res = await request(httpServer)
        .post('/time-off-requests')
        .send({
          employeeId: 'EMP-002',
          locationId: 'LOC-NYC',
          leaveType: LeaveType.ANNUAL,
          startDate: futureDate(7),
          endDate: futureDate(21), // ~10 business days >> 2
          idempotencyKey: uuidv4(),
        })
        .expect(201);

      // HCM will reject because 2 < requested; local validation also catches it
      expect([RequestStatus.REJECTED, 'REJECTED']).toContain(res.body.status);
    });

    it('returns same response on duplicate idempotency key', async () => {
      hcm.seedBalance('EMP-003', 'LOC-NYC', LeaveType.ANNUAL, 20, 0);
      await request(httpServer).post('/balances/sync').expect(200);

      const key = uuidv4();
      const body = {
        employeeId: 'EMP-003',
        locationId: 'LOC-NYC',
        leaveType: LeaveType.ANNUAL,
        startDate: futureDate(7),
        endDate: futureDate(8),
        idempotencyKey: key,
      };

      const first = await request(httpServer).post('/time-off-requests').send(body).expect(201);
      const second = await request(httpServer).post('/time-off-requests').send(body).expect(201);

      expect(first.body.requestId).toBe(second.body.requestId);
    });

    it('rejects with 400 for past startDate', async () => {
      await request(httpServer)
        .post('/time-off-requests')
        .send({
          employeeId: 'EMP-001',
          locationId: 'LOC-NYC',
          leaveType: LeaveType.ANNUAL,
          startDate: '2020-01-01',
          endDate: '2020-01-05',
          idempotencyKey: uuidv4(),
        })
        .expect(400);
    });

    it('rejects with 400 when endDate before startDate', async () => {
      await request(httpServer)
        .post('/time-off-requests')
        .send({
          employeeId: 'EMP-001',
          locationId: 'LOC-NYC',
          leaveType: LeaveType.ANNUAL,
          startDate: futureDate(10),
          endDate: futureDate(5),
          idempotencyKey: uuidv4(),
        })
        .expect(400);
    });

    it('rejects with 400 when required fields are missing', async () => {
      await request(httpServer)
        .post('/time-off-requests')
        .send({ employeeId: 'EMP-001' })
        .expect(400);
    });
  });

  // ─── Approve / Reject / Cancel ───────────────────────────────────────────────

  describe('PATCH /time-off-requests/:id/approve', () => {
    const futureDate = (n: number) => {
      const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0];
    };

    async function submitRequest(employeeId: string) {
      hcm.seedBalance(employeeId, 'LOC-NYC', LeaveType.ANNUAL, 20, 0);
      await request(httpServer).post('/balances/sync').expect(200);
      const res = await request(httpServer)
        .post('/time-off-requests')
        .send({
          employeeId,
          locationId: 'LOC-NYC',
          leaveType: LeaveType.ANNUAL,
          startDate: futureDate(3),
          endDate: futureDate(5),
          idempotencyKey: uuidv4(),
        })
        .expect(201);
      return res.body.requestId;
    }

    it('approves a PENDING_APPROVAL request', async () => {
      const id = await submitRequest('EMP-010');
      const res = await request(httpServer).patch(`/time-off-requests/${id}/approve`).expect(200);
      expect(res.body.status).toBe(RequestStatus.APPROVED);
    });

    it('rejects a PENDING_APPROVAL request', async () => {
      const id = await submitRequest('EMP-011');
      const res = await request(httpServer)
        .patch(`/time-off-requests/${id}/reject`)
        .send({ managerComment: 'Not enough cover' })
        .expect(200);
      expect(res.body.status).toBe(RequestStatus.REJECTED);
    });

    it('cancels a PENDING_APPROVAL request', async () => {
      const id = await submitRequest('EMP-012');
      const res = await request(httpServer).patch(`/time-off-requests/${id}/cancel`).expect(200);
      expect(res.body.status).toBe(RequestStatus.CANCELLED);
    });

    it('cancels an already APPROVED request (reversing usedBalance)', async () => {
      const id = await submitRequest('EMP-013');
      await request(httpServer).patch(`/time-off-requests/${id}/approve`).expect(200);
      const res = await request(httpServer).patch(`/time-off-requests/${id}/cancel`).expect(200);
      expect(res.body.status).toBe(RequestStatus.CANCELLED);
    });

    it('returns 409 when approving an already approved request', async () => {
      const id = await submitRequest('EMP-014');
      await request(httpServer).patch(`/time-off-requests/${id}/approve`).expect(200);
      await request(httpServer).patch(`/time-off-requests/${id}/approve`).expect(409);
    });

    it('returns 404 for non-existent request', async () => {
      await request(httpServer).patch(`/time-off-requests/${uuidv4()}/approve`).expect(404);
    });
  });

  // ─── HCM Sync: Batch ─────────────────────────────────────────────────────────

  describe('POST /balances/sync', () => {
    it('syncs all balances from HCM batch endpoint', async () => {
      hcm
        .seedBalance('EMP-020', 'LOC-NYC', LeaveType.ANNUAL, 15)
        .seedBalance('EMP-021', 'LOC-LA', LeaveType.SICK, 8);

      const res = await request(httpServer).post('/balances/sync').expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.succeeded).toBe(2);
      expect(res.body.failed).toBe(0);
    });

    it('reflects anniversary accrual after re-sync', async () => {
      hcm.seedBalance('EMP-022', 'LOC-NYC', LeaveType.ANNUAL, 15);
      await request(httpServer).post('/balances/sync').expect(200);

      // Check balance = 15
      let res = await request(httpServer).get('/balances/EMP-022/LOC-NYC').expect(200);
      expect(res.body.balances[0].total).toBe(15);

      // Trigger anniversary — HCM bumps total by 5
      hcm.triggerAnniversary('EMP-022', 'LOC-NYC', LeaveType.ANNUAL, 5);
      await request(httpServer).post('/balances/sync').expect(200);

      // TOMS must now reflect 20
      res = await request(httpServer).get('/balances/EMP-022/LOC-NYC').expect(200);
      expect(res.body.balances[0].total).toBe(20);
    });

    it('reflects year-start reset after re-sync', async () => {
      hcm.seedBalance('EMP-023', 'LOC-NYC', LeaveType.ANNUAL, 20, 10);
      await request(httpServer).post('/balances/sync').expect(200);

      // Year-start: reset to 20 fresh days
      hcm.triggerYearReset('EMP-023', 'LOC-NYC', LeaveType.ANNUAL, 20);
      await request(httpServer).post('/balances/sync').expect(200);

      const res = await request(httpServer).get('/balances/EMP-023/LOC-NYC').expect(200);
      expect(res.body.balances[0].total).toBe(20);
    });

    it('filters batch sync by employeeId', async () => {
      hcm
        .seedBalance('EMP-030', 'LOC-NYC', LeaveType.ANNUAL, 10)
        .seedBalance('EMP-031', 'LOC-NYC', LeaveType.ANNUAL, 12);

      const res = await request(httpServer).post('/balances/sync?employeeId=EMP-030').expect(200);
      expect(res.body.total).toBe(1);
    });

    it('returns sync status via GET /balances/sync/status', async () => {
      hcm.seedBalance('EMP-040', 'LOC-NYC', LeaveType.ANNUAL, 5);
      await request(httpServer).post('/balances/sync').expect(200);

      const res = await request(httpServer).get('/balances/sync/status').expect(200);
      expect(res.body.lastSync).not.toBeNull();
      expect(res.body.lastSync.succeeded).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Balance Integrity ───────────────────────────────────────────────────────

  describe('Balance Integrity', () => {
    const futureDate = (n: number) => {
      const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0];
    };

    it('prevents double-spending via concurrent pending requests', async () => {
      hcm.seedBalance('EMP-050', 'LOC-NYC', LeaveType.ANNUAL, 5, 0);
      await request(httpServer).post('/balances/sync').expect(200);

      // First request: 3 days (should succeed)
      const res1 = await request(httpServer)
        .post('/time-off-requests')
        .send({
          employeeId: 'EMP-050',
          locationId: 'LOC-NYC',
          leaveType: LeaveType.ANNUAL,
          startDate: futureDate(7),
          endDate: futureDate(11),
          idempotencyKey: uuidv4(),
        });
      expect(res1.body.status).toBe(RequestStatus.PENDING_APPROVAL);

      // Second request: 3 more days — only 2 remaining locally (5 - 3 pending)
      const res2 = await request(httpServer)
        .post('/time-off-requests')
        .send({
          employeeId: 'EMP-050',
          locationId: 'LOC-NYC',
          leaveType: LeaveType.ANNUAL,
          startDate: futureDate(14),
          endDate: futureDate(18),
          idempotencyKey: uuidv4(),
        });

      // Either local validation catches it (409) or HCM catches it (REJECTED)
      const blocked = res2.status === 409 || res2.body.status === RequestStatus.REJECTED;
      expect(blocked).toBe(true);
    });

    it('available balance reflects pending correctly', async () => {
      hcm.seedBalance('EMP-051', 'LOC-NYC', LeaveType.ANNUAL, 10, 0);
      await request(httpServer).post('/balances/sync').expect(200);

      // Submit 2-day request (Mon + Tue)
      await request(httpServer)
        .post('/time-off-requests')
        .send({
          employeeId: 'EMP-051',
          locationId: 'LOC-NYC',
          leaveType: LeaveType.ANNUAL,
          startDate: futureDate(7),
          endDate: futureDate(8),
          idempotencyKey: uuidv4(),
        });

      const res = await request(httpServer).get('/balances/EMP-051/LOC-NYC').expect(200);
      const bal = res.body.balances[0];
      // total=10, pending=2, used=0 → available=8
      expect(bal.pending).toBe(2);
      expect(bal.available).toBe(8);
    });
  });
});