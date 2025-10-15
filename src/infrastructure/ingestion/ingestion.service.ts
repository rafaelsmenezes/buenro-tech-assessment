import { Injectable, Inject, Logger } from '@nestjs/common';
import { pipeline } from 'stream';
import * as StreamArray from 'stream-json/streamers/StreamArray';
import { finished } from 'stream/promises';

import { HttpClientService } from '../http/http-client.service';
import {
  IUnifiedDataRepositoryInterface,
  IUnifiedDataRepositoryInterfaceToken,
} from '../../domain/repositories/unified-data.repository.interface';
import { UnifiedData } from '../../domain/entities/unified-data.entity';
import { IngestionSource } from './interfaces/ingestion-source.interface';

@Injectable()
export class IngestionService {
  private readonly sources: IngestionSource[] = [];
  private readonly logger = new Logger(IngestionService.name);

  private static readonly BATCH_SIZE = 5000;
  private static readonly MAX_CONCURRENT_BATCHES = 3;

  constructor(
    @Inject(IUnifiedDataRepositoryInterfaceToken)
    private readonly repository: IUnifiedDataRepositoryInterface,
    private readonly httpClient: HttpClientService,
  ) {}

  registerSource(source: IngestionSource): void {
    this.sources.push(source);
  }

  async ingestAll(): Promise<void> {
    for (const source of this.sources) {
      try {
        await this.ingestSource(source);
      } catch (error: unknown) {
        if (error instanceof Error) {
          this.logger.error(`Failed ingestion for ${source.name}`, error.stack);
        } else {
          this.logger.error(
            `Failed ingestion for ${source.name}: ${String(error)}`,
          );
        }
      }
    }
  }

  private async ingestSource({
    name,
    url,
    mapper,
  }: IngestionSource): Promise<void> {
    this.logger.log(`Starting ingestion for ${name}`);

    const responseStream = await this.httpClient.getStream(url);
    const jsonStream = StreamArray.withParser();

    const batch: UnifiedData[] = [];
    const pendingSaves: Promise<void>[] = [];

    pipeline(responseStream, jsonStream, (err: unknown) => {
      if (err instanceof Error) {
        this.logger.error(`Stream error for ${name}: ${err.message}`);
      } else if (err != null) {
        let msg = '[unknown]';
        try {
          if (typeof err === 'string') msg = err;
          else if (err instanceof Error) msg = err.message;
          else msg = JSON.stringify(err);
        } catch {
          msg = '[unserializable error]';
        }
        this.logger.error(`Stream error for ${name}: ${msg}`);
      }
    });

    for await (const { value } of jsonStream) {
      // mapper.map accepts unknown and should return a UnifiedData
      // defensively handle unexpected mapper outputs
      const mapFn = (mapper as unknown as { map: (r: unknown) => UnifiedData })
        .map;
      const mapped = mapFn(value as unknown);
      if (!mapped) continue;
      batch.push(mapped);

      if (batch.length >= IngestionService.BATCH_SIZE) {
        pendingSaves.push(
          this.saveBatch(batch.splice(0, IngestionService.BATCH_SIZE)),
        );

        if (pendingSaves.length >= IngestionService.MAX_CONCURRENT_BATCHES) {
          await this.flushPending(pendingSaves);
        }
      }
    }

    // Flush any remaining batches
    if (batch.length > 0) {
      pendingSaves.push(this.saveBatch(batch.splice(0, batch.length)));
    }

    await this.flushPending(pendingSaves);
    await finished(responseStream);

    this.logger.log(`✅ Finished ingestion for ${name}`);
  }

  private async saveBatch(batch: UnifiedData[]): Promise<void> {
    if (batch.length === 0) return;

    try {
      await this.repository.saveAll(batch);
      this.logger.debug(`Saved batch of ${batch.length} records`);
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Failed to save batch: ${error.message}`);
      } else {
        this.logger.error(`Failed to save batch: ${String(error)}`);
      }
    }
  }

  private async flushPending(pending: Promise<void>[]): Promise<void> {
    await Promise.allSettled(pending);
    pending.length = 0;
  }
}
