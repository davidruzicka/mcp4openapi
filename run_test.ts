import { RefreshRotationStore } from './src/auth/refresh-rotation-store.js';
import { randomUUID } from 'crypto';

const store = new RefreshRotationStore({ ttlMs: 1000, graceMs: 0 });

const redemption1 = store.beginRotation('default:fam-1', 'jti-1');
console.log('first kind:', redemption1.kind);
if (redemption1.kind === 'lease') {
  redemption1.lease.commit('result');
}

// wait 2 seconds
setTimeout(() => {
    console.log('timeout done');
    for (let i = 0; i < 99; i++) {
        try { store.beginRotation(`other:${i}`, 'jti'); } catch (e) {}
    }

    try { store.beginRotation('other:100', 'jti'); } catch (e) {}

    try {
        const redemption2 = store.beginRotation('default:fam-1', 'jti-2');
        console.log('second kind:', redemption2.kind);
    } catch (e) {
        console.log('error:', e.message);
    }
}, 2000);
