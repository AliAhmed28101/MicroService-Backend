import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { LeaveType } from '../common/enums/enums';

@Injectable()
export class HcmAdapterService {
  private readonly logger = new Logger(HcmAdapterService.name);
  private readonly baseUrl: string;
  private readonly batchUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>('HCM_BASE_URL', 'http://localhost:4000');
    this.batchUrl = this.config.get<string>('HCM_BATCH_URL', 'http://localhost:4000/hcm/batch');
    this.apiKey = this.config.get<string>('HCM_API_KEY', '');
    this.maxRetries = this.config.get<number>('HCM_RETRY_ATTEMPTS', 3);
  }

  private get headers() {
    return { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' };
  }

  /** Fetch real-time balance from HCM */
  async getBalance(employeeId: string, locationId: string, leaveType: LeaveType) {
    return this.withRetry(() =>
      firstValueFrom(
        this.httpService.get(
          `${this.baseUrl}/hcm/balance/${employeeId}/${locationId}/${leaveType}`,
          { headers: this.headers },
        ),
      ),
    );
  }

  /** Tentatively debit balance in HCM (request submission) */
  async debitBalance(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    days: number,
  ): Promise<{ transactionId: string }> {
    const res = await this.withRetry(() =>
      firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/hcm/debit`,
          { employeeId, locationId, leaveType, days },
          { headers: this.headers },
        ),
      ),
    );
    return res.data;
  }

  /** Permanently commit a tentative debit (manager approval) */
  async commitDebit(transactionId: string): Promise<void> {
    await this.withRetry(() =>
      firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/hcm/commit`,
          { transactionId },
          { headers: this.headers },
        ),
      ),
    );
  }

  /** Roll back a tentative debit (rejection / cancellation) */
  async rollbackDebit(transactionId: string): Promise<void> {
    await this.withRetry(() =>
      firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/hcm/rollback`,
          { transactionId },
          { headers: this.headers },
        ),
      ),
    );
  }

  /** Fetch full balance corpus from HCM batch endpoint */
  async fetchBatch(): Promise<HcmBatchRecord[]> {
    const res = await this.withRetry(() =>
      firstValueFrom(
        this.httpService.post(this.batchUrl, {}, { headers: this.headers }),
      ),
    );
    return res.data?.balances ?? [];
  }

  /** Exponential-backoff retry wrapper */
  private async withRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // Logic fix: extracting message safely from unknown error type
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (attempt >= this.maxRetries) {
        this.logger.error(`HCM call failed after ${attempt} attempts: ${errorMessage}`);
        throw new ServiceUnavailableException(`HCM unavailable: ${errorMessage}`);
      }
      
      const delay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s …
      this.logger.warn(`HCM call failed (attempt ${attempt}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      return this.withRetry(fn, attempt + 1);
    }
  }
}

export interface HcmBatchRecord {
  employeeId: string;
  locationId: string;
  leaveType: LeaveType;
  totalBalance: number;
}