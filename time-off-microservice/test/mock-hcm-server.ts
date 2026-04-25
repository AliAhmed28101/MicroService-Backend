/**
 * Mock HCM Server
 * Simulates a real HCM (Workday/SAP) for integration and e2e testing.
 *
 * Behaviours modelled:
 *  - Real-time balance GET
 *  - Tentative debit (POST /hcm/debit) with insufficient-balance rejection
 *  - Commit (POST /hcm/commit)
 *  - Rollback (POST /hcm/rollback)
 *  - Batch endpoint (POST /hcm/batch)
 *  - Anniversary accrual: calling triggerAnniversary() boosts a balance
 *  - Year-start reset: calling triggerYearReset() resets usedBalance to 0
 */

import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';

export interface HcmBalance {
  employeeId: string;
  locationId: string;
  leaveType: string;
  totalBalance: number;
  usedBalance: number;
}

export interface HcmTransaction {
  transactionId: string;
  employeeId: string;
  locationId: string;
  leaveType: string;
  days: number;
  committed: boolean;
  rolledBack: boolean;
}

export class MockHcmServer {
  private server: http.Server;
  private balances: Map<string, HcmBalance> = new Map();
  private transactions: Map<string, HcmTransaction> = new Map();
  public port: number;
  public baseUrl: string;

  constructor(port = 4000) {
    this.port = port;
    this.baseUrl = `http://localhost:${port}`;
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  // ─── Seed helpers ────────────────────────────────────────────────────────────

  seedBalance(employeeId: string, locationId: string, leaveType: string, total: number, used = 0) {
    const key = `${employeeId}:${locationId}:${leaveType}`;
    this.balances.set(key, { employeeId, locationId, leaveType, totalBalance: total, usedBalance: used });
    return this;
  }

  triggerAnniversary(employeeId: string, locationId: string, leaveType: string, bonus: number) {
    const key = `${employeeId}:${locationId}:${leaveType}`;
    const bal = this.balances.get(key);
    if (bal) bal.totalBalance += bonus;
  }

  triggerYearReset(employeeId: string, locationId: string, leaveType: string, newTotal: number) {
    const key = `${employeeId}:${locationId}:${leaveType}`;
    const bal = this.balances.get(key);
    if (bal) { bal.totalBalance = newTotal; bal.usedBalance = 0; }
  }

  clearAll() {
    this.balances.clear();
    this.transactions.clear();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, resolve));
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  // ─── Request routing ─────────────────────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url || '';
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        this.route(req.method, url, parsed, res);
      } catch {
        this.send(res, 400, { error: 'Invalid JSON' });
      }
    });
  }

  private route(method: string, url: string, body: any, res: http.ServerResponse) {
    // GET /hcm/balance/:employeeId/:locationId/:leaveType
    const balanceMatch = url.match(/^\/hcm\/balance\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && balanceMatch) {
      return this.handleGetBalance(balanceMatch[1], balanceMatch[2], balanceMatch[3], res);
    }

    if (method === 'POST' && url === '/hcm/debit') return this.handleDebit(body, res);
    if (method === 'POST' && url === '/hcm/commit') return this.handleCommit(body, res);
    if (method === 'POST' && url === '/hcm/rollback') return this.handleRollback(body, res);
    if (method === 'POST' && url === '/hcm/batch') return this.handleBatch(res);

    this.send(res, 404, { error: 'Not found' });
  }

  private handleGetBalance(employeeId: string, locationId: string, leaveType: string, res: http.ServerResponse) {
    const key = `${employeeId}:${locationId}:${leaveType}`;
    const bal = this.balances.get(key);
    if (!bal) return this.send(res, 404, { error: 'Balance not found' });
    const available = bal.totalBalance - bal.usedBalance;
    this.send(res, 200, { ...bal, availableBalance: available });
  }

  private handleDebit(body: any, res: http.ServerResponse) {
    const { employeeId, locationId, leaveType, days } = body;
    if (!employeeId || !locationId || !leaveType || days == null) {
      return this.send(res, 400, { error: 'Missing required fields' });
    }
    const key = `${employeeId}:${locationId}:${leaveType}`;
    const bal = this.balances.get(key);
    if (!bal) return this.send(res, 422, { error: 'Invalid dimension combination' });

    const available = bal.totalBalance - bal.usedBalance;
    if (days > available) {
      return this.send(res, 422, { error: `Insufficient balance: requested ${days}, available ${available}` });
    }

    const transactionId = uuidv4();
    this.transactions.set(transactionId, {
      transactionId, employeeId, locationId, leaveType,
      days, committed: false, rolledBack: false,
    });
    // Tentatively mark as used (will be confirmed by commit or reversed by rollback)
    bal.usedBalance += days;
    this.send(res, 200, { transactionId, message: 'Debit tentatively applied' });
  }

  private handleCommit(body: any, res: http.ServerResponse) {
    const { transactionId } = body;
    const txn = this.transactions.get(transactionId);
    if (!txn) return this.send(res, 404, { error: 'Transaction not found' });
    if (txn.committed) return this.send(res, 409, { error: 'Already committed' });
    if (txn.rolledBack) return this.send(res, 409, { error: 'Already rolled back' });
    txn.committed = true;
    this.send(res, 200, { message: 'Transaction committed' });
  }

  private handleRollback(body: any, res: http.ServerResponse) {
    const { transactionId } = body;
    const txn = this.transactions.get(transactionId);
    if (!txn) return this.send(res, 404, { error: 'Transaction not found' });
    if (txn.rolledBack) return this.send(res, 409, { error: 'Already rolled back' });

    // Reverse the tentative debit
    const key = `${txn.employeeId}:${txn.locationId}:${txn.leaveType}`;
    const bal = this.balances.get(key);
    if (bal) bal.usedBalance = Math.max(0, bal.usedBalance - txn.days);
    txn.rolledBack = true;
    this.send(res, 200, { message: 'Transaction rolled back' });
  }

  private handleBatch(res: http.ServerResponse) {
    const balances = Array.from(this.balances.values()).map((b) => ({
      employeeId: b.employeeId,
      locationId: b.locationId,
      leaveType: b.leaveType,
      totalBalance: b.totalBalance,
    }));
    this.send(res, 200, { balances, generatedAt: new Date().toISOString() });
  }

  private send(res: http.ServerResponse, status: number, body: object) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  // ─── Inspection helpers (for test assertions) ─────────────────────────────

  getBalance(employeeId: string, locationId: string, leaveType: string) {
    return this.balances.get(`${employeeId}:${locationId}:${leaveType}`);
  }

  getTransaction(transactionId: string) {
    return this.transactions.get(transactionId);
  }
}