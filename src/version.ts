import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function read(): string {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export const VERSION: string = read();
