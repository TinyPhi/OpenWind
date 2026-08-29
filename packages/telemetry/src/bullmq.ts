/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { Queue as BullQueue, Worker as BullWorker } from "bullmq";
import type { QueueOptions, WorkerOptions, Processor } from "bullmq";
import { env } from "@platform/config";
import { BullMQOtel } from "bullmq-otel";

const telemetry = env.TELEMETRY_ENABLED
  ? new BullMQOtel(env.OTEL_SERVICE_NAME ?? "openwind")
  : undefined;

export class Queue<
  DataType = any,
  ResultType = any,
  NameType extends string = string,
> extends BullQueue<DataType, ResultType, NameType> {
  constructor(name: string, opts?: QueueOptions) {
    super(name, telemetry ? ({ ...opts, telemetry } as any) : opts);
  }
}

export class Worker<
  DataType = any,
  ResultType = any,
  NameType extends string = string,
> extends BullWorker<DataType, ResultType, NameType> {
  constructor(
    name: string,
    processor?: string | Processor<DataType, ResultType, NameType>,
    opts?: WorkerOptions,
  ) {
    super(name, processor, telemetry ? ({ ...opts, telemetry } as any) : opts);
  }
}
