// Seed CLI: `npm run seed` from the repo root.
import { seedAfeelaShm } from './afeela-shm.js';
import { save } from '../db.js';

const force = process.argv.includes('--force');
const out = seedAfeelaShm({ force });
save();
console.log(JSON.stringify(out, null, 2));
