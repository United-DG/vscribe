import { Queue } from 'bullmq';
import { getRedisConnection } from './redis';

export { getRedisConnection } from './redis';

export const transcriptionQueue = new Queue('transcription', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

export const PRIORITY = {
  LOW: 10,
  NORMAL: 5,
  HIGH: 1,
};
