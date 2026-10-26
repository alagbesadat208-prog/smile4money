/**
 * MongoDB Persistent Queue Store
 *
 * Stores oracle job queue entries in MongoDB with automatic TTL cleanup.
 */

import mongoose from 'mongoose';
import type { DlqEntry, PersistentQueueStore } from './persistent-queue-store.js';

interface DlqDocument extends mongoose.Document {
  id: string;
  payload: unknown;
  failureReason: string;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
  traceContext?: DlqEntry['traceContext'];
  expireAt: Date;
}

const dlqSchema = new mongoose.Schema<DlqDocument>(
  {
    id: { type: String, required: true, unique: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    failureReason: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    createdAt: { type: Number, required: true },
    lastAttemptAt: { type: Number, required: false, default: null },
    // W3C trace context the entry was queued under (#123).
    traceContext: { type: mongoose.Schema.Types.Mixed, required: false },
    // TTL index: auto-delete entries older than 30 days
    expireAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      index: { expireAfterSeconds: 0 },
    },
  },
  { collection: 'oracle_dlq' }
);

const DlqModel = mongoose.model<DlqDocument>('OracleDLQ', dlqSchema);

export class MongoDBQueueStore implements PersistentQueueStore {
  private connection: mongoose.Connection | null = null;

  async initialize(): Promise<void> {
    if (mongoose.connection.readyState === 0) {
      const mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017/smile4money';
      await mongoose.connect(mongoUrl);
    }
    this.connection = mongoose.connection;
  }

  async add(entry: DlqEntry): Promise<void> {
    await DlqModel.create({
      ...entry,
      expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  }

  async getAll(): Promise<DlqEntry[]> {
    const docs = await DlqModel.find({}).exec();
    return docs.map((doc) => ({
      id: doc.id,
      payload: doc.payload,
      failureReason: doc.failureReason,
      attempts: doc.attempts,
      createdAt: doc.createdAt,
      lastAttemptAt: doc.lastAttemptAt,
      ...(doc.traceContext ? { traceContext: doc.traceContext } : {}),
    }));
  }

  async remove(id: string): Promise<void> {
    await DlqModel.deleteOne({ id });
  }

  async update(id: string, updates: Partial<DlqEntry>): Promise<void> {
    await DlqModel.updateOne({ id }, { $set: updates });
  }

  async count(): Promise<number> {
    return await DlqModel.countDocuments({});
  }

  async clear(): Promise<void> {
    await DlqModel.deleteMany({});
  }

  async close(): Promise<void> {
    if (this.connection) {
      await mongoose.disconnect();
    }
  }
}
