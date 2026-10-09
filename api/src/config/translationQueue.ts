import { Queue } from 'bullmq';
import { getRedisConnection } from './redis';
import { PRIORITY } from './queue';

export const translationQueue = new Queue('translation', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

export { PRIORITY };
