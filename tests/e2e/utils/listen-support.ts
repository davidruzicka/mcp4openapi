import http from 'node:http';
import { describe } from 'vitest';

async function detectListenSupport(): Promise<boolean> {
  return await new Promise(resolve => {
    let finished = false;

    const server = http.createServer((_, res) => {
      res.statusCode = 200;
      res.end('ok');
    });

    const done = (result: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      try {
        server.close(() => resolve(result));
      } catch {
        resolve(result);
      }
    };

    const timeoutId = setTimeout(() => done(false), 2000);

    server.once('error', () => done(false));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object' || typeof (address as any).port !== 'number') {
        done(false);
        return;
      }

      const port = (address as any).port as number;
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path: '/',
          timeout: 2000,
        },
        res => {
          res.resume();
          res.once('end', () => done(res.statusCode === 200));
        }
      );

      req.once('error', () => done(false));
      req.once('timeout', () => {
        req.destroy();
        done(false);
      });
    });
  });
}

export const CAN_LISTEN = await detectListenSupport();
export const describeIfListen: any = CAN_LISTEN ? describe : describe.skip;

